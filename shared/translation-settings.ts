import { normalizeProviderApiKey, normalizeProviderModel } from './connection-settings'

export type TranslationModelProvider = 'openai' | 'openrouter' | 'nanogpt'
export type TranslationProvider = 'azure' | 'google' | TranslationModelProvider | 'chat' | 'offline'
export type TranslationApi = Exclude<TranslationProvider, 'chat' | 'offline'>
export const TRANSLATION_API_IDS = ['azure', 'google', 'openai', 'openrouter', 'nanogpt'] as const
export const TRANSLATION_PROVIDER_NAMES = { azure: 'Azure Translator', google: 'Google Cloud Translation', openai: 'OpenAI', openrouter: 'OpenRouter', nanogpt: 'NanoGPT', chat: 'Chat model', offline: 'Offline translation' } as const
export const DEFAULT_TRANSLATION_MODELS = { openai: 'gpt-4.1-mini', openrouter: 'openai/gpt-4.1-mini', nanogpt: 'openai/gpt-4.1-nano' } as const
export function isTranslationModelProvider(provider: unknown): provider is TranslationModelProvider {
  return provider === 'openai' || provider === 'openrouter' || provider === 'nanogpt'
}
export interface TranslationKeyStatus { configured: boolean; persistence: 'secure-storage' | 'memory' | 'none' }
export interface PublicTranslationSettings {
  provider: TranslationProvider
  revision: number
  azure: { configured: boolean; persistence: 'secure-storage' | 'memory' | 'none'; region: string }
  google: { configured: boolean; persistence: 'secure-storage' | 'memory' | 'none' }
  openai: TranslationKeyStatus & { model: string }
  openrouter: TranslationKeyStatus & { model: string }
  nanogpt: TranslationKeyStatus & { model: string }
}
export interface ConfigureTranslationRequest {
  provider: TranslationProvider
  apiKey?: string
  region?: string
  clearKey?: boolean
  model?: string
}
export const DEFAULT_TRANSLATION_SETTINGS: PublicTranslationSettings = {
  provider: 'azure', revision: 0,
  azure: { configured: false, persistence: 'none', region: '' },
  google: { configured: false, persistence: 'none' },
  openai: { configured: false, persistence: 'none', model: DEFAULT_TRANSLATION_MODELS.openai },
  openrouter: { configured: false, persistence: 'none', model: DEFAULT_TRANSLATION_MODELS.openrouter },
  nanogpt: { configured: false, persistence: 'none', model: DEFAULT_TRANSLATION_MODELS.nanogpt }
}
export function normalizeTranslationProvider(value: unknown): TranslationProvider {
  if (value === 'azure' || value === 'google' || value === 'chat' || value === 'offline' || isTranslationModelProvider(value)) return value
  throw new Error('Choose a supported translation provider.')
}
export function normalizeTranslationRegion(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Enter an Azure region or leave it blank for a global resource.')
  const region = value.trim().toLowerCase()
  if (region && !/^[a-z][a-z0-9]{1,49}$/.test(region)) throw new Error('Use the Azure region identifier, for example eastus or westus2.')
  return region
}
export function normalizeTranslationConfiguration(raw: unknown): ConfigureTranslationRequest {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid translation settings.')
  const input = raw as ConfigureTranslationRequest
  const provider = normalizeTranslationProvider(input.provider)
  if (input.clearKey !== undefined && typeof input.clearKey !== 'boolean') throw new Error('Invalid key removal request.')
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new Error('Enter a valid translation API key.')
  const apiKey = input.apiKey?.trim() ? normalizeProviderApiKey(input.apiKey) : undefined
  if (apiKey && input.clearKey) throw new Error('Save a key or remove it in separate actions.')
  if (provider === 'chat' && (apiKey || input.clearKey || input.region !== undefined)) throw new Error('Configure chat credentials in AI connection.')
  if (provider === 'offline' && (apiKey || input.clearKey || input.region !== undefined || input.model !== undefined)) throw new Error('Offline translation uses downloaded language packs, without an API key.')
  if (provider !== 'azure' && input.region !== undefined) throw new Error('The region is only used by Azure Translator.')
  if (input.model !== undefined && !isTranslationModelProvider(provider)) throw new Error('Set a translation model only for OpenAI, OpenRouter, or NanoGPT.')
  return { provider, apiKey, clearKey: input.clearKey === true, ...(input.region !== undefined ? { region: normalizeTranslationRegion(input.region) } : {}), ...(input.model !== undefined ? { model: normalizeProviderModel(input.model) } : {}) }
}
