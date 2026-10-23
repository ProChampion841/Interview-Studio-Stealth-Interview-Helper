import { describe, expect, it } from 'vitest'
import { createChatDeltaParser } from '../shared/sse'

const delta = (content: string): string => JSON.stringify({ choices: [{ delta: { content } }], index: 0 })

describe('chat/completions SSE parser', () => {
  it('extracts delta content from a complete chunk', () => {
    const parser = createChatDeltaParser()
    const deltas = parser.push(`data: ${delta('Hello')} \n\ndata: ${delta(' world')}\n\ndata: [DONE]\n\n`)
    expect(deltas).toEqual(['Hello', ' world'])
  })

  it('tolerates chunks split mid-line', () => {
    const parser = createChatDeltaParser()
    const first = parser.push('data: {"choices":[{"delta":{"content":"Hel')
    const second = parser.push(`lo"}}]}\n\ndata: ${delta(' there')}\n`)
    expect(first).toEqual([])
    expect([...second]).toEqual(['Hello', ' there'])
  })

  it('handles CRLF line endings and blank data lines', () => {
    const parser = createChatDeltaParser()
    const deltas = parser.push(`\r\ndata: ${delta('a')}\r\n\r\ndata:\r\ndata: ${delta('b')}\r\n`)
    expect(deltas).toEqual(['a', 'b'])
  })

  it('ignores malformed JSON and reasoning-only deltas', () => {
    const parser = createChatDeltaParser()
    const deltas = parser.push(`data: {not json}\n\ndata: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\n\ndata: ${delta('ok')}\n`)
    expect(deltas).toEqual(['ok'])
  })

  it('carries state across chunk boundaries with partial CRLF', () => {
    const parser = createChatDeltaParser()
    const first = parser.push(`data: ${delta('x')}\r`)
    const second = parser.push(`\ndata: ${delta('y')}\r\n`)
    expect(first).toEqual([])
    expect(second).toEqual(['x', 'y'])
  })

  it('surfaces OpenRouter errors returned inside HTTP 200 streams', () => {
    const parser = createChatDeltaParser()
    expect(() => parser.push('data: {"error":{"code":402,"message":"Insufficient credits"}}\n\n')).toThrow(/available AI credits/)
  })

  it('does not treat a mid-stream provider failure as a completed answer', () => {
    const parser = createChatDeltaParser()
    expect(parser.push(`: OPENROUTER PROCESSING\n\ndata: ${delta('Partial answer')}\n\n`)).toEqual(['Partial answer'])
    expect(() => parser.push('data: {"error":{"message":"Provider disconnected"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n')).toThrow(/could not finish/)
  })

  it('does not display private upstream error messages or metadata', () => {
    const parser = createChatDeltaParser()
    expect(() => parser.push(`data: ${JSON.stringify({ error: { code: 502, message: 'Private interview passage sk-secret', metadata: { raw: 'Private transcript' } } })}\n\n`)).toThrow('The AI service returned HTTP 502.')
  })
})
