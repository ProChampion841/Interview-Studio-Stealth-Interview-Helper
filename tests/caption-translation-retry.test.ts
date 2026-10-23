import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionTranslations } from '../electron/main/caption-translations'
import { ChatCompletionError } from '../electron/main/chat-completions'
import { parseTranslationRetryRequest } from '../shared/caption-translation'

afterEach(() => vi.useRealTimers())
const request = { requestId: 'retry-1', text: 'Explain the transaction design.', language: 'ko' }
function fixture() {
  const online = vi.fn(async (_text: string, _language: string, _signal: AbortSignal) => 'Online translation')
  const offline = vi.fn(async (_text: string, _language: string, _signal: AbortSignal) => ({ text: 'Offline translation' }))
  const service = new CaptionTranslations({ allowed: () => false, connection: () => online, offlineFallback: offline })
  return { service, online, offline }
}
describe('explicit passage retry with offline fallback', () => {
  it('validates text and language without requiring or accepting a live capture session', () => {
    expect(parseTranslationRetryRequest(request)).toEqual(request)
    for (const bad of [null, {}, { ...request, text: '' }, { ...request, language: 'fake' }, { ...request, text: 'a'.repeat(6001) }, { ...request, requestId: '../outside' }]) expect(() => parseTranslationRetryRequest(bad)).toThrow()
  })
  it('retries the selected provider once on saved captions and avoids offline work on success', async () => {
    const f = fixture()
    await expect(f.service.retry(1, request)).resolves.toEqual({ text: 'Online translation' })
    expect(f.online).toHaveBeenCalledOnce(); expect(f.offline).not.toHaveBeenCalled()
  })
  it.each([new ChatCompletionError(400, 'content_policy_violation'), new ChatCompletionError(503), new Error('private-key private-caption')])('falls back once after a declined or failed provider attempt', async error => {
    const f = fixture(); f.online.mockRejectedValue(error)
    await expect(f.service.retry(1, request)).resolves.toEqual({ text: 'Offline translation', via: 'offline' })
    expect(f.online).toHaveBeenCalledOnce(); expect(f.offline).toHaveBeenCalledExactlyOnceWith(request.text, 'ko', expect.any(AbortSignal))
  })
  it('uses offline translation if provider configuration cannot resolve a connection', async () => {
    const offline = vi.fn(async () => ({ text: 'Local result' }))
    const service = new CaptionTranslations({ allowed: () => false, connection: () => { throw new Error('No provider key') }, offlineFallback: offline })
    await expect(service.retry(1, request)).resolves.toEqual({ text: 'Local result', via: 'offline' })
  })
  it('reports a missing or unsupported pack without exposing an upstream error body', async () => {
    for (const offlineIssue of ['missing_pack', 'unsupported_language', 'unsupported_source'] as const) {
      const service = new CaptionTranslations({ allowed: () => false, connection: () => async () => { throw new Error('private-key private-caption') }, offlineFallback: async () => ({ text: '', offlineIssue }) })
      const result = await service.retry(1, request)
      expect(result).toMatchObject({ text: '', offlineIssue }); expect(result.retryError).toBeTruthy()
      expect(JSON.stringify(result)).not.toMatch(/private-key|private-caption/)
    }
  })
  it('gives offline translation a fresh signal after the online stage times out', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.online.mockImplementation((_text, _language, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    const pending = f.service.retry(1, request)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(pending).resolves.toMatchObject({ text: 'Offline translation', via: 'offline' })
    expect(f.online.mock.calls[0][2].aborted).toBe(true); expect(f.offline.mock.calls[0][2].aborted).toBe(false)
  })
  it('cancellation wins before fallback and cancels a late offline result', async () => {
    const f = fixture(); let resolve!: (text: string) => void
    f.online.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = f.service.retry(1, request); f.service.cancel(1); resolve('Late')
    await expect(pending).resolves.toMatchObject({ cancelled: true }); expect(f.offline).not.toHaveBeenCalled()
    f.online.mockRejectedValue(new Error('Unavailable'))
    let finish!: (result: { text: string }) => void
    f.offline.mockImplementation(() => new Promise(done => { finish = done }))
    const local = f.service.retry(1, request)
    for (let n = 0; n < 6; n++) await Promise.resolve()
    f.service.cancel(1); finish({ text: 'Late local result' })
    await expect(local).resolves.toMatchObject({ cancelled: true })
  })
  it('shares duplicate and concurrency protection with automatic translation', async () => {
    const f = fixture(), completions: Array<(text: string) => void> = []
    f.online.mockImplementation(() => new Promise(done => completions.push(done)))
    const first = f.service.retry(1, request)
    await expect(f.service.retry(1, request)).rejects.toThrow(/Wait/)
    const second = f.service.retry(1, { ...request, requestId: 'second' })
    await expect(f.service.retry(1, { ...request, requestId: 'third' })).rejects.toThrow(/Wait/)
    completions.forEach(done => done('Done')); await Promise.all([first, second])
    expect(f.online).toHaveBeenCalledTimes(2)
  })
  it('bounds offline failure and does not automatically fall back for live skipped captions', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.online.mockRejectedValue(new ChatCompletionError(400, 'content_policy_violation'))
    f.offline.mockImplementation((_text, _language, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    const pending = f.service.retry(1, request)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toMatchObject({ offlineIssue: 'failed', retryError: expect.any(String) })
    const offline = vi.fn(async () => ({ text: 'Should not run' }))
    const auto = new CaptionTranslations({ allowed: () => true, connection: () => f.online, offlineFallback: offline })
    await expect(auto.translate(1, { ...request, sessionId: 'active' })).resolves.toMatchObject({ skipped: 'content_filter' })
    expect(offline).not.toHaveBeenCalled()
  })
})
