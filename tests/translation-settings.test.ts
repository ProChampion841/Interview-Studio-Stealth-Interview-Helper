import { describe, expect, it, vi } from 'vitest'
import { TranslationSettingsStore, readTranslationSettings, type StoredTranslationSettings } from '../electron/main/translation-settings'
import { normalizeTranslationConfiguration } from '../shared/translation-settings'

function fixture(secure = true) {
  let stored: StoredTranslationSettings = {}
  const write = vi.fn((next: StoredTranslationSettings) => { stored = structuredClone(next) })
  const options = { read: () => stored, write, available: () => secure, encrypt: (key: string) => Buffer.from(key).toString('base64'), decrypt: (value: string) => Buffer.from(value, 'base64').toString() }
  return { store: new TranslationSettingsStore(options), options, write, saved: () => stored }
}
describe('translation credentials and settings', () => {
  it.each(['openai', 'openrouter', 'nanogpt'] as const)('persists a separate %s translation key and model across switching and reload', provider => {
    const f = fixture()
    f.store.configure({ provider, apiKey: `private-${provider}`, model: 'custom/model:free' })
    f.store.configure({ provider: 'azure', apiKey: 'other-key', region: 'eastus' })
    const reloaded = new TranslationSettingsStore({ ...f.options, read: () => readTranslationSettings(f.saved()) })
    expect(reloaded.key(provider)).toBe(`private-${provider}`)
    expect(reloaded.public()[provider]).toMatchObject({ configured: true, model: 'custom/model:free', persistence: 'secure-storage' })
    reloaded.configure({ provider, model: 'replacement-model' })
    expect(reloaded.key(provider)).toBe(`private-${provider}`)
    expect(reloaded.public()[provider].model).toBe('replacement-model')
    reloaded.configure({ provider, clearKey: true })
    expect(reloaded.public()[provider]).toMatchObject({ configured: false, model: 'replacement-model' })
    expect(reloaded.key('azure')).toBe('other-key')
    expect(JSON.stringify(f.saved())).not.toContain(`private-${provider}`)
    expect(JSON.stringify(reloaded.public())).not.toContain(`private-${provider}`)
  })
  it('isolates keys and models for all three model providers', () => {
    const f = fixture()
    for (const provider of ['openai', 'openrouter', 'nanogpt'] as const) f.store.configure({ provider, apiKey: `key-${provider}`, model: `model-${provider}` })
    for (const provider of ['openai', 'openrouter', 'nanogpt'] as const) {
      expect(f.store.key(provider)).toBe(`key-${provider}`)
      expect(f.store.public()[provider].model).toBe(`model-${provider}`)
    }
    f.store.configure({ provider: 'chat' })
    expect(f.store.public().provider).toBe('chat')
    expect(f.store.key('openrouter')).toBe('key-openrouter')
  })
  it('encrypts independent keys, reloads them, and never exposes plaintext in public settings', () => {
    const f = fixture()
    f.store.configure({ provider: 'azure', apiKey: 'azure-private-key', region: ' EastUS ' })
    f.store.configure({ provider: 'google', apiKey: 'google-private-key' })
    expect(JSON.stringify(f.saved())).not.toContain('private-key')
    const reloaded = new TranslationSettingsStore(f.options)
    expect(reloaded.key('azure')).toBe('azure-private-key')
    expect(reloaded.key('google')).toBe('google-private-key')
    expect(reloaded.public()).toMatchObject({ provider: 'google', azure: { configured: true, region: 'eastus', persistence: 'secure-storage' }, google: { configured: true } })
    expect(JSON.stringify(reloaded.public())).not.toContain('private-key')
  })
  it('holds keys only in memory if encryption is unavailable', () => {
    const f = fixture(false)
    f.store.configure({ provider: 'azure', apiKey: 'memory-key' })
    expect(f.store.key('azure')).toBe('memory-key')
    expect(f.store.public().azure.persistence).toBe('memory')
    expect(JSON.stringify(f.saved())).not.toContain('memory-key')
    expect(new TranslationSettingsStore(f.options).key('azure')).toBe('')
  })
  it('keeps the saved key when saving a region, and removes only the selected key', () => {
    const f = fixture()
    f.store.configure({ provider: 'azure', apiKey: 'azure-key', region: 'eastus' })
    f.store.configure({ provider: 'google', apiKey: 'google-key' })
    f.store.configure({ provider: 'azure', region: 'westus2', apiKey: '' })
    expect(f.store.key('azure')).toBe('azure-key')
    f.store.configure({ provider: 'azure', clearKey: true })
    expect(f.store.key('azure')).toBe('')
    expect(f.saved().azure?.encryptedApiKey).toBeUndefined()
    expect(f.store.key('google')).toBe('google-key')
    expect(f.store.public().revision).toBe(4)
  })
  it('does not replace active credentials after a disk-write failure', () => {
    const f = fixture(false)
    f.store.configure({ provider: 'google', apiKey: 'original' })
    f.write.mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => f.store.configure({ provider: 'google', apiKey: 'replacement' })).toThrow('disk full')
    expect(f.store.key('google')).toBe('original')
    expect(f.store.public().revision).toBe(1)
  })
  it('ignores undecryptable stored credentials and malformed persisted fields', () => {
    const raw = { provider: 'untrusted', azure: { encryptedApiKey: 'ciphertext', region: 'https://evil.example', apiKey: 'plaintext' }, google: 'bad', endpoint: 'https://evil.example' }
    expect(readTranslationSettings(raw)).toEqual({ azure: { encryptedApiKey: 'ciphertext' } })
    const f = fixture()
    f.options.read = () => readTranslationSettings(raw)
    f.options.decrypt = () => { throw new Error('not this user') }
    expect(new TranslationSettingsStore(f.options).public().azure.configured).toBe(false)
  })
  it.each([
    { provider: 'unknown' }, { provider: 'azure', apiKey: 'bad\r\nheader' }, { provider: 'azure', apiKey: 'x'.repeat(1001) },
    { provider: 'azure', region: 'https://example.com' }, { provider: 'google', region: 'eastus' },
    { provider: 'azure', apiKey: 'key', clearKey: true }, { provider: 'chat', apiKey: 'secret' }, { provider: 'azure', apiKey: 123 },
    { provider: 'openai', model: '' }, { provider: 'openrouter', model: 'bad\nmodel' }, { provider: 'nanogpt', model: 123 },
    { provider: 'nanogpt', region: 'eastus' }, { provider: 'google', model: 'model' }, { provider: 'chat', model: 'model' }
  ])('rejects invalid configuration: %j', input => {
    expect(() => normalizeTranslationConfiguration(input)).toThrow()
  })
})
