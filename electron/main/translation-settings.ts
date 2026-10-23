import { DEFAULT_TRANSLATION_SETTINGS, DEFAULT_TRANSLATION_MODELS, TRANSLATION_API_IDS, isTranslationModelProvider, normalizeTranslationConfiguration, normalizeTranslationProvider, normalizeTranslationRegion, type PublicTranslationSettings, type TranslationApi } from '../../shared/translation-settings'
import { normalizeProviderModel } from '../../shared/connection-settings'

export interface StoredTranslationSettings {
  provider?: string
  azure?: { encryptedApiKey?: string; region?: string }
  google?: { encryptedApiKey?: string }
  openai?: { encryptedApiKey?: string; model?: string }
  openrouter?: { encryptedApiKey?: string; model?: string }
  nanogpt?: { encryptedApiKey?: string; model?: string }
}
export function readTranslationSettings(raw: unknown): StoredTranslationSettings {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as StoredTranslationSettings
  const result: StoredTranslationSettings = {}
  try { result.provider = normalizeTranslationProvider(input.provider) } catch { /* use default */ }
  for (const provider of TRANSLATION_API_IDS) {
    const item = input[provider]
    if (item && typeof item === 'object') result[provider] = { encryptedApiKey: typeof item.encryptedApiKey === 'string' && item.encryptedApiKey.length <= 20_000 ? item.encryptedApiKey : undefined }
    if (isTranslationModelProvider(provider)) {
      try { if (input[provider]?.model !== undefined) result[provider] = { ...result[provider], model: normalizeProviderModel(input[provider]!.model) } } catch { /* use model default */ }
    }
  }
  try { if (input.azure?.region !== undefined) result.azure = { ...result.azure, region: normalizeTranslationRegion(input.azure.region) } } catch { /* ignore invalid region */ }
  return result
}
export class TranslationSettingsStore {
  private memory: Partial<Record<TranslationApi, string>> = {}
  private revision = 0
  constructor(private options: {
    read: () => StoredTranslationSettings | undefined
    write: (next: StoredTranslationSettings) => void
    available: () => boolean
    encrypt: (key: string) => string
    decrypt: (encrypted: string) => string
  }) {}
  key(provider: TranslationApi): string {
    if (this.memory[provider]) return this.memory[provider]!
    const encrypted = this.options.read()?.[provider]?.encryptedApiKey
    if (!encrypted || !this.options.available()) return ''
    try { return this.options.decrypt(encrypted).trim() } catch { return '' }
  }
  public(): PublicTranslationSettings {
    const stored = this.options.read() ?? {}
    const status = (provider: TranslationApi) => ({ configured: Boolean(this.key(provider)), persistence: this.memory[provider] ? 'memory' as const : this.key(provider) ? 'secure-storage' as const : 'none' as const })
    const modelStatus = (provider: 'openai' | 'openrouter' | 'nanogpt') => ({ ...status(provider), model: stored[provider]?.model ?? DEFAULT_TRANSLATION_MODELS[provider] })
    return { provider: stored.provider as PublicTranslationSettings['provider'] || DEFAULT_TRANSLATION_SETTINGS.provider, revision: this.revision, azure: { ...status('azure'), region: stored.azure?.region ?? '' }, google: status('google'), openai: modelStatus('openai'), openrouter: modelStatus('openrouter'), nanogpt: modelStatus('nanogpt') }
  }
  configure(raw: unknown): PublicTranslationSettings {
    const input = normalizeTranslationConfiguration(raw)
    const next = { ...this.options.read(), provider: input.provider }
    if (input.provider !== 'chat' && input.provider !== 'offline') {
      const provider = input.provider
      const item: { encryptedApiKey?: string; region?: string; model?: string } = { ...next[provider], ...(input.region !== undefined ? { region: input.region } : {}), ...(input.model !== undefined ? { model: input.model } : {}) }
      if (input.clearKey) delete item.encryptedApiKey
      else if (input.apiKey) {
        if (this.options.available()) item.encryptedApiKey = this.options.encrypt(input.apiKey)
        else delete item.encryptedApiKey
      }
      next[provider] = item
      // Write atomically before changing in-memory credentials.
      this.options.write(next)
      if (input.clearKey || (input.apiKey && this.options.available())) delete this.memory[provider]
      else if (input.apiKey) this.memory[provider] = input.apiKey
    } else this.options.write(next)
    this.revision++
    return this.public()
  }
}
