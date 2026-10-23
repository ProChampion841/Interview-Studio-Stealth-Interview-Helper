import { contextBridge, ipcRenderer } from 'electron'
import type { CaptionChunk, CaptionInput, CaptionLine, CaptionProvider, OfflineModelStatus } from '../../shared/captions'
import type { CaptionTranslationRequest, CaptionTranslationRetryRequest, CaptionTranslationResult } from '../../shared/caption-translation'
import type { ConfigureTranslationRequest } from '../../shared/translation-settings'
import type { OfflineTranslationStatus } from '../../shared/offline-translation'
import type { ConversationRecord, ConversationList, ConversationSummary } from '../../shared/conversation-history'
import {
  IPC,
  type AppSettings,
  type CaptureSource,
  type CaptureArea,
  type CoachEvent,
  type CoachRequest,
  type CompanyAnalysisResult,
  type ConfigureProviderRequest,
  type ConsentGrant,
  type ConsentKind,
  type ExportSessionRequest,
  type ExportSessionResult,
  type ForeignHotkeyResult,
  type JobListResult,
  type JobMutationResult,
  type JobUpsertRequest,
  type ProfileListResult,
  type ProfileMutationResult,
  type ProfileUpsertRequest,
  type ProviderTestResult,
  type ProxyTestResult,
  type RealtimeSdpRequest,
  type RealtimeSdpResult,
  type RealtimeToken,
  type RealtimeTokenRequest,
  type ResumeUploadResult,
  type SetApiKeyResult,
  type SetProxyRequest,
  type SetProxyResult,
  type StealthSettings
} from '../../shared/contracts'

type CoachInput = Omit<CoachRequest, 'requestId' | 'mode'> &
  Partial<Pick<CoachRequest, 'mode'>> &
  Record<string, unknown>

const studioApi = {
  listHistory: (query = ''): Promise<ConversationList> => ipcRenderer.invoke(IPC.historyList, query),
  getHistory: (id: string): Promise<ConversationRecord> => ipcRenderer.invoke(IPC.historyGet, id),
  saveHistory: (record: ConversationRecord): Promise<ConversationSummary> => ipcRenderer.invoke(IPC.historySave, record),
  renameHistory: (id: string, title: string): Promise<ConversationSummary> => ipcRenderer.invoke(IPC.historyRename, { id, title }),
  deleteHistory: (id: string): Promise<void> => ipcRenderer.invoke(IPC.historyDelete, id),
  onHistoryFlush: (callback: () => Promise<void>): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, token: string) => {
      void callback().then(() => ipcRenderer.send(IPC.historyFlushed, { token, ok: true }), () => ipcRenderer.send(IPC.historyFlushed, { token, ok: false }))
    }
    ipcRenderer.on(IPC.historyFlush, listener)
    return () => ipcRenderer.removeListener(IPC.historyFlush, listener)
  },
  getTranslationPacks: (): Promise<OfflineTranslationStatus> => ipcRenderer.invoke(IPC.translationPacksGet),
  downloadTranslationPack: (language: string): Promise<OfflineTranslationStatus> => ipcRenderer.invoke(IPC.translationPacksDownload, language),
  cancelTranslationPackDownload: (): Promise<void> => ipcRenderer.invoke(IPC.translationPacksCancel),
  removeTranslationPack: (language: string): Promise<OfflineTranslationStatus> => ipcRenderer.invoke(IPC.translationPacksRemove, language),
  onTranslationPackStatus: (callback: (status: OfflineTranslationStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: OfflineTranslationStatus) => callback(status)
    ipcRenderer.on(IPC.translationPacksStatus, listener)
    return () => ipcRenderer.removeListener(IPC.translationPacksStatus, listener)
  },
  configureTranslation: (request: ConfigureTranslationRequest): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsConfigureTranslation, request),
  testTranslation: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke(IPC.settingsTestTranslation),
  translateCaption: (request: CaptionTranslationRequest): Promise<CaptionTranslationResult> => ipcRenderer.invoke(IPC.captionsTranslate, request),
  retryCaptionTranslation: (request: CaptionTranslationRetryRequest): Promise<CaptionTranslationResult> => ipcRenderer.invoke(IPC.captionsRetryTranslation, request),
  cancelCaptionTranslations: (): Promise<void> => ipcRenderer.invoke(IPC.captionsCancelTranslations),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke(IPC.clipboardWriteText, text),
  startCaptions: (input: CaptionInput): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC.captionsStart, input),
  stopCaptions: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.captionsStop, sessionId),
  transcribeCaption: (input: CaptionChunk): Promise<CaptionLine[]> => ipcRenderer.invoke(IPC.captionsTranscribe, {
    ...(input.streaming !== undefined ? { streaming: input.streaming } : {}),
    sessionId: input.sessionId, source: input.source, sequence: input.sequence, startMs: input.startMs, pcm: input.pcm
  }),
  onCaptionsStopped: (callback: (sessionId: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on(IPC.captionsStopped, listener)
    return () => ipcRenderer.removeListener(IPC.captionsStopped, listener)
  },
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  setCaptionProvider: (provider: CaptionProvider): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsSetCaptionProvider, provider),
  getOfflineModels: (): Promise<OfflineModelStatus> => ipcRenderer.invoke(IPC.offlineModelsGet),
  downloadOfflineModels: (): Promise<OfflineModelStatus> => ipcRenderer.invoke(IPC.offlineModelsDownload),
  cancelOfflineModelDownload: (): Promise<OfflineModelStatus> => ipcRenderer.invoke(IPC.offlineModelsCancel),
  onOfflineModelStatus: (callback: (status: OfflineModelStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: OfflineModelStatus) => callback(status)
    ipcRenderer.on(IPC.offlineModelsStatus, listener)
    return () => ipcRenderer.removeListener(IPC.offlineModelsStatus, listener)
  },
  setApiKey: (apiKeyOrRequest: string | { apiKey: string; persist?: boolean }, persist = true): Promise<SetApiKeyResult> => {
    const request = typeof apiKeyOrRequest === 'string'
      ? { apiKey: apiKeyOrRequest, persist }
      : { apiKey: apiKeyOrRequest.apiKey, persist: apiKeyOrRequest.persist ?? persist }
    return ipcRenderer.invoke(IPC.settingsSetApiKey, request)
  },
  clearApiKey: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsClearApiKey),
  setModel: (model: string): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsSetModel, { model }),
  setProxy: (request: SetProxyRequest): Promise<SetProxyResult> => ipcRenderer.invoke(IPC.settingsSetProxy, {
    mode: request.mode,
    host: request.host,
    port: request.port,
    username: request.username,
    password: request.password,
    clearPassword: request.clearPassword
  }),
  testProxy: (): Promise<ProxyTestResult> => ipcRenderer.invoke(IPC.settingsTestProxy),
  setAlwaysOnTop: (value: boolean): Promise<AppSettings> => ipcRenderer.invoke(IPC.windowAlwaysOnTop, value),
  setCompactMode: (value: boolean): Promise<AppSettings> => ipcRenderer.invoke(IPC.windowCompact, value),
  setStealth: (partial: Partial<StealthSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.stealthSet, partial),
  panicHide: (): void => ipcRenderer.send(IPC.stealthEvent, { panic: true }),
  setPassthrough: (active: boolean): void => ipcRenderer.send(IPC.displayPassthrough, active),
  setForeignHotkey: (accelerator: string, kind?: 'toggle' | 'restore'): Promise<ForeignHotkeyResult> =>
    ipcRenderer.invoke(IPC.stealthForeignSetHotkey, { accelerator, kind }),
  onStealthEvent: (callback: (payload: { hidden?: boolean; passthrough?: boolean; foreign?: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { hidden?: boolean; passthrough?: boolean }): void => callback(value)
    ipcRenderer.on(IPC.stealthEvent, listener)
    return () => ipcRenderer.removeListener(IPC.stealthEvent, listener)
  },
  requestConsent: (kind: ConsentKind): Promise<ConsentGrant | null> => {
    return ipcRenderer.invoke(IPC.consentRequest, kind)
  },
  releaseConsent: (token: string): Promise<void> => ipcRenderer.invoke(IPC.consentRelease, token),
  listCaptureSources: async (): Promise<CaptureSource[]> => {
    const grant = await ipcRenderer.invoke(IPC.consentRequest, 'capture') as ConsentGrant | null
    if (!grant) return []
    return ipcRenderer.invoke(IPC.captureListSources, grant.token)
  },
  captureArea: async (): Promise<CaptureSource | null> => {
    const grant = await ipcRenderer.invoke(IPC.consentRequest, 'capture') as ConsentGrant | null
    if (!grant) return null
    return ipcRenderer.invoke(IPC.captureArea, grant.token)
  },
  exportSession: (request: ExportSessionRequest): Promise<ExportSessionResult> => {
    return ipcRenderer.invoke(IPC.sessionExport, {
      content: request.content,
      suggestedName: request.suggestedName
    })
  },
  startCoach: (input: CoachInput): string => {
    const requestId = globalThis.crypto.randomUUID()
    ipcRenderer.send(IPC.coachStart, {
      requestId,
      mode: input.mode === 'chat' ? 'chat' : 'live',
      question: input.question,
      transcript: input.transcript,
      profile: input.profile,
      role: input.role,
      interviewType: input.interviewType,
      responseStyle: input.responseStyle,
      imageDataUrl: input.imageDataUrl,
      imageDataUrls: input.imageDataUrls,
      consentToken: input.consentToken,
      profileId: typeof input.profileId === 'string' ? input.profileId : undefined,
      jobId: typeof input.jobId === 'string' ? input.jobId : undefined
    })
    return requestId
  },
  cancelCoach: (requestId?: string): void => ipcRenderer.send(IPC.coachCancel, requestId ?? ''),
  onCoachEvent: (callback: (event: CoachEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: CoachEvent): void => callback(value)
    ipcRenderer.on(IPC.coachEvent, listener)
    return () => ipcRenderer.removeListener(IPC.coachEvent, listener)
  },
  createRealtimeToken: (request: RealtimeTokenRequest = {}): Promise<RealtimeToken> => {
    return ipcRenderer.invoke(IPC.realtimeCreateToken, {
      role: request.role,
      interviewType: request.interviewType,
      keywords: request.keywords,
      language: request.language,
      consentToken: request.consentToken
    })
  },
  exchangeRealtimeSdp: (request: RealtimeSdpRequest): Promise<RealtimeSdpResult> => {
    return ipcRenderer.invoke(IPC.realtimeExchangeSdp, {
      token: request.token,
      sdp: request.sdp
    })
  },
  onShortcut: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.shortcutToggle, listener)
    return () => ipcRenderer.removeListener(IPC.shortcutToggle, listener)
  },
  minimize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMinimize),
  restoreWindow: (): Promise<void> => ipcRenderer.invoke(IPC.windowRestore),
  onWindowState: (callback: (state: { minimizedToBar: boolean; compactMode: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { minimizedToBar: boolean; compactMode: boolean }): void => callback(state)
    ipcRenderer.on(IPC.windowState, listener)
    return () => ipcRenderer.removeListener(IPC.windowState, listener)
  },
  maximize: (): Promise<void> => ipcRenderer.invoke(IPC.windowMaximize),
  close: (): Promise<void> => ipcRenderer.invoke(IPC.windowClose),
  setProvider: (provider: string): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsSetProvider, { provider }),
  configureProvider: (request: ConfigureProviderRequest): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsConfigureProvider, {
      provider: request.provider,
      baseUrl: request.baseUrl,
      model: request.model,
      apiKey: request.apiKey
    }),
  testProvider: (provider: string): Promise<ProviderTestResult> =>
    ipcRenderer.invoke(IPC.settingsTestProvider, { provider }),
  listProfiles: (): Promise<ProfileListResult> => ipcRenderer.invoke(IPC.profilesList),
  upsertProfile: (request: ProfileUpsertRequest): Promise<ProfileMutationResult> =>
    ipcRenderer.invoke(IPC.profilesUpsert, {
      id: request.id,
      name: request.name,
      details: request.details,
      resumeText: request.resumeText
    }),
  deleteProfile: (id: string): Promise<ProfileMutationResult> => ipcRenderer.invoke(IPC.profilesDelete, { id }),
  setActiveProfile: (id: string): Promise<ProfileMutationResult> => ipcRenderer.invoke(IPC.profilesSetActive, { id }),
  uploadResume: (): Promise<ResumeUploadResult> => ipcRenderer.invoke(IPC.profilesUploadResume),
  listJobs: (): Promise<JobListResult> => ipcRenderer.invoke(IPC.jobsList),
  upsertJob: (request: JobUpsertRequest): Promise<JobMutationResult> =>
    ipcRenderer.invoke(IPC.jobsUpsert, {
      id: request.id,
      name: request.name,
      jobDescription: request.jobDescription,
      companyName: request.companyName,
      companyWebsite: request.companyWebsite,
      companySocial: request.companySocial
    }),
  deleteJob: (id: string): Promise<JobMutationResult> => ipcRenderer.invoke(IPC.jobsDelete, { id }),
  setActiveJob: (id: string): Promise<JobMutationResult> => ipcRenderer.invoke(IPC.jobsSetActive, { id }),
  analyzeCompany: (jobId: string): Promise<CompanyAnalysisResult> =>
    ipcRenderer.invoke(IPC.jobsAnalyzeCompany, { jobId })
}

contextBridge.exposeInMainWorld('studio', studioApi)
contextBridge.exposeInMainWorld('studioArea', {
  getSnapshot: (): Promise<{ imageDataUrl: string; name: string }> => ipcRenderer.invoke(IPC.captureAreaSnapshot),
  select: (area: CaptureArea): Promise<void> => ipcRenderer.invoke(IPC.captureAreaSelect, { x: area.x, y: area.y, width: area.width, height: area.height }),
  cancel: (): Promise<void> => ipcRenderer.invoke(IPC.captureAreaCancel)
})

export type StudioApi = typeof studioApi
