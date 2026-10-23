import { createChatDeltaParser } from '../../shared/sse'
import { ChatCompletionError, parseChatCompletionError } from '../../shared/chat-completion-error'
export { ChatCompletionError } from '../../shared/chat-completion-error'

export interface ChatCompletionsParams {
  baseUrl: string
  apiKey: string | null
  model: string
  fetchImpl: typeof fetch
  systemPrompt: string
  userPayload: { text: string; imageDataUrls?: string[] }
  signal: AbortSignal
  onDelta: (delta: string) => void
  /** Only the explicitly selected OpenRouter chat connection may reduce its output budget. */
  allowCreditRetry?: boolean
}

interface ChatCompletionsBody {
  model: string
  stream: boolean
  max_tokens: number
  messages: Array<{ role: 'system' | 'user'; content: string | Array<Record<string, unknown>> }>
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>
}

async function completionError(response: Response): Promise<ChatCompletionError> {
  const data = await response.json().catch(() => null)
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : NaN
  const delay = Number.isFinite(seconds) ? seconds : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
  return parseChatCompletionError(response.status, data, Number.isFinite(delay) ? Math.max(0, delay) : undefined)
}

function buildRequest(params: ChatCompletionsParams, maxTokens: number): { url: string; init: RequestInit } {
  const content = params.userPayload.imageDataUrls?.length
    ? [
        { type: 'text', text: params.userPayload.text },
        ...params.userPayload.imageDataUrls.map(url => ({ type: 'image_url', image_url: { url } }))
      ]
    : params.userPayload.text
  const body: ChatCompletionsBody = {
    model: params.model,
    stream: true,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content }
    ]
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`
  return {
    url: `${params.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: params.signal
    }
  }
}

/** Streams a chat/completions response, forwarding answer deltas as they arrive. */
export async function streamChatCompletions(params: ChatCompletionsParams): Promise<void> {
  const maxTokens = 2_200
  const { url, init } = buildRequest(params, maxTokens)
  let response = await params.fetchImpl(url, init)
  if (!response.ok) {
    const error = await completionError(response)
    // A rejected HTTP request has not started an answer. Retry just once, with
    // the identical prompt/model/images and 10% headroom below its quoted budget.
    // Never replay an HTTP 200 stream or a partially generated answer.
    const reducedTokens = Math.floor((error.affordableTokens ?? 0) * 0.9)
    if (!params.allowCreditRetry || error.status !== 402 || !error.affordableTokens || error.affordableTokens >= maxTokens || reducedTokens < 512) throw error
    params.signal.throwIfAborted()
    response = await params.fetchImpl(url, buildRequest(params, reducedTokens).init)
  }
  if (!response.ok) {
    throw await completionError(response)
  }
  if (!response.body) throw new Error('The AI service returned an empty stream.')

  const parser = createChatDeltaParser()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let sawDelta = false
  let finished = false
  try {
    for (;;) {
      if (params.signal.aborted) {
        throw new DOMException('Cancelled', 'AbortError')
      }
      const { done, value } = await reader.read()
      if (done) break
      for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
        sawDelta = true
        params.onDelta(delta)
      }
    }
    for (const delta of parser.push(decoder.decode())) { sawDelta = true; params.onDelta(delta) }
    if (!sawDelta) throw new Error('The AI service returned an empty response.')
    finished = true
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export interface ChatCompletionParams {
  baseUrl: string
  apiKey: string | null
  model: string
  fetchImpl: typeof fetch
  systemPrompt: string
  userText: string
  maxTokens?: number
  signal: AbortSignal
}

/** Non-streaming chat/completions call used for background work such as company analysis. */
export async function fetchChatCompletion(params: ChatCompletionParams): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (params.apiKey) headers.Authorization = `Bearer ${params.apiKey}`
  const response = await params.fetchImpl(`${params.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      stream: false,
      max_tokens: params.maxTokens ?? 900,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userText }
      ]
    }),
    signal: params.signal
  })
  if (!response.ok) {
    throw await completionError(response)
  }
  const data = (await response.json().catch(() => ({}))) as ChatCompletionResponse
  if (data.choices?.[0]?.finish_reason === 'length') throw new ChatCompletionError(200, 'truncated_response')
  if (data.choices?.[0]?.finish_reason === 'content_filter') throw new ChatCompletionError(200, 'content_policy_violation')
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new ChatCompletionError(200, 'empty_response')
  }
  return content.trim()
}
