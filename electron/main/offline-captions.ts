import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { CaptionSource, LocalCaptionEngine, LocalCaptionResult } from '../../shared/captions'
import type { OfflineModelPaths } from './offline-models'

class EngineExitedError extends Error {}

// Only retain a fixed error category, never raw native output (which can contain
// file paths or captured text). Classify startup failures before audio is sent.
function startupFailure(output: string): string | undefined {
  if (/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(output)) return 'A caption engine file is missing. Fully exit and reopen Interview Studio.'
  if (/ERR_DLOPEN_FAILED|specified module could not be found|not a valid Win32 application/i.test(output)) return 'A native caption component could not load. Fully exit and reopen Interview Studio.'
  if (/out of memory|allocation failed|bad_alloc/i.test(output)) return 'There is not enough memory to load offline captions. Close other apps and try again.'
  if (/WebAssembly|CompileError|LinkError/.test(output)) return 'The microphone speech detector could not load. Fully exit and reopen Interview Studio.'
}

/** Native inference runs outside the main process and has no network path. */
export class OfflineCaptions implements LocalCaptionEngine {
  private child?: UtilityProcess
  private ready?: Promise<LocalCaptionResult>
  private pending = new Map<number, { resolve: (value: LocalCaptionResult) => void; reject: (error: Error) => void }>()
  private next = 1
  private stopped = false
  constructor(private paths: OfflineModelPaths) {}
  private request(message: object): Promise<LocalCaptionResult> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.child!.postMessage({ ...message, id }) }
      catch { this.pending.delete(id); reject(new Error('Could not communicate with the offline caption engine.')) }
    })
  }
  private initialize(): Promise<LocalCaptionResult> {
    if (this.stopped) return Promise.reject(new DOMException('Captioning stopped.', 'AbortError'))
    this.ready ??= this.start()
    return this.ready
  }
  private async start(): Promise<LocalCaptionResult> {
    // A worker may exit while the development build is being replaced or after
    // a transient process launch failure. Retry startup once, before any audio.
    for (let attempt = 0; ; attempt++) {
      try { return await this.launch() }
      catch (error) {
        if (this.stopped) throw new DOMException('Captioning stopped.', 'AbortError')
        if (!(error instanceof EngineExitedError) || attempt === 1) {
          this.stop(error instanceof Error ? error : undefined)
          throw error
        }
      }
    }
  }
  private launch(): Promise<LocalCaptionResult> {
    const child = utilityProcess.fork(join(__dirname, 'offline-caption-worker.js'), [], { serviceName: 'Offline captions', stdio: 'pipe' })
    this.child = child
    let initialized = false, failure: string | undefined
    child.stdout?.resume()
    child.stderr?.on('data', (data: Buffer) => {
      if (!initialized) failure = startupFailure(data.toString()) ?? failure
    })
    child.on('message', (message: { id: number; result?: LocalCaptionResult; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result ?? {})
    })
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = undefined
      const error = new EngineExitedError(initialized
        ? `The offline caption engine stopped (exit code ${code}). Start captions again.`
        : failure ?? `The offline caption engine could not start (exit code ${code}). Fully exit and reopen Interview Studio, then start captions again.`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      if (initialized) this.stop(error)
    })
    return this.request({ type: 'init', paths: this.paths }).then(result => { initialized = true; return result })
  }
  async prepare(): Promise<void> { await this.initialize() }
  async transcribe(source: CaptionSource, pcm: Int16Array, signal: AbortSignal, timing?: { startMs: number; streaming: boolean }): Promise<LocalCaptionResult> {
    if (this.stopped || signal.aborted) throw new DOMException('Captioning stopped.', 'AbortError')
    const abort = () => this.stop(new DOMException('Captioning stopped.', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      await this.initialize()
      signal.throwIfAborted()
      if (this.stopped) throw new DOMException('Captioning stopped.', 'AbortError')
      return await this.request({ type: 'transcribe', source, pcm, timing })
    } finally { signal.removeEventListener('abort', abort) }
  }
  stop(error: Error = new DOMException('Captioning stopped.', 'AbortError')): void {
    this.stopped = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.child?.kill(); this.child = undefined
  }
}
