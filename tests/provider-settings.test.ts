import { describe, expect, it } from 'vitest'
import { normalizeProviderBaseUrl, normalizeProviderModel } from '../shared/connection-settings'

describe('provider model normalization', () => {
  it('accepts provider-prefixed and local model identifiers', () => {
    expect(normalizeProviderModel('openai/gpt-6.1-sol')).toBe('openai/gpt-6.1-sol')
    expect(normalizeProviderModel(' qwen2.5-7b-instruct ')).toBe('qwen2.5-7b-instruct')
    expect(normalizeProviderModel('meta-llama/llama-3.1:8b')).toBe('meta-llama/llama-3.1:8b')
    expect(normalizeProviderModel('openrouter/auto')).toBe('openrouter/auto')
    expect(normalizeProviderModel('openai/gpt-4.1-mini:free')).toBe('openai/gpt-4.1-mini:free')
  })

  it('rejects empty, oversized, or malicious model identifiers', () => {
    expect(() => normalizeProviderModel('')).toThrow(/model identifier/i)
    expect(() => normalizeProviderModel('   ')).toThrow(/model identifier/i)
    expect(() => normalizeProviderModel('a'.repeat(121))).toThrow(/120 characters or fewer/)
    expect(() => normalizeProviderModel('model\nmalicious')).toThrow(/unsupported characters/)
    expect(() => normalizeProviderModel('model<script>alert(1)</script>')).toThrow(/unsupported characters/)
  })
})

describe('provider base URL normalization', () => {
  it('keeps https URLs and trims trailing slashes', () => {
    expect(normalizeProviderBaseUrl('https://nano-gpt.com/api/v1/', false)).toBe('https://nano-gpt.com/api/v1')
    expect(normalizeProviderBaseUrl('https://nano-gpt.com/api/v1', false)).toBe('https://nano-gpt.com/api/v1')
    expect(normalizeProviderBaseUrl('https://openrouter.ai/api/v1/', false)).toBe('https://openrouter.ai/api/v1')
  })

  it('allows plain http only when the provider is local', () => {
    expect(normalizeProviderBaseUrl('http://localhost:1234/v1', true)).toBe('http://localhost:1234/v1')
    expect(() => normalizeProviderBaseUrl('http://localhost:1234/v1', false)).toThrow(/https/)
    expect(() => normalizeProviderBaseUrl('ftp://localhost:1234/v1', true)).toThrow(/http/)
  })

  it('rejects credentials, malformed URLs, and oversized values', () => {
    expect(() => normalizeProviderBaseUrl('https://user:pass@nano-gpt.com/api/v1', false)).toThrow(/credentials/)
    expect(() => normalizeProviderBaseUrl('not a url', false)).toThrow(/valid base URL/)
    expect(() => normalizeProviderBaseUrl('', false)).toThrow(/base URL/)
    expect(() => normalizeProviderBaseUrl(`https://example.com/${'a'.repeat(320)}`, false)).toThrow(/base URL/)
  })
})
