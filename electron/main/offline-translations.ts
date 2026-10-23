import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { TranslationLanguage } from '../../shared/caption-translation'

/** One isolated, CPU-only model at a time. No network or credentials in this process. */
export class OfflineTranslations {
  private child?: UtilityProcess
  private language?: TranslationLanguage
  private nextId = 0
  private pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private path: (language: TranslationLanguage) => Promise<string>) {}
  translate(text: string, language: TranslationLanguage, signal: AbortSignal): Promise<string> {
    if (language === 'en') return Promise.resolve(text)
    const run = this.queue.catch(() => {}).then(async () => {
      signal.throwIfAborted()
      const abort = () => this.stop(new DOMException('Translation stopped.', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (!this.child || this.language !== language) {
          this.stop()
          const path = await this.path(language)
          signal.throwIfAborted()
          const child = utilityProcess.fork(join(__dirname, 'offline-translation-worker.js'), [], { serviceName: 'Offline translation', stdio: 'pipe' })
          this.child = child; this.language = language
          child.stdout?.resume(); child.stderr?.resume()
          child.on('message', (message: { id: number; text?: string; error?: string }) => {
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            if (message.error) pending.reject(new Error(message.error))
            else pending.resolve(message.text ?? '')
          })
          child.once('exit', () => { if (this.child === child) this.stop(new Error('The offline translation engine stopped. Retry translation.')) })
          await this.request({ type: 'init', path })
        }
        signal.throwIfAborted()
        return await this.request({ type: 'translate', text })
      } catch (error) { this.stop(error instanceof Error ? error : undefined); throw error }
      finally { signal.removeEventListener('abort', abort) }
    })
    this.queue = run
    return run
  }
  private request(message: object): Promise<string> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.child!.postMessage({ ...message, id }) }
      catch { this.pending.delete(id); reject(new Error('Could not contact the offline translation engine.')) }
    })
  }
  stop(error = new Error('Offline translation stopped.')): void {
    const child = this.child; this.child = undefined; this.language = undefined
    child?.kill()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
