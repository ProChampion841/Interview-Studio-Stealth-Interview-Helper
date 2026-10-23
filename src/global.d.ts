export {};
import type { CaptionChunk, CaptionInput, CaptionLine, CaptionProvider, OfflineModelStatus } from '../shared/captions';
import type { CaptionTranslationRequest, CaptionTranslationRetryRequest, CaptionTranslationResult } from '../shared/caption-translation';
import type { ConfigureTranslationRequest, PublicTranslationSettings } from '../shared/translation-settings';
import type { OfflineTranslationStatus } from '../shared/offline-translation';
import type { ConversationRecord, ConversationList, ConversationSummary } from '../shared/conversation-history';

declare global {
  type StudioSessionMode = "live" | "chat";
  type StudioConsentKind = "session" | "microphone" | "capture";

  type StudioCaptureSource = {
    id: string;
    name: string;
    thumbnail: string;
    appIcon?: string;
  };

  type StudioSettings = {
    translation: PublicTranslationSettings;
    captionProvider: CaptionProvider;
    hasApiKey: boolean;
    apiKeySource: "environment" | "secure-storage" | "memory" | "none";
    secureStorageAvailable: boolean;
    model: string;
    modelSource: "environment" | "settings" | "default";
    proxy: StudioProxySettings;
    alwaysOnTop: boolean;
    compactMode: boolean;
    minimizedToBar: boolean;
    shortcut: string;
    stealth: StudioStealthSettings;
    panicShortcut: string;
    passthroughShortcut: string;
    foreignShortcut: string;
    restoreShortcut: string;
    provider: StudioProviderId;
    providers: Record<StudioProviderId, StudioProviderStatus>;
  };

  type StudioStealthSettings = {
    enabled: boolean;
    captureProtection: boolean;
    hideFromTaskbar: boolean;
    disguiseTitle: boolean;
    decoyTitle: string;
    noFocusSteal: boolean;
    opacity: number;
    mousePassthrough: boolean;
  };

  type StudioProxyMode = "system" | "direct" | "http" | "socks5";

  type StudioProxySettings = {
    mode: StudioProxyMode;
    host: string;
    port?: number;
    username: string;
    hasPassword: boolean;
    credentialsAvailable: boolean;
    persistence: "settings" | "secure-storage" | "memory" | "none";
  };

  type StudioProxyRequest = {
    mode: StudioProxyMode;
    host?: string;
    port?: number | string;
    username?: string;
    password?: string;
    clearPassword?: boolean;
  };

  type StudioApiKeyResult = {
    saved: boolean;
    persisted: boolean;
    message: string;
  };

  type StudioConsentGrant = {
    kind: StudioConsentKind;
    token: string;
    expiresAt: number;
  };

  type StudioCoachRequest = {
    question: string;
    transcript?: string;
    profile?: string;
    profileId?: string;
    jobId?: string;
    imageDataUrl?: string;
    imageDataUrls?: string[];
    role?: string;
    interviewType?: string;
    responseStyle?: string;
    mode?: StudioSessionMode;
    consentToken?: string;
  };

  type StudioCoachEvent =
    | { requestId: string; type: "started"; demo: boolean; provider?: StudioProviderId; model?: string }
    | { requestId: string; type: "fallback"; from: StudioProviderId; to: StudioProviderId; model: string; message: string }
    | { requestId: string; type: "delta"; delta: string }
    | { requestId: string; type: "completed" }
    | { requestId: string; type: "cancelled" }
    | { requestId: string; type: "error"; message: string };

  type StudioRealtimeToken = {
    value: string;
    expiresAt?: number;
    model: string;
  };

  type StudioExportResult = {
    saved: boolean;
    path?: string;
  };

  type StudioProviderId = "openai" | "nanogpt" | "openrouter" | "lmstudio";

  type StudioProviderStatus = {
    configured: boolean;
    keySource: "environment" | "secure-storage" | "memory" | "none";
    baseUrl: string;
    model: string;
    modelSource: "environment" | "settings" | "default";
  };

  type StudioProviderTestResult = {
    ok: boolean;
    message: string;
    models?: string[];
  };

  type StudioConfigureProviderRequest = {
    provider: StudioProviderId;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  };

  type StudioCoachProfile = {
    id: string;
    name: string;
    details: string;
    resumeText: string;
    updatedAt: string;
  };

  type StudioCoachJob = {
    id: string;
    name: string;
    jobDescription: string;
    companyName: string;
    companyWebsite: string;
    companySocial: string;
    companyBrief: string;
    updatedAt: string;
  };

  type StudioProfileListResult = {
    profiles: StudioCoachProfile[];
    activeProfileId: string | null;
  };

  type StudioProfileMutationResult = {
    profiles: StudioCoachProfile[];
    activeProfileId: string | null;
    profile?: StudioCoachProfile;
  };

  type StudioProfileUpsertRequest = {
    id?: string;
    name: string;
    details?: string;
    resumeText?: string;
  };

  type StudioJobListResult = {
    jobs: StudioCoachJob[];
    activeJobId: string | null;
  };

  type StudioJobMutationResult = {
    jobs: StudioCoachJob[];
    activeJobId: string | null;
    job?: StudioCoachJob;
  };

  type StudioJobUpsertRequest = {
    id?: string;
    name: string;
    jobDescription?: string;
    companyName?: string;
    companyWebsite?: string;
    companySocial?: string;
  };

  type StudioResumeUploadResult = {
    text: string;
    fileName: string;
    truncated: boolean;
  };

  type StudioCompanyAnalysisResult = {
    companyBrief: string;
    warning?: string;
  };

  type StudioForeignHotkeyResult = {
    ok: boolean;
    message: string;
  };

  interface Window {
    studioArea?: {
      getSnapshot: () => Promise<{ imageDataUrl: string; name: string }>;
      select: (area: { x: number; y: number; width: number; height: number }) => Promise<void>;
      cancel: () => Promise<void>;
    };
    studio?: {
      listHistory: (query?: string) => Promise<ConversationList>;
      getHistory: (id: string) => Promise<ConversationRecord>;
      saveHistory: (record: ConversationRecord) => Promise<ConversationSummary>;
      renameHistory: (id: string, title: string) => Promise<ConversationSummary>;
      deleteHistory: (id: string) => Promise<void>;
      onHistoryFlush: (callback: () => Promise<void>) => () => void;
      translateCaption: (request: CaptionTranslationRequest) => Promise<CaptionTranslationResult>;
      retryCaptionTranslation: (request: CaptionTranslationRetryRequest) => Promise<CaptionTranslationResult>;
      cancelCaptionTranslations: () => Promise<void>;
      copyText: (text: string) => Promise<void>;
      startCaptions: (input: CaptionInput) => Promise<{ sessionId: string }>;
      stopCaptions: (sessionId: string) => Promise<void>;
      transcribeCaption: (input: CaptionChunk) => Promise<CaptionLine[]>;
      onCaptionsStopped: (listener: (sessionId: string) => void) => () => void;
      getSettings: () => Promise<StudioSettings>;
      getTranslationPacks: () => Promise<OfflineTranslationStatus>;
      downloadTranslationPack: (language: string) => Promise<OfflineTranslationStatus>;
      cancelTranslationPackDownload: () => Promise<void>;
      removeTranslationPack: (language: string) => Promise<OfflineTranslationStatus>;
      onTranslationPackStatus: (callback: (status: OfflineTranslationStatus) => void) => () => void;
      configureTranslation: (request: ConfigureTranslationRequest) => Promise<StudioSettings>;
      testTranslation: () => Promise<{ ok: boolean; message: string }>;
      setCaptionProvider: (provider: CaptionProvider) => Promise<StudioSettings>;
      getOfflineModels: () => Promise<OfflineModelStatus>;
      downloadOfflineModels: () => Promise<OfflineModelStatus>;
      cancelOfflineModelDownload: () => Promise<OfflineModelStatus>;
      onOfflineModelStatus: (callback: (status: OfflineModelStatus) => void) => () => void;
      setApiKey: (
        apiKeyOrRequest: string | { apiKey: string; persist?: boolean },
        persist?: boolean,
      ) => Promise<StudioApiKeyResult>;
      clearApiKey: () => Promise<StudioSettings>;
      setModel: (model: string) => Promise<StudioSettings>;
      setProxy: (request: StudioProxyRequest) => Promise<{ settings: StudioSettings; message: string }>;
      testProxy: () => Promise<{
        ok: boolean;
        message: string;
        route: "system" | "direct" | "http" | "socks5" | "unknown";
      }>;
      setAlwaysOnTop: (enabled: boolean) => Promise<StudioSettings>;
      setCompactMode: (enabled: boolean) => Promise<StudioSettings>;
      setStealth: (partial: Partial<StudioStealthSettings>) => Promise<StudioSettings>;
      panicHide: () => void;
      setPassthrough: (active: boolean) => void;
      setForeignHotkey: (accelerator: string, kind?: "toggle" | "restore") => Promise<StudioForeignHotkeyResult>;
      onStealthEvent: (listener: (payload: { hidden?: boolean; passthrough?: boolean; foreign?: string }) => void) => () => void;
      requestConsent: (kind: StudioConsentKind) => Promise<StudioConsentGrant | null>;
      releaseConsent: (token: string) => Promise<void>;
      listCaptureSources: () => Promise<StudioCaptureSource[]>;
      captureArea: () => Promise<StudioCaptureSource | null>;
      exportSession: (request: { content: string; suggestedName?: string }) => Promise<StudioExportResult>;
      startCoach: (request: StudioCoachRequest) => string;
      cancelCoach: (requestId?: string) => void;
      onCoachEvent: (listener: (event: StudioCoachEvent) => void) => () => void;
      createRealtimeToken: (context?: {
        role?: string;
        interviewType?: string;
        keywords?: string[];
        language?: string;
        consentToken?: string;
      }) => Promise<StudioRealtimeToken>;
      exchangeRealtimeSdp: (request: { token: string; sdp: string }) => Promise<{ sdp: string }>;
      onShortcut: (listener: () => void) => () => void;
      minimize: () => Promise<void>;
      restoreWindow: () => Promise<void>;
      onWindowState: (listener: (state: { minimizedToBar: boolean; compactMode: boolean }) => void) => () => void;
      maximize: () => Promise<void>;
      close: () => Promise<void>;
      setProvider: (provider: string) => Promise<StudioSettings>;
      configureProvider: (request: StudioConfigureProviderRequest) => Promise<StudioSettings>;
      testProvider: (provider: string) => Promise<StudioProviderTestResult>;
      listProfiles: () => Promise<StudioProfileListResult>;
      upsertProfile: (request: StudioProfileUpsertRequest) => Promise<StudioProfileMutationResult>;
      deleteProfile: (id: string) => Promise<StudioProfileMutationResult>;
      setActiveProfile: (id: string) => Promise<StudioProfileMutationResult>;
      uploadResume: () => Promise<StudioResumeUploadResult>;
      listJobs: () => Promise<StudioJobListResult>;
      upsertJob: (request: StudioJobUpsertRequest) => Promise<StudioJobMutationResult>;
      deleteJob: (id: string) => Promise<StudioJobMutationResult>;
      setActiveJob: (id: string) => Promise<StudioJobMutationResult>;
      analyzeCompany: (jobId: string) => Promise<StudioCompanyAnalysisResult>;
    };
  }
}
