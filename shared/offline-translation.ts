import type { TranslationLanguage } from './caption-translation'

export type OfflineTranslationPackState = 'missing' | 'downloading' | 'installing' | 'ready' | 'error'
export interface OfflineTranslationPack {
  language: TranslationLanguage
  version: string
  bytes: number
  state: OfflineTranslationPackState
  downloadedBytes: number
  message?: string
}
export interface OfflineTranslationStatus { packs: OfflineTranslationPack[] }
export const OFFLINE_TRANSLATION_SOURCE = 'en'
