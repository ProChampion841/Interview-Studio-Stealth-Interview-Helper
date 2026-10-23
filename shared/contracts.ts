export type SessionMode = 'live' | 'chat'
export type ConsentKind = 'session' | 'microphone' | 'capture'
export type CoachingModel = 'gpt-6-astra' | 'gpt-5.6-terra' | 'gpt-5.6-luna'
export type ProxyMode = 'system' | 'direct' | 'http' | 'socks5'
export type ProviderId = 'openai' | 'nanogpt' | 'openrouter' | 'lmstudio'
export const PROVIDER_IDS: ReadonlyArray<ProviderId> = ['openai', 'nanogpt', 'openrouter', 'lmstudio']
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  openai: 'OpenAI', nanogpt: 'NanoGPT', openrouter: 'OpenRouter', lmstudio: 'LM Studio'
}

export const COACHING_MODELS: ReadonlyArray<{
  id: CoachingModel
  label: string
  description: string
}> = [
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Highest-quality coaching' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced quality and speed' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Lowest cost and latency' }
]

export interface PublicProxySettings {
  mode: ProxyMode
  host: string
  port?: number
  username: string
  hasPassword: boolean
  credentialsAvailable: boolean
  persistence: 'settings' | 'secure-storage' | 'memory' | 'none'
}

export interface StealthSettings {
  enabled: boolean
  captureProtection: boolean
  hideFromTaskbar: boolean
  disguiseTitle: boolean
  decoyTitle: string
  noFocusSteal: boolean
  opacity: number
  mousePassthrough: boolean
}

export interface ProviderStatus {
  configured: boolean
  keySource: 'environment' | 'secure-storage' | 'memory' | 'none'
  baseUrl: string
  model: string
  modelSource: 'environment' | 'settings' | 'default'
}

export interface AppSettings {
  translation: import('./translation-settings').PublicTranslationSettings
  captionProvider: import('./captions').CaptionProvider
  hasApiKey: boolean
  apiKeySource: 'environment' | 'secure-storage' | 'memory' | 'none'
  secureStorageAvailable: boolean
  model: string
  modelSource: 'environment' | 'settings' | 'default'
  proxy: PublicProxySettings
  alwaysOnTop: boolean
  compactMode: boolean
  minimizedToBar: boolean
  shortcut: string
  stealth: StealthSettings
  panicShortcut: string
  passthroughShortcut: string
  foreignShortcut: string
  restoreShortcut: string
  provider: ProviderId
  providers: Record<ProviderId, ProviderStatus>
}

export interface ConsentGrant {
  kind: ConsentKind
  token: string
  expiresAt: number
}

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
  appIcon?: string
}

export interface CaptureArea {
  x: number
  y: number
  width: number
  height: number
}

export interface CoachRequest {
  requestId: string
  mode: SessionMode
  question: string
  transcript?: string
  profile?: string
  profileId?: string
  jobId?: string
  role?: string
  interviewType?: string
  responseStyle?: string
  imageDataUrl?: string
  imageDataUrls?: string[]
  consentToken?: string
}

export type CoachEvent =
  | { requestId: string; type: 'started'; demo: boolean; provider?: ProviderId; model?: string }
  | { requestId: string; type: 'fallback'; from: ProviderId; to: ProviderId; model: string; message: string }
  | { requestId: string; type: 'delta'; delta: string }
  | { requestId: string; type: 'completed' }
  | { requestId: string; type: 'cancelled' }
  | { requestId: string; type: 'error'; message: string }

export interface RealtimeToken {
  value: string
  expiresAt?: number
  model: string
}

export interface RealtimeTokenRequest {
  role?: string
  interviewType?: string
  keywords?: string[]
  language?: string
  consentToken?: string
}

export interface ExportSessionRequest {
  content: string
  suggestedName?: string
}

export interface ExportSessionResult {
  saved: boolean
  path?: string
}

export interface SetApiKeyRequest {
  apiKey: string
  persist: boolean
}

export interface SetApiKeyResult {
  saved: boolean
  persisted: boolean
  message: string
}

export interface SetModelRequest {
  model: string
}

export interface SetProxyRequest {
  mode: ProxyMode
  host?: string
  port?: number | string
  username?: string
  password?: string
  clearPassword?: boolean
}

export interface SetProxyResult {
  settings: AppSettings
  message: string
}

export interface ProxyTestResult {
  ok: boolean
  message: string
  route: 'system' | 'direct' | 'http' | 'socks5' | 'unknown'
}

export interface SetProviderRequest {
  provider: ProviderId
}

export interface ConfigureProviderRequest {
  provider: ProviderId
  baseUrl?: string
  model?: string
  apiKey?: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  models?: string[]
}

export interface CoachProfile {
  id: string
  name: string
  details: string
  resumeText: string
  updatedAt: string
}

export interface CoachJob {
  id: string
  name: string
  jobDescription: string
  companyName: string
  companyWebsite: string
  companySocial: string
  companyBrief: string
  updatedAt: string
}

export interface ProfileListResult {
  profiles: CoachProfile[]
  activeProfileId: string | null
}

export interface ProfileUpsertRequest {
  id?: string
  name: string
  details?: string
  resumeText?: string
}

export interface ProfileMutationResult {
  profiles: CoachProfile[]
  activeProfileId: string | null
  profile?: CoachProfile
}

export interface JobListResult {
  jobs: CoachJob[]
  activeJobId: string | null
}

export interface JobUpsertRequest {
  id?: string
  name: string
  jobDescription?: string
  companyName?: string
  companyWebsite?: string
  companySocial?: string
}

export interface JobMutationResult {
  jobs: CoachJob[]
  activeJobId: string | null
  job?: CoachJob
}

export interface ResumeUploadResult {
  text: string
  fileName: string
  truncated: boolean
}

export interface CompanyAnalysisResult {
  companyBrief: string
  warning?: string
}

export interface RealtimeSdpRequest {
  token: string
  sdp: string
}

export interface RealtimeSdpResult {
  sdp: string
}

export interface ForeignWindowMutationResult {
  ok: boolean
  message: string
  appliedCount: number
}

export interface ForeignHotkeyResult {
  ok: boolean
  message: string
}

export const IPC = {
  historyList: 'history:list',
  historyGet: 'history:get',
  historySave: 'history:save',
  historyRename: 'history:rename',
  historyDelete: 'history:delete',
  historyFlush: 'history:flush',
  historyFlushed: 'history:flushed',
  translationPacksGet: 'translation:packs:get',
  translationPacksDownload: 'translation:packs:download',
  translationPacksCancel: 'translation:packs:cancel',
  translationPacksRemove: 'translation:packs:remove',
  translationPacksStatus: 'translation:packs:status',
  settingsConfigureTranslation: 'settings:configure-translation',
  settingsTestTranslation: 'settings:test-translation',
  settingsGet: 'settings:get',
  settingsSetApiKey: 'settings:set-api-key',
  settingsClearApiKey: 'settings:clear-api-key',
  settingsSetModel: 'settings:set-model',
  settingsSetProxy: 'settings:set-proxy',
  settingsTestProxy: 'settings:test-proxy',
  settingsSetProvider: 'settings:set-provider',
  settingsSetCaptionProvider: 'settings:set-caption-provider',
  offlineModelsGet: 'captions:offline-models:get',
  offlineModelsDownload: 'captions:offline-models:download',
  offlineModelsCancel: 'captions:offline-models:cancel',
  offlineModelsStatus: 'captions:offline-models:status',
  settingsConfigureProvider: 'settings:configure-provider',
  settingsTestProvider: 'settings:test-provider',
  profilesList: 'profiles:list',
  profilesUpsert: 'profiles:upsert',
  profilesDelete: 'profiles:delete',
  profilesSetActive: 'profiles:set-active',
  profilesUploadResume: 'profiles:upload-resume',
  jobsList: 'jobs:list',
  jobsUpsert: 'jobs:upsert',
  jobsDelete: 'jobs:delete',
  jobsSetActive: 'jobs:set-active',
  jobsAnalyzeCompany: 'jobs:analyze-company',
  windowAlwaysOnTop: 'window:always-on-top',
  windowCompact: 'window:compact',
  windowMinimize: 'window:minimize',
  windowRestore: 'window:restore',
  windowState: 'window:state',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  stealthSet: 'stealth:set',
  stealthEvent: 'stealth:event',
  displayPassthrough: 'display:passthrough',
  stealthForeignSetHotkey: 'stealth:foreign:set-hotkey',
  consentRequest: 'consent:request',
  consentRelease: 'consent:release',
  captureListSources: 'capture:list-sources',
  captureArea: 'capture:area',
  captureAreaSnapshot: 'capture:area:snapshot',
  captureAreaSelect: 'capture:area:select',
  captureAreaCancel: 'capture:area:cancel',
  sessionExport: 'session:export',
  clipboardWriteText: 'clipboard:write-text',
  coachStart: 'coach:start',
  coachCancel: 'coach:cancel',
  coachEvent: 'coach:event',
  captionsStart: 'captions:start',
  captionsStop: 'captions:stop',
  captionsStopped: 'captions:stopped',
  captionsTranscribe: 'captions:transcribe',
  captionsTranslate: 'captions:translate',
  captionsRetryTranslation: 'captions:translation:retry',
  captionsCancelTranslations: 'captions:cancel-translations',
  realtimeCreateToken: 'realtime:create-token',
  realtimeExchangeSdp: 'realtime:exchange-sdp',
  shortcutToggle: 'shortcut:toggle'
} as const

export const LIMITS = {
  questionChars: 12_000,
  transcriptChars: 24_000,
  imageDataUrlChars: 4_500_000,
  roleChars: 120,
  interviewTypeChars: 120,
  profileChars: 2_000,
  responseStyleChars: 80,
  decoyTitleChars: 80,
  minOpacityPercent: 20,
  maxOpacityPercent: 100,
  keywordCount: 24,
  keywordChars: 80,
  exportChars: 1_000_000,
  exportNameChars: 120,
  proxyHostChars: 255,
  proxyUsernameChars: 255,
  proxyPasswordChars: 1_024,
  realtimeTokenChars: 2_000,
  realtimeSdpChars: 300_000,
  providerModelChars: 120,
  providerBaseUrlChars: 300,
  providerKeyChars: 1_000,
  profileCount: 20,
  profileIdChars: 100,
  profileNameChars: 80,
  profileDetailsChars: 4_000,
  resumeTextChars: 20_000,
  jobCount: 20,
  jobIdChars: 100,
  jobNameChars: 80,
  jobDescriptionChars: 8_000,
  companyNameChars: 120,
  companyWebsiteChars: 300,
  companySocialChars: 300,
  companyBriefChars: 6_000,
  resumeFileBytes: 5_000_000,
  companyPageChars: 200_000,
  libraryTitleChars: 120,
  foreignWindowCount: 10,
  foreignWindowTitleChars: 120,
  foreignProcessChars: 120,
  foreignHwndChars: 20,
  foreignHotkeyChars: 60
} as const
