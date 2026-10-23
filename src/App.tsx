import {
  Activity,
  BrainCircuit,
  Briefcase,
  Camera,
  Captions,
  Check,
  ChevronDown,
  Crop,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Library,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minimize2,
  MonitorUp,
  MoreHorizontal,
  Pencil,
  Pin,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { DragEvent, FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import {
  COACHING_MODELS,
  LIMITS,
  PROVIDER_NAMES,
  type ProxyMode,
  type PublicProxySettings,
  type SetProxyRequest,
} from "../shared/contracts";
import { parseScreenshotAttachments } from "../shared/screenshots";
import { normalizeResponseStyle, RESPONSE_STYLES } from "../shared/prompt";
import { CAPTION_PROVIDER_NAMES, type CaptionProvider } from "../shared/captions";
import { useCaptions, type CaptionControls } from "./lib/use-captions";
import CaptionsPanel, { type CaptionActions } from "./CaptionsPanel";
import FloatingBar from "./FloatingBar";
import QuestionAnswers, { QuestionPicker } from "./QuestionAnswers";
import { useConversationHistory } from "./lib/use-conversation-history";
import { useConversationMemory } from "./lib/use-conversation-memory";
import { exportConversation, questionThreadContext, type ConversationRecord, type ConversationSummary, type QuestionExchange, type QuestionThread } from "../shared/conversation-history";
import CaptionContext from "./CaptionContext";
import { latestCaptionQuestion, mergeCaptionContext, type CaptionContextItem, type CaptionQuestion } from "../shared/caption-question";
import OfflineCaptionSetup from "./OfflineCaptionSetup";
import MenuSelect from "./MenuSelect";
import TranslationSettings from "./TranslationSettings";
import { DEFAULT_TRANSLATION_SETTINGS, type ConfigureTranslationRequest, type PublicTranslationSettings } from "../shared/translation-settings";
import ActionMenu from "./ActionMenu";
import CopyButton from "./CopyButton";
import ConnectionFeedback from "./ConnectionFeedback";
import logoUrl from "../build/logo.svg";

type View = "session" | "library" | "settings";
type CoachStatus = "idle" | "thinking" | "ready" | "error";
type ApiKeySource = StudioSettings["apiKeySource"];
type ModelSource = StudioSettings["modelSource"];

type ConnectionStatus = {
  tone: "neutral" | "working" | "success" | "error";
  message: string;
};

type SessionSnapshot = ConversationSummary;

const MAX_DROPPED_IMAGE_EDGE = 1280;
const MAX_DROPPED_IMAGE_CHARS = 4_000_000;

const emptyProviderStatuses = (): Record<StudioProviderId, StudioProviderStatus> => ({
  openai: { configured: false, keySource: "none", baseUrl: "", model: "", modelSource: "default" },
  nanogpt: { configured: false, keySource: "none", baseUrl: "", model: "", modelSource: "default" },
  openrouter: { configured: false, keySource: "none", baseUrl: "", model: "", modelSource: "default" },
  lmstudio: { configured: false, keySource: "none", baseUrl: "", model: "", modelSource: "default" },
});

type ProfileDraft = {
  id?: string;
  name: string;
  details: string;
  resumeText: string;
  resumeName: string;
};

const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  name: "",
  details: "",
  resumeText: "",
  resumeName: "",
};

type JobDraft = {
  id?: string;
  name: string;
  jobDescription: string;
  companyName: string;
  companyWebsite: string;
  companySocial: string;
  companyBrief: string;
};

const EMPTY_JOB_DRAFT: JobDraft = {
  name: "",
  jobDescription: "",
  companyName: "",
  companyWebsite: "",
  companySocial: "",
  companyBrief: "",
};

const readDroppedImage = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image file could not be read."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("That file is not a readable image."));
      image.onload = () => {
        const scale = Math.min(1, MAX_DROPPED_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("The image could not be prepared."));
          return;
        }
        let dataUrl: string;
        try { context.drawImage(image, 0, 0, canvas.width, canvas.height); dataUrl = canvas.toDataURL("image/jpeg", 0.85); }
        catch { reject(new Error("This image could not be prepared. Use a PNG, JPEG, or WebP screenshot.")); return; }
        if (dataUrl.length > MAX_DROPPED_IMAGE_CHARS) {
          reject(new Error("That screenshot is too large; try a smaller image."));
          return;
        }
        resolve(dataUrl);
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });

const DEFAULT_PROXY_SETTINGS: PublicProxySettings = {
  mode: "system",
  host: "",
  username: "",
  hasPassword: false,
  credentialsAvailable: true,
  persistence: "none",
};

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function WindowControls() {
  return (
    <div className="window-controls no-drag" aria-label="Window controls">
      <button aria-label="Minimize" onClick={() => void window.studio?.minimize()}>
        <Minimize2 size={13} />
      </button>
      <button aria-label="Maximize or restore" onClick={() => void window.studio?.maximize()}>
        <Square size={10} />
      </button>
      <button className="window-close" aria-label="Close" onClick={() => void window.studio?.close()}>
        <X size={14} />
      </button>
    </div>
  );
}

function TitleBar({ compact = false }: { compact?: boolean }) {
  return (
    <div className="titlebar">
      <div className="titlebar-label">
        <img className="brand-logo" src={logoUrl} alt="" width="22" height="22" draggable={false} />
        <span>Interview Studio</span>
        {compact && <span className="titlebar-mode">Compact</span>}
      </div>
      <WindowControls />
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      className={`toggle ${checked ? "is-on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}


function Modal({
  children,
  onClose,
  titleId,
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  titleId: string;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = cardRef.current?.querySelector<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']",
    );
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !cardRef.current) return;
      const focusable = [...cardRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']",
      )].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && (active === firstItem || !cardRef.current.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={cardRef}
        className={`modal-card ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {children}
      </section>
    </div>
  );
}

function App() {
  const [captionProvider, setCaptionProvider] = useState<CaptionProvider>("openai");
  const [captionsOpen, setCaptionsOpen] = useState(true);
  const [view, setView] = useState<View>("session");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeySource, setApiKeySource] = useState<ApiKeySource>("none");
  const [secureStorageAvailable, setSecureStorageAvailable] = useState(true);
  const [model, setModel] = useState("");
  const [modelSource, setModelSource] = useState<ModelSource>("default");
  const [proxySettings, setProxySettings] = useState<PublicProxySettings>(DEFAULT_PROXY_SETTINGS);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [alwaysOnTop, setAlwaysOnTopState] = useState(true);
  const [compact, setCompact] = useState(false);
  const [minimizedToBar, setMinimizedToBar] = useState(false);
  const [stealthState, setStealthState] = useState<StudioStealthSettings>({
    enabled: true,
    captureProtection: true,
    hideFromTaskbar: true,
    disguiseTitle: true,
    decoyTitle: "Microsoft Edge",
    noFocusSteal: true,
    opacity: 85,
    mousePassthrough: false,
  });
  const [panicShortcut, setPanicShortcut] = useState("Ctrl+Shift+H");
  const [passthroughShortcut, setPassthroughShortcut] = useState("Ctrl+Shift+M");
  const [foreignShortcut, setForeignShortcut] = useState("Ctrl+Shift+K");
  const [restoreShortcut, setRestoreShortcut] = useState("Ctrl+Shift+L");
  const [stealthHidden, setStealthHidden] = useState(false);
  const [showCapture, setShowCapture] = useState(false);
  const [captureSources, setCaptureSources] = useState<StudioCaptureSource[]>([]);
  const [captureError, setCaptureError] = useState("");
  const [attachments, setAttachments] = useState<StudioCaptureSource[]>([]);
  const attachmentsRef = useRef<StudioCaptureSource[]>([]);
  const attachmentGenerationRef = useRef(0);
  const attachmentBusyRef = useRef(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const compactComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [submittedSourceNames, setSubmittedSourceNames] = useState<string[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sessionId, setSessionId] = useState(newId);
  const [sessionCreatedAt, setSessionCreatedAt] = useState(() => new Date().toISOString());
  const [conversationTitle, setConversationTitle] = useState("");
  const [threads, setThreads] = useState<QuestionThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [draftCaptionIds, setDraftCaptionIds] = useState<string[]>([]);
  const activeExchangeRef = useRef<{ threadId: string; exchangeId: string } | null>(null);
  const [question, setQuestion] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [pendingCaptionContext, setPendingCaptionContext] = useState<CaptionContextItem[]>([]);
  const [submittedCaptionContext, setSubmittedCaptionContext] = useState<CaptionContextItem[]>([]);
  const [captionShortcutEnabled, setCaptionShortcutEnabled] = useState(false);
  const [coachStatus, setCoachStatus] = useState<CoachStatus>("idle");
  const [coachText, setCoachText] = useState("");
  const [coachDemo, setCoachDemo] = useState(false);
  const [toast, setToast] = useState("");
  const [role, setRole] = useState("Senior software engineer");
  const [interviewType, setInterviewType] = useState("Technical interview");
  const [responseStyle, setResponseStyle] = useState<string>(RESPONSE_STYLES[0]);
  const [provider, setProvider] = useState<StudioProviderId>("openai");
  const [translationSettings, setTranslationSettings] = useState<PublicTranslationSettings>(DEFAULT_TRANSLATION_SETTINGS);
  const captions = useCaptions(captionProvider, provider, translationSettings);
  const interviewMemory = useConversationMemory(sessionId, captions.lines);
  const [providers, setProviders] = useState<Record<StudioProviderId, StudioProviderStatus>>(emptyProviderStatuses);
  const [profiles, setProfiles] = useState<StudioCoachProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<StudioCoachJob[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const coachRequestIdRef = useRef<string | null>(null);
  // Keep only the latest request in memory so an immediate retry can reuse its
  // screenshots without accumulating image data throughout a long interview.
  const lastCoachRequestRef = useRef<{ exchangeId: string; input: StudioCoachRequest } | null>(null);
  const captureRequestRef = useRef(0);
  const [foreignStatus, setForeignStatus] = useState<ConnectionStatus | null>(null);
  const selectedThread = threads.find(thread => thread.id === selectedThreadId);
  const conversation: ConversationRecord = {
    version: 1, id: sessionId, title: conversationTitle || (threads[0]?.question || captions.lines[0]?.text || 'Interview conversation').slice(0, 120),
    createdAt: sessionCreatedAt, updatedAt: new Date().toISOString(), captions: captions.lines, threads,
    selectedThreadId, draft: question, draftCaptionIds, pendingContext: pendingCaptionContext, role, interviewType, responseStyle
  };
  const history = useConversationHistory(conversation);
  const sessions = history.sessions;
  const patchActiveExchange = (patch: Partial<QuestionExchange>, delta?: string, separator = '') => {
    const active = activeExchangeRef.current;
    if (!active) return;
    setThreads(current => current.map(thread => thread.id !== active.threadId ? thread : { ...thread, exchanges: thread.exchanges.map(exchange => exchange.id !== active.exchangeId ? exchange : { ...exchange, ...patch, ...(delta !== undefined ? { answer: exchange.answer + (exchange.answer ? separator : '') + delta } : {}) }) }));
  };

  useEffect(() => { if (view !== "session" || stealthHidden) captions.stop(); }, [view, stealthHidden, captions.stop]);

  const applySettings = (settings: StudioSettings) => {
    setCaptionProvider(settings.captionProvider ?? "openai");
    setTranslationSettings(settings.translation ?? DEFAULT_TRANSLATION_SETTINGS);
    setHasApiKey(settings.hasApiKey);
    setApiKeySource(settings.apiKeySource);
    setSecureStorageAvailable(settings.secureStorageAvailable);
    setAlwaysOnTopState(settings.alwaysOnTop);
    setCompact(settings.compactMode);
    setMinimizedToBar(Boolean(settings.minimizedToBar));
    setStealthState(settings.stealth);
    setPanicShortcut(settings.panicShortcut);
    setPassthroughShortcut(settings.passthroughShortcut);
    setForeignShortcut(settings.foreignShortcut);
    setRestoreShortcut(settings.restoreShortcut);
    setModel(settings.model);
    setModelSource(settings.modelSource);
    setProxySettings(settings.proxy);
    setProvider(settings.provider);
    setProviders(settings.providers);
  };

  useEffect(() => {
    const studio = window.studio;
    if (!studio) {
      setToast("The desktop bridge is unavailable. Restart the desktop app.");
      return;
    }
    void studio.getSettings()
      .then((settings) => {
        applySettings(settings);
      })
      .catch((error: unknown) => {
        setToast(error instanceof Error ? error.message : "Could not load desktop settings.");
      });
  }, []);

  useEffect(() => {
    void window.studio?.listProfiles()
      .then((result) => {
        setProfiles(result.profiles);
        setActiveProfileId(result.activeProfileId);
      })
      .catch(() => undefined);
    void window.studio?.listJobs()
      .then((result) => {
        setJobs(result.jobs);
        setActiveJobId(result.activeJobId);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const unsubscribe = window.studio?.onCoachEvent((event) => {
      if (event.requestId !== coachRequestIdRef.current) return;
      if (event.type === "started") {
        patchActiveExchange({ demo: event.demo, provider: event.provider, model: event.model });
        setCoachDemo(event.demo);
        setCoachStatus("thinking");
      } else if (event.type === 'fallback') {
        const active = activeExchangeRef.current;
        if (active) setThreads(current => current.map(thread => thread.id !== active.threadId ? thread : { ...thread, exchanges: thread.exchanges.map(exchange => exchange.id !== active.exchangeId ? exchange : {
          ...exchange, answer: '', error: undefined, provider: event.to, model: event.model, fallbackNotice: event.message,
          previousAnswers: [...(exchange.previousAnswers ?? []), ...(exchange.answer ? [{ provider: event.from, answer: exchange.answer.slice(0, 120_000) }] : [])].slice(-3)
        }) }));
        setCoachText('');
      } else if (event.type === "delta") {
        patchActiveExchange({}, event.delta);
        setCoachText((current) => current + event.delta);
      } else if (event.type === "completed") {
        patchActiveExchange({ status: 'ready' });
        setCoachStatus("ready");
        coachRequestIdRef.current = null;
        activeExchangeRef.current = null;
        lastCoachRequestRef.current = null;
      } else if (event.type === "cancelled") {
        patchActiveExchange({ status: 'stopped' });
        setCoachStatus("idle");
        coachRequestIdRef.current = null;
        activeExchangeRef.current = null;
      } else if (event.type === "error") {
        const notice = (event.message || "The coach could not complete this response.").slice(0, 1000);
        patchActiveExchange({ status: 'error', error: notice });
        setCoachStatus("error");
        coachRequestIdRef.current = null;
        activeExchangeRef.current = null;
      }
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const unsubscribe = window.studio?.onShortcut(() => {
      setCompact((current) => {
        const next = !current;
        void window.studio?.setCompactMode(next).catch(() => undefined);
        return next;
      });
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => window.studio?.onWindowState?.(state => {
    setMinimizedToBar(state.minimizedToBar);
    setCompact(state.compactMode);
  }), []);

  useEffect(() => {
    const unsubscribe = window.studio?.onStealthEvent((payload) => {
      if (typeof payload.hidden === 'boolean') setStealthHidden(payload.hidden);
      if (payload.hidden) setToast(`Window hidden. Press ${panicShortcut} to restore it.`);
      if (typeof payload.passthrough === 'boolean') {
        setStealthState((current) => ({ ...current, mousePassthrough: payload.passthrough as boolean }));
        setToast(payload.passthrough ? "Mouse pass-through on. Hover the window to interact with it." : "Mouse pass-through off.");
      }
      if (typeof payload.foreign === 'string') setToast(payload.foreign);
    });
    return () => unsubscribe?.();
  }, [panicShortcut]);

  // When pass-through is enabled the window ignores the mouse so clicks and focus
  // go to the app underneath; hovering the window re-enables interaction.
  const passthroughInteractiveRef = useRef(false);
  useEffect(() => {
    const studio = window.studio;
    if (!studio?.setPassthrough) return;
    const setInteractive = (interactive: boolean): void => {
      if (passthroughInteractiveRef.current === interactive) return;
      passthroughInteractiveRef.current = interactive;
      studio.setPassthrough(!interactive);
    };
    if (!stealthState.mousePassthrough || minimizedToBar) {
      setInteractive(true);
      return;
    }
    const onMouseMove = () => setInteractive(true);
    const onMouseOut = (event: MouseEvent) => {
      if (!event.relatedTarget) setInteractive(false);
    };
    setInteractive(false);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseout", onMouseOut);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseout", onMouseOut);
      setInteractive(true);
    };
  }, [stealthState.mousePassthrough, minimizedToBar]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => () => {
    if (coachRequestIdRef.current) window.studio?.cancelCoach(coachRequestIdRef.current);
  }, []);

  const archiveCurrentSession = () => {
    void history.saveNow().catch(() => setToast("Could not save history. Retry saving or export your conversation."));
  };

  const toggleCompact = async () => {
    const studio = window.studio;
    if (!studio) {
      setToast("The desktop bridge is unavailable.");
      return;
    }
    const next = !compact;
    try {
      const settings = await studio.setCompactMode(next);
      setCompact(settings.compactMode);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not resize the workspace.");
    }
  };

  const toggleAlwaysOnTop = async () => {
    const studio = window.studio;
    if (!studio) {
      setToast("The desktop bridge is unavailable.");
      return;
    }
    try {
      const settings = await studio.setAlwaysOnTop(!alwaysOnTop);
      setAlwaysOnTopState(settings.alwaysOnTop);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not update the window setting.");
    }
  };

  const updateStealth = async (partial: Partial<StudioStealthSettings>) => {
    const studio = window.studio;
    if (!studio) {
      setToast("The desktop bridge is unavailable.");
      return;
    }
    try {
      const settings = await studio.setStealth(partial);
      setStealthState(settings.stealth);
      setPanicShortcut(settings.panicShortcut);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not update stealth settings.");
    }
  };

  const resetSession = () => {
    if (!history.ready) { setToast('Wait for conversation history to finish opening.'); return; }
    archiveCurrentSession();
    captions.stop(); captions.clear();
    if (coachRequestIdRef.current) window.studio?.cancelCoach(coachRequestIdRef.current);
    coachRequestIdRef.current = null;
    setSessionId(newId());
    setSessionCreatedAt(new Date().toISOString()); setConversationTitle(""); setThreads([]); setSelectedThreadId(null); setDraftCaptionIds([]); activeExchangeRef.current = null; lastCoachRequestRef.current = null;
    setQuestion("");
    setSubmittedQuestion("");
    setPendingCaptionContext([]); setSubmittedCaptionContext([]);
    setCoachText("");
    setCoachStatus("idle");
    setCoachDemo(false);
    clearAttachments();
    setSubmittedSourceNames([]);
    setCaptureSources([]);
    setView("session");
    setToast("New session ready.");
  };

  const closeCapturePicker = () => {
    captureRequestRef.current += 1;
    setShowCapture(false);
    setCaptureSources([]);
    setCaptureError("");
    setSourceLoading(false);
  };

  const openCapturePicker = async () => {
    if (attachmentBusyRef.current) return;
    const studio = window.studio;
    if (!studio) {
      setToast("Screen references are unavailable in this build.");
      return;
    }
    setShowCapture(true);
    setSourceLoading(true);
    setCaptureSources([]);
    setCaptureError("");
    const requestNumber = ++captureRequestRef.current;
    try {
      const sources = await studio.listCaptureSources();
      if (requestNumber !== captureRequestRef.current) return;
      setCaptureSources(sources);
      if (!sources.length) setCaptureError("No sources were shared. You can close this picker and try again.");
    } catch (error) {
      if (requestNumber !== captureRequestRef.current) return;
      setCaptureError(error instanceof Error ? error.message : "Could not list screens and windows.");
    } finally {
      if (requestNumber === captureRequestRef.current) setSourceLoading(false);
    }
  };

  function clearAttachments() {
    attachmentGenerationRef.current++;
    attachmentsRef.current = [];
    setAttachments([]);
  }

  const addAttachments = (items: StudioCaptureSource[]) => {
    const next = [...attachmentsRef.current, ...items.map(item => ({ ...item, id: newId() }))];
    parseScreenshotAttachments({ imageDataUrls: next.map(item => item.thumbnail) });
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const removeAttachment = (id: string) => {
    const next = attachmentsRef.current.filter(item => item.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
  };

  const chooseSources = (sources: StudioCaptureSource[]) => {
    try {
      addAttachments(sources);
      closeCapturePicker();
      setToast(`${sources.length} screenshot${sources.length === 1 ? "" : "s"} attached.`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not attach these screenshots."); }
  };

  const attachImageFiles = async (files: File[]) => {
    if (attachmentBusyRef.current) { setToast("Wait for the current screenshot to finish preparing."); return; }
    const generation = attachmentGenerationRef.current;
    attachmentBusyRef.current = true;
    setAttachmentBusy(true);
    try {
      const prepared: StudioCaptureSource[] = [];
      for (const file of files) {
        if (generation !== attachmentGenerationRef.current) return;
        if (file.size > 25_000_000) throw new Error(`${file.name} is too large. Use a file smaller than 25 MB.`);
        prepared.push({ id: newId(), name: file.name || "Screenshot", thumbnail: await readDroppedImage(file) });
      }
      if (generation !== attachmentGenerationRef.current) return;
      addAttachments(prepared);
      if (view !== "session") setView("session");
      setToast(`${prepared.length} screenshot${prepared.length === 1 ? "" : "s"} attached.`);
    } catch (error) {
      if (generation === attachmentGenerationRef.current) setToast(error instanceof Error ? error.message : "Could not attach these images.");
    } finally {
      attachmentBusyRef.current = false;
      setAttachmentBusy(false);
    }
  };

  const selectArea = async () => {
    if (attachmentBusyRef.current) return;
    if (!window.studio?.captureArea) { setToast("Area selection is available in the updated desktop app."); return; }
    const generation = attachmentGenerationRef.current;
    attachmentBusyRef.current = true;
    setAttachmentBusy(true);
    try {
      const selected = await window.studio.captureArea();
      if (selected && generation === attachmentGenerationRef.current) { addAttachments([selected]); setToast("Selected area attached."); }
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not select a screen area."); }
    finally { attachmentBusyRef.current = false; setAttachmentBusy(false); }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((item) => item.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void attachImageFiles(files);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    const hasImage = Array.from(event.dataTransfer?.items ?? []).some(
      (item) => item.kind === "file" && item.type.startsWith("image/")
    );
    if (!hasImage) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const changeForeignHotkey = async (kind: "toggle" | "restore", accelerator: string): Promise<string> => {
    const studio = window.studio;
    if (!studio?.setForeignHotkey) return "The desktop bridge is unavailable.";
    try {
      const result = await studio.setForeignHotkey(accelerator, kind);
      setForeignStatus({ tone: result.ok ? "success" : "error", message: result.message });
      if (result.ok) {
        const settings = await studio.getSettings();
        setForeignShortcut(settings.foreignShortcut);
        setRestoreShortcut(settings.restoreShortcut);
      }
      return result.message;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not change the hotkey.";
      setForeignStatus({ tone: "error", message });
      return message;
    }
  };

  const launchCoach = (input: StudioCoachRequest, threadId: string, exchangeId: string) => {
    activeExchangeRef.current = { threadId, exchangeId };
    lastCoachRequestRef.current = { exchangeId, input };
    setSubmittedQuestion(input.question);
    setCoachText(""); setCoachDemo(false); setCoachStatus("thinking");
    try {
      coachRequestIdRef.current = window.studio!.startCoach(input);
    } catch (error) {
      const message = (error instanceof Error ? error.message : "The coach request failed.").slice(0, 1000);
      patchActiveExchange({ status: 'error', error: message });
      coachRequestIdRef.current = null; activeExchangeRef.current = null;
      setCoachStatus("error");
    }
  };
  const editExchange = (thread: QuestionThread, exchange: QuestionExchange) => {
    if (coachRequestIdRef.current) { setToast("Stop the current answer before editing this question."); return; }
    setSelectedThreadId(null); setDraftCaptionIds(thread.captionIds);
    setQuestion(exchange.question); setPendingCaptionContext(exchange.context);
    compactComposerRef.current?.focus();
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
    setToast(exchange.sourceNames.length ? "Review the question and reattach its screenshots before sending." : "Edit the question, then send when ready.");
  };
  const retryCoach = (thread: QuestionThread, exchange: QuestionExchange) => {
    if (!history.ready || coachRequestIdRef.current || coachStatus === "thinking") { setToast("Wait for the current answer, or stop it first."); return; }
    if (exchange.status !== 'error' && exchange.status !== 'stopped') return;
    const cached = lastCoachRequestRef.current?.exchangeId === exchange.id ? lastCoachRequestRef.current.input : undefined;
    if (exchange.sourceNames.length && !cached) { editExchange(thread, exchange); return; }
    const index = thread.exchanges.findIndex(item => item.id === exchange.id);
    const input: StudioCoachRequest = cached ?? {
      question: exchange.question,
      transcript: questionThreadContext(index > 0 ? { ...thread, exchanges: thread.exchanges.slice(0, index) } : undefined, exchange.context, exchange.memory) || undefined,
      profileId: activeProfileId ?? undefined, jobId: activeJobId ?? undefined,
      role, interviewType, responseStyle, mode: 'chat'
    };
    setThreads(current => current.map(item => item.id !== thread.id ? item : { ...item, exchanges: item.exchanges.map(answer => answer.id !== exchange.id ? answer : { ...answer, answer: '', error: undefined, fallbackNotice: undefined, provider: undefined, model: undefined, demo: false, status: 'thinking' }) }));
    setSelectedThreadId(thread.id); setSubmittedCaptionContext(exchange.context); setSubmittedSourceNames(exchange.sourceNames);
    launchCoach(input, thread.id, exchange.id);
  };
  const matchingCaptionThread = (prompt: string, ids: readonly string[]) => {
    const matches = threads.filter(thread => thread.exchanges.length && thread.question === prompt && thread.captionIds.join('\n') === ids.join('\n'));
    return matches.find(thread => thread.exchanges.some(exchange => exchange.status === 'ready' || exchange.status === 'thinking')) ?? matches.at(-1);
  };
  const captionNeedsRetry = (thread: QuestionThread | undefined) => !!thread && !thread.exchanges.some(exchange => exchange.status === 'ready' || exchange.status === 'thinking') && !!thread.exchanges.length;
  const sendCoach = (prompt: string, context: CaptionContextItem[], fromCaption = false, captionIds: string[] = []) => {
    if (!history.ready) { setToast("Wait for saved conversation history to finish opening."); return; }
    if (fromCaption) {
      const saved = matchingCaptionThread(prompt, captionIds);
      if (saved) {
        if (captionNeedsRetry(saved)) retryCoach(saved, saved.exchanges[0]);
        else { setSelectedThreadId(saved.id); setDraftCaptionIds([]); setToast("Showing saved answers for this question."); }
        return;
      }
    }
    if (coachRequestIdRef.current || coachStatus === "thinking") { setToast("Wait for the current answer, or stop it first."); return; }
    if (!fromCaption && attachmentBusyRef.current) { setToast("Wait for your screenshots to finish preparing."); return; }
    if (!prompt) {
      setToast("Enter an interview question first.");
      return;
    }
    const studio = window.studio;
    if (!studio?.startCoach) {
      setCoachStatus("error");
      setCoachText("The desktop coaching bridge is unavailable. Restart the desktop app.");
      return;
    }
    setSubmittedQuestion(prompt);
    setSubmittedCaptionContext(context);
    if (!fromCaption) { setQuestion(""); setPendingCaptionContext([]); }
    // A direct caption action leaves the user's unfinished composer and images intact.
    const attachedSources = fromCaption ? [] : attachmentsRef.current;
    const parent = !fromCaption && !draftCaptionIds.length ? selectedThread : undefined;
    const chosenContext = mergeCaptionContext(parent?.exchanges[0]?.context ?? [], context);
    const memory = interviewMemory.forQuestion([parent?.question, prompt].filter(Boolean).join('\n'), [...captionIds, ...chosenContext.map(item => item.id)]);
    const threadId = parent?.id ?? newId(), exchangeId = newId();
    const exchange: QuestionExchange = { id: exchangeId, question: prompt, answer: '', createdAt: new Date().toISOString(), status: 'thinking', context: chosenContext, memory, sourceNames: attachedSources.map(source => source.name) };
    setThreads(current => parent ? current.map(thread => thread.id === parent.id ? { ...thread, exchanges: [...thread.exchanges, exchange] } : thread) : [...current, { id: threadId, question: prompt, captionIds: fromCaption ? captionIds : draftCaptionIds, exchanges: [exchange] }]);
    setSelectedThreadId(threadId); if (!fromCaption) setDraftCaptionIds([]);
    launchCoach({
      question: prompt,
      transcript: questionThreadContext(parent, chosenContext, memory) || undefined,
      profileId: activeProfileId ?? undefined,
      jobId: activeJobId ?? undefined,
      imageDataUrls: attachedSources.map(source => source.thumbnail),
      role,
      interviewType,
      responseStyle,
      mode: "chat",
    }, threadId, exchangeId);
    setSubmittedSourceNames(attachedSources.map(source => source.name));
    if (!fromCaption) clearAttachments();
  };
  const askCoach = (event?: FormEvent) => {
    event?.preventDefault();
    sendCoach(question.trim(), pendingCaptionContext);
  };
  const captionActions: CaptionActions = {
    onDraft: input => sendCoach(input.question, mergeCaptionContext(input.context, pendingCaptionContext), true, input.captionIds ?? []),
    selectedCaptionIds: selectedThread?.captionIds ?? [],
    hasSavedQuestion: (question, ids) => { const thread = matchingCaptionThread(question, ids); return !!thread && !captionNeedsRetry(thread); },
    canRetryQuestion: (question, ids) => captionNeedsRetry(matchingCaptionThread(question, ids)),
    onEdit: (input: CaptionQuestion) => {
      setSelectedThreadId(null); setDraftCaptionIds(input.captionIds ?? []);
      setQuestion(current => (current.trim() ? `${current.trim()}\n${input.question}` : input.question).slice(0, LIMITS.questionChars));
      setPendingCaptionContext(current => mergeCaptionContext(input.context, current));
      compactComposerRef.current?.focus();
      setToast("Caption added to your question. Review the context, edit, then send when ready.");
    },
    onAddContext: item => {
      setPendingCaptionContext(current => mergeCaptionContext(current, [item]));
      setToast("Caption context added to your next question.");
    },
    onNotice: setToast,
    busy: coachStatus === "thinking" || !history.ready,
    shortcutEnabled: captionShortcutEnabled,
    onShortcutChange: setCaptionShortcutEnabled,
    summary: interviewMemory.summary,
  };
  useEffect(() => {
    if (!captionShortcutEnabled || view !== "session" || stealthHidden || showCapture) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || captionActions.busy) return;
      try {
        const latest = latestCaptionQuestion(captions.lines);
        if (latest) captionActions.onDraft(latest);
        else setToast("No completed Professional caption is available yet.");
      } catch (error) { setToast(error instanceof Error ? error.message : "Select a shorter caption first."); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [captionShortcutEnabled, view, stealthHidden, showCapture, captionActions, captions.lines]);

  const cancelCoach = () => {
    patchActiveExchange({ status: 'stopped' });
    if (coachRequestIdRef.current) window.studio?.cancelCoach(coachRequestIdRef.current);
    coachRequestIdRef.current = null;
    activeExchangeRef.current = null;
    setCoachStatus("idle");
    setToast("Coach response stopped.");
  };

  const resetCoach = () => {
    setSelectedThreadId(null); setDraftCaptionIds([]);
    compactComposerRef.current?.focus();
  };

  const exportSession = async (record: ConversationRecord = conversation) => {
    const studio = window.studio;
    if (!studio?.exportSession) {
      setToast("Export is unavailable in this build.");
      return;
    }
    const content = exportConversation(record);
    try {
      const result = await studio.exportSession({
        content,
        suggestedName: `interview-session-${new Date().toISOString().slice(0, 10)}.md`,
      });
      setToast(result.saved ? "Session exported." : "Export cancelled.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not export the session.");
    }
  };

  const saveApiKey = async (event: FormEvent): Promise<boolean> => {
    event.preventDefault();
    const studio = window.studio;
    if (!studio) {
      setToast("The desktop bridge is unavailable; the key was not saved.");
      return false;
    }
    if (!apiKey.trim()) return false;
    try {
      const result = await studio.setApiKey(apiKey.trim());
      if (!result.saved) {
        setToast(result.message);
        return false;
      }
      const settings = await studio.getSettings();
      setHasApiKey(settings.hasApiKey);
      setApiKeySource(settings.apiKeySource);
      setSecureStorageAvailable(settings.secureStorageAvailable);
      setApiKey("");
      setShowKey(false);
      setToast(result.message);
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not save the API key.");
      return false;
    }
  };

  const clearApiKey = async () => {
    const studio = window.studio;
    if (!studio) {
      setToast("The desktop bridge is unavailable; the key was not changed.");
      return;
    }
    try {
      const settings = await studio.clearApiKey();
      setHasApiKey(settings.hasApiKey);
      setApiKeySource(settings.apiKeySource);
      setApiKey("");
      setToast(settings.apiKeySource === "environment" ? "The environment-provided key is still active." : "API key removed.");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not remove the API key.");
    }
  };

  const selectModel = async (nextModel: string): Promise<string> => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the model was not changed.");
    const settings = await studio.setModel(nextModel);
    setModel(settings.model);
    setModelSource(settings.modelSource);
    setToast(`Coaching model changed to ${settings.model}.`);
    return `Coaching model changed to ${settings.model}.`;
  };

  const saveProxy = async (request: SetProxyRequest): Promise<string> => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; proxy settings were not saved.");
    const result = await studio.setProxy(request);
    setProxySettings(result.settings.proxy);
    setToast(result.message);
    return result.message;
  };

  const testProxy = async (): Promise<{ ok: boolean; message: string; route: string }> => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the proxy could not be tested.");
    const result = await studio.testProxy();
    setToast(result.message);
    return result;
  };

  const changeProvider = async (next: StudioProviderId) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the provider was not changed.");
    applySettings(await studio.setProvider(next));
  };

  const configureProvider = async (request: StudioConfigureProviderRequest) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the provider was not configured.");
    applySettings(await studio.configureProvider(request));
  };

  const testProvider = async (id: StudioProviderId) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the provider could not be tested.");
    return studio.testProvider(id);
  };

  const applyProfiles = (result: StudioProfileListResult | StudioProfileMutationResult) => {
    setProfiles(result.profiles);
    setActiveProfileId(result.activeProfileId);
  };

  const upsertProfile = async (request: StudioProfileUpsertRequest) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the profile was not saved.");
    const result = await studio.upsertProfile(request);
    applyProfiles(result);
    return result.profile;
  };

  const deleteProfileById = async (id: string) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the profile was not deleted.");
    applyProfiles(await studio.deleteProfile(id));
  };

  const activateProfile = async (id: string) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the profile was not activated.");
    applyProfiles(await studio.setActiveProfile(id));
  };

  const uploadResume = async () => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; resume upload is unavailable.");
    return studio.uploadResume();
  };

  const analyzeProfileCompany = async (jobId: string) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; company analysis is unavailable.");
    const result = await studio.analyzeCompany(jobId);
    const refreshed = await studio.listJobs();
    setJobs(refreshed.jobs);
    setActiveJobId(refreshed.activeJobId);
    return result;
  };

  const applyJobs = (result: StudioJobListResult | StudioJobMutationResult) => {
    setJobs(result.jobs);
    setActiveJobId(result.activeJobId);
  };

  const upsertJob = async (request: StudioJobUpsertRequest) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the job was not saved.");
    const result = await studio.upsertJob(request);
    applyJobs(result);
    return result.job;
  };

  const deleteJobById = async (id: string) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the job was not deleted.");
    applyJobs(await studio.deleteJob(id));
  };

  const activateJob = async (id: string) => {
    const studio = window.studio;
    if (!studio) throw new Error("The desktop bridge is unavailable; the job was not activated.");
    applyJobs(await studio.setActiveJob(id));
  };

  const renameSession = (id: string, title: string) => {
    void history.rename(id, title).then(() => { if (id === sessionId) setConversationTitle(title); setToast("Conversation renamed."); }).catch(() => setToast("Could not rename the conversation. Try again."));
  };

  const deleteSession = (id: string) => {
    void history.remove(id).then(() => { if (id === sessionId) { resetSession(); setView('library'); } setToast("Conversation deleted."); }).catch(() => setToast("Could not delete the conversation. Try again."));
  };

  const navigateTo = (next: View) => {
    if (next === "library") archiveCurrentSession();
    setView(next);
  };

  const restoreConversation = (snapshot: ConversationRecord) => {
    captions.restore(snapshot.captions);
    const requestId = coachRequestIdRef.current;
    coachRequestIdRef.current = null;
    if (requestId) window.studio?.cancelCoach(requestId);
    setSessionId(snapshot.id);
    setSessionCreatedAt(snapshot.createdAt); setConversationTitle(snapshot.title);
    const restoredThreads = snapshot.threads.map(thread => ({ ...thread, exchanges: thread.exchanges.map(exchange => ({ ...exchange, status: exchange.status === 'thinking' ? 'stopped' as const : exchange.status })) }));
    setThreads(restoredThreads); setSelectedThreadId(snapshot.selectedThreadId); activeExchangeRef.current = null; lastCoachRequestRef.current = null;
    const exchange = restoredThreads.find(thread => thread.id === snapshot.selectedThreadId)?.exchanges.at(-1);
    setQuestion(snapshot.draft); setDraftCaptionIds(snapshot.draftCaptionIds ?? []);
    setRole(snapshot.role); setInterviewType(snapshot.interviewType); setResponseStyle(normalizeResponseStyle(snapshot.responseStyle));
    setCoachText(exchange?.answer ?? ''); setSubmittedQuestion(exchange?.question ?? '');
    setPendingCaptionContext(snapshot.pendingContext); setSubmittedCaptionContext(exchange?.context ?? []);
    setCoachStatus(exchange?.answer ? "ready" : "idle");
    setCoachDemo(false);
    clearAttachments();
    setSubmittedSourceNames([]);
    setView("session");
  };
  const openSnapshot = (snapshot: SessionSnapshot) => {
    void (async () => { await history.saveNow(); const record = await window.studio!.getHistory(snapshot.id); restoreConversation(record); })().catch(() => setToast('Could not open that conversation. Its saved file was kept unchanged.'));
  };
  const selectThread = (id: string) => { setSelectedThreadId(id); setDraftCaptionIds([]); };
  const saveHistoryNow = () => { void history.retry().catch(() => setToast('Conversation could not be saved. Export it or retry saving.')); };
  const conversationCaptions: CaptionControls = { ...captions, start: async () => { if (!history.ready) { setToast('Wait for conversation history to finish opening.'); return; } await captions.start(); } };

  const imageFileInput = <input ref={fileInputRef} className="image-file-input" type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="Attach screenshot files" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length) void attachImageFiles(files); }} />;
  const capturePicker = showCapture ? <CaptureModal sources={captureSources} loading={sourceLoading} error={captureError} onClose={closeCapturePicker} onChoose={chooseSources} /> : null;

  if (minimizedToBar) return <FloatingBar captions={captions} answerStatus={coachStatus} historyError={history.error} />;

  if (compact) {
    return (
      <div className="app compact-app" onDragOver={handleDragOver} onDrop={handleDrop}>
        <TitleBar compact />
        {imageFileInput}
        <main className={`compact-shell ${captionsOpen ? "with-captions" : ""}`}>
          <div className="compact-topline">
            <div className="compact-brand">
              <span className={`capture-beacon ${coachStatus === "thinking" ? "is-live" : ""}`} />
              <div>
                <strong>Interview</strong>
                <span>{coachStatus === "thinking" ? "Generating answer..." : role}</span>
              </div>
            </div>
            <div className="compact-actions">
              <button type="button" className={`icon-button caption-toggle ${captions.status === "listening" ? "active" : ""}`} aria-label="Live captions" title="Live captions" aria-expanded={captionsOpen} onClick={() => setCaptionsOpen(!captionsOpen)}><Captions size={15} /></button>
              <ActionMenu label="Window options" icon={<MoreHorizontal size={17} />}>
                <button type="button" onClick={() => void toggleAlwaysOnTop()}><Pin size={15} />{alwaysOnTop ? "Turn off always on top" : "Keep window on top"}</button>
                <button type="button" onClick={() => window.studio?.panicHide()}><EyeOff size={15} />Hide window <kbd>{panicShortcut}</kbd></button>
              </ActionMenu>
              <button className="icon-button" aria-label="Expand workspace" onClick={() => void toggleCompact()}>
                <Maximize2 size={15} />
              </button>
            </div>
          </div>
          {captionsOpen && <CaptionsPanel compact captions={conversationCaptions} actions={captionActions} onClose={() => setCaptionsOpen(false)} />}
          <div className="compact-question-tools"><QuestionPicker threads={threads} selectedId={selectedThreadId} onSelect={selectThread} /><button type="button" onClick={resetCoach} title="Start a new question">New question</button>{coachStatus === 'thinking' && !selectedThread?.exchanges.some(exchange => exchange.status === 'thinking') && <button type="button" onClick={cancelCoach}>Stop answer</button>}{history.error && <button type="button" title={history.error} onClick={saveHistoryNow}>History issue · Retry</button>}</div>
          <div className="compact-guidance" aria-live="polite">
            <QuestionAnswers thread={selectedThread} onStop={cancelCoach} onRetry={retryCoach} onEdit={editExchange} busy={coachStatus === 'thinking' || !history.ready} retryWithImagesId={lastCoachRequestRef.current?.exchangeId} />
          </div>
          <AttachmentTray items={attachments} onRemove={removeAttachment} busy={attachmentBusy} />
          <div className="compact-capture-tools"><ActionMenu label="Attach screenshots" icon={<Paperclip size={13} />} text="Attach" above><button type="button" onClick={() => fileInputRef.current?.click()} disabled={attachmentBusy}><Paperclip size={13} />Files</button><button type="button" onClick={() => void openCapturePicker()} disabled={attachmentBusy}><MonitorUp size={13} />Sources</button></ActionMenu><button type="button" onClick={() => void selectArea()} disabled={attachmentBusy}><Crop size={13} /> Select area</button><CaptionContext inline items={pendingCaptionContext} onRemove={id => setPendingCaptionContext(current => current.filter(item => item.id !== id))} onClear={() => setPendingCaptionContext([])} /></div>
          <form className="compact-composer" onSubmit={askCoach}>
            <textarea
              ref={compactComposerRef}
              disabled={!history.ready}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              aria-label="Ask an interview question"
              placeholder={selectedThread ? "Ask a follow-up about this question..." : "Ask an interview question..."}
              maxLength={12_000}
              rows={2}
            />
            <button type="submit" disabled={!history.ready || coachStatus === "thinking" || attachmentBusy || !question.trim()}><Send size={14} /> Ask</button>
          </form>
        </main>
        {capturePicker}
        {toast && <div className="toast" role="status" aria-live="polite"><Activity size={15} />{toast}</div>}
      </div>
    );
  }

  return (
    <div className="app" onDragOver={handleDragOver} onDrop={handleDrop}>
      <TitleBar />
      {imageFileInput}
      <div className="app-body">
        <Sidebar
          view={view}
          onNavigate={navigateTo}
          onNew={resetSession}
          sessionCount={sessions.length}
        />
        <main className="main-shell">
          {view === "session" && (
            <SessionView
              key={sessionId}
              attachments={attachments}
              captions={conversationCaptions}
              captionsOpen={captionsOpen}
              onToggleCaptions={() => setCaptionsOpen(!captionsOpen)}
              captionActions={captionActions}
              threads={threads}
              selectedThreadId={selectedThreadId}
              onSelectThread={selectThread}
              historyMessage={history.error || (history.status === 'saving' ? 'Saving…' : history.ready ? history.hasContent ? 'Saved locally' : 'History ready' : 'Opening history…')}
              historyError={Boolean(history.error)}
              historyReady={history.ready}
              onSaveHistory={saveHistoryNow}
              pendingCaptionContext={pendingCaptionContext}
              submittedCaptionContext={submittedCaptionContext}
              onRemoveCaptionContext={id => setPendingCaptionContext(current => current.filter(item => item.id !== id))}
              onClearCaptionContext={() => setPendingCaptionContext([])}
              attachmentBusy={attachmentBusy}
              submittedSourceNames={submittedSourceNames}
              coachStatus={coachStatus}
              coachText={coachText}
              coachDemo={coachDemo}
              submittedQuestion={submittedQuestion}
              question={question}
              setQuestion={setQuestion}
              onCapture={() => void openCapturePicker()}
              onRemoveCapture={removeAttachment}
              onSelectArea={() => void selectArea()}
              onAttachFiles={() => fileInputRef.current?.click()}
              onAsk={askCoach}
              onCancel={cancelCoach}
              onRetryAnswer={retryCoach}
              onEditQuestion={editExchange}
              retryWithImagesId={lastCoachRequestRef.current?.exchangeId}
              onResetCoach={resetCoach}
              onExport={() => void exportSession()}
              onCompact={() => void toggleCompact()}
              alwaysOnTop={alwaysOnTop}
              onAlwaysOnTop={() => void toggleAlwaysOnTop()}
              panicShortcut={panicShortcut}
              role={role}
              activeProfileName={profiles.find((item) => item.id === activeProfileId)?.name ?? ""}
              stealth={stealthState}
              onUpdateStealth={(partial) => void updateStealth(partial)}
            />
          )}
          {view === "library" && (
            <LibraryView
              sessions={sessions}
              onOpen={openSnapshot}
              onNew={resetSession}
              onRename={renameSession}
              onDelete={deleteSession}
              onSearch={async query => (await window.studio!.listHistory(query)).conversations}
              onExport={id => { void (async () => { await history.saveNow(); await exportSession(id === sessionId ? conversation : await window.studio!.getHistory(id)); })().catch(() => setToast('Could not export that conversation.')); }}
            />
          )}
          {view === "settings" && (
            <SettingsView
              translationSettings={translationSettings}
              onConfigureTranslation={async request => {
                if (!window.studio) throw new Error("Desktop app required.");
                const settings = await window.studio.configureTranslation(request);
                captions.stopTranslationWork();
                applySettings(settings);
              }}
              captionProvider={captionProvider}
              onChangeCaptionProvider={async next => {
                if (!window.studio) throw new Error("The desktop bridge is unavailable.");
                applySettings(await window.studio.setCaptionProvider(next));
              }}
              hasApiKey={hasApiKey}
              apiKeySource={apiKeySource}
              secureStorageAvailable={secureStorageAvailable}
              model={model}
              modelSource={modelSource}
              proxy={proxySettings}
              apiKey={apiKey}
              setApiKey={setApiKey}
              showKey={showKey}
              setShowKey={setShowKey}
              onSave={saveApiKey}
              onClear={() => void clearApiKey()}
              onModelChange={selectModel}
              onSaveProxy={saveProxy}
              onTestProxy={testProxy}
              alwaysOnTop={alwaysOnTop}
              onAlwaysOnTop={() => void toggleAlwaysOnTop()}
              stealth={stealthState}
              panicShortcut={panicShortcut}
              passthroughShortcut={passthroughShortcut}
              onUpdateStealth={(partial) => void updateStealth(partial)}
              role={role}
              setRole={setRole}
              interviewType={interviewType}
              setInterviewType={setInterviewType}
              responseStyle={responseStyle}
              setResponseStyle={setResponseStyle}
              provider={provider}
              providers={providers}
              onChangeProvider={changeProvider}
              onConfigureProvider={configureProvider}
              onTestProvider={testProvider}
              profiles={profiles}
              activeProfileId={activeProfileId}
              onUpsertProfile={upsertProfile}
              onDeleteProfile={deleteProfileById}
              onSetActiveProfile={activateProfile}
              onUploadResume={uploadResume}
              onAnalyzeCompany={analyzeProfileCompany}
              jobs={jobs}
              activeJobId={activeJobId}
              onUpsertJob={upsertJob}
              onDeleteJob={deleteJobById}
              onSetActiveJob={activateJob}
              foreignStatus={foreignStatus}
              foreignShortcut={foreignShortcut}
              restoreShortcut={restoreShortcut}
              onChangeForeignHotkey={(kind, accelerator) => changeForeignHotkey(kind, accelerator)}
            />
          )}
        </main>
      </div>

      {capturePicker}
      {toast && <div className="toast" role="status" aria-live="polite"><Activity size={15} />{toast}</div>}
    </div>
  );
}

function Sidebar({
  view,
  onNavigate,
  onNew,
  sessionCount,
}: {
  view: View;
  onNavigate: (view: View) => void;
  onNew: () => void;
  sessionCount: number;
}) {
  const items: { id: View; label: string; icon: ReactNode }[] = [
    { id: "session", label: "Interview chat", icon: <MessageSquareText size={17} /> },
    { id: "library", label: `Conversation history${sessionCount ? ` (${sessionCount})` : ""}`, icon: <Library size={17} /> },
  ];
  return (
    <aside className="sidebar simple-sidebar">
      <button className="new-session-button" onClick={onNew} aria-label="New session" title="New session">
        <Plus size={16} /> <span>New session</span>
      </button>
      <nav className="primary-nav" aria-label="Primary navigation">
        {items.map((item) => (
          <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} aria-label={item.label} title={item.label} onClick={() => onNavigate(item.id)}>
            {item.icon}<span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-spacer" />
      <button className={`settings-nav ${view === "settings" ? "active" : ""}`} aria-label="Settings" title="Settings" aria-current={view === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}>
        <Settings size={17} /><span>Settings</span>
      </button>
    </aside>
  );
}

function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let pressed = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const isInteractive = (target: EventTarget | null): boolean =>
      target instanceof Element
      && Boolean(target.closest("button, input, textarea, select, a, label, [role='option'], [contenteditable]"));

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isInteractive(event.target)) return;
      pressed = true;
      dragging = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = el.scrollLeft;
      startTop = el.scrollTop;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pressed) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragging = true;
        el.classList.add("drag-scrolling");
        window.getSelection()?.removeAllRanges();
      }
      el.scrollLeft = startLeft - dx;
      el.scrollTop = startTop - dy;
    };
    const onPointerUp = () => {
      if (!pressed) return;
      pressed = false;
      if (dragging) {
        dragging = false;
        el.classList.remove("drag-scrolling");
      }
    };

    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);
  return ref;
}

type SessionViewProps = {
  threads: QuestionThread[];
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  historyMessage: string;
  historyError: boolean;
  historyReady: boolean;
  onSaveHistory: () => void;
  captions: CaptionControls;
  captionsOpen: boolean;
  onToggleCaptions: () => void;
  captionActions: CaptionActions;
  pendingCaptionContext: CaptionContextItem[];
  submittedCaptionContext: CaptionContextItem[];
  onRemoveCaptionContext: (id: string) => void;
  onClearCaptionContext: () => void;
  attachments: StudioCaptureSource[];
  attachmentBusy: boolean;
  submittedSourceNames: string[];
  coachStatus: CoachStatus;
  coachText: string;
  coachDemo: boolean;
  submittedQuestion: string;
  question: string;
  setQuestion: (value: string) => void;
  onCapture: () => void;
  onRemoveCapture: (id: string) => void;
  onSelectArea: () => void;
  onAttachFiles: () => void;
  onAsk: (event: FormEvent) => void;
  onCancel: () => void;
  onRetryAnswer: (thread: QuestionThread, exchange: QuestionExchange) => void;
  onEditQuestion: (thread: QuestionThread, exchange: QuestionExchange) => void;
  retryWithImagesId?: string;
  onResetCoach: () => void;
  onExport: () => void;
  onCompact: () => void;
  alwaysOnTop: boolean;
  onAlwaysOnTop: () => void;
  panicShortcut: string;
  role: string;
  activeProfileName: string;
  stealth: StudioStealthSettings;
  onUpdateStealth: (partial: Partial<StudioStealthSettings>) => void;
};

function SessionView(props: SessionViewProps) {
  const {
    threads, selectedThreadId, onSelectThread, historyMessage, historyError, historyReady, onSaveHistory,
    captions, captionsOpen, onToggleCaptions, captionActions,
    pendingCaptionContext, submittedCaptionContext, onRemoveCaptionContext, onClearCaptionContext,
    attachments, attachmentBusy, submittedSourceNames,
    coachStatus, coachText, coachDemo, submittedQuestion, question, setQuestion,
    onCapture, onRemoveCapture, onSelectArea, onAttachFiles, onAsk, onCancel, onRetryAnswer, onEditQuestion, retryWithImagesId, onResetCoach, onExport,
    onCompact, alwaysOnTop, onAlwaysOnTop, panicShortcut, role,
    activeProfileName, stealth, onUpdateStealth,
  } = props;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [opacity, setOpacity] = useState(stealth.opacity);

  useEffect(() => {
    setOpacity(stealth.opacity);
  }, [stealth.opacity]);

  const changeQuickOpacity = (value: number) => {
    setOpacity(value);
    onUpdateStealth({ opacity: value });
  };

  return (
    <div className="session-page simple-session">
      <header className="session-header">
        <div className="session-title">
          <div>
            <div className="session-heading-line"><h1>Interview workspace</h1><span className={`history-save-status ${historyError ? 'error' : ''}`} role="status" title={historyMessage}>{historyError ? 'History issue' : historyMessage}</span></div>
            <p>{activeProfileName || role}</p>
          </div>
        </div>
        <div className="session-controls">
          <span className={`workspace-privacy ${stealth.enabled ? "enabled" : ""}`} title={`Window privacy ${stealth.enabled ? "on" : "off"}. Manage in Settings.`}><ShieldCheck size={14} /><span>{stealth.enabled ? "Private" : "Privacy off"}</span></span>
          <button type="button" className={`icon-button caption-toggle ${captionsOpen ? "active" : ""}`} aria-label="Live captions" title={captionsOpen ? "Hide live captions" : "Show live captions"} aria-expanded={captionsOpen} onClick={onToggleCaptions}><Captions size={16} /></button>
          <button className="compact-button" onClick={onCompact}><Minimize2 size={14} /> Compact</button>
          <ActionMenu label="Window options" icon={<MoreHorizontal size={18} />}>
            <button type="button" onClick={onAlwaysOnTop}><Pin size={15} /><span>{alwaysOnTop ? "Turn off always on top" : "Keep window on top"}</span>{alwaysOnTop && <Check size={14} />}</button>
            <button type="button" onClick={() => window.studio?.panicHide()}><EyeOff size={15} /><span>Hide window</span><kbd>{panicShortcut}</kbd></button>
            <label className="menu-range"><span>Window transparency <output>{opacity}%</output></span><input type="range" min={20} max={100} step={5} value={opacity} aria-label="Window opacity percent" onChange={event => changeQuickOpacity(Number(event.target.value))} /></label>
          </ActionMenu>
        </div>
      </header>
      {historyError && <div className="history-error" role="status"><span>{historyMessage}</span><button type="button" onClick={onSaveHistory}>Retry saving</button><button type="button" onClick={onExport}>Export</button></div>}
      <div className={`workspace-grid ${captionsOpen ? "with-captions" : "single"}`}>
        {captionsOpen && <CaptionsPanel captions={captions} actions={{ ...captionActions, onEdit: input => { captionActions.onEdit(input); composerRef.current?.focus(); } }} onClose={onToggleCaptions} />}
        <section className="coach-panel" aria-label="Chat answer">
          <div className="pane-heading coach-heading">
            <div><MessageSquareText size={16} /><h2>Answers</h2><QuestionPicker threads={threads} selectedId={selectedThreadId} onSelect={onSelectThread} /></div>
            <div className="pane-actions">
              {(coachText || submittedQuestion || captions.lines.length > 0) && <button title="Export session" aria-label="Export session" onClick={onExport}><FileText size={15} /></button>}
              {coachStatus === 'thinking' && !threads.find(thread => thread.id === selectedThreadId)?.exchanges.some(exchange => exchange.status === 'thinking') && <button title="Stop answer" aria-label="Stop answer" onClick={onCancel}><Square size={14} /></button>}
              <button title="New question" aria-label="New question" onClick={() => { onResetCoach(); composerRef.current?.focus(); }}><Plus size={15} /></button>
            </div>
          </div>
          <div className="coach-scroll" aria-live="polite">
            <QuestionAnswers thread={threads.find(thread => thread.id === selectedThreadId)} onStop={onCancel} onRetry={onRetryAnswer} onEdit={onEditQuestion} busy={coachStatus === 'thinking' || !historyReady} retryWithImagesId={retryWithImagesId} />
          </div>
          <form className="composer" onSubmit={onAsk}>
            <AttachmentTray items={attachments} onRemove={onRemoveCapture} busy={attachmentBusy} />
            <textarea ref={composerRef} disabled={!historyReady} value={question} maxLength={12_000} onChange={(event) => setQuestion(event.target.value)} aria-label="Interview question" placeholder={selectedThreadId ? "Ask a follow-up about this question…" : "Ask a question…"} rows={2} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            <div className="composer-footer">
              <div>
                <ActionMenu label="Attach screenshots" icon={<Paperclip size={15} />} text="Attach" above>
                  <button type="button" onClick={onAttachFiles} disabled={attachmentBusy}><Paperclip size={15} /> Attach files</button>
                  <button type="button" onClick={onCapture} disabled={attachmentBusy}><MonitorUp size={15} /> Screens / windows</button>
                </ActionMenu>
                <button type="button" className="composer-tool" onClick={onSelectArea} disabled={attachmentBusy}><Crop size={15} /> Select area</button>
                <CaptionContext inline items={pendingCaptionContext} onRemove={onRemoveCaptionContext} onClear={onClearCaptionContext} />
              </div>
              <div className="composer-submit"><button className="send-button" aria-label="Send question" title="Send question (Enter)" type="submit" disabled={!historyReady || coachStatus === "thinking" || attachmentBusy || !question.trim()}><Send size={17} /></button></div>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}


function SourcePreview({ source, compact = false }: { source: StudioCaptureSource; compact?: boolean }) {
  return <img className={`source-image ${compact ? "compact" : ""}`} src={source.thumbnail} alt={`${source.name} one-time preview`} />;
}

function AttachmentTray({ items, onRemove, busy }: { items: StudioCaptureSource[]; onRemove: (id: string) => void; busy: boolean }) {
  if (!items.length && !busy) return null;
  return <div className="attachment-tray" aria-label="Screenshot attachments"><div className="attachment-tray-heading"><span>{items.length} screenshot{items.length === 1 ? "" : "s"}</span>{busy && <span role="status"><LoaderCircle size={12} className="attachment-spinner" /> Preparing screenshot…</span>}</div><div className="attachment-items">{items.map(item => <figure className="attachment-item" key={item.id}><img src={item.thumbnail} alt={item.name} /><figcaption title={item.name}>{item.name}</figcaption><button type="button" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name}`} title="Remove screenshot"><X size={12} /></button></figure>)}</div></div>;
}

function CaptureModal({
  sources,
  loading,
  error,
  onClose,
  onChoose,
}: {
  sources: StudioCaptureSource[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onChoose: (sources: StudioCaptureSource[]) => void;
}) {
  const [choices, setChoices] = useState<StudioCaptureSource[]>([]);
  const choice = choices.at(-1);
  return (
    <Modal onClose={onClose} titleId="capture-title" wide>
      <div className="modal-header-row"><div><span className="modal-eyebrow">Screenshot attachments</span><h2 id="capture-title">Choose screens or windows</h2><p>Select the screenshots to attach. Only attached images are sent with your question.</p></div><button className="modal-close inline" onClick={onClose} aria-label="Close capture picker"><X size={17} /></button></div>
      <div className="capture-disclosure"><MonitorUp size={16} /><div><strong>One-time thumbnails are active in this picker</strong><span>Opening the picker captured source thumbnails in memory. Closing it clears the unselected thumbnails; this is not continuous capture. You can also close this picker and drag a screenshot image file anywhere into the window instead.</span></div></div>
      {loading ? (
        <div className="source-loading"><LoaderCircle size={22} /><span>Loading screen thumbnails...</span></div>
      ) : error ? (
        <div className="source-loading" role="status"><MonitorUp size={22} /><span>{error}</span></div>
      ) : (
        <div className="source-picker-layout">
          <div className="source-grid">
            {sources.map((source) => (
              <button key={source.id} aria-pressed={choices.some(item => item.id === source.id)} className={`source-card ${choices.some(item => item.id === source.id) ? "selected" : ""}`} onClick={() => setChoices(current => current.some(item => item.id === source.id) ? current.filter(item => item.id !== source.id) : [...current, source])}>
                <SourcePreview source={source} />
                <div><span className="source-radio">{choices.some(item => item.id === source.id) && <Check size={11} />}</span><strong>{source.name}</strong></div>
              </button>
            ))}
          </div>
          <div className="capture-preview-large">
            <span className="preview-label"><Eye size={13} /> Preview</span>
            {choice ? <SourcePreview source={choice} /> : <div className="empty-preview"><MonitorUp size={25} /><span>Select a source to preview</span></div>}
            {choice && <p><i /> Ready to attach: <strong>{choice.name}</strong></p>}
          </div>
        </div>
      )}
      <div className="modal-actions right"><span className="capture-selection-count">{choices.length} selected</span><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!choices.length || loading} onClick={() => onChoose(choices)}><Camera size={15} /> Attach {choices.length || ""} screenshot{choices.length === 1 ? "" : "s"}</button></div>
    </Modal>
  );
}

function acceleratorKey(event: KeyboardEvent): string {
  const named: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Space: "Space",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete",
    Backspace: "Backspace",
    Enter: "Enter",
    Tab: "Tab",
  };
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^Numpad[0-9]$/.test(event.code)) return `num${event.code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  return named[event.code] ?? "";
}

/** Captures the next key combination as the new foreign-stealth hotkey. */
function ForeignHotkeyCapture({ current, onChange }: { current: string; onChange: (accelerator: string) => Promise<string> }) {
  const [capturing, setCapturing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        setDraft("");
        return;
      }
      const key = acceleratorKey(event);
      if (!key) return; // A modifier alone keeps waiting for the full combination.
      if (event.altKey) {
        setDraft("Alt is not supported — use Ctrl (optionally with Shift)");
        return;
      }
      if (!event.ctrlKey && !event.metaKey) {
        setDraft("Add Ctrl to the combination");
        return;
      }
      const parts: string[] = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Super");
      parts.push(key);
      setCapturing(false);
      setDraft("");
      void onChange(parts.join("+"));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, onChange]);

  if (!capturing) {
    return <button className="secondary-button" onClick={() => setCapturing(true)}>Change ({current})</button>;
  }
  return <span className="hotkey-capture" role="status">{draft || "Press the new combination (Esc cancels)"}</span>;
}

function LibraryView({
  sessions,
  onOpen,
  onNew,
  onRename,
  onDelete,
  onSearch,
  onExport,
}: {
  sessions: SessionSnapshot[];
  onOpen: (session: SessionSnapshot) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSearch: (query: string) => Promise<ConversationSummary[]>;
  onExport: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [filtered, setFiltered] = useState(sessions);
  const [searchError, setSearchError] = useState('');
  const searchRef = useRef(onSearch); searchRef.current = onSearch;
  useEffect(() => {
    if (!search.trim()) { setFiltered(sessions); setSearchError(''); return; }
    let cancelled = false;
    const timer = setTimeout(() => { void searchRef.current(search).then(items => { if (!cancelled) { setFiltered(items); setSearchError(''); } }).catch(() => { if (!cancelled) setSearchError('History search could not be completed. Try again.'); }); }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [search, sessions]);

  const startRename = (item: SessionSnapshot) => {
    setRenamingId(item.id);
    setRenameDraft(item.title);
    setConfirmId(null);
  };

  const commitRename = (item: SessionSnapshot) => {
    if (renamingId !== item.id) return;
    const title = renameDraft.trim().slice(0, 120);
    if (title && title !== item.title) onRename(item.id, title);
    setRenamingId(null);
    setRenameDraft("");
  };

  const dragRef = useDragScroll<HTMLDivElement>();
  return (
    <div className="page library-page" ref={dragRef}>
      <header className="page-header"><div><span className="eyebrow">Saved on this computer</span><h1>Conversation history</h1><p>Reopen your captions, selected questions, and answers—even after restarting.</p></div><button className="primary-button" onClick={onNew}><Plus size={15} /> New session</button></header>
      <div className="library-toolbar"><div className="search-field"><Search size={16} /><input value={search} maxLength={300} onChange={(event) => setSearch(event.target.value)} placeholder="Search captions, questions, or answers" aria-label="Search sessions" /></div></div>
      {searchError && <p role="status">{searchError}</p>}
      <section className="library-table panel" aria-label="Saved conversations">
        <div className="library-head"><span>Conversation</span><span>Captions</span><span>Questions</span><span>Manage</span></div>
        {filtered.map((item, index) => (
          <div className="library-row" key={item.id}>
            {renamingId === item.id ? (
              <div className="library-open">
                <span className={`library-item-icon color-${index % 4}`}><FileText size={17} /></span>
                <input
                  className="rename-input"
                  value={renameDraft}
                  maxLength={120}
                  autoFocus
                  aria-label="Rename session"
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename(item);
                    if (event.key === "Escape") { setRenamingId(null); setRenameDraft(""); }
                  }}
                  onBlur={() => commitRename(item)}
                />
              </div>
            ) : (
              <button className="library-open" onClick={() => { setConfirmId(null); onOpen(item); }}>
                <span className={`library-item-icon color-${index % 4}`}><FileText size={17} /></span>
                <span><strong>{item.title}</strong><small>{new Date(item.updatedAt).toLocaleString()}</small></span>
              </button>
            )}
            <span>{item.captionCount}</span>
            <span>{item.questionCount} · {item.answerCount} answers</span>
            <span className="library-actions">
              <button className="icon-button" aria-label={`Export ${item.title}`} title="Export conversation" onClick={() => onExport(item.id)}><FileText size={14} /></button>
              {renamingId === item.id ? (
                <span className="library-hint">Enter to save</span>
              ) : confirmId === item.id ? (
                <>
                  <button className="icon-button confirm-delete" aria-label={`Confirm deleting ${item.title}`} title="Confirm delete" onClick={() => { onDelete(item.id); setConfirmId(null); }}><Check size={14} /></button>
                  <button className="icon-button" aria-label="Cancel delete" title="Keep session" onClick={() => setConfirmId(null)}><X size={14} /></button>
                </>
              ) : (
                <>
                  <button className="icon-button" aria-label={`Rename ${item.title}`} title="Rename session" onClick={() => startRename(item)}><Pencil size={14} /></button>
                  <button className="icon-button" aria-label={`Delete ${item.title}`} title="Delete session" onClick={() => setConfirmId(item.id)}><Trash2 size={14} /></button>
                </>
              )}
            </span>
          </div>
        ))}
        {!filtered.length && <div className="library-empty"><Library size={25} /><strong>{sessions.length ? "No matching conversations" : "No conversations yet"}</strong><span>{sessions.length ? "Try a different search." : "Start captions or ask a question. Your conversation saves automatically."}</span></div>}
      </section>
    </div>
  );
}

type SettingsProps = {
  translationSettings: PublicTranslationSettings;
  onConfigureTranslation: (request: ConfigureTranslationRequest) => Promise<void>;
  captionProvider: CaptionProvider;
  onChangeCaptionProvider: (provider: CaptionProvider) => Promise<void>;
  hasApiKey: boolean;
  apiKeySource: ApiKeySource;
  secureStorageAvailable: boolean;
  model: string;
  modelSource: ModelSource;
  proxy: PublicProxySettings;
  apiKey: string;
  setApiKey: (value: string) => void;
  showKey: boolean;
  setShowKey: (value: boolean) => void;
  onSave: (event: FormEvent) => Promise<boolean>;
  onClear: () => void;
  onModelChange: (model: string) => Promise<string>;
  onSaveProxy: (request: SetProxyRequest) => Promise<string>;
  onTestProxy: () => Promise<{ ok: boolean; message: string; route: string }>;
  alwaysOnTop: boolean;
  onAlwaysOnTop: () => void;
  role: string;
  setRole: (value: string) => void;
  interviewType: string;
  setInterviewType: (value: string) => void;
  responseStyle: string;
  setResponseStyle: (value: string) => void;
  stealth: StudioStealthSettings;
  panicShortcut: string;
  passthroughShortcut: string;
  onUpdateStealth: (partial: Partial<StudioStealthSettings>) => void;
  provider: StudioProviderId;
  providers: Record<StudioProviderId, StudioProviderStatus>;
  onChangeProvider: (provider: StudioProviderId) => Promise<void>;
  onConfigureProvider: (request: StudioConfigureProviderRequest) => Promise<void>;
  onTestProvider: (provider: StudioProviderId) => Promise<StudioProviderTestResult>;
  profiles: StudioCoachProfile[];
  activeProfileId: string | null;
  onUpsertProfile: (request: StudioProfileUpsertRequest) => Promise<StudioCoachProfile | undefined>;
  onDeleteProfile: (id: string) => Promise<void>;
  onSetActiveProfile: (id: string) => Promise<void>;
  onUploadResume: () => Promise<StudioResumeUploadResult>;
  onAnalyzeCompany: (jobId: string) => Promise<StudioCompanyAnalysisResult>;
  jobs: StudioCoachJob[];
  activeJobId: string | null;
  onUpsertJob: (request: StudioJobUpsertRequest) => Promise<StudioCoachJob | undefined>;
  onDeleteJob: (id: string) => Promise<void>;
  onSetActiveJob: (id: string) => Promise<void>;
  foreignStatus: ConnectionStatus | null;
  foreignShortcut: string;
  restoreShortcut: string;
  onChangeForeignHotkey: (kind: "toggle" | "restore", accelerator: string) => Promise<string>;
};

function SettingsView(props: SettingsProps) {
  const [captionWorking, setCaptionWorking] = useState(false);
  const [captionStatus, setCaptionStatus] = useState<ConnectionStatus | null>(null);
  const [tab, setTab] = useState<"connection" | "coach" | "privacy" | "window">("connection");
  const [replacingKey, setReplacingKey] = useState(false);
  const [decoyDraft, setDecoyDraft] = useState(props.stealth.decoyTitle);
  const [opacityDraft, setOpacityDraft] = useState(props.stealth.opacity);
  const [modelDraft, setModelDraft] = useState(props.model);
  const [modelSaving, setModelSaving] = useState(false);
  const [proxyMode, setProxyMode] = useState<ProxyMode>(props.proxy.mode);
  const [proxyHost, setProxyHost] = useState(props.proxy.host);
  const [proxyPort, setProxyPort] = useState(props.proxy.port?.toString() ?? "");
  const [proxyUsername, setProxyUsername] = useState(props.proxy.username);
  const [proxyPassword, setProxyPassword] = useState("");
  const [showProxyPassword, setShowProxyPassword] = useState(false);
  const [clearProxyPassword, setClearProxyPassword] = useState(false);
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyErrors, setProxyErrors] = useState<Record<string, string>>({});
  const [modelStatus, setModelStatus] = useState<ConnectionStatus | null>(null);
  const [proxyStatus, setProxyStatus] = useState<ConnectionStatus | null>(null);
  const [providerStatus, setProviderStatus] = useState<ConnectionStatus | null>(null);
  const [providerWorking, setProviderWorking] = useState(false);
  const [providerStatusScope, setProviderStatusScope] = useState<StudioProviderId | "selection">("selection");
  const [providerAction, setProviderAction] = useState<"save" | "test" | "switch" | null>(null);
  const [nanoKey, setNanoKey] = useState("");
  const [showNanoKey, setShowNanoKey] = useState(false);
  const [nanoBaseUrl, setNanoBaseUrl] = useState(props.providers.nanogpt.baseUrl);
  const [nanoModel, setNanoModel] = useState(props.providers.nanogpt.model);
  const [routerKey, setRouterKey] = useState("");
  const [showRouterKey, setShowRouterKey] = useState(false);
  const [routerBaseUrl, setRouterBaseUrl] = useState(props.providers.openrouter.baseUrl);
  const [routerModel, setRouterModel] = useState(props.providers.openrouter.model);
  const [lmBaseUrl, setLmBaseUrl] = useState(props.providers.lmstudio.baseUrl);
  const [lmModel, setLmModel] = useState(props.providers.lmstudio.model);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [profileSaving, setProfileSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [profileStatus, setProfileStatus] = useState<ConnectionStatus | null>(null);
  const [jobDraft, setJobDraft] = useState<JobDraft>(EMPTY_JOB_DRAFT);
  const [jobSaving, setJobSaving] = useState(false);
  const [jobStatus, setJobStatus] = useState<ConnectionStatus | null>(null);
  const hostRef = useRef<HTMLInputElement | null>(null);
  const portRef = useRef<HTMLInputElement | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => setModelDraft(props.model), [props.model]);
  useEffect(() => setDecoyDraft(props.stealth.decoyTitle), [props.stealth.decoyTitle]);
  useEffect(() => setOpacityDraft(props.stealth.opacity), [props.stealth.opacity]);
  useEffect(() => {
    setProxyMode(props.proxy.mode);
    setProxyHost(props.proxy.host);
    setProxyPort(props.proxy.port?.toString() ?? "");
    setProxyUsername(props.proxy.username);
    setProxyPassword("");
    setShowProxyPassword(false);
    setClearProxyPassword(false);
    setProxyErrors({});
  }, [props.proxy]);

  const apiKeyInvalid = Boolean(props.apiKey) && (props.apiKey.trim().length < 20 || /\s/.test(props.apiKey.trim()));
  const proxyUsesEndpoint = proxyMode === "http" || proxyMode === "socks5";
  const proxyCredentialsEnabled = proxyMode === "http";
  const normalizedProxyHost = proxyHost.trim();
  const normalizedProxyUsername = proxyUsername.trim();
  const proxyIdentityUnchanged = proxyMode === "http"
    && props.proxy.mode === "http"
    && normalizedProxyHost.toLowerCase() === props.proxy.host.toLowerCase()
    && Number(proxyPort) === props.proxy.port
    && normalizedProxyUsername === props.proxy.username;
  const proxyDirty = proxyMode !== props.proxy.mode
    || normalizedProxyHost !== props.proxy.host
    || proxyPort !== (props.proxy.port?.toString() ?? "")
    || normalizedProxyUsername !== props.proxy.username
    || Boolean(proxyPassword)
    || clearProxyPassword;
  const proxyModeLabel = proxyMode === "system"
    ? "System proxy"
    : proxyMode === "direct"
      ? "Direct"
      : proxyMode === "http"
        ? "HTTP proxy"
        : "SOCKS5 proxy";
  const selectedModel = COACHING_MODELS.find((candidate) => candidate.id === modelDraft);

  const changeModel = async (nextModel: string) => {
    setModelDraft(nextModel);
    setModelSaving(true);
    setModelStatus({ tone: "working", message: "Saving the coaching model..." });
    try {
      const message = await props.onModelChange(nextModel);
      setModelStatus({ tone: "success", message });
    } catch (error) {
      setModelDraft(props.model);
      setModelStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not change the coaching model." });
    } finally {
      setModelSaving(false);
    }
  };

  const changeProxyMode = (nextMode: ProxyMode) => {
    setProxyMode(nextMode);
    setProxyErrors({});
    setProxyStatus(null);
    if ((nextMode === "http" || nextMode === "socks5") && !proxyPort) {
      setProxyPort(nextMode === "http" ? "8080" : "1080");
    }
    if (nextMode !== "http") {
      setProxyUsername("");
      setProxyPassword("");
      setShowProxyPassword(false);
      setClearProxyPassword(props.proxy.hasPassword || Boolean(props.proxy.username));
    }
  };

  const validateProxy = (): boolean => {
    const errors: Record<string, string> = {};
    if (proxyUsesEndpoint) {
      if (!normalizedProxyHost) errors.host = "Enter the proxy hostname or IP address.";
      else if (normalizedProxyHost.includes("://") || /[\s\u0000-\u001f\u007f\/@?#;,=\\]/.test(normalizedProxyHost)) {
        errors.host = "Enter only a hostname or IP address, without a scheme or path.";
      } else if (normalizedProxyHost.startsWith("[") || normalizedProxyHost.endsWith("]")) {
        if (!/^\[[0-9a-f:.]+\]$/i.test(normalizedProxyHost) || !normalizedProxyHost.includes(":")) {
          errors.host = "Enter a valid bracketed IPv6 address, for example [::1].";
        }
      } else if (normalizedProxyHost.includes(":")) {
        errors.host = "Enter IPv6 addresses in brackets, for example [::1].";
      } else if (!/^[a-z0-9.-]+$/i.test(normalizedProxyHost)
        || normalizedProxyHost.startsWith(".")
        || normalizedProxyHost.endsWith(".")
        || normalizedProxyHost.includes("..")
        || normalizedProxyHost.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
        errors.host = "Enter a valid proxy hostname or IP address.";
      }
      if (!/^\d+$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65_535) {
        errors.port = "Enter a port from 1 to 65535.";
      }
    }
    if (proxyCredentialsEnabled) {
      const passwordAvailable = Boolean(proxyPassword)
        || (props.proxy.hasPassword && !clearProxyPassword && proxyIdentityUnchanged);
      if (!props.proxy.credentialsAvailable && !proxyPassword) {
        errors.password = "Re-enter the saved proxy credentials before continuing.";
      }
      if (normalizedProxyUsername && !passwordAvailable) errors.password = "Enter a password or clear the username.";
      if (proxyPassword && !normalizedProxyUsername) errors.username = "Enter a username for this proxy password.";
    }
    setProxyErrors(errors);
    if (errors.host) hostRef.current?.focus();
    else if (errors.port) portRef.current?.focus();
    else if (errors.username) usernameRef.current?.focus();
    else if (errors.password) passwordRef.current?.focus();
    return !Object.keys(errors).length;
  };

  const submitProxy = async (event: FormEvent) => {
    event.preventDefault();
    if (!validateProxy()) return;
    setProxySaving(true);
    setProxyStatus({ tone: "working", message: "Saving proxy settings..." });
    try {
      const request: SetProxyRequest = {
        mode: proxyMode,
        host: proxyUsesEndpoint ? normalizedProxyHost : undefined,
        port: proxyUsesEndpoint ? Number(proxyPort) : undefined,
        username: proxyCredentialsEnabled ? normalizedProxyUsername : "",
        clearPassword: !proxyCredentialsEnabled || clearProxyPassword,
      };
      if (proxyCredentialsEnabled && proxyPassword) request.password = proxyPassword;
      const message = await props.onSaveProxy(request);
      setProxyPassword("");
      setShowProxyPassword(false);
      setClearProxyPassword(false);
      setProxyStatus({ tone: "success", message });
    } catch (error) {
      setProxyStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not save proxy settings." });
    } finally {
      setProxySaving(false);
    }
  };

  const testSavedProxy = async () => {
    if (proxyDirty) {
      setProxyStatus({ tone: "error", message: "Save the proxy changes before testing the connection." });
      return;
    }
    setProxyTesting(true);
    setProxyStatus({ tone: "working", message: "Testing the saved OpenAI HTTPS route..." });
    try {
      const result = await props.onTestProxy();
      setProxyStatus({ tone: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setProxyStatus({ tone: "error", message: error instanceof Error ? error.message : "The proxy test failed." });
    } finally {
      setProxyTesting(false);
    }
  };

  const clearCredentials = () => {
    setProxyUsername("");
    setProxyPassword("");
    setShowProxyPassword(false);
    setClearProxyPassword(true);
    setProxyErrors({});
    setProxyStatus(null);
  };

  const switchCaptionProvider = async (next: CaptionProvider) => {
    setCaptionWorking(true);
    setCaptionStatus(null);
    try {
      await props.onChangeCaptionProvider(next);
      setCaptionStatus({ tone: "success", message: `Captions will use ${CAPTION_PROVIDER_NAMES[next]}. Your chat provider is unchanged.` });
    } catch (error) {
      setCaptionStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not change the caption provider." });
    } finally { setCaptionWorking(false); }
  };

  const saveCaptionRouterKey = async (event: FormEvent) => {
    event.preventDefault();
    setCaptionWorking(true);
    setCaptionStatus(null);
    try {
      await props.onConfigureProvider({ provider: "openrouter", apiKey: routerKey });
      setRouterKey(""); setShowRouterKey(false);
      setCaptionStatus({ tone: "success", message: "OpenRouter key saved. Chat provider and model are unchanged." });
    } catch (error) {
      setCaptionStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not save the caption key." });
    } finally { setCaptionWorking(false); }
  };

  const switchProvider = async (next: StudioProviderId) => {
    setProviderStatusScope("selection"); setProviderAction("switch");
    setProviderWorking(true);
    setProviderStatus({ tone: "working", message: "Switching provider..." });
    try {
      await props.onChangeProvider(next);
      setProviderStatus({ tone: "success", message: `Provider switched to ${PROVIDER_NAMES[next]}.` });
    } catch (error) {
      setProviderStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not change the provider." });
    } finally {
      setProviderWorking(false);
    }
  };

  const saveProviderConfig = async (target: Exclude<StudioProviderId, "openai">) => {
    setProviderStatusScope(target); setProviderAction("save");
    setProviderWorking(true);
    setProviderStatus({ tone: "working", message: "Saving provider settings..." });
    try {
      const request: StudioConfigureProviderRequest = target === "nanogpt"
        ? {
            provider: "nanogpt",
            baseUrl: nanoBaseUrl,
            model: nanoModel,
            ...(nanoKey ? { apiKey: nanoKey } : {}),
          }
        : target === "openrouter"
          ? { provider: "openrouter", baseUrl: routerBaseUrl, model: routerModel, ...(routerKey ? { apiKey: routerKey } : {}) }
          : { provider: "lmstudio", baseUrl: lmBaseUrl, model: lmModel };
      await props.onConfigureProvider(request);
      if (target === "nanogpt") {
        setNanoKey("");
        setShowNanoKey(false);
      }
      if (target === "openrouter") { setRouterKey(""); setShowRouterKey(false); }
      setProviderStatus({ tone: "success", message: `${PROVIDER_NAMES[target]} settings saved. Test the connection to verify access.` });
      return true;
    } catch (error) {
      setProviderStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not save the provider settings." });
      return false;
    } finally {
      setProviderWorking(false);
    }
  };

  const providerDirty = (target: Exclude<StudioProviderId, "openai">) => {
    const saved = props.providers[target];
    const [key, baseUrl, model] = target === "nanogpt" ? [nanoKey, nanoBaseUrl, nanoModel]
      : target === "openrouter" ? [routerKey, routerBaseUrl, routerModel] : ["", lmBaseUrl, lmModel];
    return Boolean(key.trim()) || (baseUrl.trim() || saved.baseUrl) !== saved.baseUrl || (model.trim() || saved.model) !== saved.model;
  };
  const runProviderTest = async (target: Exclude<StudioProviderId, "openai">) => {
    if (providerWorking) return;
    if (providerDirty(target) && !await saveProviderConfig(target)) return;
    setProviderStatusScope(target); setProviderAction("test"); setProviderWorking(true);
    setProviderStatus({ tone: "working", message: `Testing ${PROVIDER_NAMES[target]} connection...` });
    try {
      const result = await props.onTestProvider(target);
      setProviderStatus({ tone: result.ok ? "success" : "error", message: result.message });
    } catch (error) {
      setProviderStatus({ tone: "error", message: error instanceof Error ? error.message : "The provider test failed." });
    } finally {
      setProviderWorking(false); setProviderAction(null);
    }
  };
  const providerActions = (target: Exclude<StudioProviderId, "openai">) => <div className="connection-action-area full-width">
    <ConnectionFeedback status={providerStatusScope === target ? providerStatus : null} hint={providerDirty(target) ? "Unsaved changes. Save & test will save these settings before connecting." : "Test the saved connection to verify access."} />
    <div className="settings-actions">
      <button className="primary-button" type="button" disabled={providerWorking} onClick={() => void runProviderTest(target)}>{providerWorking && providerAction === "test" && <LoaderCircle size={14} className="connection-spinner" />}{providerWorking && providerAction === "test" ? "Testing..." : providerDirty(target) ? "Save & test connection" : "Test connection"}</button>
      <button className="secondary-button" type="button" disabled={providerWorking || !providerDirty(target)} onClick={() => void saveProviderConfig(target)}>{providerWorking && providerAction === "save" ? "Saving..." : `Save ${PROVIDER_NAMES[target]} settings`}</button>
    </div>
  </div>;

  const loadProfileDraft = (item: StudioCoachProfile) => {
    setDraft({
      id: item.id,
      name: item.name,
      details: item.details,
      resumeText: item.resumeText,
      resumeName: item.resumeText ? "Saved resume" : "",
    });
    setProfileStatus(null);
  };

  const clearProfileDraft = () => {
    setDraft(EMPTY_PROFILE_DRAFT);
    setProfileStatus(null);
  };

  const saveProfileDraft = async () => {
    if (!draft.name.trim()) {
      setProfileStatus({ tone: "error", message: "Give the profile a name." });
      return;
    }
    setProfileSaving(true);
    setProfileStatus({ tone: "working", message: "Saving profile..." });
    try {
      const saved = await props.onUpsertProfile({
        id: draft.id,
        name: draft.name,
        details: draft.details,
        resumeText: draft.resumeText,
      });
      if (saved) {
        setDraft({
          id: saved.id,
          name: saved.name,
          details: saved.details,
          resumeText: saved.resumeText,
          resumeName: saved.resumeText ? "Saved resume" : "",
        });
      }
      setProfileStatus({ tone: "success", message: "Profile saved." });
    } catch (error) {
      setProfileStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not save the profile." });
    } finally {
      setProfileSaving(false);
    }
  };

  const removeProfile = async (id: string) => {
    setProfileStatus({ tone: "working", message: "Deleting profile..." });
    try {
      await props.onDeleteProfile(id);
      if (draft.id === id) setDraft(EMPTY_PROFILE_DRAFT);
      setProfileStatus({ tone: "success", message: "Profile deleted." });
    } catch (error) {
      setProfileStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not delete the profile." });
    }
  };

  const activateProfileById = async (id: string) => {
    try {
      await props.onSetActiveProfile(id);
    } catch (error) {
      setProfileStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not activate the profile." });
    }
  };

  const uploadResumeDraft = async () => {
    setProfileStatus({ tone: "working", message: "Reading resume..." });
    try {
      const result = await props.onUploadResume();
      if (!result.text && !result.fileName) {
        setProfileStatus(null);
        return;
      }
      setDraft((current) => ({ ...current, resumeText: result.text, resumeName: result.fileName || "Resume" }));
      setProfileStatus({
        tone: "success",
        message: result.truncated ? "Resume added. It was long, so it was trimmed to fit." : "Resume added to the profile form. Save the profile to keep it.",
      });
    } catch (error) {
      setProfileStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not read the resume." });
    }
  };

  const loadJobDraft = (item: StudioCoachJob) => {
    setJobDraft({
      id: item.id,
      name: item.name,
      jobDescription: item.jobDescription,
      companyName: item.companyName,
      companyWebsite: item.companyWebsite,
      companySocial: item.companySocial,
      companyBrief: item.companyBrief,
    });
    setJobStatus(null);
  };

  const clearJobDraft = () => {
    setJobDraft(EMPTY_JOB_DRAFT);
    setJobStatus(null);
  };

  const saveJobDraft = async () => {
    if (!jobDraft.name.trim()) {
      setJobStatus({ tone: "error", message: "Give the job a name." });
      return;
    }
    setJobSaving(true);
    setJobStatus({ tone: "working", message: "Saving job..." });
    try {
      const saved = await props.onUpsertJob({
        id: jobDraft.id,
        name: jobDraft.name,
        jobDescription: jobDraft.jobDescription,
        companyName: jobDraft.companyName,
        companyWebsite: jobDraft.companyWebsite,
        companySocial: jobDraft.companySocial,
      });
      if (saved) {
        setJobDraft({
          id: saved.id,
          name: saved.name,
          jobDescription: saved.jobDescription,
          companyName: saved.companyName,
          companyWebsite: saved.companyWebsite,
          companySocial: saved.companySocial,
          companyBrief: saved.companyBrief,
        });
      }
      setJobStatus({ tone: "success", message: "Job saved." });
    } catch (error) {
      setJobStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not save the job." });
    } finally {
      setJobSaving(false);
    }
  };

  const removeJob = async (id: string) => {
    setJobStatus({ tone: "working", message: "Deleting job..." });
    try {
      await props.onDeleteJob(id);
      if (jobDraft.id === id) setJobDraft(EMPTY_JOB_DRAFT);
      setJobStatus({ tone: "success", message: "Job deleted." });
    } catch (error) {
      setJobStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not delete the job." });
    }
  };

  const activateJobById = async (id: string) => {
    try {
      await props.onSetActiveJob(id);
    } catch (error) {
      setJobStatus({ tone: "error", message: error instanceof Error ? error.message : "Could not activate the job." });
    }
  };

  const savedJobDraft = props.jobs.find(job => job.id === jobDraft.id);
  const jobDraftDirty = !savedJobDraft || ['name', 'jobDescription', 'companyName', 'companyWebsite', 'companySocial'].some(key => jobDraft[key as keyof JobDraft] !== savedJobDraft[key as keyof StudioCoachJob]);
  const analyzeDraftJobCompany = async () => {
    if (!jobDraft.name.trim()) {
      setJobStatus({ tone: "error", message: "Give the job a name before analyzing its company." });
      return;
    }
    if (!jobDraft.companyName.trim() && !jobDraft.companyWebsite.trim()) {
      setJobStatus({ tone: "error", message: "Add a company name or website first." });
      return;
    }
    setAnalyzing(true);
    setJobStatus({ tone: "working", message: "Saving your job details before researching the company..." });
    try {
      const saved = await props.onUpsertJob({ id: jobDraft.id, name: jobDraft.name, jobDescription: jobDraft.jobDescription, companyName: jobDraft.companyName, companyWebsite: jobDraft.companyWebsite, companySocial: jobDraft.companySocial });
      if (!saved) throw new Error("Could not save the job. Company research has not started.");
      setJobDraft(current => current === jobDraft ? { ...saved } : current);
      setJobStatus({ tone: "working", message: "Researching the company — fetching its website and recent news..." });
      const result = await props.onAnalyzeCompany(saved.id);
      // A user may open/edit another draft while research is in flight. The
      // main process saves the result to its original job; mirror it only here.
      setJobDraft(current => current.id === saved.id && current.companyName === saved.companyName && current.companyWebsite === saved.companyWebsite && current.companySocial === saved.companySocial ? { ...current, companyBrief: result.companyBrief } : current);
      setJobStatus(
        result.warning
          ? { tone: "neutral", message: `Briefing saved with a note: ${result.warning}` }
          : { tone: "success", message: "Company briefing saved." },
      );
    } catch (error) {
      setJobStatus({ tone: "error", message: error instanceof Error ? error.message : "Company analysis failed." });
    } finally {
      setAnalyzing(false);
    }
  };

  const dragRef = useDragScroll<HTMLDivElement>();
  return (
    <div className="page settings-page" ref={dragRef}>
      <header className="page-header"><div><span className="eyebrow">Local preferences</span><h1>Settings</h1><p>Configure your own API connection, coaching context, privacy boundary, and visible window behavior.</p></div></header>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Settings sections">
          <button type="button" aria-current={tab === "connection" ? "page" : undefined} className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}><KeyRound size={16} /> AI connection</button>
          <button type="button" aria-current={tab === "coach" ? "page" : undefined} className={tab === "coach" ? "active" : ""} onClick={() => setTab("coach")}><BrainCircuit size={16} /> Coach profile</button>
          <button type="button" aria-current={tab === "privacy" ? "page" : undefined} className={tab === "privacy" ? "active" : ""} onClick={() => setTab("privacy")}><ShieldCheck size={16} /> Privacy</button>
          <button type="button" aria-current={tab === "window" ? "page" : undefined} className={tab === "window" ? "active" : ""} onClick={() => setTab("window")}><MonitorUp size={16} /> Window</button>
        </nav>
        <div className="settings-content">
          {tab === "connection" && <>
            <section className="settings-section">
              <div className="settings-title"><span className="settings-icon"><KeyRound size={18} /></span><div><h2>AI provider</h2><p>Choose where chat answers and company research are generated. Keys stay on this device.</p></div></div>
              <div className="connection-field provider-field">
                <label htmlFor="provider-select">Provider</label>
                <MenuSelect
                  id="provider-select"
                  ariaLabel="AI provider"
                  value={props.provider}
                  disabled={providerWorking}
                  options={[
                    { value: "openai", label: "OpenAI (bring your own key)" },
                    { value: "nanogpt", label: "NanoGPT API" },
                    { value: "openrouter", label: "OpenRouter API" },
                    { value: "lmstudio", label: "LM Studio (local server)" },
                  ]}
                  onChange={(next) => void switchProvider(next as StudioProviderId)}
                />
                <p>For screenshot questions, choose a model that supports images.</p>
              </div>
              {providerStatusScope === "selection" && providerStatus && <ConnectionFeedback status={providerStatus} hint="" />}
            </section>

            {props.provider === "openai" && <section className="settings-section">
              <div className="settings-title"><span className="settings-icon"><KeyRound size={18} /></span><div><h2>OpenAI connection</h2><p>No login or signup is used. Your key is transferred through the desktop bridge and is never written to browser storage.</p></div><span className={`configured-badge ${props.hasApiKey ? "on" : ""}`}><i />{props.hasApiKey ? "Configured" : "Not configured"}</span></div>
              {props.hasApiKey && (
                <div className="configured-key">
                  <div><KeyRound size={17} /><span><strong>API key</strong><small>{props.apiKeySource === "environment" ? "Provided by OPENAI_API_KEY · manual override available" : props.apiKeySource === "memory" ? "Manual key held in memory · cleared when the app closes" : "Manual key stored with operating-system encryption"}</small></span></div>
                  {props.apiKeySource !== "environment" && <div className="configured-actions"><button type="button" className="text-button" onClick={() => setReplacingKey(true)}>Replace</button><button type="button" className="danger-text" onClick={props.onClear}><Trash2 size={14} /> Remove</button></div>}
                </div>
              )}
              {(!props.hasApiKey || replacingKey || props.apiKeySource === "environment") && (
                <form className="api-form" onSubmit={async (event) => {
                  const saved = await props.onSave(event);
                  if (saved) setReplacingKey(false);
                }}>
                  <label htmlFor="api-key">{props.apiKeySource === "environment" ? "Manual API key" : props.hasApiKey ? "Replacement API key" : "API key"}</label>
                  <div className={`key-input ${apiKeyInvalid ? "input-error" : ""}`}><KeyRound size={16} /><input id="api-key" type={props.showKey ? "text" : "password"} value={props.apiKey} maxLength={1_000} onChange={(event) => props.setApiKey(event.target.value)} placeholder="sk-..." autoComplete="off" spellCheck={false} aria-invalid={apiKeyInvalid} aria-describedby="api-key-help" /><button type="button" aria-label={props.showKey ? "Hide API key" : "Show API key"} aria-controls="api-key" aria-pressed={props.showKey} onClick={() => props.setShowKey(!props.showKey)}>{props.showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
                  <p id="api-key-help">{apiKeyInvalid ? "Use a key of at least 20 characters without spaces." : props.apiKeySource === "environment" ? "Save a manual key here to override OPENAI_API_KEY. Removing it later restores the environment key." : props.secureStorageAvailable ? "The saved key is encrypted through the operating-system credential facility and is not shown again." : "OS-backed encryption is unavailable, so this key will remain in memory only until the app closes."}</p>
                  <div className="settings-actions"><button className="primary-button" type="submit" disabled={!props.apiKey.trim() || apiKeyInvalid}>{props.apiKeySource === "environment" ? "Use manual API key" : props.hasApiKey ? "Replace API key" : "Save API key"}</button>{replacingKey && props.apiKeySource !== "environment" && <button className="secondary-button" type="button" onClick={() => { props.setApiKey(""); props.setShowKey(false); setReplacingKey(false); }}>Cancel</button>}</div>
                </form>
              )}
              <div className="connection-divider" />
              <div className="connection-field">
                <label htmlFor="coaching-model">Coaching model</label>
                <MenuSelect
                  id="coaching-model"
                  ariaLabel="Coaching model"
                  describedBy="coaching-model-help"
                  disabled={modelSaving || props.modelSource === "environment"}
                  value={modelDraft}
                  options={[
                    ...(!COACHING_MODELS.some((candidate) => candidate.id === modelDraft)
                      ? [{ value: modelDraft, label: modelDraft }]
                      : []),
                    ...COACHING_MODELS.map((candidate) => ({ value: candidate.id, label: candidate.label })),
                  ]}
                  onChange={(next) => void changeModel(next)}
                />
                <p id="coaching-model-help">{props.modelSource === "environment" ? "Managed by OPENAI_MODEL for this app run." : selectedModel?.description ?? "Used for chat answers."}</p>
              </div>
              {modelStatus && <div className={`connection-status ${modelStatus.tone}`} role="status" aria-live="polite">{modelStatus.message}</div>}
            </section>}

            {props.provider === "nanogpt" && <section className="settings-section">
              <div className="settings-title"><span className="settings-icon"><KeyRound size={18} /></span><div><h2>NanoGPT connection</h2><p>Uses the OpenAI-compatible NanoGPT API. Create an API key on nano-gpt.com and paste it here; it is stored with operating-system encryption when available.</p></div><span className={`configured-badge ${props.providers.nanogpt.configured ? "on" : ""}`}><i />{props.providers.nanogpt.configured ? "Configured" : "Not configured"}</span></div>
              <div className="connection-form">
                <div className="connection-field full-width">
                  <label htmlFor="nano-key">API key</label>
                  <div className="key-input">
                    <KeyRound size={16} />
                    <input disabled={providerWorking} id="nano-key" type={showNanoKey ? "text" : "password"} value={nanoKey} maxLength={1_000} onChange={(event) => { setNanoKey(event.target.value); setProviderStatus(null); }} placeholder={props.providers.nanogpt.configured ? "Saved · enter a new key to replace it" : "NanoGPT API key"} autoComplete="off" spellCheck={false} />
                    <button type="button" disabled={providerWorking} aria-label={showNanoKey ? "Hide NanoGPT API key" : "Show NanoGPT API key"} aria-pressed={showNanoKey} onClick={() => setShowNanoKey(!showNanoKey)}>{showNanoKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  </div>
                  {props.providers.nanogpt.keySource !== "none" && <p>{props.providers.nanogpt.keySource === "environment" ? "Provided by NANOGPT_API_KEY." : props.providers.nanogpt.keySource === "memory" ? "Held in memory until the app closes." : "Stored with operating-system encryption."}</p>}
                </div>
                <div className="connection-field">
                  <label htmlFor="nano-base">Base URL</label>
                  <input disabled={providerWorking} id="nano-base" value={nanoBaseUrl} maxLength={300} spellCheck={false} placeholder={props.providers.nanogpt.baseUrl || "https://nano-gpt.com/api/v1"} onChange={(event) => { setNanoBaseUrl(event.target.value); setProviderStatus(null); }} />
                </div>
                <div className="connection-field">
                  <label htmlFor="nano-model">Model</label>
                  <input disabled={providerWorking} id="nano-model" value={nanoModel} maxLength={120} spellCheck={false} placeholder={props.providers.nanogpt.model || "openai/gpt-4.1-nano"} onChange={(event) => { setNanoModel(event.target.value); setProviderStatus(null); }} />
                  <p>Current: {props.providers.nanogpt.model}</p>
                </div>
                {providerActions("nanogpt")}
              </div>
            </section>}

            {props.provider === "openrouter" && <section className="settings-section">
              <div className="settings-title"><span className="settings-icon"><KeyRound size={18} /></span><div><h2>OpenRouter connection</h2><p>Uses the OpenAI-compatible OpenRouter API. Create an API key on openrouter.ai/keys and paste it here; it is stored with operating-system encryption when available.</p></div><span className={`configured-badge ${props.providers.openrouter.configured ? "on" : ""}`}><i />{props.providers.openrouter.configured ? "Configured" : "Not configured"}</span></div>
              <div className="connection-form provider-connection-form">
                <div className="connection-field full-width">
                  <label htmlFor="router-key">API key</label>
                  <div className="key-input">
                    <KeyRound size={16} />
                    <input disabled={providerWorking} id="router-key" type={showRouterKey ? "text" : "password"} value={routerKey} maxLength={1_000} onChange={(event) => { setRouterKey(event.target.value); setProviderStatus(null); }} placeholder={props.providers.openrouter.configured ? "Saved · enter a new key to replace it" : "OpenRouter API key"} autoComplete="off" spellCheck={false} />
                    <button type="button" disabled={providerWorking} aria-label={showRouterKey ? "Hide OpenRouter API key" : "Show OpenRouter API key"} aria-pressed={showRouterKey} onClick={() => setShowRouterKey(!showRouterKey)}>{showRouterKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  </div>
                  {props.providers.openrouter.keySource !== "none" && <p>{props.providers.openrouter.keySource === "environment" ? "Provided by OPENROUTER_API_KEY." : props.providers.openrouter.keySource === "memory" ? "Held in memory until the app closes." : "Stored with operating-system encryption."}</p>}
                </div>
                <div className="connection-field">
                  <label htmlFor="router-base">Base URL</label>
                  <input disabled={providerWorking} id="router-base" value={routerBaseUrl} maxLength={300} spellCheck={false} placeholder={props.providers.openrouter.baseUrl || "https://openrouter.ai/api/v1"} onChange={(event) => { setRouterBaseUrl(event.target.value); setProviderStatus(null); }} />
                </div>
                <div className="connection-field">
                  <label htmlFor="router-model">Model</label>
                  <input disabled={providerWorking} id="router-model" value={routerModel} maxLength={120} spellCheck={false} placeholder={props.providers.openrouter.model || "openai/gpt-4.1-mini"} onChange={(event) => { setRouterModel(event.target.value); setProviderStatus(null); }} />
                  <p>Current: {props.providers.openrouter.model}. Use an image-capable model for screenshot questions.</p>
                </div>
                {providerActions("openrouter")}
              </div>
            </section>}

            {props.provider === "lmstudio" && <section className="settings-section">
              <div className="settings-title"><span className="settings-icon purple"><Activity size={18} /></span><div><h2>LM Studio connection</h2><p>Chat answers run on your local LM Studio server — no API key and no cloud connection. Load a model and start the server in LM Studio first.</p></div><span className="configured-badge on"><i />Local server</span></div>
              <div className="connection-form">
                <div className="connection-field">
                  <label htmlFor="lm-base">Server URL</label>
                  <input disabled={providerWorking} id="lm-base" value={lmBaseUrl} maxLength={300} spellCheck={false} placeholder={props.providers.lmstudio.baseUrl || "http://localhost:1234/v1"} onChange={(event) => { setLmBaseUrl(event.target.value); setProviderStatus(null); }} />
                  <p>The default local server address is {props.providers.lmstudio.baseUrl || "http://localhost:1234/v1"}.</p>
                </div>
                <div className="connection-field">
                  <label htmlFor="lm-model">Model</label>
                  <input disabled={providerWorking} id="lm-model" value={lmModel} maxLength={120} spellCheck={false} placeholder={props.providers.lmstudio.model || "local-model"} onChange={(event) => { setLmModel(event.target.value); setProviderStatus(null); }} />
                  <p>Current: {props.providers.lmstudio.model}</p>
                </div>
                {providerActions("lmstudio")}
              </div>
            </section>}

            <section className="settings-section">
              <div className="settings-title"><span className="settings-icon"><Captions size={18} /></span><div><h2>Caption transcription</h2><p>Choose captions separately. Your answer provider stays on {PROVIDER_NAMES[props.provider]}.</p></div>{props.captionProvider === "offline" ? <span className="configured-badge on"><i /> Local audio</span> : <span className={`configured-badge ${props.providers[props.captionProvider].configured ? "on" : ""}`}><i />{props.providers[props.captionProvider].configured ? "Key configured" : "Key needed"}</span>}</div>
              <div className="connection-field">
                <label htmlFor="caption-provider-select">Caption provider</label>
                <MenuSelect id="caption-provider-select" ariaLabel="Caption provider" value={props.captionProvider} disabled={captionWorking} options={[{ value: "openai", label: "OpenAI" }, { value: "openrouter", label: "OpenRouter" }, { value: "offline", label: "Offline (local)" }]} onChange={next => void switchCaptionProvider(next as CaptionProvider)} />
                <p>{props.captionProvider === "offline" ? "Uses sherpa-onnx on this PC for live English captions. No caption audio is uploaded and there is no cloud fallback." : props.captionProvider === "openrouter" ? "Uses your saved OpenRouter key and MAI-Transcribe 2 for captions." : "Uses your saved OpenAI key and GPT-4o Transcribe for both audio sources."} Captions separate your microphone (YOU) from computer audio (Professional).</p>
              </div>
              {props.captionProvider === "offline" && <OfflineCaptionSetup />}
              {props.captionProvider === "openai" && props.provider !== "openai" && <form className="api-form" onSubmit={props.onSave}>
                <label htmlFor="caption-api-key">OpenAI API key for captions</label>
                <div className="key-input"><KeyRound size={16} /><input id="caption-api-key" type={props.showKey ? "text" : "password"} value={props.apiKey} maxLength={1000} onChange={event => props.setApiKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder={props.hasApiKey ? "Saved key in use; enter a key to replace it" : "sk-..."} /><button type="button" aria-label="Show or hide caption API key" onClick={() => props.setShowKey(!props.showKey)}>{props.showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
                <p>Stored with operating-system encryption when available; otherwise held in memory until exit. Audio is sent only while captions run.</p>
                <div className="settings-actions"><button className="primary-button" type="submit" disabled={!props.apiKey.trim() || apiKeyInvalid}>Save caption key</button></div>
              </form>}
              {props.captionProvider === "openrouter" && props.provider !== "openrouter" && <form className="api-form" onSubmit={event => void saveCaptionRouterKey(event)}>
                <label htmlFor="caption-router-key">OpenRouter API key for captions</label>
                <div className="key-input"><KeyRound size={16} /><input id="caption-router-key" type={showRouterKey ? "text" : "password"} value={routerKey} maxLength={1000} onChange={event => setRouterKey(event.target.value)} autoComplete="off" spellCheck={false} placeholder={props.providers.openrouter.configured ? "Saved OpenRouter key in use; enter a key to replace it" : "sk-or-v1-..."} /><button type="button" aria-label="Show or hide OpenRouter caption API key" aria-pressed={showRouterKey} onClick={() => setShowRouterKey(!showRouterKey)}>{showRouterKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
                <p>This key is shared with the OpenRouter chat connection. Stored with operating-system encryption when available; otherwise held in memory until exit.</p>
                <div className="settings-actions"><button className="primary-button" type="submit" disabled={captionWorking || !routerKey.trim()}>Save OpenRouter caption key</button></div>
              </form>}
              {props.captionProvider === props.provider && <p className="caption-key-note">Uses the API key in your {PROVIDER_NAMES[props.captionProvider]} connection.</p>}
              {captionStatus && <div className={`connection-status ${captionStatus.tone}`} role="status">{captionStatus.message}</div>}
            </section>

            <TranslationSettings settings={props.translationSettings} chatProvider={props.provider} chatConfigured={props.providers[props.provider].configured} onConfigure={props.onConfigureTranslation} />

            <section className="settings-section">
              <div className="settings-title"><span className="settings-icon purple"><Activity size={18} /></span><div><h2>Network proxy</h2><p>Route supported OpenAI network requests through the system configuration, a direct route, HTTP, or SOCKS5 proxy.</p></div><span className={`configured-badge ${props.proxy.mode !== "direct" && !proxyDirty ? "on" : ""}`}><i />{proxyDirty ? "Unsaved changes" : proxyModeLabel}</span></div>
              <form className="connection-form" onSubmit={submitProxy} noValidate>
                <div className="connection-field full-width">
                  <label htmlFor="proxy-mode">Proxy mode</label>
                  <MenuSelect
                    id="proxy-mode"
                    ariaLabel="Proxy mode"
                    value={proxyMode}
                    options={[
                      { value: "system", label: "Use operating-system proxy" },
                      { value: "direct", label: "Direct connection (no proxy)" },
                      { value: "http", label: "HTTP proxy" },
                      { value: "socks5", label: "SOCKS5 proxy" },
                    ]}
                    onChange={(next) => changeProxyMode(next as ProxyMode)}
                  />
                </div>
                <div className="connection-field">
                  <label htmlFor="proxy-host">Host</label>
                  <input ref={hostRef} id="proxy-host" value={proxyHost} disabled={!proxyUsesEndpoint} maxLength={255} placeholder="proxy.example.com" autoComplete="off" spellCheck={false} aria-invalid={Boolean(proxyErrors.host)} aria-describedby={proxyErrors.host ? "proxy-host-error" : undefined} onChange={(event) => { setProxyHost(event.target.value); setProxyErrors((current) => ({ ...current, host: "" })); setProxyStatus(null); }} />
                  {proxyErrors.host && <span className="field-error" id="proxy-host-error">{proxyErrors.host}</span>}
                </div>
                <div className="connection-field port-field">
                  <label htmlFor="proxy-port">Port</label>
                  <input ref={portRef} id="proxy-port" value={proxyPort} disabled={!proxyUsesEndpoint} inputMode="numeric" pattern="[0-9]*" placeholder={proxyMode === "socks5" ? "1080" : "8080"} aria-invalid={Boolean(proxyErrors.port)} aria-describedby={proxyErrors.port ? "proxy-port-error" : undefined} onChange={(event) => { setProxyPort(event.target.value.replace(/\D/g, "").slice(0, 5)); setProxyErrors((current) => ({ ...current, port: "" })); setProxyStatus(null); }} />
                  {proxyErrors.port && <span className="field-error" id="proxy-port-error">{proxyErrors.port}</span>}
                </div>
                <fieldset className="proxy-credentials full-width" disabled={!proxyCredentialsEnabled}>
                  <legend>HTTP proxy credentials <span>Optional</span></legend>
                  <p id="proxy-credentials-help">Username and password authentication is available for HTTP proxies. SOCKS5 credentials are not supported and are cleared when SOCKS5 is selected.</p>
                  <div className="credential-grid">
                    <div className="connection-field">
                      <label htmlFor="proxy-username">Username</label>
                      <input ref={usernameRef} id="proxy-username" value={proxyUsername} maxLength={255} autoComplete="username" aria-invalid={Boolean(proxyErrors.username)} aria-describedby={proxyErrors.username ? "proxy-username-error" : "proxy-credentials-help"} onChange={(event) => { setProxyUsername(event.target.value); setClearProxyPassword(false); setProxyErrors((current) => ({ ...current, username: "" })); setProxyStatus(null); }} />
                      {proxyErrors.username && <span className="field-error" id="proxy-username-error">{proxyErrors.username}</span>}
                    </div>
                    <div className="connection-field">
                      <label htmlFor="proxy-password">Password</label>
                      <div className={`key-input ${proxyErrors.password ? "input-error" : ""}`}><input ref={passwordRef} id="proxy-password" type={showProxyPassword ? "text" : "password"} value={proxyPassword} maxLength={1_024} placeholder={props.proxy.hasPassword && !clearProxyPassword && proxyIdentityUnchanged ? "Saved · leave blank to keep" : "Optional"} autoComplete="new-password" aria-invalid={Boolean(proxyErrors.password)} aria-describedby={proxyErrors.password ? "proxy-password-error" : "proxy-credentials-help"} onChange={(event) => { setProxyPassword(event.target.value); setClearProxyPassword(false); setProxyErrors((current) => ({ ...current, password: "" })); setProxyStatus(null); }} /><button type="button" aria-label={showProxyPassword ? "Hide proxy password" : "Show proxy password"} aria-controls="proxy-password" aria-pressed={showProxyPassword} onClick={() => setShowProxyPassword(!showProxyPassword)}>{showProxyPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
                      {proxyErrors.password && <span className="field-error" id="proxy-password-error">{proxyErrors.password}</span>}
                    </div>
                  </div>
                  {(props.proxy.hasPassword || proxyUsername || proxyPassword) && <button className="danger-text credential-clear" type="button" onClick={clearCredentials}><Trash2 size={14} /> Clear credentials</button>}
                </fieldset>
                {!props.proxy.credentialsAvailable && <div className="connection-status error" role="alert">Saved proxy credentials could not be decrypted. Re-enter and save them before contacting OpenAI.</div>}
                <div className="proxy-disclosure full-width"><ShieldCheck size={15} /><p>Chat API requests use the selected route.</p></div>
                <div className="settings-actions full-width"><button className="primary-button" type="submit" disabled={proxySaving || proxyTesting}>{proxySaving ? "Saving..." : "Save proxy"}</button><button className="secondary-button" type="button" disabled={proxySaving || proxyTesting} onClick={() => void testSavedProxy()}>{proxyTesting ? "Testing..." : "Test saved connection"}</button></div>
                {proxyStatus && <div className={`connection-status ${proxyStatus.tone}`} role="status" aria-live="polite">{proxyStatus.message}</div>}
              </form>
            </section>
          </>}

          {tab === "coach" && <section className="settings-section">
            <div className="settings-title"><span className="settings-icon purple"><BrainCircuit size={18} /></span><div><h2>Candidate profiles</h2><p>Save multiple profiles about you — your experience, skills, and resume. The active profile tailors chat answers. Only include experience you actually have — the coach never invents achievements.</p></div><span className={`configured-badge ${props.activeProfileId ? "on" : ""}`}><i />{props.activeProfileId ? "Profile active" : "No profile"}</span></div>
            <div className="profile-manager">
              <div className="profile-list" role="list" aria-label="Saved profiles">
                {props.profiles.map((item) => (
                  <div key={item.id} role="listitem" className={`profile-item ${item.id === props.activeProfileId ? "active" : ""}`}>
                    <button type="button" className="profile-select" aria-pressed={item.id === props.activeProfileId} title={item.id === props.activeProfileId ? "Active profile" : "Use this profile"} onClick={() => void activateProfileById(item.id)}>
                      <BrainCircuit size={15} />
                      <span><strong>{item.name}</strong><small>{item.resumeText ? "Resume included" : "No resume"}</small></span>
                    </button>
                    <div className="profile-item-actions">
                      <button type="button" className="icon-button" aria-label={`Edit ${item.name}`} title="Edit profile" onClick={() => loadProfileDraft(item)}><Pencil size={13} /></button>
                      <button type="button" className="icon-button" aria-label={`Delete ${item.name}`} title="Delete profile" onClick={() => void removeProfile(item.id)}><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
                {!props.profiles.length && <p className="profile-empty">No profiles saved yet. Fill in the form below and save your first profile.</p>}
              </div>
              <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void saveProfileDraft(); }}>
                <div className="connection-field">
                  <label htmlFor="profile-name">Profile name</label>
                  <input id="profile-name" value={draft.name} maxLength={80} placeholder="Frontend engineer" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </div>
                <label className="profile-field">Profile details
                  <textarea
                    className="profile-textarea"
                    rows={4}
                    value={draft.details}
                    maxLength={4_000}
                    placeholder={"Experience, skills, and anything the coach should know:\n- 3 years of React and TypeScript\n- Led a team of 2 junior developers"}
                    onChange={(event) => setDraft({ ...draft, details: event.target.value })}
                    aria-label="Profile details"
                  />
                </label>
                <div className="resume-actions">
                  <button type="button" className="secondary-button" onClick={() => void uploadResumeDraft()}><FileText size={14} /> {draft.resumeName ? "Replace resume" : "Upload resume"}</button>
                  {draft.resumeName && <span className="resume-name">{draft.resumeName}</span>}
                </div>
                <div className="settings-actions">
                  <button className="primary-button" type="submit" disabled={profileSaving || !draft.name.trim()}>{profileSaving ? "Saving..." : draft.id ? "Save profile" : "Create profile"}</button>
                  <button className="secondary-button" type="button" onClick={clearProfileDraft}>New profile</button>
                </div>
                {profileStatus && <div className={`connection-status ${profileStatus.tone}`} role="status" aria-live="polite">{profileStatus.message}</div>}
              </form>
            </div>
            <div className="settings-title coach-job-title"><span className="settings-icon lime"><Briefcase size={18} /></span><div><h2>Jobs &amp; companies</h2><p>Separate from profiles: each job holds the job description plus the target company details, and company research adds a briefing. Pick the job you are applying for; it pairs with any candidate profile.</p></div><span className={`configured-badge ${props.activeJobId ? "on" : ""}`}><i />{props.activeJobId ? "Job active" : "No job"}</span></div>
            <div className="profile-manager">
              <div className="profile-list" role="list" aria-label="Saved jobs">
                {props.jobs.map((item) => (
                  <div key={item.id} role="listitem" className={`profile-item ${item.id === props.activeJobId ? "active" : ""}`}>
                    <button type="button" className="profile-select" aria-pressed={item.id === props.activeJobId} title={item.id === props.activeJobId ? "Active job" : "Use this job"} onClick={() => void activateJobById(item.id)}>
                      <Briefcase size={15} />
                      <span><strong>{item.name}</strong><small>{item.companyName || "No company set"}</small></span>
                    </button>
                    <div className="profile-item-actions">
                      <button type="button" className="icon-button" aria-label={`Edit ${item.name}`} title="Edit job" onClick={() => loadJobDraft(item)}><Pencil size={13} /></button>
                      <button type="button" className="icon-button" aria-label={`Delete ${item.name}`} title="Delete job" onClick={() => void removeJob(item.id)}><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
                {!props.jobs.length && <p className="profile-empty">No jobs saved yet. Add the job description and company details below.</p>}
              </div>
              <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void saveJobDraft(); }}>
                <div className="connection-field">
                  <label htmlFor="job-name">Job label</label>
                  <input id="job-name" value={jobDraft.name} maxLength={80} placeholder="Senior frontend role" onChange={(event) => setJobDraft({ ...jobDraft, name: event.target.value })} />
                </div>
                <label className="profile-field">Job description
                  <textarea
                    className="profile-textarea"
                    rows={4}
                    value={jobDraft.jobDescription}
                    maxLength={8_000}
                    placeholder="Paste the job description of the position you are applying for."
                    onChange={(event) => setJobDraft({ ...jobDraft, jobDescription: event.target.value })}
                    aria-label="Job description"
                  />
                </label>
                <div className="form-grid">
                  <label>Company name<input value={jobDraft.companyName} maxLength={120} placeholder="Acme Corp" onChange={(event) => setJobDraft({ ...jobDraft, companyName: event.target.value })} /></label>
                  <label>Company website<input value={jobDraft.companyWebsite} maxLength={300} placeholder="https://acme.example" spellCheck={false} onChange={(event) => setJobDraft({ ...jobDraft, companyWebsite: event.target.value })} /></label>
                  <label>Company social profile<input value={jobDraft.companySocial} maxLength={300} placeholder="https://linkedin.com/company/acme" spellCheck={false} onChange={(event) => setJobDraft({ ...jobDraft, companySocial: event.target.value })} /></label>
                </div>
                {jobDraft.companyBrief && (
                  <div className="company-brief">
                    <strong>Company briefing</strong>
                    <p>{jobDraft.companyBrief}</p>
                  </div>
                )}
                <div className="settings-actions">
                  <button className="primary-button" type="submit" disabled={jobSaving || !jobDraft.name.trim()}>{jobSaving ? "Saving..." : jobDraft.id ? "Save job" : "Create job"}</button>
                  <button className="secondary-button" type="button" disabled={analyzing || jobSaving} onClick={() => void analyzeDraftJobCompany()}>{analyzing ? "Researching..." : jobDraftDirty ? "Save & analyze company" : "Analyze company"}</button>
                  <button className="secondary-button" type="button" onClick={clearJobDraft}>New job</button>
                </div>
                {jobStatus && <div className={`connection-status ${jobStatus.tone}`} role="status" aria-live="polite">{jobStatus.message}</div>}
              </form>
            </div>
            <div className="form-grid"><label>Target role<input value={props.role} maxLength={120} onChange={(event) => props.setRole(event.target.value)} /></label><label>Interview type<input value={props.interviewType} maxLength={120} onChange={(event) => props.setInterviewType(event.target.value)} /></label><div className="form-grid-field"><span>Response style</span><MenuSelect ariaLabel="Response style" value={props.responseStyle} options={RESPONSE_STYLES.map((style) => ({ value: style, label: style }))} onChange={props.setResponseStyle} /></div></div>
          </section>}

          {tab === "privacy" && <section className="settings-section compact-settings">
            <div className="settings-title"><span className="settings-icon purple"><ShieldCheck size={18} /></span><div><h2>Privacy boundary</h2><p>Questions are sent to your selected provider when you submit them. Captions use your separately selected caption provider.</p></div><span className="configured-badge on"><i /> Always enforced</span></div>
            <div className="setting-row"><div><strong>Optional live captions</strong><p>{props.captionProvider === "offline" ? "Selected microphone and/or computer audio is processed on this PC for offline captions." : `Start captions to send selected microphone and/or computer audio to ${CAPTION_PROVIDER_NAMES[props.captionProvider]}.`} Pause disables audio inputs; Stop, new session, navigation away from chat, panic hide, or closing the window ends capture. Raw audio is never saved to disk.</p></div><span className="locked-setting"><Captions size={14} /> Off until started</span></div>
            <div className="setting-row"><div><strong>Screen references</strong><p>One-time thumbnails are shown only after an explicit action; there is no continuous screen capture.</p></div><span className="locked-setting"><Eye size={14} /> On demand</span></div>
            <div className="setting-row"><div><strong>Conversation history</strong><p>Captions, translations, questions, and answers are saved locally as text. Manage or delete them in Conversation history. Audio and screenshot images are not saved.</p></div><span className="locked-setting"><FileText size={14} /> Local</span></div>
          </section>}

          {tab === "window" && <section className="settings-section compact-settings">
            <div className="settings-title"><span className="settings-icon"><MonitorUp size={18} /></span><div><h2>Stealth &amp; window</h2><p>Conceal the assistant from screen shares, the taskbar, and window lists while it stays visible on your monitor.</p></div><span className={`configured-badge ${props.stealth.enabled ? "on" : ""}`}><i />{props.stealth.enabled ? "Stealth on" : "Stealth off"}</span></div>
            <div className="setting-row"><div><strong>Stealth mode</strong><p>Master switch for capture concealment, taskbar hiding, and the decoy title.</p></div><Toggle checked={props.stealth.enabled} onChange={() => props.onUpdateStealth({ enabled: !props.stealth.enabled })} label="Stealth mode" /></div>
            <div className="setting-row"><div><strong>Invisible in screen share</strong><p>Excludes the window from screen capture on Windows 10 2004 and newer; older systems may show a black rectangle instead.</p></div><Toggle checked={props.stealth.captureProtection} onChange={() => props.onUpdateStealth({ captureProtection: !props.stealth.captureProtection })} label="Invisible in screen share" /></div>
            <div className="setting-row"><div><strong>Hide from taskbar and Alt-Tab</strong><p>Removes the window from the taskbar and the Alt-Tab switcher while stealth is on.</p></div><Toggle checked={props.stealth.hideFromTaskbar} onChange={() => props.onUpdateStealth({ hideFromTaskbar: !props.stealth.hideFromTaskbar })} label="Hide from taskbar and Alt-Tab" /></div>
            <div className="setting-row"><div><strong>Disguise window title</strong><p>Shows a generic name in window lists and share pickers instead of Interview Studio.</p></div><Toggle checked={props.stealth.disguiseTitle} onChange={() => props.onUpdateStealth({ disguiseTitle: !props.stealth.disguiseTitle })} label="Disguise window title" /></div>
            <div className="setting-row"><div><strong>Decoy title</strong><p>The generic name shown while the disguise is on.</p></div><input className="decoy-title-input" value={decoyDraft} maxLength={80} aria-label="Decoy window title" onChange={(event) => setDecoyDraft(event.target.value)} onBlur={() => { if (decoyDraft.trim() !== props.stealth.decoyTitle) props.onUpdateStealth({ decoyTitle: decoyDraft }); }} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} /></div>
            <div className="setting-row"><div><strong>Window transparency</strong><p>See the meeting and other apps through the window while it stays on top. The preview applies while you drag.</p></div><div className="opacity-control"><input type="range" min={20} max={100} step={5} value={opacityDraft} aria-label="Window opacity percent" onChange={(event) => { const next = Number(event.target.value); setOpacityDraft(next); props.onUpdateStealth({ opacity: next }); }} /><span className="opacity-value">{opacityDraft}%</span></div></div>
            <div className="setting-row"><div><strong>Mouse pass-through</strong><p>The window ignores clicks and never takes focus; hover it to interact. Hotkey: {props.passthroughShortcut}.</p></div><Toggle checked={props.stealth.mousePassthrough} onChange={() => props.onUpdateStealth({ mousePassthrough: !props.stealth.mousePassthrough })} label="Mouse pass-through" /></div>
            <div className="setting-row"><div><strong>Restore without focus</strong><p>After a panic hide, the window reappears without taking keyboard focus.</p></div><Toggle checked={props.stealth.noFocusSteal} onChange={() => props.onUpdateStealth({ noFocusSteal: !props.stealth.noFocusSteal })} label="Restore without focus" /></div>
            <div className="setting-row"><div><strong>Panic hide</strong><p>Press {props.panicShortcut} anywhere to instantly hide or restore the window.</p></div><button className="secondary-button" onClick={() => window.studio?.panicHide()}>Hide now</button></div>
            <div className="setting-row"><div><strong>Keep window on top</strong><p>Keep the visible assistant above other apps.</p></div><Toggle checked={props.alwaysOnTop} onChange={props.onAlwaysOnTop} label="Keep window on top" /></div>
            <div className="setting-row"><div><strong>Stealth hotkey</strong><p>Press {props.foreignShortcut} anywhere to toggle stealth on the window that has keyboard focus: it is excluded from screen shares and hidden from the taskbar and Alt-Tab while it stays visible on your monitor. Interview Studio asks the focused application to apply the exclusion itself, and every modified window is restored when the app closes.</p></div><ForeignHotkeyCapture current={props.foreignShortcut} onChange={(accelerator) => props.onChangeForeignHotkey("toggle", accelerator)} /></div>
            <div className="setting-row"><div><strong>Restore-all hotkey</strong><p>Press {props.restoreShortcut} anywhere to restore every stealthed window to its previous state at once — it works from any application. Failed restores remain available to retry. If a shared window stays black after restoration, try stopping the share and selecting the window again.</p></div><ForeignHotkeyCapture current={props.restoreShortcut} onChange={(accelerator) => props.onChangeForeignHotkey("restore", accelerator)} /></div>
            {props.foreignStatus && <div className={`connection-status ${props.foreignStatus.tone}`} role="status" aria-live="polite">{props.foreignStatus.message}</div>}
          </section>}
        </div>
      </div>
    </div>
  );
}

export default App;
