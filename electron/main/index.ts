import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  screen,
  shell,
  clipboard,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import OpenAI from 'openai'
import {
  IPC,
  LIMITS,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type AppSettings,
  type CaptureSource,
  type CoachEvent,
  type CoachProfile,
  type CoachRequest,
  type CompanyAnalysisResult,
  type ConsentGrant,
  type ConsentKind,
  type ConfigureProviderRequest,
  type ExportSessionResult,
  type ForeignHotkeyResult,
  type CoachJob,
  type JobListResult,
  type JobMutationResult,
  type ProfileListResult,
  type ProfileMutationResult,
  type ProviderId,
  type ProviderStatus,
  type ProviderTestResult,
  type ProxyTestResult,
  type PublicProxySettings,
  type RealtimeSdpResult,
  type RealtimeToken,
  type RealtimeTokenRequest,
  type ResumeUploadResult,
  type SetApiKeyRequest,
  type SetApiKeyResult,
  type SetProxyResult,
  type StealthSettings
} from '../../shared/contracts'
import {
  normalizeCoachingModel,
  normalizeEnvironmentModel,
  normalizeProviderApiKey,
  normalizeProviderBaseUrl,
  normalizeProviderModel,
  normalizeProxySettings,
  proxyAuthMatches,
  proxyRulesFor,
  sameProxyIdentity,
  type NormalizedProxySettings
} from '../../shared/connection-settings'
import { applyCompanyBrief, cleanProfileText, normalizeJobFields, normalizePersistedJobs, normalizePersistedProfiles, normalizeProfileFields } from '../../shared/coach-profiles'
import {
  buildCompanyAnalysisInstructions,
  buildCompanyAnalysisText,
  extractSearchSnippets,
  stripHtmlToText
} from '../../shared/company-research'
import { resolveApiKey } from '../../shared/api-key-settings'
import { buildCoachInstructions, buildCoachText, normalizeResponseStyle, sanitizeKeywords, type CoachRequestWithProfile } from '../../shared/prompt'
import { fetchChatCompletion, streamChatCompletions } from './chat-completions'
import { parseChatCompletionError } from '../../shared/chat-completion-error'
import { runCoachWithFallback, type CoachConnection } from './coach-fallback'
import { CaptionTranslations, translationErrorMessage, translationFailure } from './caption-translations'
import { translationInstructions, type TranslationLanguage } from '../../shared/caption-translation'
import { TranslationSettingsStore, readTranslationSettings, type StoredTranslationSettings } from './translation-settings'
import { TRANSLATION_ENDPOINTS, translateWithApi } from './translation-api'
import { TRANSLATION_PROVIDER_NAMES, isTranslationModelProvider } from '../../shared/translation-settings'
import { OfflineTranslationPacks } from './offline-translation-packs'
import { OfflineTranslations } from './offline-translations'
import {
  primeForeignWindowBindings,
  restoreAllForeignWindows,
  toggleForeignWindowStealth
} from './window-stealth'
import type { StealthApplyPlan } from '../../shared/foreign-window'
import { parseScreenshotAttachments, screenshotContent } from '../../shared/screenshots'
import { captureScreenArea, registerAreaCaptureHandlers, cancelAreaCapture, isAreaCaptureActive } from './area-capture'
import { CaptionSessions } from './captions'
import { normalizeCaptionProvider, type CaptionProvider } from '../../shared/captions'
import { OfflineModelStore } from './offline-models'
import { OfflineCaptions } from './offline-captions'
import { ConversationHistory } from './conversation-history'
import { historyId, HISTORY_MAX_BYTES } from '../../shared/conversation-history'

// Acquire the lock before settings, windows, or hotkeys initialize.
// A duplicate must exit immediately without running the primary's quit cleanup.
if (!app.requestSingleInstanceLock()) app.exit(0)

// The UI is local and model downloads have their own verified stores. Avoid
// reusing Chromium's disposable HTTP disk cache after an interrupted shutdown.
// This switch must precede ready/defaultSession creation; it does not disable
// cookies, local storage, OS-encrypted credentials, or the offline model stores.
app.commandLine.appendSwitch('disable-http-cache')

app.on('second-instance', () => showMainWindow())

const DEFAULT_MODEL = 'gpt-6-astra'
const GLOBAL_SHORTCUT = 'CommandOrControl+Shift+I'
const PANIC_SHORTCUT = 'CommandOrControl+Shift+H'
const PASSTHROUGH_SHORTCUT = 'CommandOrControl+Shift+M'
/** Default hotkey candidates (no Alt): the first free one wins per action. */
const FOREIGN_SHORTCUT_CANDIDATES = [
  'CommandOrControl+Shift+K',
  'CommandOrControl+Shift+9',
  'CommandOrControl+Shift+0',
  'CommandOrControl+Shift+8'
]
const RESTORE_SHORTCUT_CANDIDATES = [
  'CommandOrControl+Shift+L',
  'CommandOrControl+Shift+8',
  'CommandOrControl+Shift+0'
]
let foreignShortcutActive = ''
let restoreShortcutActive = ''
const DECOY_WINDOW_TITLE = 'Microsoft Edge'
const WINDOW_BOUNDS = { width: 1320, height: 840, minWidth: 640, minHeight: 560 }
const COMPACT_BOUNDS = { width: 560, height: 740 }
const COACH_DEADLINE_MS = 75_000
const COMPANY_ANALYSIS_DEADLINE_MS = 60_000
const REALTIME_TOKEN_DEADLINE_MS = 15_000
const REALTIME_SDP_DEADLINE_MS = 20_000
const PROXY_TEST_DEADLINE_MS = 12_000
const NANO_GPT_DEFAULT_BASE = 'https://nano-gpt.com/api/v1'
const OPENROUTER_DEFAULT_BASE = 'https://openrouter.ai/api/v1'
const LM_STUDIO_DEFAULT_BASE = 'http://localhost:1234/v1'
const NANO_GPT_DEFAULT_MODEL = 'openai/gpt-4.1-nano'
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4.1-mini'
const LM_STUDIO_DEFAULT_MODEL = 'local-model'
const CONSENT_TTL_MS = 2 * 60_000
const SESSION_CONSENT_TTL_MS = 4 * 60 * 60_000

interface PersistedSettings {
  translation?: StoredTranslationSettings
  captionProvider?: string
  encryptedApiKey?: string
  installId?: string
  model?: string
  provider?: string
  profiles?: unknown
  activeProfileId?: string
  jobs?: unknown
  activeJobId?: string
  nanoGpt?: {
    encryptedApiKey?: string
    model?: string
    baseUrl?: string
  }
  openRouter?: {
    encryptedApiKey?: string
    model?: string
    baseUrl?: string
  }
  lmStudio?: {
    model?: string
    baseUrl?: string
  }
  stealth?: {
    enabled?: unknown
    captureProtection?: unknown
    hideFromTaskbar?: unknown
    disguiseTitle?: unknown
    decoyTitle?: unknown
    noFocusSteal?: unknown
    opacity?: unknown
    mousePassthrough?: unknown
  }
  proxy?: {
    mode?: unknown
    host?: unknown
    port?: unknown
    username?: unknown
    encryptedPassword?: string
    encryptedCredentials?: string
  }
  foreignHotkey?: string
  restoreHotkey?: string
}

type RuntimeProxySettings = NormalizedProxySettings

let mainWindow: BrowserWindow | null = null
let quitting = false
let memoryApiKey = ''
let memoryNanoGptKey = ''
let memoryOpenRouterKey = ''
let alwaysOnTop = true
let compactMode = false
let minimizedToBar = false
let barRestore: { bounds: Electron.Rectangle; maximized: boolean } | null = null
let lastBarBounds: Electron.Rectangle | null = null
let expandedBounds: Electron.Rectangle | null = null
let stealthHidden = false
let stealth: StealthSettings = {
  enabled: true,
  captureProtection: true,
  hideFromTaskbar: true,
  disguiseTitle: true,
  decoyTitle: DECOY_WINDOW_TITLE,
  noFocusSteal: true,
  opacity: 85,
  mousePassthrough: false
}
let persisted: PersistedSettings = {}
const conversationHistory = new ConversationHistory(() => join(app.getPath('userData'), 'conversations'))
let historyFlush: { token: string; resolve: (ok: boolean) => void } | null = null

async function flushConversationHistory(): Promise<boolean> {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isCrashed() || window.webContents.isLoading()) { await conversationHistory.flush(); return true }
  const token = randomUUID()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const ok = await new Promise<boolean>(resolve => {
      historyFlush = { token, resolve }
      // A renderer that has crashed cannot provide its last edits. Already
      // acknowledged periodic saves remain durable and startup must not hang.
      deadline = setTimeout(() => resolve(true), 3000)
      window.webContents.send(IPC.historyFlush, token)
    })
    await conversationHistory.flush()
    return ok
  } finally { clearTimeout(deadline); historyFlush = null }
}
const translationSettings = new TranslationSettingsStore({
  read: () => persisted.translation,
  write: translation => savePersistedSettings({ ...persisted, translation }),
  available: secureStorageAvailable,
  encrypt: key => safeStorage.encryptString(key).toString('base64'),
  decrypt: encrypted => safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
})
let runtimeProxy: RuntimeProxySettings = normalizeProxySettings({ mode: 'system' })
let proxyPersistence: PublicProxySettings['persistence'] = 'none'
let proxyApplyError = ''
let proxyCredentialsUnavailable = false
let proxyMutation: Promise<void> = Promise.resolve()
let activeCoach: { requestId: string; controller: AbortController; deadline: ReturnType<typeof setTimeout> } | null = null
const recentCoachStarts: number[] = []
const recentTokenStarts: number[] = []
const recentCaptionStarts: number[] = []
const offlineModels = new OfflineModelStore({
  directory: () => join(app.getPath('userData'), 'caption-models', 'english-v1'),
  fetch: async (url, init) => {
    await assertOpenAITransportReady()
    // URLs are fixed, checksum-pinned model assets; no credentials are attached.
    return session.defaultSession.fetch(url as string, { ...init, credentials: 'omit' }) as Promise<Response>
  },
  onStatus: status => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.offlineModelsStatus, status) }
})
function getCaptionProvider(): CaptionProvider {
  try { return normalizeCaptionProvider(persisted.captionProvider) } catch { return 'openai' }
}
const captionTranslations = new CaptionTranslations({
  allowed: (ownerId, sessionId) => captionSessions.sessionId === sessionId && (captionSessions.allows(ownerId, 'microphone') || captionSessions.allows(ownerId, 'computer')),
  connection: translationConnection,
  offlineFallback: async (text, language, signal) => {
    if (translationSettings.public().provider === 'offline') return { text: '', offlineIssue: 'failed' }
    // Packs are directional English models. Reject clearly incompatible scripts
    // rather than presenting their output as a meaningful translation.
    const letters = text.match(/\p{L}/gu) ?? [], latin = text.match(/\p{Script=Latin}/gu) ?? []
    if (letters.length && latin.length / letters.length < .8) return { text: '', offlineIssue: 'unsupported_source' }
    if (language === 'en') return { text }
    const pack = (await translationPacks.check()).packs.find(pack => pack.language === language)
    if (!pack) return { text: '', offlineIssue: 'unsupported_language' }
    if (pack.state !== 'ready') return { text: '', offlineIssue: 'missing_pack' }
    try { return { text: await offlineTranslations.translate(text, language, signal) } }
    catch { return { text: '', offlineIssue: translationPacks.snapshot().packs.find(pack => pack.language === language)?.state === 'ready' ? 'failed' : 'missing_pack' } }
  }
})
const translationPacks = new OfflineTranslationPacks({
  directory: () => join(app.getPath('userData'), 'translation-packs'),
  fetch: async (url, init) => {
    await assertOpenAITransportReady()
    return session.defaultSession.fetch(url as string, { ...init, redirect: 'error', credentials: 'omit' }) as Promise<Response>
  },
  onStatus: status => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.translationPacksStatus, status) }
})
const offlineTranslations = new OfflineTranslations(language => translationPacks.path(language))
function translationConnection(): (text: string, language: TranslationLanguage, signal: AbortSignal) => Promise<string> {
  const settings = translationSettings.public()
  if (settings.provider === 'offline') return (text, language, signal) => offlineTranslations.translate(text, language, signal)
  if (settings.provider !== 'chat') {
    const provider = settings.provider, apiKey = translationSettings.key(provider)
    if (!apiKey) throw new Error(`Add your ${TRANSLATION_PROVIDER_NAMES[provider]} API key in Settings > AI connection > Caption translation.`)
    if (isTranslationModelProvider(provider)) {
      const model = settings[provider].model
      return (text, language, signal) => provider === 'openai'
        ? completeWithOpenAI(translationInstructions(language), text, signal, 2000, { apiKey, model })
        : fetchChatCompletion({ baseUrl: providerBaseUrl(provider), apiKey, model, fetchImpl: providerFetch(provider), systemPrompt: translationInstructions(language), userText: text, maxTokens: 2000, signal })
    }
    return (text, language, signal) => translateWithApi({ provider, apiKey, region: settings.azure.region, text, language, signal, fetchImpl: translationApiFetch })
  }
  const provider = getActiveProvider(), key = resolveProviderKey(provider).value
  if (!key) throw new Error(`Configure ${PROVIDER_NAMES[provider]} in Settings > AI connection before enabling translation.`)
  return (text, language, signal) => provider === 'openai'
    ? completeWithOpenAI(translationInstructions(language), text, signal, 2000)
    : fetchChatCompletion({ baseUrl: providerBaseUrl(provider), apiKey: provider === 'lmstudio' ? null : key, model: getProviderModel(provider).value, fetchImpl: providerFetch(provider), systemPrompt: translationInstructions(language), userText: text, maxTokens: 2000, signal })
}
const captionSessions = new CaptionSessions({
  getConnection: () => {
    const provider = getCaptionProvider()
    if (provider === 'offline') return { provider, apiKey: '', baseUrl: '', fetch, local: new OfflineCaptions(offlineModels.paths()) }
    return { provider, apiKey: resolveProviderKey(provider).value, baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : providerBaseUrl(provider), fetch: providerFetch(provider) }
  },
  onStop: (ownerId, sessionId) => {
    captionTranslations.cancel(ownerId)
    offlineTranslations.stop()
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerId) mainWindow.webContents.send(IPC.captionsStopped, sessionId)
  }
})
const recentCompanyAnalyses: number[] = []
const recentProfileMutations: number[] = []
const recentJobMutations: number[] = []
const recentForeignMutations: number[] = []
const recentForeignRestores: number[] = []
const consentGrants = new Map<string, {
  kind: ConsentKind
  expiresAt: number
  ownerId: number
  claimed: boolean
}>()

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadPersistedSettings(): PersistedSettings {
  try {
    const path = settingsPath()
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const value = parsed as Record<string, unknown>
    const proxy = value.proxy && typeof value.proxy === 'object'
      ? value.proxy as Record<string, unknown>
      : undefined
    const stealthRaw = value.stealth && typeof value.stealth === 'object'
      ? value.stealth as Record<string, unknown>
      : undefined
    const nanoGpt = value.nanoGpt && typeof value.nanoGpt === 'object'
      ? value.nanoGpt as Record<string, unknown>
      : undefined
    const lmStudio = value.lmStudio && typeof value.lmStudio === 'object'
      ? value.lmStudio as Record<string, unknown>
      : undefined
    const openRouter = value.openRouter && typeof value.openRouter === 'object'
      ? value.openRouter as Record<string, unknown>
      : undefined
    return {
      translation: readTranslationSettings(value.translation),
      encryptedApiKey: typeof value.encryptedApiKey === 'string' ? value.encryptedApiKey : undefined,
      captionProvider: value.captionProvider === 'offline' ? 'offline' : value.captionProvider === 'openrouter' ? 'openrouter' : 'openai',
      installId: typeof value.installId === 'string' ? value.installId : undefined,
      model: typeof value.model === 'string' ? value.model : undefined,
      provider: typeof value.provider === 'string' ? value.provider : undefined,
      profiles: value.profiles,
      activeProfileId: typeof value.activeProfileId === 'string' ? value.activeProfileId : undefined,
      jobs: value.jobs,
      activeJobId: typeof value.activeJobId === 'string' ? value.activeJobId : undefined,
      nanoGpt: nanoGpt
        ? {
            encryptedApiKey: typeof nanoGpt.encryptedApiKey === 'string' ? nanoGpt.encryptedApiKey : undefined,
            model: typeof nanoGpt.model === 'string' ? nanoGpt.model : undefined,
            baseUrl: typeof nanoGpt.baseUrl === 'string' ? nanoGpt.baseUrl : undefined
          }
        : undefined,
      openRouter: openRouter
        ? {
            encryptedApiKey: typeof openRouter.encryptedApiKey === 'string' ? openRouter.encryptedApiKey : undefined,
            model: typeof openRouter.model === 'string' ? openRouter.model : undefined,
            baseUrl: typeof openRouter.baseUrl === 'string' ? openRouter.baseUrl : undefined
          }
        : undefined,
      lmStudio: lmStudio
        ? {
            model: typeof lmStudio.model === 'string' ? lmStudio.model : undefined,
            baseUrl: typeof lmStudio.baseUrl === 'string' ? lmStudio.baseUrl : undefined
          }
        : undefined,
      stealth: stealthRaw,
      proxy: proxy
        ? {
            mode: proxy.mode,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            encryptedPassword: typeof proxy.encryptedPassword === 'string' ? proxy.encryptedPassword : undefined,
            encryptedCredentials: typeof proxy.encryptedCredentials === 'string' ? proxy.encryptedCredentials : undefined
          }
        : undefined,
      foreignHotkey: typeof value.foreignHotkey === 'string' ? value.foreignHotkey : undefined,
      restoreHotkey: typeof value.restoreHotkey === 'string' ? value.restoreHotkey : undefined
    }
  } catch {
    return {}
  }
}

function savePersistedSettings(next: PersistedSettings): void {
  const path = settingsPath()
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  renameSync(temporaryPath, path)
  persisted = next
}

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function storedApiKey(): string {
  if (!persisted.encryptedApiKey || !secureStorageAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(persisted.encryptedApiKey, 'base64')).trim()
  } catch {
    return ''
  }
}

function storedHostedKey(provider: 'nanogpt' | 'openrouter'): string {
  const encrypted = (provider === 'openrouter' ? persisted.openRouter : persisted.nanoGpt)?.encryptedApiKey
  if (!encrypted || !secureStorageAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64')).trim()
  } catch {
    return ''
  }
}

function getApiKey(): { value: string; source: AppSettings['apiKeySource'] } {
  return resolveApiKey({
    memory: memoryApiKey,
    stored: storedApiKey(),
    environment: process.env.OPENAI_API_KEY
  })
}

function getCoachingModel(): { value: string; source: AppSettings['modelSource'] } {
  const environmentModel = normalizeEnvironmentModel(process.env.OPENAI_MODEL)
  if (environmentModel) return { value: environmentModel, source: 'environment' }
  try {
    if (persisted.model) return { value: normalizeCoachingModel(persisted.model), source: 'settings' }
  } catch {
    // Ignore an invalid or obsolete persisted model and use the supported default.
  }
  return { value: DEFAULT_MODEL, source: 'default' }
}

function normalizeProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)) {
    return value as ProviderId
  }
  throw new Error('Choose a supported provider.')
}

function getActiveProvider(): ProviderId {
  try {
    return normalizeProviderId(persisted.provider)
  } catch {
    return 'openai'
  }
}

function providerBaseUrl(provider: ProviderId): string {
  if (provider === 'openai') return 'https://api.openai.com/v1'
  const stored = provider === 'openrouter' ? persisted.openRouter?.baseUrl : provider === 'nanogpt' ? persisted.nanoGpt?.baseUrl : persisted.lmStudio?.baseUrl
  const fallback = provider === 'openrouter' ? OPENROUTER_DEFAULT_BASE : provider === 'nanogpt' ? NANO_GPT_DEFAULT_BASE : LM_STUDIO_DEFAULT_BASE
  try {
    return normalizeProviderBaseUrl(stored, provider === 'lmstudio') || fallback
  } catch {
    return fallback
  }
}

function getProviderModel(provider: ProviderId): { value: string; source: AppSettings['modelSource'] } {
  if (provider === 'openai') return getCoachingModel()
  const environmentModel = provider === 'openrouter' ? process.env.OPENROUTER_MODEL : provider === 'nanogpt' ? process.env.NANOGPT_MODEL : process.env.LMSTUDIO_MODEL
  try {
    if (environmentModel?.trim()) return { value: normalizeProviderModel(environmentModel), source: 'environment' }
  } catch {
    // Ignore an invalid environment override.
  }
  const stored = provider === 'openrouter' ? persisted.openRouter?.model : provider === 'nanogpt' ? persisted.nanoGpt?.model : persisted.lmStudio?.model
  try {
    if (stored) return { value: normalizeProviderModel(stored), source: 'settings' }
  } catch {
    // Ignore an invalid persisted model and use the provider default.
  }
  return {
    value: provider === 'openrouter' ? OPENROUTER_DEFAULT_MODEL : provider === 'nanogpt' ? NANO_GPT_DEFAULT_MODEL : LM_STUDIO_DEFAULT_MODEL,
    source: 'default'
  }
}

function resolveProviderKey(provider: ProviderId): { value: string; source: AppSettings['apiKeySource'] } {
  if (provider === 'openai') return getApiKey()
  if (provider === 'lmstudio') return { value: 'lm-studio', source: 'none' }
  return resolveApiKey({
    memory: provider === 'openrouter' ? memoryOpenRouterKey : memoryNanoGptKey,
    stored: storedHostedKey(provider),
    environment: provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.NANOGPT_API_KEY
  })
}

function publicProxySettings(): PublicProxySettings {
  const fixed = runtimeProxy.mode === 'http' || runtimeProxy.mode === 'socks5'
  const encryptedCredentialsPresent = Boolean(
    persisted.proxy?.encryptedCredentials || persisted.proxy?.encryptedPassword
  )
  return {
    mode: runtimeProxy.mode,
    host: fixed ? runtimeProxy.host : '',
    port: fixed ? runtimeProxy.port : undefined,
    username: fixed ? runtimeProxy.username : '',
    hasPassword: fixed && (Boolean(runtimeProxy.password) || encryptedCredentialsPresent),
    credentialsAvailable: !proxyCredentialsUnavailable,
    persistence: proxyPersistence
  }
}

function restoreRuntimeProxy(): void {
  const stored = persisted.proxy
  if (!stored) {
    runtimeProxy = normalizeProxySettings({ mode: 'system' })
    proxyPersistence = 'none'
    proxyCredentialsUnavailable = false
    return
  }

  let username = typeof stored.username === 'string' ? stored.username : ''
  let password = ''
  proxyCredentialsUnavailable = false
  const encryptedCredentials = stored.encryptedCredentials || stored.encryptedPassword
  if (encryptedCredentials) {
    if (!secureStorageAvailable()) {
      proxyCredentialsUnavailable = true
    } else {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(encryptedCredentials, 'base64'))
        if (stored.encryptedCredentials) {
          const credentials = JSON.parse(decrypted) as Record<string, unknown>
          username = typeof credentials.username === 'string' ? credentials.username : ''
          password = typeof credentials.password === 'string' ? credentials.password : ''
        } else {
          password = decrypted
        }
      } catch {
        proxyCredentialsUnavailable = true
      }
    }
  }

  try {
    runtimeProxy = normalizeProxySettings({
      mode: stored.mode,
      host: stored.host,
      port: stored.port,
      username,
      password
    })
    proxyPersistence = encryptedCredentials ? 'secure-storage' : 'settings'
  } catch {
    runtimeProxy = normalizeProxySettings({ mode: 'system' })
    proxyPersistence = 'none'
    proxyApplyError = 'Saved proxy settings are invalid. Open Settings and save them again before contacting OpenAI.'
  }
}

async function applyProxyNow(config: RuntimeProxySettings): Promise<void> {
  const proxyRules = proxyRulesFor(config)
  try {
    if (config.mode === 'system') {
      await session.defaultSession.setProxy({ mode: 'system' })
    } else if (config.mode === 'direct') {
      await session.defaultSession.setProxy({ mode: 'direct' })
    } else {
      await session.defaultSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxyRules ?? undefined,
        proxyBypassRules: '<local>'
      })
    }
    runtimeProxy = config
    await session.defaultSession.clearAuthCache()
    await session.defaultSession.closeAllConnections()
    proxyApplyError = ''
  } catch {
    proxyApplyError = 'The proxy configuration could not be applied. OpenAI requests are blocked until it is fixed.'
    throw new Error(proxyApplyError)
  }
}

function enqueueProxyMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = proxyMutation.then(task, task)
  proxyMutation = run.then(() => undefined, () => undefined)
  return run
}

async function assertOpenAITransportReady(): Promise<void> {
  await proxyMutation
  if (proxyApplyError) throw new Error(proxyApplyError)
  if (proxyCredentialsUnavailable) {
    throw new Error('Saved HTTP proxy credentials cannot be decrypted. Re-enter them in Settings before contacting OpenAI.')
  }
}

function openAIUrl(input: Parameters<typeof fetch>[0]): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.hostname !== 'api.openai.com' || url.port) {
    throw new Error('Blocked a network request outside the approved OpenAI API origin.')
  }
  return url.href
}

const openAIFetch: typeof fetch = async (input, init) => {
  await assertOpenAITransportReady()
  const url = openAIUrl(input)
  const request = typeof input === 'string' || input instanceof URL
    ? url
    : input as Parameters<typeof session.defaultSession.fetch>[0]
  return session.defaultSession.fetch(request, { ...init, redirect: 'error' }) as Promise<Response>
}

function validateProviderOrigin(input: Parameters<typeof fetch>[0], provider: ProviderId): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  const url = new URL(raw)
  const expected = new URL(providerBaseUrl(provider))
  const allowedPlainHttp = provider === 'lmstudio'
  if (url.protocol !== expected.protocol || url.origin !== expected.origin) {
    throw new Error(
      allowedPlainHttp
        ? 'Blocked a network request outside the configured LM Studio server origin.'
        : `Blocked a network request outside the configured ${PROVIDER_NAMES[provider]} API origin.`
    )
  }
  return url.href
}

function hostedProviderFetch(provider: 'nanogpt' | 'openrouter'): typeof fetch {
  return async (input, init) => {
    await assertOpenAITransportReady()
    const url = validateProviderOrigin(input, provider)
    const request = typeof input === 'string' || input instanceof URL
      ? url
      : input as Parameters<typeof session.defaultSession.fetch>[0]
    return session.defaultSession.fetch(request, { ...init, redirect: 'error' }) as Promise<Response>
  }
}
const nanoGptFetch = hostedProviderFetch('nanogpt')
const openRouterFetch = hostedProviderFetch('openrouter')

const lmStudioFetch: typeof fetch = async (input, init) => {
  validateProviderOrigin(input, 'lmstudio')
  return fetch(input, init)
}

function providerFetch(provider: ProviderId): typeof fetch {
  return { openai: openAIFetch, nanogpt: nanoGptFetch, openrouter: openRouterFetch, lmstudio: lmStudioFetch }[provider]
}
const translationApiFetch: typeof fetch = async (input, init) => {
  await assertOpenAITransportReady()
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw)
  if (!Object.values(TRANSLATION_ENDPOINTS).some(endpoint => {
    const expected = new URL(endpoint)
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password && !url.hash
  })) throw new Error('Blocked a request outside the approved translation endpoints.')
  return session.defaultSession.fetch(url.href, { ...init, redirect: 'error', credentials: 'omit' }) as Promise<Response>
}

function hasActiveNetworkSession(): boolean {
  pruneConsentGrants()
  return captionSessions.active || Boolean(activeCoach) || [...consentGrants.values()].some(
    (grant) => grant.kind === 'session' || (grant.kind === 'microphone' && grant.claimed)
  )
}

function withoutPersistedProxy(): PersistedSettings {
  const { proxy: _removed, ...rest } = persisted
  return rest
}

async function updateProxySettings(raw: unknown): Promise<SetProxyResult> {
  if (hasActiveNetworkSession()) {
    throw new Error('End the active live session or coaching request before changing proxy settings.')
  }
  const requested = normalizeProxySettings(raw)
  let password = requested.clearPassword ? '' : requested.password
  if (
    requested.mode === 'http' &&
    !requested.clearPassword &&
    !password &&
    sameProxyIdentity(requested, runtimeProxy)
  ) {
    password = runtimeProxy.password
  }
  const next: RuntimeProxySettings = requested.mode === 'http'
    ? { ...requested, password }
    : requested

  await applyProxyNow(next)
  proxyCredentialsUnavailable = false

  if (next.mode === 'system' || next.mode === 'direct') {
    savePersistedSettings({ ...withoutPersistedProxy(), proxy: { mode: next.mode } })
    proxyPersistence = 'settings'
    return {
      settings: publicSettings(),
      message: next.mode === 'system' ? 'System proxy settings are active.' : 'Direct connection mode is active.'
    }
  }

  if (next.mode === 'http' && (next.username || next.password)) {
    if (secureStorageAvailable()) {
      savePersistedSettings({
        ...withoutPersistedProxy(),
        proxy: {
          mode: next.mode,
          host: next.host,
          port: next.port,
          encryptedCredentials: safeStorage.encryptString(JSON.stringify({
            username: next.username,
            password: next.password
          })).toString('base64')
        }
      })
      proxyPersistence = 'secure-storage'
      return { settings: publicSettings(), message: 'HTTP proxy and encrypted credentials saved.' }
    }

    savePersistedSettings(withoutPersistedProxy())
    proxyPersistence = 'memory'
    return {
      settings: publicSettings(),
      message: 'Secure storage is unavailable, so this authenticated proxy will be kept only until the app closes.'
    }
  }

  savePersistedSettings({
    ...withoutPersistedProxy(),
    proxy: { mode: next.mode, host: next.host, port: next.port }
  })
  proxyPersistence = 'settings'
  return {
    settings: publicSettings(),
    message: `${next.mode === 'http' ? 'HTTP' : 'SOCKS5'} proxy saved and applied.`
  }
}

function proxyRoute(): ProxyTestResult['route'] {
  return runtimeProxy.mode
}

async function testProxyConnection(): Promise<ProxyTestResult> {
  await assertOpenAITransportReady()
  try {
    await session.defaultSession.resolveProxy('https://api.openai.com/v1/models')
    const response = await openAIFetch('https://api.openai.com/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(PROXY_TEST_DEADLINE_MS)
    })
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 407) {
      return {
        ok: false,
        route: proxyRoute(),
        message: 'The proxy requires authentication or rejected the saved HTTP proxy credentials.'
      }
    }
    if (response.status >= 500) {
      return {
        ok: false,
        route: proxyRoute(),
        message: `The selected route responded, but OpenAI was not reachable (HTTP ${response.status}).`
      }
    }
    return {
      ok: true,
      route: proxyRoute(),
      message: `OpenAI is reachable through the selected route (HTTP ${response.status}). No API key was sent.`
    }
  } catch (error) {
    return {
      ok: false,
      route: proxyRoute(),
      message: publicErrorMessage(error, 'Could not reach OpenAI through the selected route.')
    }
  }
}

function normalizeStealth(value: unknown, base: StealthSettings): StealthSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const flag = (key: Exclude<keyof StealthSettings, 'decoyTitle' | 'opacity'>): boolean =>
    typeof input[key] === 'boolean' ? (input[key] as boolean) : base[key]
  const rawTitle = input.decoyTitle
  const decoyTitle = rawTitle === undefined
    ? base.decoyTitle
    : cleanString(rawTitle, LIMITS.decoyTitleChars) || DECOY_WINDOW_TITLE
  let opacity = base.opacity
  if (typeof input.opacity === 'number' && Number.isFinite(input.opacity)) {
    opacity = Math.min(LIMITS.maxOpacityPercent, Math.max(LIMITS.minOpacityPercent, Math.round(input.opacity)))
  }
  return {
    enabled: flag('enabled'),
    captureProtection: flag('captureProtection'),
    hideFromTaskbar: flag('hideFromTaskbar'),
    disguiseTitle: flag('disguiseTitle'),
    decoyTitle,
    noFocusSteal: flag('noFocusSteal'),
    opacity,
    mousePassthrough: flag('mousePassthrough')
  }
}

function applyStealth(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.setOpacity(stealth.opacity / 100)
  window.setIgnoreMouseEvents(!minimizedToBar && stealth.mousePassthrough, { forward: !minimizedToBar && stealth.mousePassthrough })
  if (stealth.enabled) {
    window.setContentProtection(stealth.captureProtection)
    window.setSkipTaskbar(stealth.hideFromTaskbar)
    window.setTitle(stealth.disguiseTitle ? stealth.decoyTitle : 'Interview Studio')
  } else {
    window.setContentProtection(false)
    window.setSkipTaskbar(false)
    window.setTitle('Interview Studio')
  }
}

function sendStealthEvent(payload: { hidden?: boolean; passthrough?: boolean; foreign?: string }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.stealthEvent, payload)
}

const WINDOW_FALLBACK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function windowIconImage(size = 64): Electron.NativeImage {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    join(__dirname, '..', '..', 'build', 'icon.png')
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const image = nativeImage.createFromPath(candidate)
        if (!image.isEmpty()) return image.resize({ width: size, height: size })
      }
    } catch {
      // Try the next candidate.
    }
  }
  return nativeImage.createFromDataURL(WINDOW_FALLBACK_PNG).resize({ width: size, height: size })
}

function sendWindowState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.windowState, { minimizedToBar, compactMode })
}

function minimizeToBar(): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || minimizedToBar || quitting || stealthHidden) return
  cancelAreaCapture()
  barRestore = { bounds: window.getNormalBounds(), maximized: window.isMaximized() }
  minimizedToBar = true
  if (window.isMinimized()) window.restore()
  if (window.isMaximized()) window.unmaximize()
  const work = screen.getDisplayMatching(lastBarBounds ?? barRestore.bounds).workArea
  const width = Math.min(480, work.width), height = Math.min(96, work.height)
  const desired = lastBarBounds ?? { x: work.x + Math.round((work.width - width) / 2), y: work.y + 16 }
  const x = Math.max(work.x, Math.min(desired.x, work.x + work.width - width))
  const y = Math.max(work.y, Math.min(desired.y, work.y + work.height - height))
  window.setMinimumSize(Math.min(320, width), height)
  window.setBounds({ x, y, width, height })
  window.setResizable(false); window.setMaximizable(false)
  window.setAlwaysOnTop(true, 'floating')
  window.setIgnoreMouseEvents(false)
  sendWindowState()
  window.showInactive()
}

function restoreFromBar(): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || !minimizedToBar || !barRestore) return
  const previous = barRestore
  lastBarBounds = window.getBounds(); barRestore = null; minimizedToBar = false
  window.setResizable(true); window.setMaximizable(true)
  window.setMinimumSize(compactMode ? 460 : WINDOW_BOUNDS.minWidth, WINDOW_BOUNDS.minHeight)
  window.setBounds(previous.bounds)
  if (previous.maximized) window.maximize()
  window.setAlwaysOnTop(alwaysOnTop, 'floating')
  applyStealth()
  sendWindowState()
}

function showMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  restoreFromBar()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  if (stealthHidden) {
    stealthHidden = false
    sendStealthEvent({ hidden: false })
  }
}

function togglePanicHide(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  captionSessions.stop()
  if (isAreaCaptureActive()) {
    cancelAreaCapture()
    stealthHidden = true
    window.hide()
    sendStealthEvent({ hidden: true })
    return
  }
  const hide = window.isVisible() || window.isMinimized()
  stealthHidden = hide
  if (hide) {
    window.hide()
  } else {
    if (window.isMinimized()) window.restore()
    window.show()
    if (!stealth.noFocusSteal) window.focus()
  }
  sendStealthEvent({ hidden: stealthHidden })
}

function providerStatus(provider: ProviderId, key: { value: string; source: AppSettings['apiKeySource'] }, model: { value: string; source: AppSettings['modelSource'] }): ProviderStatus {
  return {
    configured: provider === 'lmstudio' ? true : Boolean(key.value),
    keySource: provider === 'lmstudio' ? 'none' : key.source,
    baseUrl: providerBaseUrl(provider),
    model: model.value,
    modelSource: model.source
  }
}

function publicSettings(): AppSettings {
  const apiKey = getApiKey()
  const coachingModel = getCoachingModel()
  const nanoKey = resolveProviderKey('nanogpt')
  const lmStudioModel = getProviderModel('lmstudio')
  const nanoModel = getProviderModel('nanogpt')
  return {
    translation: translationSettings.public(),
    captionProvider: getCaptionProvider(),
    hasApiKey: Boolean(apiKey.value),
    apiKeySource: apiKey.source,
    secureStorageAvailable: secureStorageAvailable(),
    model: coachingModel.value,
    modelSource: coachingModel.source,
    proxy: publicProxySettings(),
    alwaysOnTop,
    compactMode,
    minimizedToBar,
    shortcut: GLOBAL_SHORTCUT.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    stealth: { ...stealth },
    panicShortcut: PANIC_SHORTCUT.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    passthroughShortcut: PASSTHROUGH_SHORTCUT.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl'),
    foreignShortcut: shortcutLabel(foreignShortcutActive || FOREIGN_SHORTCUT_CANDIDATES[0]),
    restoreShortcut: shortcutLabel(restoreShortcutActive || RESTORE_SHORTCUT_CANDIDATES[0]),
    provider: getActiveProvider(),
    providers: {
      openai: providerStatus('openai', apiKey, coachingModel),
      nanogpt: providerStatus('nanogpt', nanoKey, nanoModel),
      openrouter: providerStatus('openrouter', resolveProviderKey('openrouter'), getProviderModel('openrouter')),
      lmstudio: providerStatus('lmstudio', { value: '', source: 'none' }, lmStudioModel)
    }
  }
}

function rendererEntryUrl(): string {
  return pathToFileURL(resolve(__dirname, '../renderer/index.html')).href
}

function developmentRendererUrl(): URL | null {
  if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL) return null
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    return url.protocol === 'http:' && loopback ? url : null
  } catch {
    return null
  }
}

function isAllowedRendererUrl(rawUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl)
    const developmentUrl = developmentRendererUrl()
    if (developmentUrl) {
      return candidate.origin === developmentUrl.origin && candidate.pathname === developmentUrl.pathname
    }
    candidate.hash = ''
    candidate.search = ''
    return candidate.href === rendererEntryUrl()
  } catch {
    return false
  }
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.isDestroyed()) return false
    if (event.sender !== mainWindow.webContents) return false
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
    return isAllowedRendererUrl(event.senderFrame.url)
  } catch {
    return false
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!isTrustedSender(event)) throw new Error('Blocked an IPC request from an untrusted page.')
}

function cleanString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : ''
}

function pruneConsentGrants(): void {
  const now = Date.now()
  for (const [token, grant] of consentGrants) {
    if (grant.expiresAt <= now) consentGrants.delete(token)
  }
}

function validateConsent(tokenValue: unknown, kind: ConsentKind, ownerId: number, consume = false): boolean {
  pruneConsentGrants()
  const token = cleanString(tokenValue, 200)
  const grant = token ? consentGrants.get(token) : undefined
  if (!grant || grant.kind !== kind || grant.ownerId !== ownerId) return false
  if (consume) consentGrants.delete(token)
  return true
}

function claimConsent(tokenValue: unknown, kind: ConsentKind, ownerId: number): boolean {
  pruneConsentGrants()
  const token = cleanString(tokenValue, 200)
  const grant = token ? consentGrants.get(token) : undefined
  if (!grant || grant.kind !== kind || grant.ownerId !== ownerId || grant.claimed) return false
  grant.claimed = true
  return true
}

function hasActiveConsent(kind: ConsentKind, ownerId: number, requireClaimed = false): boolean {
  pruneConsentGrants()
  return [...consentGrants.values()].some(
    (grant) => grant.kind === kind && grant.ownerId === ownerId && (!requireClaimed || grant.claimed)
  )
}

async function requestConsent(event: IpcMainInvokeEvent, kindValue: unknown): Promise<ConsentGrant | null> {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const kind: ConsentKind | null = kindValue === 'session' || kindValue === 'microphone' || kindValue === 'capture'
    ? kindValue
    : null
  if (!kind) throw new Error('Unsupported consent request.')
  if (!isTrustedSender(event)) return null
  // Screen references are chosen inside the app's own picker, so no native
  // confirmation dialog is shown — a visible system popup would defeat stealth.
  // The in-app picker modal remains the explicit, per-use confirmation.
  if (kind !== 'capture') {
    const microphone = kind === 'microphone'
    const liveSession = kind === 'session'
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: liveSession ? 'Confirm permitted live assistance?' : 'Allow microphone for this session?',
      message: liveSession
        ? 'Start a visible AI-assisted interview session only when the interviewer or platform explicitly permits it.'
        : 'Interview Studio will stream microphone audio for transcription during an explicitly permitted live session.',
      detail: liveSession
        ? 'Continue only after providing any participant notice or consent required for AI assistance and voice processing.'
        : 'Audio capture stops when you end the session. Continue only when everyone involved permits this assistance.',
      buttons: ['Continue', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (result.response !== 0) return null
  }
  const grant: ConsentGrant = {
    kind,
    token: randomUUID(),
    expiresAt: Date.now() + (kind === 'session' ? SESSION_CONSENT_TTL_MS : CONSENT_TTL_MS)
  }
  consentGrants.set(grant.token, {
    kind,
    expiresAt: grant.expiresAt,
    ownerId: event.sender.id,
    claimed: false
  })
  return grant
}

function parseCoachRequest(value: unknown, ownerId: number): CoachRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid coaching request.')
  const input = value as Record<string, unknown>
  const requestId = cleanString(input.requestId, 100) || randomUUID()
  const mode = input.mode === 'chat' ? 'chat' : 'live'
  const consentToken = cleanString(input.consentToken, 200)
  if (mode === 'live' && !validateConsent(consentToken, 'session', ownerId)) {
    throw new Error('Live-session permission expired or was not confirmed. Start the live session again.')
  }
  const question = cleanString(input.question, LIMITS.questionChars)
  if (!question) throw new Error('Enter a question before asking the coach.')
  const imageDataUrls = parseScreenshotAttachments(input)
  const profileId = cleanString(input.profileId, LIMITS.profileIdChars)
  const jobId = cleanString(input.jobId, LIMITS.jobIdChars)
  return {
    requestId,
    mode,
    question,
    transcript: cleanString(input.transcript, LIMITS.transcriptChars),
    profile: cleanString(input.profile, LIMITS.profileChars),
    profileId: profileId || undefined,
    jobId: jobId || undefined,
    role: cleanString(input.role, LIMITS.roleChars),
    interviewType: cleanString(input.interviewType, LIMITS.interviewTypeChars),
    responseStyle: normalizeResponseStyle(cleanString(input.responseStyle, LIMITS.responseStyleChars)),
    imageDataUrls,
    consentToken: consentToken || undefined
  }
}

function rateLimit(bucket: number[], maximum: number, windowMs: number, message: string): void {
  const now = Date.now()
  while (bucket.length && bucket[0] < now - windowMs) bucket.shift()
  if (bucket.length >= maximum) throw new Error(message)
  bucket.push(now)
}

function sendCoachEvent(event: CoachEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IPC.coachEvent, event)
}

function publicErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  let message = error.message
  const secrets = [
    getApiKey().value,
    resolveProviderKey('nanogpt').value,
    resolveProviderKey('openrouter').value,
    runtimeProxy.mode === 'http' ? runtimeProxy.password : '',
    runtimeProxy.mode === 'http' ? runtimeProxy.username : ''
  ].filter((value) => value.length >= 3)
  for (const secret of secrets) message = message.split(secret).join('[redacted]')
  message = message
    .replace(/sk-[a-z0-9_*.-]{8,}/gi, '[redacted API key]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .slice(0, 500)
  if (/proxy.{0,40}(?:auth|credential)|(?:auth|credential).{0,40}proxy|ERR_PROXY/i.test(message)) {
    return 'The proxy rejected the connection or its credentials. Check the proxy settings and try again.'
  }
  if (/incorrect api key|invalid api key|authentication/i.test(message)) {
    return 'The AI provider rejected the configured API key. Check the key and account access, then try again.'
  }
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) {
    return 'The AI service rate limit was reached. Wait a moment and try again.'
  }
  return message || fallback
}

function demoAnswer(request: CoachRequest): string {
  const lower = request.question.toLowerCase()
  if (request.mode === 'live') return 'Clarify the goal and the most important constraints. Explain the simplest workable approach, then discuss its main tradeoff. Use a real example from your own experience if one fits.'

  if (/system design|design (a|the)|architecture|scale/.test(lower)) {
    return "I would first confirm who will use the system, what it needs to do, and how much traffic we expect. That helps me focus on the requirements that matter most.\n\nI would start with a simple API and choose storage based on how we read and write the data. If some work can happen later, I would consider a queue. I would add caching where a small delay in updated data is acceptable.\n\nThe main tradeoff is keeping the system simple while leaving room to grow. I would measure performance and add complexity only when there is a clear need."
  }

  if (/tell me about|conflict|failure|challenge|behavioral|leadership/.test(lower)) {
    return "I would start by making sure I understood the problem and my responsibility. I would listen to the people involved, agree on the goal, and work through the options with them.\n\nThen I would choose a practical next step, explain why I chose it, and check whether it helped. If it did not, I would adjust the approach. I would also share what I learned so the team could handle a similar situation better next time."
  }

  return "I would start with the simplest solution that meets the requirements. I would confirm the inputs, the expected output, and any limits that could change the approach.\n\nThen I would work through a small example and look for repeated work or unnecessary storage. If there is a better approach, I would explain how it improves the time or memory cost.\n\nBefore finishing, I would check empty inputs and other edge cases, and explain the main tradeoff in my choice."
}

async function streamDemo(request: CoachRequest, controller: AbortController): Promise<void> {
  sendCoachEvent({ requestId: request.requestId, type: 'started', demo: true })
  const answer = demoAnswer(request)
  const chunks = answer.match(/.{1,18}(?:\s|$)/g) ?? [answer]
  for (const chunk of chunks) {
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    sendCoachEvent({ requestId: request.requestId, type: 'delta', delta: chunk })
    await delay(18, undefined, { signal: controller.signal })
  }
}

async function streamOpenAI(request: CoachRequest, connection: CoachConnection, controller: AbortController, onDelta: (text: string) => void): Promise<void> {
  const client = new OpenAI({ apiKey: connection.apiKey, fetch: openAIFetch, maxRetries: 0 })
  const content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string; detail: 'auto' }
  > = [{ type: 'input_text', text: buildCoachText(request) }, ...screenshotContent(request.imageDataUrls ?? [])]

  try {
    const stream = await client.responses.create(
      {
        model: connection.model,
        instructions: buildCoachInstructions(request.mode, request.responseStyle),
        input: [{ role: 'user', content }],
        max_output_tokens: 2_200,
        store: false,
        stream: true
      },
      { signal: controller.signal }
    )

    for await (const event of stream) {
      if (controller.signal.aborted) break
      if (event.type === 'response.output_text.delta') {
        onDelta(event.delta)
      } else if (event.type === 'error') {
        throw parseChatCompletionError(200, { error: event })
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        throw parseChatCompletionError(200, { error: event.response.error })
      }
    }
  } catch (error) {
    if (error instanceof OpenAI.APIError && (error.status !== undefined || error.error || error.code)) throw parseChatCompletionError(error.status ?? 200, { error: error.error ?? { code: error.code, type: error.type } })
    throw error
  }
}

function coachRequestWithProfile(request: CoachRequest): CoachRequestWithProfile {
  const { profiles } = normalizePersistedProfiles(persisted.profiles, persisted.activeProfileId)
  const profile = request.profileId
    ? profiles.find((entry) => entry.id === request.profileId)
    : undefined
  const { jobs } = normalizePersistedJobs(persisted.jobs, persisted.activeJobId)
  const job = request.jobId
    ? jobs.find((entry) => entry.id === request.jobId)
    : undefined
  if (!profile && !job) return request
  return {
    ...request,
    profile: request.profile || undefined,
    profileDetails: profile?.details,
    resumeText: profile?.resumeText,
    jobDescription: job?.jobDescription,
    companyName: job?.companyName,
    companyBrief: job?.companyBrief
  }
}

async function streamChatProvider(
  request: CoachRequest,
  connection: CoachConnection,
  controller: AbortController,
  onDelta: (text: string) => void
): Promise<void> {
  const { provider, apiKey, model, baseUrl } = connection
  await streamChatCompletions({
    baseUrl,
    apiKey: provider === 'lmstudio' ? null : apiKey,
    model,
    fetchImpl: providerFetch(provider),
    allowCreditRetry: provider === 'openrouter',
    systemPrompt: buildCoachInstructions(request.mode, request.responseStyle),
    userPayload: { text: buildCoachText(request), imageDataUrls: request.imageDataUrls },
    signal: controller.signal,
    onDelta
  })
}

async function streamCoach(
  request: CoachRequest,
  provider: ProviderId,
  apiKey: string,
  controller: AbortController
): Promise<void> {
  const enriched = coachRequestWithProfile(request)
  const connections = [provider, ...PROVIDER_IDS.filter(item => item !== provider)].flatMap(item => {
    const key = item === provider ? apiKey : resolveProviderKey(item).value
    const localSaved = item === provider || Boolean(persisted.lmStudio?.baseUrl || persisted.lmStudio?.model || process.env.LMSTUDIO_MODEL?.trim())
    return key && (item !== 'lmstudio' || localSaved) ? [{ provider: item, apiKey: key, model: getProviderModel(item).value, baseUrl: providerBaseUrl(item) }] : []
  })
  await runCoachWithFallback({
    connections, signal: controller.signal,
    attempt: (connection, onDelta) => connection.provider === 'openai'
      ? streamOpenAI(enriched, connection, controller, onDelta)
      : streamChatProvider(enriched, connection, controller, onDelta),
    onStarted: connection => sendCoachEvent({ requestId: request.requestId, type: 'started', demo: false, provider: connection.provider, model: connection.model }),
    onDelta: delta => sendCoachEvent({ requestId: request.requestId, type: 'delta', delta }),
    onFallback: fallback => sendCoachEvent({ requestId: request.requestId, type: 'fallback', ...fallback })
  })
}

function storedProfiles(): { profiles: CoachProfile[]; activeProfileId: string | null } {
  return normalizePersistedProfiles(persisted.profiles, persisted.activeProfileId)
}

function saveProfiles(profiles: CoachProfile[], activeProfileId: string | null): void {
  savePersistedSettings({
    ...persisted,
    profiles,
    activeProfileId: activeProfileId ?? undefined
  })
}

function listProfiles(): ProfileListResult {
  return storedProfiles()
}

function profileInput(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

function profileIdFrom(raw: unknown): string {
  const input = profileInput(raw)
  return cleanString(typeof input.id === 'string' || typeof input.profileId === 'string' ? input.id ?? input.profileId : raw, LIMITS.profileIdChars)
}

function upsertProfile(raw: unknown): ProfileMutationResult {
  rateLimit(recentProfileMutations, 30, 60_000, 'Too many profile changes. Wait a moment and try again.')
  const { profiles, activeProfileId } = storedProfiles()
  const input = profileInput(raw)
  const id = cleanString(input.id, LIMITS.profileIdChars)
  const fields = normalizeProfileFields(input)
  const existing = id ? profiles.find((entry) => entry.id === id) : undefined
  if (!existing && profiles.length >= LIMITS.profileCount) {
    throw new Error(`You can keep up to ${LIMITS.profileCount} profiles. Delete one first.`)
  }
  const profile: CoachProfile = {
    id: existing?.id ?? randomUUID(),
    updatedAt: new Date().toISOString(),
    ...fields
  }
  const next = existing
    ? profiles.map((entry) => (entry.id === profile.id ? profile : entry))
    : [...profiles, profile]
  const nextActive = activeProfileId ?? profile.id
  saveProfiles(next, nextActive)
  return { profiles: next, activeProfileId: nextActive, profile }
}

function deleteProfile(raw: unknown): ProfileMutationResult {
  rateLimit(recentProfileMutations, 30, 60_000, 'Too many profile changes. Wait a moment and try again.')
  const { profiles, activeProfileId } = storedProfiles()
  const id = profileIdFrom(raw)
  const next = profiles.filter((entry) => entry.id !== id)
  if (next.length === profiles.length) throw new Error('That profile no longer exists.')
  const nextActive = activeProfileId === id ? null : activeProfileId
  saveProfiles(next, nextActive)
  return { profiles: next, activeProfileId: nextActive }
}

function setActiveProfile(raw: unknown): ProfileMutationResult {
  const { profiles, activeProfileId } = storedProfiles()
  const id = profileIdFrom(raw)
  if (!profiles.some((entry) => entry.id === id)) throw new Error('That profile no longer exists.')
  saveProfiles(profiles, id)
  return { profiles, activeProfileId: id }
}

function storedJobs(): { jobs: CoachJob[]; activeJobId: string | null } {
  return normalizePersistedJobs(persisted.jobs, persisted.activeJobId)
}

function saveJobs(jobs: CoachJob[], activeJobId: string | null): void {
  savePersistedSettings({
    ...persisted,
    jobs,
    activeJobId: activeJobId ?? undefined
  })
}

function listJobs(): JobListResult {
  return storedJobs()
}

function jobInput(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

function jobIdFrom(raw: unknown): string {
  const input = jobInput(raw)
  return cleanString(typeof input.id === 'string' || typeof input.jobId === 'string' ? input.id ?? input.jobId : raw, LIMITS.jobIdChars)
}

/** Profiles saved before the split carried job and company fields; lift them into one job target once. */
function migrateLegacyJobs(): { jobs: CoachJob[]; activeJobId: string | null } {
  const { profiles } = normalizePersistedProfiles(persisted.profiles, persisted.activeProfileId)
  let job: CoachJob | null = null
  for (const profile of profiles) {
    const legacy = profile as CoachProfile & {
      jobDescription?: unknown
      companyName?: unknown
      companyWebsite?: unknown
      companySocial?: unknown
      companyBrief?: unknown
    }
    try {
      const fields = normalizeJobFields({
        name: legacy.companyName || legacy.name,
        jobDescription: legacy.jobDescription,
        companyName: legacy.companyName,
        companyWebsite: legacy.companyWebsite,
        companySocial: legacy.companySocial
      })
      if (!fields.jobDescription && !fields.companyName && !fields.companyWebsite && !fields.companySocial) continue
      job = {
        id: randomUUID(),
        updatedAt: new Date().toISOString(),
        companyBrief: typeof legacy.companyBrief === 'string' ? legacy.companyBrief : '',
        ...fields
      }
      break
    } catch {
      continue
    }
  }
  const jobs = job ? [job] : []
  saveJobs(jobs, job?.id ?? null)
  return { jobs, activeJobId: job?.id ?? null }
}

function upsertJob(raw: unknown): JobMutationResult {
  rateLimit(recentJobMutations, 30, 60_000, 'Too many job changes. Wait a moment and try again.')
  const { jobs, activeJobId } = storedJobs()
  const input = jobInput(raw)
  const id = cleanString(input.id, LIMITS.jobIdChars)
  const fields = normalizeJobFields(input)
  const existing = id ? jobs.find((entry) => entry.id === id) : undefined
  if (!existing && jobs.length >= LIMITS.jobCount) {
    throw new Error(`You can keep up to ${LIMITS.jobCount} jobs. Delete one first.`)
  }
  let companyBrief = existing?.companyBrief ?? ''
  if (
    existing &&
    (fields.companyName !== existing.companyName ||
      fields.companyWebsite !== existing.companyWebsite ||
      fields.companySocial !== existing.companySocial)
  ) {
    companyBrief = ''
  }
  const job: CoachJob = {
    id: existing?.id ?? randomUUID(),
    updatedAt: new Date().toISOString(),
    companyBrief,
    ...fields
  }
  const next = existing
    ? jobs.map((entry) => (entry.id === job.id ? job : entry))
    : [...jobs, job]
  const nextActive = activeJobId ?? job.id
  saveJobs(next, nextActive)
  return { jobs: next, activeJobId: nextActive, job }
}

function deleteJob(raw: unknown): JobMutationResult {
  rateLimit(recentJobMutations, 30, 60_000, 'Too many job changes. Wait a moment and try again.')
  const { jobs, activeJobId } = storedJobs()
  const id = jobIdFrom(raw)
  const next = jobs.filter((entry) => entry.id !== id)
  if (next.length === jobs.length) throw new Error('That job no longer exists.')
  const nextActive = activeJobId === id ? null : activeJobId
  saveJobs(next, nextActive)
  return { jobs: next, activeJobId: nextActive }
}

function setActiveJob(raw: unknown): JobMutationResult {
  const { jobs, activeJobId } = storedJobs()
  const id = jobIdFrom(raw)
  if (!jobs.some((entry) => entry.id === id)) throw new Error('That job no longer exists.')
  saveJobs(jobs, id)
  return { jobs, activeJobId: id }
}

async function uploadResume(): Promise<ResumeUploadResult> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('No window is available to pick a resume file.')
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload resume',
    properties: ['openFile'],
    filters: [{ name: 'Resume document', extensions: ['txt', 'md', 'pdf'] }]
  })
  if (picked.canceled || !picked.filePaths.length) {
    return { text: '', fileName: '', truncated: false }
  }
  const filePath = picked.filePaths[0]
  const extension = extname(filePath).toLowerCase()
  if (!['.txt', '.md', '.pdf'].includes(extension)) {
    throw new Error('Choose a .txt, .md, or .pdf resume file.')
  }
  const stats = statSync(filePath)
  if (!stats.isFile()) throw new Error('The selected resume is not a file.')
  if (stats.size > LIMITS.resumeFileBytes) throw new Error('The resume file is larger than 5 MB.')

  let text = ''
  if (extension === '.pdf') {
    try {
      const { PDFParse } = await import('pdf-parse')
      const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) })
      try {
        const result = await parser.getText()
        text = typeof result.text === 'string' ? result.text : ''
      } finally {
        await parser.destroy().catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof Error && /larger|not a file/i.test(error.message)) throw error
      throw new Error('The PDF resume could not be read. Try exporting it as text or Markdown.')
    }
  } else {
    text = readFileSync(filePath, 'utf8').replace(/^﻿/, '')
  }

  const cleaned = cleanProfileText(text, LIMITS.resumeTextChars)
  if (!cleaned) throw new Error('No readable text was found in the resume file.')
  return {
    text: cleaned,
    fileName: cleanString(basename(filePath), 200),
    truncated: text.trim().length > LIMITS.resumeTextChars
  }
}

async function completeWithOpenAI(systemPrompt: string, userText: string, signal: AbortSignal, maxTokens = 900, connection?: { apiKey: string; model: string }): Promise<string> {
  const client = new OpenAI({ apiKey: connection?.apiKey ?? getApiKey().value, fetch: openAIFetch })
  const response = await client.responses.create(
    {
      model: connection?.model ?? getCoachingModel().value,
      instructions: systemPrompt,
      input: [{ role: 'user', content: [{ type: 'input_text', text: userText }] }],
      max_output_tokens: maxTokens,
      store: false
    },
    { signal }
  )
  const text = response.output_text?.trim()
  if (!text) throw new Error('The AI service returned an empty response.')
  return text
}

async function fetchWebsiteText(website: string, signal: AbortSignal): Promise<string> {
  const target = new URL(website)
  if (target.protocol !== 'https:') throw new Error('The company website must use https.')
  const response = await session.defaultSession.fetch(target.href, {
    method: 'GET',
    signal,
    redirect: 'follow'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (new URL(response.url).protocol !== 'https:') {
    throw new Error('The company website redirected away from https.')
  }
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
    throw new Error('the site did not return an HTML page')
  }
  return stripHtmlToText(await response.text())
}

async function fetchSearchSnippets(companyName: string, signal: AbortSignal): Promise<string[]> {
  const query = encodeURIComponent(`${companyName} company latest news`)
  const response = await session.defaultSession.fetch(`https://lite.duckduckgo.com/lite/?q=${query}`, {
    method: 'GET',
    signal
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return extractSearchSnippets(await response.text())
}

async function analyzeCompany(raw: unknown): Promise<CompanyAnalysisResult> {
  rateLimit(recentCompanyAnalyses, 6, 60_000, 'Too many company analyses. Wait a moment and try again.')
  const { jobs, activeJobId } = storedJobs()
  const id = jobIdFrom(raw)
  const job = jobs.find((entry) => entry.id === id)
  if (!job) throw new Error('Save the job before analyzing its company.')
  if (!job.companyName && !job.companyWebsite) {
    throw new Error('Add a company name or website to the job first.')
  }

  const controller = new AbortController()
  const deadline = setTimeout(() => {
    controller.abort(new DOMException('Company analysis timed out.', 'TimeoutError'))
  }, COMPANY_ANALYSIS_DEADLINE_MS)
  const warnings: string[] = []
  try {
    let websiteText = ''
    if (job.companyWebsite) {
      try {
        websiteText = await fetchWebsiteText(job.companyWebsite, controller.signal)
      } catch (error) {
        warnings.push(`The company website could not be fetched (${publicErrorMessage(error, 'network error')}).`)
      }
    }
    let snippets: string[] = []
    try {
      snippets = await fetchSearchSnippets(job.companyName || job.companyWebsite, controller.signal)
    } catch (error) {
      warnings.push(`Web search was unavailable (${publicErrorMessage(error, 'network error')}).`)
    }
    if (!websiteText && !snippets.length) {
      throw new Error('No company information could be fetched. Check the connection and try again.')
    }

    const provider = getActiveProvider()
    const key = resolveProviderKey(provider)
    if (!key.value) throw new Error('Configure the active AI provider before analyzing a company.')
    const instructions = buildCompanyAnalysisInstructions()
    const analysisText = buildCompanyAnalysisText({
      companyName: job.companyName || job.companyWebsite,
      websiteText,
      searchSnippets: snippets
    })
    const brief = provider === 'openai'
      ? await completeWithOpenAI(instructions, analysisText, controller.signal)
      : await fetchChatCompletion({
          baseUrl: providerBaseUrl(provider),
          apiKey: provider === 'lmstudio' ? null : key.value,
          model: getProviderModel(provider).value,
          fetchImpl: providerFetch(provider),
          systemPrompt: instructions,
          userText: analysisText,
          signal: controller.signal
        })
    const companyBrief = brief.slice(0, LIMITS.companyBriefChars)
    if (!companyBrief) throw new Error('The AI service returned an empty company briefing.')

    const current = storedJobs()
    const next = applyCompanyBrief(current.jobs, job, companyBrief)
    saveJobs(next, current.activeJobId)
    return warnings.length
      ? { companyBrief, warning: warnings.join(' ').slice(0, 400) }
      : { companyBrief }
  } finally {
    clearTimeout(deadline)
  }
}

async function testProviderConnection(provider: ProviderId): Promise<ProviderTestResult> {
  if (provider === 'openai') {
    const result = await testProxyConnection()
    return { ok: result.ok, message: result.message }
  }
  const key = resolveProviderKey(provider)
  if (provider !== 'lmstudio' && !key.value) {
    return { ok: false, message: `Add your ${PROVIDER_NAMES[provider]} API key first.` }
  }
  const fetchImpl = providerFetch(provider)
  try {
    // OpenRouter's model catalogue is public, so check the key separately.
    if (provider === 'openrouter') {
      const auth = await fetchImpl(`${providerBaseUrl(provider)}/key`, {
        headers: { Authorization: `Bearer ${key.value}` }, signal: AbortSignal.timeout(12_000)
      })
      if (!auth.ok) return { ok: false, message: `OpenRouter rejected the connection with HTTP ${auth.status}. Check your API key.` }
      await auth.body?.cancel()
    }
    const response = await fetchImpl(`${providerBaseUrl(provider)}/models`, {
      method: 'GET',
      headers: provider !== 'lmstudio' ? { Authorization: `Bearer ${key.value}` } : undefined,
      signal: AbortSignal.timeout(provider !== 'lmstudio' ? 12_000 : 8_000)
    })
    if (!response.ok) {
      return { ok: false, message: `The provider responded with HTTP ${response.status}.` }
    }
    const payload = (await response.json().catch(() => null)) as unknown
    const list = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)
        ? ((payload as Record<string, unknown>).data as unknown[])
        : null
    if (!list) return { ok: false, message: 'The provider did not return a model list.' }
    const models = list
      .map((entry) => {
        if (typeof entry === 'string') return entry
        if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).id === 'string') {
          return (entry as Record<string, unknown>).id as string
        }
        return ''
      })
      .filter(Boolean)
      .slice(0, 200)
    if (!models.length) return { ok: false, message: 'The provider returned an empty model list.' }
    return { ok: true, message: `Connected. ${models.length} model(s) available.`, models }
  } catch (error) {
    return { ok: false, message: publicErrorMessage(error, 'Could not reach the provider.') }
  }
}

function setProvider(raw: unknown): AppSettings {
  const provider = normalizeProviderId(
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).provider : raw
  )
  if (translationSettings.public().provider === 'chat') captionTranslations.cancel()
  savePersistedSettings({ ...persisted, provider })
  return publicSettings()
}

function configureProvider(raw: unknown): AppSettings {
  const input = profileInput(raw)
  const provider = normalizeProviderId(input.provider)
  if (provider === 'openai') {
    throw new Error('Use the OpenAI key and model controls to configure OpenAI.')
  }
  const isNano = provider === 'nanogpt'
  const isOpenRouter = provider === 'openrouter'
  const next: { encryptedApiKey?: string; model?: string; baseUrl?: string } = {
    ...(isOpenRouter ? persisted.openRouter : isNano ? persisted.nanoGpt : persisted.lmStudio)
  }
  const model = cleanString(input.model, LIMITS.providerModelChars)
  if (model) next.model = normalizeProviderModel(model)
  const baseUrl = cleanString(input.baseUrl, LIMITS.providerBaseUrlChars)
  if (baseUrl) next.baseUrl = normalizeProviderBaseUrl(baseUrl, provider === 'lmstudio')
  if (provider !== 'lmstudio') {
    const candidate = cleanString(input.apiKey, LIMITS.providerKeyChars)
    if (candidate) {
      const valid = normalizeProviderApiKey(candidate)
      if (secureStorageAvailable()) {
        next.encryptedApiKey = safeStorage.encryptString(valid).toString('base64')
        if (isOpenRouter) memoryOpenRouterKey = ''
        else memoryNanoGptKey = ''
      } else {
        if (isOpenRouter) memoryOpenRouterKey = valid
        else memoryNanoGptKey = valid
        delete next.encryptedApiKey
      }
    }
  }
  savePersistedSettings({
    ...persisted,
    nanoGpt: isNano ? next : persisted.nanoGpt,
    openRouter: isOpenRouter ? next : persisted.openRouter,
    lmStudio: provider === 'lmstudio' ? next : persisted.lmStudio
  })
  return publicSettings()
}

async function handleCoachStart(event: IpcMainEvent, rawRequest: unknown): Promise<void> {
  let owner: typeof activeCoach = null
  const requestId = cleanString((rawRequest as Record<string, unknown> | undefined)?.requestId, 100)
  try {
    assertTrustedSender(event)
    rateLimit(recentCoachStarts, 20, 60_000, 'Too many coaching requests. Wait a moment and try again.')
    const request = parseCoachRequest(rawRequest, event.sender.id)
    activeCoach?.controller.abort(new DOMException('Replaced by a newer request.', 'AbortError'))
    const controller = new AbortController()
    const deadline = setTimeout(() => {
      controller.abort(new DOMException('The coaching request timed out.', 'TimeoutError'))
    }, COACH_DEADLINE_MS)
    owner = { requestId: request.requestId, controller, deadline }
    activeCoach = owner
    const provider = getActiveProvider()
    const providerKey = resolveProviderKey(provider)
    if (providerKey.value) await streamCoach(request, provider, providerKey.value, controller)
    else await streamDemo(request, controller)

    if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Cancelled', 'AbortError')
    sendCoachEvent({ requestId: request.requestId, type: 'completed' })
  } catch (error) {
    const reason = owner?.controller.signal.reason
    const timedOut = reason instanceof Error && reason.name === 'TimeoutError'
    const aborted = !timedOut && error instanceof Error && (error.name === 'AbortError' || /aborted|cancel/i.test(error.message))
    if (requestId) {
      sendCoachEvent(
        aborted
          ? { requestId, type: 'cancelled' }
          : {
              requestId,
              type: 'error',
              message: timedOut
                ? 'The coaching request timed out. Try again with a shorter question or attachment.'
                : publicErrorMessage(error, 'The coaching request failed.')
            }
      )
    }
  } finally {
    if (owner) clearTimeout(owner.deadline)
    if (owner && activeCoach?.controller === owner.controller) activeCoach = null
  }
}

function installId(): string {
  if (persisted.installId) return persisted.installId
  const next = randomUUID()
  try {
    savePersistedSettings({ ...persisted, installId: next })
  } catch {
    // The identifier is a best-effort abuse-prevention signal, not user data.
  }
  return next
}

function safetyIdentifier(): string {
  return createHash('sha256').update(`interview-studio:${installId()}`).digest('hex')
}

async function createRealtimeToken(raw: unknown, ownerId: number): Promise<RealtimeToken> {
  if (getActiveProvider() !== 'openai') {
    throw new Error('Live transcription uses OpenAI. Switch the provider back to OpenAI in Settings to use live mode.')
  }
  rateLimit(recentTokenStarts, 8, 60_000, 'Too many microphone sessions. Wait a moment and try again.')
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (!claimConsent(input.consentToken, 'microphone', ownerId)) {
    throw new Error('Microphone consent expired or was not granted. Start the session again.')
  }
  const apiKey = getApiKey().value
  if (!apiKey) throw new Error('Add an OpenAI API key in Settings to enable live transcription.')

  const request: RealtimeTokenRequest = {
    role: cleanString(input.role, LIMITS.roleChars),
    interviewType: cleanString(input.interviewType, LIMITS.interviewTypeChars),
    keywords: Array.isArray(input.keywords)
      ? sanitizeKeywords(input.keywords.filter((item): item is string => typeof item === 'string'))
      : [],
    language: cleanString(input.language, 12).toLowerCase()
  }
  const context = [request.role, request.interviewType].filter(Boolean).join(' interview; ')
  const transcription: Record<string, unknown> = {
    model: 'gpt-live-transcribe',
    delay: 'low'
  }
  if (context) transcription.prompt = `Technical interview context: ${context}`
  if (request.keywords?.length) transcription.keywords = request.keywords
  if (request.language && /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(request.language)) {
    transcription.languages = [request.language]
  }

  let response: Response
  try {
    response = await openAIFetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': safetyIdentifier()
      },
      body: JSON.stringify({
        session: {
          type: 'transcription',
          audio: {
            input: {
              transcription,
              turn_detection: null
            }
          }
        }
      }),
      signal: AbortSignal.timeout(REALTIME_TOKEN_DEADLINE_MS)
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('Realtime transcription setup timed out. Check your connection and try again.')
    }
    throw error
  }

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const error = data.error as Record<string, unknown> | undefined
    const message = publicErrorMessage(
      new Error(cleanString(error?.message, 300) || `Realtime service returned ${response.status}.`),
      'Realtime transcription could not start.'
    )
    throw new Error(message)
  }
  const clientSecret = data.client_secret as Record<string, unknown> | undefined
  const value = cleanString(data.value ?? clientSecret?.value, 2_000)
  if (!value) throw new Error('Realtime service did not return a client token.')
  const expiresAtRaw = data.expires_at ?? clientSecret?.expires_at
  return {
    value,
    expiresAt: typeof expiresAtRaw === 'number' ? expiresAtRaw : undefined,
    model: 'gpt-live-transcribe'
  }
}

async function exchangeRealtimeSdp(raw: unknown): Promise<RealtimeSdpResult> {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const rawToken = typeof input.token === 'string' ? input.token : ''
  const rawSdp = typeof input.sdp === 'string' ? input.sdp : ''
  if (rawToken.length > LIMITS.realtimeTokenChars || rawSdp.length > LIMITS.realtimeSdpChars) {
    throw new Error('The realtime connection request is too large.')
  }
  const token = cleanString(rawToken, LIMITS.realtimeTokenChars)
  const sdp = rawSdp.trim()
  if (token.length < 20 || /\s/.test(token)) throw new Error('The realtime client credential is invalid or expired.')
  if (!sdp || !/^v=0(?:\r?\n)/.test(sdp)) throw new Error('The realtime connection offer is invalid.')

  let response: Response
  try {
    response = await openAIFetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/sdp'
      },
      body: sdp,
      signal: AbortSignal.timeout(REALTIME_SDP_DEADLINE_MS)
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error('Realtime signaling timed out. Check the proxy and try again.')
    }
    throw new Error(publicErrorMessage(error, 'Realtime signaling failed.'))
  }
  if (!response.ok) {
    throw new Error(`Realtime signaling failed (HTTP ${response.status}).`)
  }
  const answer = (await response.text()).trim()
  if (!answer || answer.length > LIMITS.realtimeSdpChars || !/^v=0(?:\r?\n)/.test(answer)) {
    throw new Error('Realtime signaling returned an invalid answer.')
  }
  return { sdp: answer }
}

async function listCaptureSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 960, height: 600 },
    fetchWindowIcons: true
  })
  return sources.map((source) => ({
    id: source.id,
    name: cleanString(source.name, 180) || 'Untitled source',
    thumbnail: source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : undefined
  }))
}

async function exportSession(raw: unknown): Promise<ExportSessionResult> {
  if (!mainWindow || mainWindow.isDestroyed()) return { saved: false }
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const content = typeof input.content === 'string' ? input.content : ''
  if (!content.trim()) throw new Error('There is no session content to export.')
  if (Buffer.byteLength(content, 'utf8') > HISTORY_MAX_BYTES) throw new Error('This conversation exceeds the 64 MB export limit. Select a shorter conversation to export.')
  const requestedName = cleanString(input.suggestedName, LIMITS.exportNameChars)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/^\.+|\.+$/g, '')
  const suggestedName = requestedName || `interview-session-${new Date().toISOString().slice(0, 10)}.md`
  const exportName = /\.(?:md|txt)$/i.test(suggestedName) ? suggestedName : `${suggestedName}.md`
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export session',
    defaultPath: join(app.getPath('documents'), exportName),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] }
    ]
  })
  if (result.canceled || !result.filePath) return { saved: false }
  writeFileSync(result.filePath, `${content}\n`, { encoding: 'utf8', mode: 0o600 })
  return { saved: true, path: result.filePath }
}

function setCompact(next: boolean): void {
  restoreFromBar()
  if (!mainWindow || mainWindow.isDestroyed() || compactMode === next) return
  compactMode = next
  if (next) {
    expandedBounds = mainWindow.getBounds()
    mainWindow.setMinimumSize(460, 560)
    mainWindow.setSize(COMPACT_BOUNDS.width, COMPACT_BOUNDS.height, true)
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating')
  } else {
    mainWindow.setMinimumSize(WINDOW_BOUNDS.minWidth, WINDOW_BOUNDS.minHeight)
    if (expandedBounds) mainWindow.setBounds(expandedBounds, true)
    else mainWindow.setSize(WINDOW_BOUNDS.width, WINDOW_BOUNDS.height, true)
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating')
  }
  sendWindowState()
}

function ownHwndString(): string {
  const window = mainWindow
  if (!window || window.isDestroyed()) return ''
  try {
    return window.getNativeWindowHandle().readBigUInt64LE(0).toString()
  } catch {
    return ''
  }
}

function shortcutLabel(accelerator: string): string {
  return accelerator.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
}

async function restoreAllForeignHotkey(): Promise<void> {
  try {
    rateLimit(recentForeignRestores, 30, 60_000, 'Too many restore attempts. Wait a moment and try again.')
    const result = await restoreAllForeignWindows()
    if (!result.ok) console.error('Foreign-window restore-all could not fully restore:', result.message)
    sendStealthEvent({ foreign: result.message })
  } catch (error) {
    console.error('Foreign-window restore failed:', error)
    sendStealthEvent({ foreign: publicErrorMessage(error, 'The foreign-window restore failed.') })
  }
}

function registerForeignHotkey(kind: 'toggle' | 'restore', candidates: string[]): boolean {
  for (const candidate of candidates) {
    let registered = false
    try {
      registered = globalShortcut.register(candidate, () => {
        if (kind === 'restore') void restoreAllForeignHotkey()
        else void toggleForeignStealthHotkey()
      })
    } catch {
      registered = false
    }
    if (registered) {
      if (kind === 'restore') restoreShortcutActive = candidate
      else foreignShortcutActive = candidate
      return true
    }
  }
  return false
}

/** The foreign-window plan mirrors the stealth settings at the moment the hotkey fires. */
function foreignApplyPlan(): StealthApplyPlan {
  return {
    captureProtection: stealth.enabled && stealth.captureProtection,
    hideFromTaskbar: stealth.enabled && stealth.hideFromTaskbar
  }
}

async function toggleForeignStealthHotkey(): Promise<void> {
  try {
    rateLimit(recentForeignMutations, 30, 60_000, 'Too many window changes. Wait a moment and try again.')
    const result = await toggleForeignWindowStealth(ownHwndString(), process.pid, foreignApplyPlan())
    if (!result.ok) console.error('Foreign-window hotkey rejected the toggle:', result.message)
    sendStealthEvent({ foreign: result.message })
  } catch (error) {
    console.error('Foreign-window hotkey failed:', error)
    sendStealthEvent({ foreign: publicErrorMessage(error, 'The foreign-window hotkey failed.') })
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.historyList, (event, query: unknown) => { assertTrustedSender(event); return conversationHistory.list(typeof query === 'string' ? query : '') })
  ipcMain.handle(IPC.historyGet, (event, id: unknown) => { assertTrustedSender(event); return conversationHistory.get(historyId(id)) })
  ipcMain.handle(IPC.historySave, (event, record: unknown) => { assertTrustedSender(event); return conversationHistory.save(record) })
  ipcMain.handle(IPC.historyRename, (event, raw: unknown) => { assertTrustedSender(event); const input = raw as { id: string; title: string }; return conversationHistory.rename(historyId(input?.id), input?.title) })
  ipcMain.handle(IPC.historyDelete, (event, id: unknown) => { assertTrustedSender(event); return conversationHistory.remove(historyId(id)) })
  ipcMain.on(IPC.historyFlushed, (event, raw: unknown) => {
    if (!isTrustedSender(event)) return
    const input = raw as { token?: string; ok?: boolean }
    const pending = historyFlush
    if (pending && pending.token === input?.token) pending.resolve(input.ok === true)
  })
  ipcMain.handle(IPC.offlineModelsGet, event => { assertTrustedSender(event); return offlineModels.check() })
  ipcMain.handle(IPC.offlineModelsDownload, event => { assertTrustedSender(event); return offlineModels.download() })
  ipcMain.handle(IPC.offlineModelsCancel, event => { assertTrustedSender(event); offlineModels.cancel(); return offlineModels.snapshot() })
  ipcMain.handle(IPC.settingsSetCaptionProvider, (event, raw: unknown): AppSettings => {
    assertTrustedSender(event)
    const captionProvider = normalizeCaptionProvider(raw)
    captionSessions.stop(event.sender.id)
    savePersistedSettings({ ...persisted, captionProvider })
    return publicSettings()
  })
  ipcMain.handle(IPC.captionsStart, async (event, input: unknown) => {
    assertTrustedSender(event)
    rateLimit(recentCaptionStarts, 12, 60_000, 'Too many caption starts. Wait a moment and try again.')
    if (process.platform !== 'win32' && input !== 'microphone') throw new Error('Computer-audio captions currently require Windows. Choose Microphone instead.')
    if (getCaptionProvider() === 'offline') await offlineModels.check()
    assertTrustedSender(event)
    const result = captionSessions.start(event.sender.id, input)
    await captionSessions.prepare(event.sender.id, result.sessionId)
    assertTrustedSender(event)
    return result
  })
  ipcMain.handle(IPC.captionsStop, (event, sessionId: unknown) => { assertTrustedSender(event); if (captionSessions.sessionId === sessionId) captionSessions.stop(event.sender.id) })
  ipcMain.handle(IPC.captionsTranscribe, async (event, input: unknown) => {
    assertTrustedSender(event)
    try { return await captionSessions.transcribe(event.sender.id, input) }
    catch (error) { throw new Error(publicErrorMessage(error, 'Caption transcription failed.')) }
  })
  ipcMain.handle(IPC.captionsTranslate, (event, input: unknown) => {
    assertTrustedSender(event)
    return captionTranslations.translate(event.sender.id, input)
  })
  ipcMain.handle(IPC.captionsRetryTranslation, (event, input: unknown) => {
    assertTrustedSender(event)
    return captionTranslations.retry(event.sender.id, input)
  })
  ipcMain.handle(IPC.captionsCancelTranslations, event => {
    assertTrustedSender(event)
    captionTranslations.cancel(event.sender.id)
    offlineTranslations.stop()
  })
  registerAreaCaptureHandlers(isAllowedRendererUrl)
  ipcMain.handle(IPC.captureArea, async (event, token: unknown) => {
    assertTrustedSender(event)
    if (!validateConsent(token, 'capture', event.sender.id, true)) throw new Error('Screen-reference consent expired or was not granted.')
    return captureScreenArea(mainWindow!, {
      preload: join(__dirname, '../preload/index.js'),
      rendererUrl: `${developmentRendererUrl()?.href ?? rendererEntryUrl()}#area-capture`,
      captureProtection: stealth.enabled && stealth.captureProtection,
      shouldRestoreOwner: () => !quitting && !stealthHidden
    })
  })
  ipcMain.handle(IPC.settingsGet, (event) => {
    assertTrustedSender(event)
    return publicSettings()
  })

  ipcMain.handle(IPC.settingsSetApiKey, (event, raw: unknown): SetApiKeyResult => {
    assertTrustedSender(event)
    const input: SetApiKeyRequest = typeof raw === 'string'
      ? { apiKey: raw, persist: true }
      : {
          apiKey: cleanString((raw as Record<string, unknown> | undefined)?.apiKey, 1_000),
          persist: (raw as Record<string, unknown> | undefined)?.persist !== false
        }
    const apiKey = input.apiKey.trim()
    if (apiKey.length < 20 || /\s/.test(apiKey)) {
      throw new Error('Enter a valid API key without spaces.')
    }
    const overridesEnvironment = Boolean(process.env.OPENAI_API_KEY?.trim())
    if (input.persist && secureStorageAvailable()) {
      const encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64')
      savePersistedSettings({ ...persisted, encryptedApiKey })
      memoryApiKey = ''
      return {
        saved: true,
        persisted: true,
        message: overridesEnvironment
          ? 'Manual API key saved securely. It now overrides OPENAI_API_KEY.'
          : 'API key saved using the operating system credential store.'
      }
    }
    memoryApiKey = apiKey
    return {
      saved: true,
      persisted: false,
      message: overridesEnvironment
        ? 'Manual API key is active for this app session and overrides OPENAI_API_KEY.'
        : input.persist
          ? 'Secure storage is unavailable, so the key will be kept only for this app session.'
          : 'API key will be kept only for this app session.'
    }
  })

  ipcMain.handle(IPC.settingsClearApiKey, (event): AppSettings => {
    assertTrustedSender(event)
    memoryApiKey = ''
    if (persisted.encryptedApiKey) {
      const { encryptedApiKey: _removed, ...rest } = persisted
      savePersistedSettings(rest)
    }
    return publicSettings()
  })

  ipcMain.handle(IPC.settingsSetModel, (event, raw: unknown): AppSettings => {
    assertTrustedSender(event)
    if (normalizeEnvironmentModel(process.env.OPENAI_MODEL)) {
      throw new Error('OPENAI_MODEL is set by the environment and takes precedence over the Settings panel.')
    }
    const model = normalizeCoachingModel(
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>).model : raw
    )
    savePersistedSettings({ ...persisted, model })
    return publicSettings()
  })

  ipcMain.handle(IPC.settingsSetProxy, async (event, raw: unknown): Promise<SetProxyResult> => {
    assertTrustedSender(event)
    return enqueueProxyMutation(() => updateProxySettings(raw))
  })

  ipcMain.handle(IPC.settingsTestProxy, async (event): Promise<ProxyTestResult> => {
    assertTrustedSender(event)
    return testProxyConnection()
  })

  ipcMain.handle(IPC.windowAlwaysOnTop, (event, value: unknown): AppSettings => {
    assertTrustedSender(event)
    alwaysOnTop = Boolean(value)
    mainWindow?.setAlwaysOnTop(minimizedToBar || alwaysOnTop, 'floating')
    return publicSettings()
  })

  ipcMain.handle(IPC.windowCompact, (event, value: unknown): AppSettings => {
    assertTrustedSender(event)
    setCompact(Boolean(value))
    return publicSettings()
  })

  ipcMain.handle(IPC.windowMinimize, (event) => {
    assertTrustedSender(event)
    minimizeToBar()
  })
  ipcMain.handle(IPC.windowRestore, (event) => {
    assertTrustedSender(event)
    showMainWindow()
  })
  ipcMain.handle(IPC.windowMaximize, (event) => {
    assertTrustedSender(event)
    if (!mainWindow) return
    if (minimizedToBar) { showMainWindow(); return }
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle(IPC.windowClose, (event) => {
    assertTrustedSender(event)
    app.quit()
  })

  ipcMain.handle(IPC.stealthSet, (event, raw: unknown): AppSettings => {
    assertTrustedSender(event)
    stealth = normalizeStealth(raw, stealth)
    savePersistedSettings({ ...persisted, stealth: { ...stealth } })
    if (stealthHidden && !stealth.enabled) {
      stealthHidden = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        if (!stealth.noFocusSteal) mainWindow.focus()
        sendStealthEvent({ hidden: false })
      }
    }
    applyStealth()
    return publicSettings()
  })

  ipcMain.on(IPC.stealthEvent, (event) => {
    if (!isTrustedSender(event)) return
    togglePanicHide()
  })

  ipcMain.on(IPC.displayPassthrough, (event, value: unknown) => {
    if (!isTrustedSender(event)) return
    const window = mainWindow
    if (!window || window.isDestroyed()) return
    const active = Boolean(value)
    window.setIgnoreMouseEvents(!minimizedToBar && active, { forward: !minimizedToBar && active })
  })

  ipcMain.handle(IPC.stealthForeignSetHotkey, (event, raw: unknown): ForeignHotkeyResult => {
    assertTrustedSender(event)
    const input = (raw ?? {}) as Record<string, unknown>
    const requested = cleanString(input.accelerator, LIMITS.foreignHotkeyChars)
    const kind = input.kind === 'restore' ? 'restore' : 'toggle'
    if (!requested) return { ok: false, message: 'Press a key combination first.' }
    if (/alt/i.test(requested)) return { ok: false, message: 'Alt is not supported in stealth hotkeys — use Ctrl (optionally with Shift).' }
    const previous = kind === 'restore' ? restoreShortcutActive : foreignShortcutActive
    if (previous) globalShortcut.unregister(previous)
    const registered = registerForeignHotkey(kind, [requested])
    if (registered) {
      savePersistedSettings(kind === 'restore'
        ? { ...persisted, restoreHotkey: requested }
        : { ...persisted, foreignHotkey: requested })
      return {
        ok: true,
        message: kind === 'restore'
          ? `Restore-all hotkey updated to ${shortcutLabel(requested)}.`
          : `Hotkey updated to ${shortcutLabel(requested)}. Press it anywhere to toggle stealth on the focused window.`
      }
    }
    if (previous) {
      registerForeignHotkey(kind, [previous])
    }
    return { ok: false, message: 'That key combination could not be registered. It may be taken by another application or invalid — try a different one.' }
  })

  ipcMain.handle(IPC.consentRequest, async (event, kind: unknown) => {
    assertTrustedSender(event)
    return requestConsent(event, kind)
  })
  ipcMain.handle(IPC.consentRelease, (event, tokenValue: unknown) => {
    assertTrustedSender(event)
    const token = cleanString(tokenValue, 200)
    const grant = token ? consentGrants.get(token) : undefined
    if (grant?.ownerId === event.sender.id) consentGrants.delete(token)
  })

  ipcMain.handle(IPC.captureListSources, async (event, token: unknown) => {
    assertTrustedSender(event)
    if (!validateConsent(token, 'capture', event.sender.id, true)) throw new Error('Screen-reference consent expired or was not granted.')
    return listCaptureSources()
  })

  ipcMain.handle(IPC.sessionExport, async (event, request: unknown) => {
    assertTrustedSender(event)
    return exportSession(request)
  })

  ipcMain.handle(IPC.clipboardWriteText, (event, text: unknown) => {
    assertTrustedSender(event)
    if (typeof text !== 'string' || text.length > LIMITS.exportChars) throw new Error('The response could not be copied.')
    clipboard.writeText(text)
  })

  ipcMain.on(IPC.coachStart, (event, request) => {
    void handleCoachStart(event, request)
  })
  ipcMain.on(IPC.coachCancel, (event, requestId: unknown) => {
    assertTrustedSender(event)
    const id = cleanString(requestId, 100)
    if (id && activeCoach?.requestId === id) {
      activeCoach.controller.abort(new DOMException('Cancelled by the user.', 'AbortError'))
    }
  })

  ipcMain.handle(IPC.realtimeCreateToken, async (event, request) => {
    assertTrustedSender(event)
    return createRealtimeToken(request, event.sender.id)
  })

  ipcMain.handle(IPC.realtimeExchangeSdp, async (event, request) => {
    assertTrustedSender(event)
    return exchangeRealtimeSdp(request)
  })

  ipcMain.handle(IPC.settingsSetProvider, (event, raw: unknown): AppSettings => {
    assertTrustedSender(event)
    return setProvider(raw)
  })

  ipcMain.handle(IPC.translationPacksGet, event => { assertTrustedSender(event); return translationPacks.check() })
  ipcMain.handle(IPC.translationPacksDownload, (event, language: unknown) => { assertTrustedSender(event); return translationPacks.download(language) })
  ipcMain.handle(IPC.translationPacksCancel, event => { assertTrustedSender(event); translationPacks.cancel() })
  ipcMain.handle(IPC.translationPacksRemove, (event, language: unknown) => {
    assertTrustedSender(event)
    captionTranslations.cancel(); offlineTranslations.stop()
    return translationPacks.remove(language)
  })
  ipcMain.handle(IPC.settingsConfigureTranslation, (event, raw: unknown): AppSettings => {
    assertTrustedSender(event)
    translationSettings.configure(raw)
    captionTranslations.cancel()
    offlineTranslations.stop()
    return publicSettings()
  })
  let lastTranslationTest = 0
  ipcMain.handle(IPC.settingsTestTranslation, async event => {
    assertTrustedSender(event)
    if (Date.now() - lastTranslationTest < 3000) return { ok: false, message: 'Wait a moment before testing again.' }
    lastTranslationTest = Date.now()
    try {
      const translate = translationConnection()
      await translate('Hello. How are you?', 'es', AbortSignal.timeout(12_000))
      return { ok: true, message: 'Connected. A short sample translated successfully.' }
    } catch (error) {
      const { status, code } = translationFailure(error)
      return { ok: false, message: /API key in Settings/.test(error instanceof Error ? error.message : '') ? 'Save your translation API key before testing.' : error instanceof Error && /TimeoutError|AbortError/.test(error.name) ? 'Translation connection test timed out. Retry or choose a faster translation model.' : translationErrorMessage(status, code) }
    }
  })
  ipcMain.handle(IPC.settingsConfigureProvider, (event, raw: unknown): AppSettings => {
    assertTrustedSender(event)
    return configureProvider(raw)
  })

  ipcMain.handle(IPC.settingsTestProvider, (event, raw: unknown): Promise<ProviderTestResult> => {
    assertTrustedSender(event)
    return testProviderConnection(normalizeProviderId(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).provider : raw))
  })

  ipcMain.handle(IPC.profilesList, (event): ProfileListResult => {
    assertTrustedSender(event)
    return listProfiles()
  })

  ipcMain.handle(IPC.profilesUpsert, (event, raw: unknown): ProfileMutationResult => {
    assertTrustedSender(event)
    return upsertProfile(raw)
  })

  ipcMain.handle(IPC.profilesDelete, (event, raw: unknown): ProfileMutationResult => {
    assertTrustedSender(event)
    return deleteProfile(raw)
  })

  ipcMain.handle(IPC.profilesSetActive, (event, raw: unknown): ProfileMutationResult => {
    assertTrustedSender(event)
    return setActiveProfile(raw)
  })

  ipcMain.handle(IPC.profilesUploadResume, (event): Promise<ResumeUploadResult> => {
    assertTrustedSender(event)
    return uploadResume()
  })

  ipcMain.handle(IPC.jobsAnalyzeCompany, (event, raw: unknown): Promise<CompanyAnalysisResult> => {
    assertTrustedSender(event)
    return analyzeCompany(raw)
  })

  ipcMain.handle(IPC.jobsList, (event): JobListResult => {
    assertTrustedSender(event)
    return listJobs()
  })

  ipcMain.handle(IPC.jobsUpsert, (event, raw: unknown): JobMutationResult => {
    assertTrustedSender(event)
    return upsertJob(raw)
  })

  ipcMain.handle(IPC.jobsDelete, (event, raw: unknown): JobMutationResult => {
    assertTrustedSender(event)
    return deleteJob(raw)
  })

  ipcMain.handle(IPC.jobsSetActive, (event, raw: unknown): JobMutationResult => {
    assertTrustedSender(event)
    return setActiveJob(raw)
  })
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...WINDOW_BOUNDS,
    icon: windowIconImage(64),
    show: false,
    frame: false,
    backgroundColor: '#090b10',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(platform\.openai\.com|developers\.openai\.com)\//.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  window.webContents.on('page-title-updated', (event) => {
    if (stealth.enabled && stealth.disguiseTitle) event.preventDefault()
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) captionSessions.stop() })
  window.webContents.on('destroyed', () => {
    captionSessions.stop()
    activeCoach?.controller.abort(new DOMException('Window closed.', 'AbortError'))
    activeCoach = null
    stealthHidden = false
    consentGrants.clear()
  })

  window.setAlwaysOnTop(alwaysOnTop, 'floating')
  window.on('minimize', () => {
    setImmediate(() => {
      if (window.isDestroyed() || quitting || stealthHidden) return
      if (window.isMinimized()) window.restore()
      if (!minimizedToBar) minimizeToBar()
      else window.showInactive()
    })
  })
  window.on('close', (event) => {
    captionSessions.stop()
    if (!quitting && !window.isDestroyed()) {
      event.preventDefault()
      app.quit()
    }
  })

  const developmentUrl = developmentRendererUrl()
  if (developmentUrl) {
    void window.loadURL(developmentUrl.href)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

app.on('login', (event, _webContents, _details, authInfo, callback) => {
  if (!authInfo.isProxy || runtimeProxy.mode !== 'http') return
  event.preventDefault()
  if (
    (runtimeProxy.username || runtimeProxy.password) &&
    proxyAuthMatches(runtimeProxy, authInfo)
  ) {
    callback(runtimeProxy.username, runtimeProxy.password)
    return
  }
  callback()
})

app.whenReady().then(async () => {
  // Use Electron's scoped API, never remove the userData directory or call
  // clearStorageData: those also contain settings and the session library.
  const cacheDeadline = new AbortController()
  try {
    await Promise.race([
      session.defaultSession.clearCache(),
      delay(3000, undefined, { signal: cacheDeadline.signal }).then(() => { throw new Error('HTTP cache reset timed out.') })
    ])
  }
  catch { console.warn('HTTP cache reset was unavailable. HTTP disk caching remains disabled; saved app data is preserved.') }
  finally { cacheDeadline.abort() }
  persisted = loadPersistedSettings()
  if (persisted.jobs === undefined) migrateLegacyJobs()
  stealth = normalizeStealth(persisted.stealth, stealth)
  restoreRuntimeProxy()
  if (!proxyApplyError) {
    try {
      await applyProxyNow(runtimeProxy)
    } catch (error) {
      console.error(publicErrorMessage(error, 'Could not apply saved proxy settings.'))
    }
  }

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = mainWindow?.webContents === webContents && details.isMainFrame && isAllowedRendererUrl(details.requestingUrl) && isAllowedRendererUrl(webContents.getURL())
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    // Electron 38 reports display media as `media` with no device types;
    // newer versions use the separate `display-capture` permission.
    const displayCapture = permission === 'display-capture' || (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0)
    if (displayCapture) { callback(Boolean(trusted && captionSessions.allows(webContents.id, 'computer'))); return }
    const microphoneOnly = Boolean(mediaTypes?.length && mediaTypes.every((type) => type === 'audio'))
    callback(Boolean(trusted && permission === 'media' && microphoneOnly && (captionSessions.allows(webContents.id, 'microphone') || hasActiveConsent('microphone', webContents.id, true))))
  })
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    return Boolean(
      mainWindow?.webContents === webContents &&
      details.isMainFrame &&
      details.requestingUrl && isAllowedRendererUrl(details.requestingUrl) &&
      isAllowedRendererUrl(webContents.getURL()) &&
      permission === 'media' &&
      details.mediaType === 'audio' &&
      (captionSessions.allows(webContents.id, 'microphone') || hasActiveConsent('microphone', webContents.id, true))
    )
  })

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const owner = mainWindow
    if (!owner || owner.isDestroyed() || request.frame !== owner.webContents.mainFrame || !isAllowedRendererUrl(request.frame.url) || !request.audioRequested || !captionSessions.claimDisplay(owner.webContents.id)) { callback({}); return }
    const sessionId = captionSessions.sessionId
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      if (captionSessions.sessionId !== sessionId || !sources[0]) { callback({}); return }
      callback({ video: sources[0], audio: 'loopback' })
    } catch { callback({}) }
  })

  registerIpc()
  primeForeignWindowBindings()
  mainWindow = createWindow()
  applyStealth()

  globalShortcut.register(GLOBAL_SHORTCUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (stealthHidden) {
      showMainWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send(IPC.shortcutToggle)
  })

  globalShortcut.register(PANIC_SHORTCUT, () => {
    togglePanicHide()
  })

  globalShortcut.register(PASSTHROUGH_SHORTCUT, () => {
    stealth = { ...stealth, mousePassthrough: !stealth.mousePassthrough }
    savePersistedSettings({ ...persisted, stealth: { ...stealth } })
    applyStealth()
    sendStealthEvent({ passthrough: stealth.mousePassthrough })
  })

  const toggleCandidates = persisted.foreignHotkey
    ? [persisted.foreignHotkey, ...FOREIGN_SHORTCUT_CANDIDATES]
    : FOREIGN_SHORTCUT_CANDIDATES
  if (registerForeignHotkey('toggle', toggleCandidates)) {
    console.error(`Foreign-window stealth hotkey registered as ${shortcutLabel(foreignShortcutActive)}.`)
  } else {
    console.error('The foreign-window stealth hotkey could not be registered; every fallback is already taken by another application.')
  }
  const restoreCandidates = persisted.restoreHotkey
    ? [persisted.restoreHotkey, ...RESTORE_SHORTCUT_CANDIDATES]
    : RESTORE_SHORTCUT_CANDIDATES
  if (registerForeignHotkey('restore', restoreCandidates)) {
    console.error(`Foreign-window restore-all hotkey registered as ${shortcutLabel(restoreShortcutActive)}.`)
  } else {
    console.error('The foreign-window restore-all hotkey could not be registered; every fallback is already taken by another application.')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const restoreCompact = compactMode
      compactMode = false
      mainWindow = createWindow()
      applyStealth()
      if (restoreCompact) setCompact(true)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let foreignWindowsRestoredForQuit = false
let foreignWindowQuitCleanup: Promise<void> | null = null

app.on('before-quit', (event) => {
  offlineModels.cancel()
  translationPacks.cancel()
  offlineTranslations.stop()
  captionSessions.stop()
  cancelAreaCapture()
  if (foreignWindowsRestoredForQuit) {
    quitting = true
    return
  }
  event.preventDefault()
  if (foreignWindowQuitCleanup) return
  foreignWindowQuitCleanup = (async () => {
    activeCoach?.controller.abort(new DOMException('Application closing.', 'AbortError'))
    if (!await flushConversationHistory()) {
      sendStealthEvent({ foreign: 'Conversation history could not be saved. Retry closing after saving succeeds, or export the conversation.' })
      restoreFromBar(); mainWindow?.showInactive()
      foreignWindowQuitCleanup = null
      return
    }
    try {
      const result = await restoreAllForeignWindows()
      if (!result.ok) {
        console.error('Foreign-window cleanup was incomplete:', result.message)
        sendStealthEvent({ foreign: `Exit paused: ${result.message}` })
        restoreFromBar(); mainWindow?.showInactive()
        foreignWindowQuitCleanup = null
        return
      }
    } catch (error) {
      console.error('Foreign-window cleanup failed:', error)
      sendStealthEvent({ foreign: 'Exit paused because a modified window could not be restored. Try restore-all, then exit again.' })
      restoreFromBar(); mainWindow?.showInactive()
      foreignWindowQuitCleanup = null
      return
    }
    foreignWindowsRestoredForQuit = true
    app.quit()
  })()
})

app.on('will-quit', () => {
  if (activeCoach) {
    clearTimeout(activeCoach.deadline)
    activeCoach.controller.abort(new DOMException('Application closed.', 'AbortError'))
    activeCoach = null
  }
  consentGrants.clear()
  globalShortcut.unregisterAll()
})
