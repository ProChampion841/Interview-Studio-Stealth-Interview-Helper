import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OfflineTranslationPacks, packEntryName } from '../electron/main/offline-translation-packs'
import { normalizeTranslationConfiguration } from '../shared/translation-settings'

// Small stored ZIP fixture, without depending on archive-writing software.
function archive(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0
  for (const [name, contents] of Object.entries(entries)) {
    const filename = Buffer.from(name), data = Buffer.from(contents)
    let crc = 0xffffffff
    for (const byte of data) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    const item = Buffer.alloc(46); item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20, 4); item.writeUInt16LE(20, 6); item.writeUInt32LE(crc, 16); item.writeUInt32LE(data.length, 20); item.writeUInt32LE(data.length, 24); item.writeUInt16LE(filename.length, 28); item.writeUInt32LE(offset, 42)
    locals.push(local, filename, data); central.push(item, filename); offset += local.length + filename.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const entries = { 'en_es/model/model.bin': 'model-data', 'en_es/model/shared_vocabulary.txt': 'word\nword2', 'en_es/sentencepiece.model': 'tokenizer', 'en_es/README.md': 'Attribution', 'en_es/unused.py': 'never execute or extract' }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(bytes = archive(entries)) {
  const root = await mkdtemp(join(tmpdir(), 'studio-translation-')); roots.push(root)
  const definition = { language: 'es', version: 'test', url: 'https://argos-net.com/v1/test.argosmodel', bytes: bytes.length, md5: createHash('md5').update(bytes).digest('hex') }
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(Uint8Array.from(bytes).buffer))
  const onStatus = vi.fn()
  const store = new OfflineTranslationPacks({ directory: () => root, definitions: [definition], fetch, onStatus })
  return { root, definition, fetch, store, onStatus }
}
describe('offline translation language packs', () => {
  it('downloads only the selected pack, installs data, preserves attribution, and reloads offline', async () => {
    const f = await fixture()
    expect((await f.store.check()).packs[0].state).toBe('missing')
    expect(f.fetch).not.toHaveBeenCalled()
    await f.store.download('es'); await f.store.settled()
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.store.snapshot().packs[0].state).toBe('ready')
    const directory = await f.store.path('es')
    expect(await readFile(join(directory, 'source.spm'), 'utf8')).toBe('tokenizer')
    expect(await readFile(join(directory, 'target.spm'), 'utf8')).toBe('tokenizer')
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toBe('Attribution')
    expect(await readdir(directory)).not.toContain('unused.py')
    const reloaded = new OfflineTranslationPacks({ directory: () => f.root, definitions: [f.definition], fetch: f.fetch, onStatus: vi.fn() })
    expect((await reloaded.check()).packs[0].state).toBe('ready')
    expect(await reloaded.path('es')).toBe(directory)
    await reloaded.download('es'); expect(f.fetch).toHaveBeenCalledOnce()
    await reloaded.remove('es')
    expect((await readdir(f.root))).toEqual([])
  })
  it('rejects corrupt downloads and cleans incomplete data', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(Buffer.alloc(f.definition.bytes)))
    await f.store.download('es'); await f.store.settled()
    expect(f.store.snapshot().packs[0].state).toBe('error')
    expect(await readdir(f.root)).toEqual([])
  })
  it('detects modified installed files and repairs them with a fresh download', async () => {
    const f = await fixture(); await f.store.download('es'); await f.store.settled()
    const directory = await f.store.path('es')
    await writeFile(join(directory, 'model.bin'), 'corruption')
    await expect(f.store.path('es')).rejects.toThrow(/Download/)
    expect(f.store.snapshot().packs[0].state).toBe('error')
    await f.store.download('es'); await f.store.settled()
    expect(await f.store.path('es')).toBe(directory)
    expect(f.fetch).toHaveBeenCalledTimes(2)
  })
  it('cancels an in-flight download, blocks duplicate downloads/removal, and installs nothing partial', async () => {
    const f = await fixture()
    f.fetch.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))))
    await f.store.download('es')
    await expect(f.store.download('es')).rejects.toThrow(/current pack/)
    await expect(f.store.remove('es')).rejects.toThrow(/download/)
    f.store.cancel(); await f.store.settled()
    expect(f.store.snapshot().packs[0].state).toBe('missing')
    expect(await readdir(f.root)).toEqual([])
  })
  it('rejects missing-model archives and unsupported target languages without a request', async () => {
    const f = await fixture(archive({ 'en_es/README.md': 'missing data' }))
    await expect(f.store.download('../../secrets')).rejects.toThrow()
    await expect(f.store.download('ta')).rejects.toThrow(/not available/)
    expect(f.fetch).not.toHaveBeenCalled()
    await f.store.download('es'); await f.store.settled()
    expect(f.store.snapshot().packs[0].state).toBe('error')
  })
  it.each(['../model.bin', '/tmp/model.bin', 'en_es/../../secret', 'en_es/C:/secret', 'en_es\\model.bin'])('rejects unsafe archive paths: %s', name => {
    expect(() => packEntryName(name)).toThrow(/Unsafe/)
  })
  it('rejects archive symlinks and filters executable files', () => {
    expect(() => packEntryName('en_es/model/model.bin', 0xa000 << 16)).toThrow(/Unsafe/)
    expect(packEntryName('en_es/tool.exe')).toBeUndefined()
    expect(normalizeTranslationConfiguration({ provider: 'offline' })).toMatchObject({ provider: 'offline' })
    expect(() => normalizeTranslationConfiguration({ provider: 'offline', apiKey: 'unneeded' })).toThrow(/without an API key/)
  })
})
