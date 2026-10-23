import { describe, expect, it, vi } from 'vitest'
import { runCoachWithFallback, type CoachConnection } from '../electron/main/coach-fallback'
import { ChatCompletionError, parseChatCompletionError, isCreditLimitError } from '../shared/chat-completion-error'

const connections: CoachConnection[] = ['openrouter', 'openai', 'nanogpt', 'lmstudio'].map(provider => ({ provider: provider as CoachConnection['provider'], model: `${provider}/selected-model`, apiKey: 'private-fixture-key', baseUrl: 'https://fixture.example/v1' }))
const credit = () => new ChatCompletionError(402, undefined, undefined, 'openrouter_in_flight_budget')

function setup(attempt: Parameters<typeof runCoachWithFallback>[0]['attempt']) {
  return { connections, signal: new AbortController().signal, attempt: vi.fn(attempt), onStarted: vi.fn(), onDelta: vi.fn(), onFallback: vi.fn() }
}
describe('saved-provider credit fallback', () => {
  it('switches once on the shown in-flight credit error and uses the next saved model', async () => {
    const options = setup(async (connection, delta) => { if (connection.provider === 'openrouter') throw credit(); delta('Answer from saved model') })
    await runCoachWithFallback(options)
    expect(options.attempt.mock.calls.map(([connection]) => connection.provider)).toEqual(['openrouter', 'openai'])
    expect(options.onFallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ from: 'openrouter', to: 'openai', model: 'openai/selected-model' }))
    expect(options.onDelta).toHaveBeenCalledExactlyOnceWith('Answer from saved model')
  })
  it('signals a restart before the new provider emits text, keeping provider answers separate', async () => {
    const events: string[] = []
    const options = setup(async (connection, delta) => { delta(connection.provider); if (connection.provider === 'openrouter') throw credit() })
    options.onDelta.mockImplementation(text => { events.push(text) })
    options.onFallback.mockImplementation(() => { events.push('reset') })
    await runCoachWithFallback(options)
    expect(events).toEqual(['openrouter', 'reset', 'openai'])
  })
  it('shows a clear configuration message when no alternative is saved', async () => {
    const options = setup(async () => { throw credit() }); options.connections = connections.slice(0, 1)
    await expect(runCoachWithFallback(options)).rejects.toThrow(/No other saved provider is configured/)
    expect(options.onFallback).not.toHaveBeenCalled()
    expect(options.attempt).toHaveBeenCalledOnce()
  })
  it('tries each configured alternative once even if an alternative is disconnected or misconfigured', async () => {
    const options = setup(async (connection, delta) => {
      if (connection.provider === 'openrouter') throw credit()
      if (connection.provider === 'openai') throw new ChatCompletionError(401)
      if (connection.provider === 'nanogpt') throw new Error('Network unavailable')
      delta('Local answer')
    })
    await runCoachWithFallback(options)
    expect(options.attempt).toHaveBeenCalledTimes(4)
    expect(options.onDelta).toHaveBeenCalledExactlyOnceWith('Local answer')
  })
  it('ends a failed chain without loops or exposing any provider messages', async () => {
    const options = setup(async connection => { if (connection.provider === 'openrouter') throw credit(); throw new Error('private-question private-fixture-key') })
    await expect(runCoachWithFallback(options)).rejects.toThrow('No saved provider could complete this answer. Tried OpenRouter, OpenAI, NanoGPT, LM Studio.')
    expect(options.attempt).toHaveBeenCalledTimes(4)
  })
  it.each([401, 403, 429, 500, 503])('does not switch providers for an ordinary HTTP %i failure', async status => {
    const options = setup(async () => { throw new ChatCompletionError(status) })
    await expect(runCoachWithFallback(options)).rejects.toBeInstanceOf(ChatCompletionError)
    expect(options.attempt).toHaveBeenCalledOnce()
  })
  it('honors Stop between provider attempts', async () => {
    const controller = new AbortController(), options = setup(async () => { throw credit() })
    options.signal = controller.signal; options.onFallback.mockImplementation(() => { controller.abort() })
    await expect(runCoachWithFallback(options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(options.attempt).toHaveBeenCalledOnce()
  })
  it('does not start a request after cancellation and ignores late deltas', async () => {
    const controller = new AbortController(), options = setup(async (_connection, delta) => { controller.abort(); delta('Late private text') })
    options.signal = controller.signal
    await expect(runCoachWithFallback(options)).rejects.toMatchObject({ name: 'AbortError' })
    expect(options.onDelta).not.toHaveBeenCalled(); expect(options.onFallback).not.toHaveBeenCalled()
  })
  it.each(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'billing_hard_limit_reached'])('recognizes OpenAI billing code %s without exposing raw errors', code => {
    const error = parseChatCompletionError(429, { error: { code, message: 'Private question and key' } })
    expect(isCreditLimitError(error)).toBe(true)
    expect(error.message).not.toMatch(/Private question|key$/)
  })
  it('recognizes legacy quota type and OpenRouter 403 key limits', () => {
    expect(isCreditLimitError(parseChatCompletionError(429, { error: { type: 'insufficient_quota' } }))).toBe(true)
    expect(isCreditLimitError(parseChatCompletionError(403, { error: { metadata: { limit_source: 'openrouter_key_limit' } } }))).toBe(true)
    expect(isCreditLimitError(parseChatCompletionError(429, { error: { code: 'slow_down', type: 'rate_limit_error' } }))).toBe(false)
  })
  it('deduplicates and bounds the provider chain', async () => {
    const options = setup(async () => { throw credit() }); options.connections = [...connections, ...connections]
    await expect(runCoachWithFallback(options)).rejects.toThrow(/No saved provider could complete/)
    expect(options.attempt).toHaveBeenCalledTimes(4)
  })
})
