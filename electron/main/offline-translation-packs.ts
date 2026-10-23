import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import yauzl from 'yauzl'
import catalog from './offline-translation-catalog.json'
import { translationLanguage, type TranslationLanguage } from '../../shared/caption-translation'
import type { OfflineTranslationPack, OfflineTranslationStatus } from '../../shared/offline-translation'

export interface TranslationPackDefinition { language: string; version: string; url: string; bytes: number; md5: string }
interface InstalledFile { name: string; bytes: number; sha256: string }
const FILES = new Set(['model.bin', 'config.json', 'shared_vocabulary.json', 'shared_vocabulary.txt', 'source_vocabulary.json', 'source_vocabulary.txt', 'target_vocabulary.json', 'target_vocabulary.txt', 'source.spm', 'target.spm', 'tokenizer.model', 'sentencepiece.model', 'README.md', 'LICENSE', 'LICENSE.txt', 'metadata.json'])
const MAX_FILE_BYTES = 800_000_000
const MAX_INSTALLED_BYTES = 1_000_000_000

export function packEntryName(name: string, externalAttributes = 0): string | undefined {
  if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part.includes(':')) || ((externalAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('Unsafe translation archive.')
  const parts = name.split('/')
  if (parts.length === 3 && parts[1] === 'model' && FILES.has(parts[2])) return parts[2]
  if (parts.length === 2 && ['tokenizer.model', 'sentencepiece.model', 'README.md', 'LICENSE', 'LICENSE.txt', 'metadata.json'].includes(parts[1])) return parts[1]
  return undefined
}
export async function extractTranslationPack(archive: string, destination: string, signal: AbortSignal): Promise<InstalledFile[]> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip!)))
  const installed: InstalledFile[] = [], names = new Set<string>()
  let total = 0, entries = 0
  await new Promise<void>((resolve, reject) => {
    const abort = () => { zip.close(); reject(new DOMException('Download canceled.', 'AbortError')) }
    const fail = (error: unknown) => { zip.close(); signal.removeEventListener('abort', abort); reject(error) }
    signal.addEventListener('abort', abort, { once: true })
    zip.on('error', fail)
    zip.on('end', () => { signal.removeEventListener('abort', abort); resolve() })
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      signal.throwIfAborted()
      if (++entries > 1000) throw new Error('Translation archive has too many entries.')
      const name = packEntryName(entry.fileName, entry.externalFileAttributes)
      if (!name) { zip.readEntry(); return }
      if (names.has(name) || entry.uncompressedSize > MAX_FILE_BYTES || (total += entry.uncompressedSize) > MAX_INSTALLED_BYTES) throw new Error('Unexpected translation archive contents.')
      names.add(name)
      const stream = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!)))
      const output = await open(join(destination, name), 'wx')
      const hash = createHash('sha256'); let received = 0
      try {
        await new Promise<void>((resolve, reject) => {
          let writes = Promise.resolve()
          const cancel = () => stream.destroy(new DOMException('Download canceled.', 'AbortError'))
          signal.addEventListener('abort', cancel, { once: true })
          const cleanup = () => signal.removeEventListener('abort', cancel)
          stream.on('data', (chunk: Buffer) => {
            stream.pause()
            writes = writes.then(async () => {
              signal.throwIfAborted(); received += chunk.length
              if (received > entry.uncompressedSize) throw new Error('Translation file exceeded its expected size.')
              hash.update(chunk); await output.writeFile(chunk)
            })
            void writes.then(() => stream.resume(), error => stream.destroy(error))
          })
          stream.once('error', error => { cleanup(); reject(error) })
          stream.once('end', () => { cleanup(); void writes.then(resolve, reject) })
          if (signal.aborted) cancel()
        })
      } finally { await output.close() }
      if (received !== entry.uncompressedSize) throw new Error('Translation file is incomplete.')
      installed.push({ name, bytes: received, sha256: hash.digest('hex') })
      zip.readEntry()
    })().catch(fail) })
    if (signal.aborted) abort(); else zip.readEntry()
  })
  if (!names.has('model.bin') || !(names.has('tokenizer.model') || names.has('sentencepiece.model')) || ![...names].some(name => name.includes('vocabulary'))) throw new Error('Translation pack is missing model or tokenizer files.')
  const tokenizer = installed.find(file => file.name === 'tokenizer.model' || file.name === 'sentencepiece.model')!
  for (const name of ['source.spm', 'target.spm']) {
    if (names.has(name)) continue
    await copyFile(join(destination, tokenizer.name), join(destination, name))
    installed.push({ ...tokenizer, name })
  }
  return installed
}

/** Fixed official Argos data archives. Only selected packs download; never code. */
export class OfflineTranslationPacks {
  private states = new Map<TranslationLanguage, OfflineTranslationPack>()
  private task?: Promise<void>
  private controller?: AbortController
  private active?: TranslationLanguage
  private verified = new Map<TranslationLanguage, string>()
  private invalid = new Set<TranslationLanguage>()
  private checking?: Promise<OfflineTranslationStatus>
  readonly definitions: readonly TranslationPackDefinition[]
  constructor(private options: { directory: () => string; fetch: typeof fetch; onStatus: (status: OfflineTranslationStatus) => void; definitions?: readonly TranslationPackDefinition[] }) {
    this.definitions = options.definitions ?? catalog
    for (const pack of this.definitions) {
      const language = translationLanguage(pack.language).id
      this.states.set(language, { language, version: pack.version, bytes: pack.bytes, state: 'missing', downloadedBytes: 0 })
    }
  }
  snapshot(): OfflineTranslationStatus { return { packs: [...this.states.values()].map(pack => ({ ...pack })) } }
  private update(language: TranslationLanguage, change: Partial<OfflineTranslationPack>) {
    this.states.set(language, { ...this.states.get(language)!, ...change }); this.options.onStatus(this.snapshot())
  }
  private definition(value: unknown) {
    const language = translationLanguage(value).id
    const pack = this.definitions.find(pack => pack.language === language)
    if (!pack) throw new Error('An offline English translation pack is not available for this language.')
    return { ...pack, language }
  }
  private directory(language: TranslationLanguage): string { return join(this.options.directory(), `en-${language}`) }
  private async receipt(language: TranslationLanguage): Promise<InstalledFile[]> {
    const pack = this.definition(language), directory = this.directory(language)
    const info = await stat(join(directory, 'installed.json'))
    if (info.size > 12_000) throw new Error('Invalid translation receipt.')
    const receipt = JSON.parse(await readFile(join(directory, 'installed.json'), 'utf8'))
    if (receipt.version !== pack.version || receipt.archiveMd5 !== pack.md5 || !Array.isArray(receipt.files) || receipt.files.length < 4 || receipt.files.length > 20) throw new Error('Translation pack needs downloading.')
    const files = receipt.files as InstalledFile[]
    const names = new Set<string>()
    for (const file of files) {
      if (!FILES.has(file.name) || names.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_FILE_BYTES || (await stat(join(directory, file.name))).size !== file.bytes) throw new Error('Translation pack is incomplete.')
      names.add(file.name)
    }
    if (!names.has('model.bin') || !names.has('source.spm') || !names.has('target.spm')) throw new Error('Translation pack is incomplete.')
    return files
  }
  async check(): Promise<OfflineTranslationStatus> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      for (const language of this.states.keys()) {
        if (this.active === language || this.invalid.has(language)) continue
        try { await this.receipt(language); this.states.set(language, { ...this.states.get(language)!, state: 'ready', downloadedBytes: this.states.get(language)!.bytes }) }
        catch { if (this.states.get(language)?.state !== 'error') this.states.set(language, { ...this.states.get(language)!, state: 'missing', downloadedBytes: 0 }) }
      }
      this.options.onStatus(this.snapshot()); return this.snapshot()
    })().finally(() => { this.checking = undefined })
    return this.checking
  }
  async path(language: TranslationLanguage): Promise<string> {
    this.definition(language)
    try {
      const files = await this.receipt(language)
      const signature = JSON.stringify(await Promise.all(files.map(async file => { const info = await stat(join(this.directory(language), file.name)); return [file.name, info.size, info.mtimeMs] })))
      if (this.verified.get(language) !== signature) {
        for (const file of files) {
          const hash = createHash('sha256')
          for await (const chunk of createReadStream(join(this.directory(language), file.name))) hash.update(chunk)
          if (hash.digest('hex') !== file.sha256) throw new Error('damaged')
        }
        this.verified.set(language, signature)
      }
    } catch {
      this.invalid.add(language); this.verified.delete(language)
      this.update(language, { state: 'error', message: 'Pack missing or damaged. Download it again to repair offline translation.' })
      throw new Error('Download this language pack in Settings > Caption translation before translating offline.')
    }
    return this.directory(language)
  }
  async download(value: unknown): Promise<OfflineTranslationStatus> {
    const pack = this.definition(value)
    if (this.task) throw new Error('Wait for the current pack download, or cancel it first.')
    await this.check()
    if (this.task) throw new Error('Wait for the current pack download, or cancel it first.')
    if (this.states.get(pack.language)?.state === 'ready') return this.snapshot()
    this.active = pack.language; this.controller = new AbortController()
    this.update(pack.language, { state: 'downloading', downloadedBytes: 0, message: 'Downloading language pack…' })
    this.task = this.install(pack, this.controller).finally(() => { this.active = undefined; this.controller = undefined; this.task = undefined })
    return this.snapshot()
  }
  private async install(pack: TranslationPackDefinition & { language: TranslationLanguage }, controller: AbortController): Promise<void> {
    const root = this.options.directory(), archive = join(root, `${pack.language}.part`), staging = join(root, `.install-${pack.language}`)
    try {
      await mkdir(root, { recursive: true }); await rm(staging, { recursive: true, force: true }); await mkdir(staging)
      controller.signal.throwIfAborted()
      const response = await this.options.fetch(pack.url, { signal: controller.signal, credentials: 'omit', headers: { 'User-Agent': 'Mozilla/5.0 InterviewStudio' } })
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Download failed (HTTP ${response.status}).`) }
      const declared = response.headers.get('content-length')
      if (declared && Number(declared) !== pack.bytes) { await response.body.cancel(); throw new Error('Pack size changed. Update the app to download this pack.') }
      const reader = response.body.getReader(), file = await open(archive, 'w'), hash = createHash('md5')
      let received = 0, last = 0
      try {
        for (;;) {
          controller.signal.throwIfAborted()
          const { done, value } = await reader.read(); if (done) break
          received += value.byteLength
          if (received > pack.bytes) throw new Error('Pack download exceeded its expected size.')
          hash.update(value); await file.writeFile(value)
          if (Date.now() - last > 150) { this.update(pack.language, { downloadedBytes: received }); last = Date.now() }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close() }
      if (received !== pack.bytes || hash.digest('hex') !== pack.md5) throw new Error('The downloaded pack is incomplete or changed. Retry or update the app.')
      controller.signal.throwIfAborted()
      this.update(pack.language, { state: 'installing', downloadedBytes: received, message: 'Installing language pack…' })
      const files = await extractTranslationPack(archive, staging, controller.signal)
      await writeFile(join(staging, 'installed.json'), JSON.stringify({ version: pack.version, archiveMd5: pack.md5, files }))
      await writeFile(join(staging, 'NOTICE.txt'), `Argos Translate English → ${pack.language}\nSource: ${pack.url}\nPackage version: ${pack.version}\nhttps://github.com/argosopentech/argos-translate\nModel packages are data, processed locally with CTranslate2.\n`)
      controller.signal.throwIfAborted()
      await rm(this.directory(pack.language), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); await rename(staging, this.directory(pack.language))
      this.verified.delete(pack.language)
      this.invalid.delete(pack.language)
      this.update(pack.language, { state: 'ready', downloadedBytes: received, message: 'Ready for offline translation.' })
    } catch (error) {
      this.update(pack.language, { state: controller.signal.aborted ? 'missing' : 'error', downloadedBytes: 0, message: controller.signal.aborted ? 'Download canceled. No incomplete pack was installed.' : error instanceof Error ? error.message : 'Could not install this pack.' })
    } finally { await unlink(archive).catch(() => {}); await rm(staging, { recursive: true, force: true }).catch(() => {}) }
  }
  cancel(): void { this.controller?.abort() }
  async remove(value: unknown): Promise<OfflineTranslationStatus> {
    const pack = this.definition(value)
    if (this.task) throw new Error('Cancel or finish the download before removing a pack.')
    await rm(this.directory(pack.language), { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); this.verified.delete(pack.language); this.invalid.delete(pack.language)
    this.update(pack.language, { state: 'missing', downloadedBytes: 0, message: 'Language pack removed.' }); return this.snapshot()
  }
  async settled(): Promise<void> { await this.task }
}
