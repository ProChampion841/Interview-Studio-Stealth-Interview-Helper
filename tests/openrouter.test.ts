import { describe, expect, it, vi } from 'vitest'
import { fetchChatCompletion, streamChatCompletions } from '../electron/main/chat-completions'

const base = {
  baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-key', model: 'openai/gpt-4.1-mini',
  systemPrompt: 'Answer the interview question.', signal: new AbortController().signal
}

describe('OpenRouter compatible requests', () => {
  it('streams text with bearer authentication and every selected screenshot', async () => {
    const attachments = Array.from({ length: 12 }, () => 'data:image/png;base64,AAAA')
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n'))
    const onDelta = vi.fn()
    await streamChatCompletions({ ...base, fetchImpl, userPayload: { text: 'Compare.', imageDataUrls: attachments }, onDelta })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key')
    const body = JSON.parse(init!.body as string)
    expect(body.model).toBe(base.model)
    expect(body.stream).toBe(true)
    expect(body.messages[1].content.slice(1).map((part: { image_url: { url: string } }) => part.image_url.url)).toEqual(attachments)
    expect(onDelta).toHaveBeenCalledWith('Answer')
  })

  it('rejects streaming errors and cancels the reader even after a partial answer', async () => {
    const cancel = vi.fn()
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"error":{"code":502,"message":"Upstream provider failed"}}\n\n'))
      }, cancel
    })
    const fetchImpl: typeof fetch = async () => new Response(stream)
    const onDelta = vi.fn()
    await expect(streamChatCompletions({ ...base, fetchImpl, userPayload: { text: 'Explain.' }, onDelta })).rejects.toThrow(/HTTP 502/)
    expect(onDelta).toHaveBeenCalledWith('Partial')
    expect(cancel).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
  })

  it('uses the selected OpenRouter model for non-streaming company analysis', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'Company briefing' } }] }))
    expect(await fetchChatCompletion({ ...base, fetchImpl, userText: 'Summarize this company.' })).toBe('Company briefing')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key')
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: base.model, stream: false })
  })
})
