import { describe, expect, it, vi } from 'vitest'
import { ChatCompletionError, streamChatCompletions } from '../electron/main/chat-completions'

const base = {
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-key', model: 'selected/model',
  systemPrompt: 'Use the supplied history.', userPayload: { text: 'History and selected question', imageDataUrls: ['data:image/png;base64,AAAA'] },
  signal: new AbortController().signal, allowCreditRetry: true, onDelta: vi.fn()
}
const creditError = (message = 'You requested up to 2200 tokens, but can only afford 2151.', metadata: Record<string, unknown> | undefined = { limit_source: 'openrouter_credits' }, status = 402) =>
  Response.json({ error: { code: status, message, metadata } }, { status })
const answer = () => new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n')

describe('OpenRouter chat credit recovery', () => {
  it('retries the reported 2200/2151 rejection once with headroom and unchanged context/model/images/key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(creditError()).mockResolvedValueOnce(answer())
    const onDelta = vi.fn()
    await streamChatCompletions({ ...base, fetchImpl, onDelta })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)
    const second = JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)
    expect(first.max_tokens).toBe(2200)
    expect(second).toEqual({ ...first, max_tokens: 1935 })
    expect(fetchImpl.mock.calls[1][0]).toBe(fetchImpl.mock.calls[0][0])
    expect(fetchImpl.mock.calls[1][1]!.headers).toEqual(fetchImpl.mock.calls[0][1]!.headers)
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('Answer')
  })

  it('stops after one smaller attempt and returns a safe actionable error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => creditError('Private interview sk-secret. You requested up to 2200 tokens, but can only afford 2151.'))
    const error = await streamChatCompletions({ ...base, fetchImpl }).catch(error => error)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(error).toBeInstanceOf(ChatCompletionError)
    expect(error.status).toBe(402)
    expect(error.message).toContain('Check the selected provider\'s credit settings')
    expect(JSON.stringify(error)).not.toMatch(/Private interview|sk-secret|remedy_hint/)
  })

  it('supports legacy errors without metadata and comma-separated token counts', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: 'This request requires more credits. You can only afford 2,151 tokens.' } }, { status: 402 })).mockResolvedValueOnce(answer())
    await streamChatCompletions({ ...base, fetchImpl })
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string).max_tokens).toBe(1935)
  })

  it.each(['0', '-1', '400', '2200', '99999999999999999999', '2151.5', '1500,12', '2151x', 'NaN'])('does not retry an invalid, too-small or non-reducing budget: %s', async budget => {
    const fetchImpl = vi.fn<typeof fetch>(async () => creditError(`You can only afford ${budget}.`))
    await expect(streamChatCompletions({ ...base, fetchImpl })).rejects.toBeInstanceOf(ChatCompletionError)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each(['openrouter_in_flight_budget', 'openrouter_key_limit', 'unknown_limit'])('does not reduce the budget for %s', async limit_source => {
    const fetchImpl = vi.fn<typeof fetch>(async () => creditError(undefined, { limit_source }))
    const error = await streamChatCompletions({ ...base, fetchImpl }).catch(error => error)
    expect(fetchImpl).toHaveBeenCalledOnce()
    if (limit_source === 'openrouter_in_flight_budget') expect(error.message).toContain('still processing or settling')
    if (limit_source === 'openrouter_key_limit') expect(error.message).toContain('API key spending limit')
  })

  it.each([401, 403, 429, 503])('does not budget-retry HTTP %i', async status => {
    const fetchImpl = vi.fn<typeof fetch>(async () => creditError(undefined, undefined, status))
    await expect(streamChatCompletions({ ...base, fetchImpl })).rejects.toBeInstanceOf(ChatCompletionError)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not retry unquoted credit errors or errors without JSON', async () => {
    for (const response of [creditError('Insufficient credits.'), new Response('Private error sk-secret', { status: 402 })]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => response)
      const error = await streamChatCompletions({ ...base, fetchImpl }).catch(error => error)
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(error.message).toContain('available AI credits')
      expect(error.message).not.toContain('sk-secret')
    }
  })

  it('leaves other providers on their existing single-attempt path', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => creditError())
    await expect(streamChatCompletions({ ...base, allowCreditRetry: undefined, fetchImpl })).rejects.toBeInstanceOf(ChatCompletionError)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('honors cancellation before sending the smaller attempt', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      controller.abort()
      return creditError()
    })
    await expect(streamChatCompletions({ ...base, signal: controller.signal, fetchImpl })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([false, true])('never replays an HTTP 200 credit-error stream (partial answer: %s)', async partial => {
    const encoder = new TextEncoder()
    const cancel = vi.fn()
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        if (partial) controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n\n'))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { code: 402, message: 'Private passage. You can only afford 2151.', metadata: { limit_source: 'openrouter_credits' } } })}\n\n`))
      }, cancel
    })))
    const onDelta = vi.fn()
    await expect(streamChatCompletions({ ...base, fetchImpl, onDelta })).rejects.toThrow(/available AI credits/)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    if (partial) expect(onDelta).toHaveBeenCalledExactlyOnceWith('Partial answer')
    else expect(onDelta).not.toHaveBeenCalled()
  })
})
