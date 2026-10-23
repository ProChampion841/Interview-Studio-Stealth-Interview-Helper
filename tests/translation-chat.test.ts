import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCompletionError, fetchChatCompletion } from '../electron/main/chat-completions'
import { CaptionTranslations, translationErrorMessage, translationFailure } from '../electron/main/caption-translations'

afterEach(() => vi.useRealTimers())
const request = { sessionId: 'session-1', requestId: 'request-1', text: 'Hello.', language: 'es' }
const input = { baseUrl: 'https://nano-gpt.com/api/v1', apiKey: 'private-key', model: 'openai/gpt-4.1-nano', systemPrompt: 'Translate into Spanish.', userText: 'private-caption', maxTokens: 2000, signal: new AbortController().signal }

describe('NanoGPT translation completions', () => {
  it('sends the configured text model and extracts the translation', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ message: { content: ' Hola. ' }, finish_reason: 'stop' }] }))
    expect(await fetchChatCompletion({ ...input, fetchImpl })).toBe('Hola.')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://nano-gpt.com/api/v1/chat/completions')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer private-key' })
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: input.model, stream: false, max_tokens: 2000, messages: [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.userText }] })
  })
  it.each([400, 401, 402, 403, 404, 429, 503])('preserves HTTP %i without exposing upstream bodies', async status => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'model_not_found', message: 'private-key private-caption' } }, { status, headers: { 'Retry-After': '2' } }))
    const error = await fetchChatCompletion({ ...input, fetchImpl }).catch(error => error)
    expect(error).toBeInstanceOf(ChatCompletionError)
    expect(error).toMatchObject({ status, code: 'model_not_found', retryAfterMs: 2000 })
    expect(JSON.stringify(error) + error.message + translationErrorMessage(status, error.code)).not.toMatch(/private-key|private-caption/)
  })
  it('discards unknown codes and classifies legacy model errors without exposing text', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'private-key', message: 'Model private-caption does not exist' } }, { status: 400 }))
    await expect(fetchChatCompletion({ ...input, fetchImpl })).rejects.toMatchObject({ code: 'model_not_found', status: 400 })
  })
  it.each([
    [{ choices: [{ message: { content: null, reasoning_content: 'hidden reasoning' }, finish_reason: 'stop' }] }, 'empty_response'],
    [{ choices: [{ message: { content: 'unfinished' }, finish_reason: 'length' }] }, 'truncated_response'],
    [{ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 'content_policy_violation']
  ])('does not show empty, truncated, or filtered output as a successful translation', async (data, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data))
    await expect(fetchChatCompletion({ ...input, fetchImpl })).rejects.toMatchObject({ status: 200, code })
    expect(translationErrorMessage(200, code as string)).not.toMatch(/Check Caption translation in Settings and retry/)
  })
  it('explains network failures without revealing connection details', () => {
    const details = translationFailure(new Error('net::ERR_CONNECTION_RESET private-key private-caption'))
    expect(details).toMatchObject({ status: 0, code: 'network_error' })
    expect(translationErrorMessage(details.status, details.code)).toMatch(/internet connection and proxy/)
  })
})

describe('temporary live translation failures', () => {
  it.each([
    Response.json({ error: { code: 'content_policy_violation', message: 'private-caption private-key' } }, { status: 400 }),
    Response.json({ choices: [{ message: { content: 'partial private-caption' }, finish_reason: 'content_filter' }] })
  ])('returns a skipped passage for content rejection without throwing, retrying, or leaking partial output', async response => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    const translate = () => fetchChatCompletion({ ...input, fetchImpl })
    const service = new CaptionTranslations({ allowed: () => true, connection: () => translate })
    await expect(service.translate(1, request)).resolves.toEqual({ text: '', skipped: 'content_filter' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('leaves the other source running when a passage is declined', async () => {
    let complete!: (text: string) => void
    const translate = vi.fn().mockRejectedValueOnce(new ChatCompletionError(400, 'content_policy_violation'))
      .mockImplementationOnce(() => new Promise<string>(resolve => { complete = resolve }))
    const service = new CaptionTranslations({ allowed: () => true, connection: () => translate })
    const first = service.translate(1, request)
    const second = service.translate(1, { ...request, requestId: 'other-source' })
    await expect(first).resolves.toMatchObject({ skipped: 'content_filter' })
    complete('Other source translated.')
    await expect(second).resolves.toEqual({ text: 'Other source translated.' })
  })
  it('treats an SDK content-filter error as skipped but cancels a late decline after Stop', async () => {
    const translate = vi.fn().mockRejectedValue(Object.assign(new Error('private-key private-caption'), { status: 400, code: 'content_filter' }))
    let allowed = true
    const service = new CaptionTranslations({ allowed: () => allowed, connection: () => translate })
    await expect(service.translate(1, request)).resolves.toEqual({ text: '', skipped: 'content_filter' })
    const pending = service.translate(1, request)
    allowed = false
    await expect(pending).resolves.toEqual({ text: '', cancelled: true })
  })
  it('retries a temporary service failure once within the same caption request', async () => {
    vi.useFakeTimers()
    const translate = vi.fn().mockRejectedValueOnce(new ChatCompletionError(503)).mockResolvedValue('Hola.')
    const service = new CaptionTranslations({ allowed: () => true, connection: () => translate })
    const pending = service.translate(1, request)
    await vi.advanceTimersByTimeAsync(999); expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ text: 'Hola.' })
    expect(translate).toHaveBeenCalledTimes(2)
  })
  it('honors short retry-after and reports a repeated failure without further retries', async () => {
    vi.useFakeTimers()
    const translate = vi.fn().mockRejectedValue(new ChatCompletionError(429, 'rate_limit_exceeded', 2000))
    const service = new CaptionTranslations({ allowed: () => true, connection: () => translate })
    const rejected = expect(service.translate(1, request)).rejects.toThrow(/quota or request limit/)
    await vi.advanceTimersByTimeAsync(1999); expect(translate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); await rejected
    expect(translate).toHaveBeenCalledTimes(2)
  })
  it.each([new ChatCompletionError(401), new ChatCompletionError(400, 'model_not_found'), new ChatCompletionError(429, 'daily_rpd_limit_exceeded'), new ChatCompletionError(429, undefined, 60000), new ChatCompletionError(200, 'empty_response')])('does not retry credentials, model, daily quota, long waits, or empty output', async error => {
    const translate = vi.fn().mockRejectedValue(error)
    const service = new CaptionTranslations({ allowed: () => true, connection: () => translate })
    await expect(service.translate(1, request)).rejects.toThrow()
    expect(translate).toHaveBeenCalledOnce()
  })
  it('cancels immediately during backoff without another provider call', async () => {
    vi.useFakeTimers()
    const translate = vi.fn().mockRejectedValue(new ChatCompletionError(503))
    const service = new CaptionTranslations({ allowed: () => true, connection: () => translate })
    const pending = service.translate(1, request)
    await vi.advanceTimersByTimeAsync(100); service.cancel(1)
    await expect(pending).resolves.toMatchObject({ cancelled: true })
    await vi.advanceTimersByTimeAsync(2000); expect(translate).toHaveBeenCalledOnce()
  })
})
