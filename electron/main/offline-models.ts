import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OfflineModelStatus } from '../../shared/captions'
import { OFFLINE_MODEL_NOTICES } from './offline-model-notices'

const asr = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/672fbf1b30579d6585301139bb363f42a0ad4a24/'
// Byte-identical to the official sherpa-onnx-online-punct-en-2024-08-06
// release, pinned as individual data files so setup never extracts archives.
const punctuation = 'https://huggingface.co/jiangzhuo9357/edge-punct-casing-en-onnx/resolve/a0897f6d38cc6f60ac9b9f807a31f7033d1fbc89/'
export const OFFLINE_MODEL_FILES = [
  { name: 'encoder.onnx', url: `${asr}encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, bytes: 71083163, sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1' },
  { name: 'decoder.onnx', url: `${asr}decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, bytes: 1307236, sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02' },
  { name: 'joiner.onnx', url: `${asr}joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx`, bytes: 259335, sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297' },
  { name: 'tokens.txt', url: `${asr}tokens.txt`, bytes: 5048, sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb' },
  { name: 'punctuation.onnx', url: `${punctuation}model.int8.onnx`, bytes: 7490500, sha256: '9d611f445fe4a46186080fe161be6059d87d72eb88d3a8cb00c1a06e83a6067e' },
  { name: 'punctuation.vocab', url: `${punctuation}bpe.vocab`, bytes: 149430, sha256: 'e118b7ad88c54db562517df49e1cffd4836d166c34fb190fd311d7f34eb238f5' }
] as const
export type OfflineModelFile = { name: string; url: string; bytes: number; sha256: string }
export interface OfflineModelPaths { encoder: string; decoder: string; joiner: string; tokens: string; punctuation: string; punctuationVocab: string }

/** Downloads only the pinned data files; no scripts, executables, or archives. */
export class OfflineModelStore {
  private controller?: AbortController
  private checkPromise?: Promise<OfflineModelStatus>
  private task?: Promise<void>
  private status: OfflineModelStatus
  private files: readonly OfflineModelFile[]
  constructor(private options: { directory: () => string; fetch: typeof fetch; onStatus: (status: OfflineModelStatus) => void; files?: readonly OfflineModelFile[] }) {
    this.files = options.files ?? OFFLINE_MODEL_FILES
    this.status = { state: 'missing', downloadedBytes: 0, totalBytes: this.files.reduce((sum, file) => sum + file.bytes, 0), message: 'Download the English caption models once to use captions offline.' }
  }
  snapshot(): OfflineModelStatus { return { ...this.status } }
  private update(value: Partial<OfflineModelStatus>): void { this.status = { ...this.status, ...value }; this.options.onStatus(this.snapshot()) }
  private async valid(file: OfflineModelFile): Promise<boolean> {
    const path = join(this.options.directory(), file.name)
    try {
      if ((await stat(path)).size !== file.bytes) return false
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      return hash.digest('hex') === file.sha256
    } catch { return false }
  }
  async check(): Promise<OfflineModelStatus> {
    if (this.task || this.status.state === 'ready') return this.snapshot()
    if (!this.checkPromise) this.checkPromise = (async () => {
      this.update({ state: 'checking', message: 'Checking local models…' })
      let bytes = 0
      for (const file of this.files) if (await this.valid(file)) bytes += file.bytes
      this.update({ downloadedBytes: bytes, state: bytes === this.status.totalBytes ? 'ready' : 'missing', message: bytes === this.status.totalBytes ? 'English captions with punctuation are ready. No internet or API key needed.' : bytes > 0 ? 'Complete model setup to add punctuation. Verified files are reused; only missing files download.' : 'Download the English caption models once to use captions offline.' })
      return this.snapshot()
    })().finally(() => { this.checkPromise = undefined })
    return this.checkPromise
  }
  paths(): OfflineModelPaths {
    if (this.status.state !== 'ready') throw new Error('Download the offline models in Settings > AI connection > Caption transcription first.')
    const directory = this.options.directory()
    return { encoder: join(directory, 'encoder.onnx'), decoder: join(directory, 'decoder.onnx'), joiner: join(directory, 'joiner.onnx'), tokens: join(directory, 'tokens.txt'), punctuation: join(directory, 'punctuation.onnx'), punctuationVocab: join(directory, 'punctuation.vocab') }
  }
  async download(): Promise<OfflineModelStatus> {
    if (this.task) return this.snapshot()
    await this.check()
    if (this.task || this.status.state === 'ready') return this.snapshot()
    const controller = new AbortController()
    this.controller = controller
    this.update({ state: 'downloading', downloadedBytes: 0, message: 'Downloading offline models…' })
    this.task = this.runDownload(controller).finally(() => { this.controller = undefined; this.task = undefined })
    return this.snapshot()
  }
  private async runDownload(controller: AbortController): Promise<void> {
    let completed = 0
    try {
      await mkdir(this.options.directory(), { recursive: true })
      for (const file of this.files) {
        controller.signal.throwIfAborted()
        if (await this.valid(file)) { completed += file.bytes; this.update({ downloadedBytes: completed }); continue }
        const path = join(this.options.directory(), file.name)
        const partial = `${path}.part`
        try {
          const response = await this.options.fetch(file.url, { signal: controller.signal, credentials: 'omit' })
          if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Model download failed (HTTP ${response.status}).`) }
          const declared = response.headers.get('content-length')
          if (declared && Number(declared) !== file.bytes) { await response.body.cancel(); throw new Error('Model download has an unexpected size.') }
          const reader = response.body.getReader()
          let handle: Awaited<ReturnType<typeof open>> | undefined
          const hash = createHash('sha256')
          let received = 0, lastUpdate = 0
          try {
            handle = await open(partial, 'w')
            for (;;) {
              controller.signal.throwIfAborted()
              const { done, value } = await reader.read()
              if (done) break
              received += value.byteLength
              if (received > file.bytes) throw new Error('Model download exceeded its expected size.')
              hash.update(value)
              await handle.writeFile(value)
              if (Date.now() - lastUpdate > 200) { this.update({ downloadedBytes: completed + received, message: `Downloading ${file.name}…` }); lastUpdate = Date.now() }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await handle?.close() }
          controller.signal.throwIfAborted()
          if (received !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('Model verification failed. Retry the download.')
          await rename(partial, path)
          completed += received
          this.update({ downloadedBytes: completed })
        } finally { await unlink(partial).catch(() => {}) }
      }
      await writeFile(join(this.options.directory(), 'NOTICE.txt'), OFFLINE_MODEL_NOTICES, 'utf8')
      this.update({ state: 'ready', downloadedBytes: this.status.totalBytes, message: 'English captions with punctuation are ready. No internet or API key needed.' })
    } catch (error) {
      this.update({ state: controller.signal.aborted ? 'missing' : 'error', downloadedBytes: completed, message: controller.signal.aborted ? 'Download canceled. Completed models are kept; you can resume setup.' : error instanceof Error ? error.message : 'Could not download the offline models.' })
    }
  }
  cancel(): void { this.controller?.abort() }
  async settled(): Promise<void> { await this.task }
}
