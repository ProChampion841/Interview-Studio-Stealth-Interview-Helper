import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflineModelStore, OFFLINE_MODEL_FILES } from '../electron/main/offline-models'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture(names = ['encoder.onnx', 'decoder.onnx']) {
  const directory = await mkdtemp(join(tmpdir(), 'interview-offline-models-'))
  directories.push(directory)
  const bytes = new TextEncoder().encode('fixture model, never loaded into native code')
  const files = names.map(name => ({ name, url: `https://fixture.example/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(bytes))
  const onStatus = vi.fn()
  const store = new OfflineModelStore({ directory: () => directory, fetch: fetchImpl, onStatus, files })
  return { store, directory, bytes, files, fetchImpl, onStatus }
}

describe('offline model installation', () => {
  it('does not fetch until requested, verifies files, reports progress, and recognizes them after restart', async () => {
    const f = await fixture()
    expect((await f.store.check()).state).toBe('missing')
    expect(f.fetchImpl).not.toHaveBeenCalled()
    expect(() => f.store.paths()).toThrow(/Download the offline models/)
    expect((await f.store.download()).state).toBe('downloading')
    await f.store.settled()
    expect(f.store.snapshot()).toMatchObject({ state: 'ready', downloadedBytes: f.bytes.length * 2, totalBytes: f.bytes.length * 2 })
    expect(await readFile(join(f.directory, 'encoder.onnx'))).toEqual(Buffer.from(f.bytes))
    expect(f.store.paths().encoder).toBe(join(f.directory, 'encoder.onnx'))
    const restart = new OfflineModelStore({ directory: () => f.directory, files: f.files, fetch: f.fetchImpl, onStatus: vi.fn() })
    expect((await restart.check()).state).toBe('ready')
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(f.onStatus.mock.calls.some(([status]) => status.state === 'downloading' && status.downloadedBytes > 0)).toBe(true)
  })
  it('refuses truncated or wrong-hash downloads and removes partial files', async () => {
    const f = await fixture()
    f.fetchImpl.mockResolvedValueOnce(new Response(new Uint8Array(f.bytes.length).fill(1)))
    await f.store.download(); await f.store.settled()
    expect(f.store.snapshot()).toMatchObject({ state: 'error', message: 'Model verification failed. Retry the download.' })
    expect(await readdir(f.directory)).toEqual([])
    f.fetchImpl.mockResolvedValueOnce(new Response(f.bytes.slice(0, 5)))
    await f.store.download(); await f.store.settled()
    expect(f.store.snapshot().state).toBe('error')
    expect(await readdir(f.directory)).toEqual([])
    await f.store.download(); await f.store.settled()
    expect(f.store.snapshot().state).toBe('ready')
  })
  it('skips verified models but replaces damaged models of the correct size', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, f.files[0].name), f.bytes)
    await writeFile(join(f.directory, f.files[1].name), new Uint8Array(f.bytes.length))
    expect((await f.store.check()).downloadedBytes).toBe(f.bytes.length)
    await f.store.download(); await f.store.settled()
    expect(f.fetchImpl).toHaveBeenCalledOnce()
    expect(f.fetchImpl.mock.calls[0][0]).toBe(f.files[1].url)
    expect(f.store.snapshot().state).toBe('ready')
  })
  it('cancels an in-flight download and permits a clean retry without duplicate requests', async () => {
    const f = await fixture()
    f.fetchImpl.mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Canceled', 'AbortError')), { once: true }) }
    })))
    await f.store.download()
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce())
    await f.store.download()
    expect(f.fetchImpl).toHaveBeenCalledOnce()
    f.store.cancel(); await f.store.settled()
    expect(f.store.snapshot().state).toBe('missing')
    expect(await readdir(f.directory)).toEqual([])
    await f.store.download(); await f.store.settled()
    expect(f.store.snapshot().state).toBe('ready')
  })
})

describe('caption-only model pack', () => {
  it('requires recognition and punctuation without loading legacy speaker models', async () => {
    expect(OFFLINE_MODEL_FILES.map(file => file.name)).toEqual(['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt', 'punctuation.onnx', 'punctuation.vocab'])
    const f = await fixture()
    for (const file of f.files) await writeFile(join(f.directory, file.name), f.bytes)
    await writeFile(join(f.directory, 'segmentation.onnx'), 'unused legacy file')
    await writeFile(join(f.directory, 'embedding.onnx'), 'unused legacy file')
    expect((await f.store.check()).state).toBe('ready')
    expect(Object.keys(f.store.paths())).toEqual(['encoder', 'decoder', 'joiner', 'tokens', 'punctuation', 'punctuationVocab'])
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('upgrades an installed recognizer by downloading only the punctuation files', async () => {
    const f = await fixture(OFFLINE_MODEL_FILES.map(file => file.name))
    for (const file of f.files.slice(0, 4)) await writeFile(join(f.directory, file.name), f.bytes)
    expect(await f.store.check()).toMatchObject({ state: 'missing', downloadedBytes: f.bytes.length * 4, message: expect.stringContaining('add punctuation') })
    expect(f.fetchImpl).not.toHaveBeenCalled()
    await f.store.download(); await f.store.settled()
    expect(f.fetchImpl.mock.calls.map(([url]) => url)).toEqual(f.files.slice(4).map(file => file.url))
    expect(f.store.snapshot().state).toBe('ready')
  })
})
