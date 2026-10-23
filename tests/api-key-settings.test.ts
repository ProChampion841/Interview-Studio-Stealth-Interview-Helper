import { describe, expect, it } from 'vitest'
import { resolveApiKey } from '../shared/api-key-settings'

describe('API key source selection', () => {
  it('uses a memory-only manual key before saved and environment keys', () => {
    expect(resolveApiKey({
      memory: 'manual-memory-key',
      stored: 'manual-saved-key',
      environment: 'environment-key'
    })).toEqual({ value: 'manual-memory-key', source: 'memory' })
  })

  it('uses an encrypted saved manual key before the environment fallback', () => {
    expect(resolveApiKey({
      stored: 'manual-saved-key',
      environment: 'environment-key'
    })).toEqual({ value: 'manual-saved-key', source: 'secure-storage' })
  })

  it('falls back to the environment only when no manual key exists', () => {
    expect(resolveApiKey({ environment: '  environment-key  ' }))
      .toEqual({ value: 'environment-key', source: 'environment' })
  })

  it('reports no key when every source is empty', () => {
    expect(resolveApiKey({ memory: ' ', stored: '', environment: undefined }))
      .toEqual({ value: '', source: 'none' })
  })
})
