import { parseTranslationRequest, parseTranslationRetryRequest, type CaptionTranslationRequest, type CaptionTranslationResult, type TranslationLanguage } from '../../shared/caption-translation'
import { ChatCompletionError } from './chat-completions'

export function translationFailure(error: unknown): { status: number; code?: string; retryAfterMs?: number } {
  if (error instanceof ChatCompletionError) return error
  const status = (error as { status?: unknown })?.status
  const rawCode = (error as { code?: unknown })?.code
  const code = rawCode === 'content_policy_violation' || rawCode === 'content_filter' ? 'content_policy_violation'
    : error instanceof Error && /net::ERR_|fetch failed|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(error.message) ? 'network_error' : undefined
  return { status: typeof status === 'number' ? status : Number(error instanceof Error ? /HTTP (\d{3})/.exec(error.message)?.[1] : 0) || 0, code }
}

function retryDelay(error: unknown): number | undefined {
  const { status, code, retryAfterMs } = translationFailure(error)
  if (![408, 429, 500, 502, 503, 504].includes(status) || code === 'content_policy_violation' || code === 'daily_rpd_limit_exceeded' || code === 'daily_usd_limit_exceeded') return
  // Never wait through long quota windows or exceed the original request deadline.
  if (retryAfterMs !== undefined && retryAfterMs > 3000) return
  return Math.max(1000, retryAfterMs ?? 0)
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class CaptionTranslations {
  private pending = new Map<string, { ownerId: number; controller: AbortController }>()
  private starts: number[] = []
  constructor(private options: {
    allowed: (ownerId: number, sessionId: string) => boolean
    connection: () => (text: string, language: TranslationLanguage, signal: AbortSignal) => Promise<string>
    offlineFallback?: (text: string, language: TranslationLanguage, signal: AbortSignal) => Promise<CaptionTranslationResult>
    timeoutMs?: number
  }) {}
  async translate(ownerId: number, raw: unknown): Promise<CaptionTranslationResult> {
    const request = parseTranslationRequest(raw)
    return this.run(ownerId, request, false)
  }
  async retry(ownerId: number, raw: unknown): Promise<CaptionTranslationResult> {
    return this.run(ownerId, { ...parseTranslationRetryRequest(raw), sessionId: 'manual-retry' }, true)
  }
  private async run(ownerId: number, request: CaptionTranslationRequest, manual: boolean): Promise<CaptionTranslationResult> {
    // Manual retries are explicit text-only actions from the trusted main
    // renderer. They also work on saved captions without starting recording.
    const allowed = () => manual || this.options.allowed(ownerId, request.sessionId)
    // A queued renderer request can arrive after Stop or a session replacement.
    // Treat it like other cancelled work, before resolving credentials or a model.
    if (!allowed()) return { text: '', cancelled: true }
    const key = `${ownerId}:${request.requestId}`
    if (this.pending.has(key) || [...this.pending.values()].filter(item => item.ownerId === ownerId).length >= 2) throw new Error('Wait for the current caption translation to finish.')
    this.starts = this.starts.filter(start => start > Date.now() - 60_000)
    if (this.starts.length >= 120) throw new Error('Translation rate limit reached. Wait a moment and retry.')
    const automaticConnection = manual ? undefined : this.options.connection()
    this.starts.push(Date.now())
    const item = { ownerId, controller: new AbortController() }
    this.pending.set(key, item)
    let timer = setTimeout(() => item.controller.abort(new DOMException('Translation timed out.', 'TimeoutError')), this.options.timeoutMs ?? 20_000)
    try {
      const translate = automaticConnection ?? this.options.connection()
      let text: string
      try { text = await translate(request.text, request.language, item.controller.signal) }
      catch (error) {
        item.controller.signal.throwIfAborted()
        const delay = retryDelay(error)
        if (manual || delay === undefined || !allowed()) throw error
        await waitForRetry(delay, item.controller.signal)
        if (!allowed()) return { text: '', cancelled: true }
        text = await translate(request.text, request.language, item.controller.signal)
      }
      item.controller.signal.throwIfAborted()
      if (!allowed()) return { text: '', cancelled: true }
      if (typeof text !== 'string' || !text.trim() || text.length > 12_000) throw new Error('Invalid translation response.')
      return { text: text.trim() }
    } catch (error) {
      if (!allowed() || this.pending.get(key) !== item) return { text: '', cancelled: true }
      if (manual && this.options.offlineFallback) {
        if (item.controller.signal.aborted && item.controller.signal.reason?.name !== 'TimeoutError') return { text: '', cancelled: true }
        // Each stage gets its own bounded deadline. A timed-out online request
        // must not poison the offline attempt, while owner cancellation wins.
        clearTimeout(timer)
        if (item.controller.signal.aborted) item.controller = new AbortController()
        timer = setTimeout(() => item.controller.abort(new DOMException('Offline translation timed out.', 'TimeoutError')), 30_000)
        try {
          const result = await this.options.offlineFallback(request.text, request.language, item.controller.signal)
          item.controller.signal.throwIfAborted()
          if (this.pending.get(key) !== item) return { text: '', cancelled: true }
          if (result.text?.trim() && result.text.length <= 12_000) return { text: result.text.trim(), via: 'offline' }
          return { text: '', offlineIssue: result.offlineIssue ?? 'failed', retryError: offlineRetryMessage(result.offlineIssue) }
        } catch {
          if (this.pending.get(key) !== item || (item.controller.signal.aborted && item.controller.signal.reason?.name !== 'TimeoutError')) return { text: '', cancelled: true }
          return { text: '', offlineIssue: 'failed', retryError: offlineRetryMessage('failed') }
        }
      }
      if (item.controller.signal.aborted) {
        if (item.controller.signal.reason?.name === 'TimeoutError') throw new Error('Translation timed out. Retry to continue; original captions are unaffected.')
        return { text: '', cancelled: true }
      }
      const { status, code } = translationFailure(error)
      // A declined passage is an expected per-passage outcome, not a broken
      // connection. Return it without throwing through Electron or retrying it.
      if (code === 'content_policy_violation') return { text: '', skipped: 'content_filter' }
      throw new Error(translationErrorMessage(status, code))
    } finally {
      clearTimeout(timer)
      if (this.pending.get(key) === item) this.pending.delete(key)
    }
  }
  cancel(ownerId?: number): void {
    for (const [key, item] of this.pending) if (ownerId === undefined || item.ownerId === ownerId) {
      this.pending.delete(key); item.controller.abort()
    }
  }
}

function offlineRetryMessage(issue: CaptionTranslationResult['offlineIssue']): string {
  if (issue === 'missing_pack') return 'The provider retry failed. Download this language’s English source pack to try offline.'
  if (issue === 'unsupported_language') return 'The provider retry failed. No offline English source pack is available for this target language.'
  if (issue === 'unsupported_source') return 'The provider retry failed. Offline fallback supports English source captions only.'
  return 'The provider retry and offline translation could not finish. Try this passage again; original captions are unchanged.'
}

export function translationErrorMessage(status: number, code?: string): string {
  if (code === 'network_error') return 'Could not reach the translation provider. Check your internet connection and proxy settings, then retry.'
  if (code === 'model_not_found' || status === 404) return 'Translation model was not found. Check the exact model ID in Settings > Caption translation, then test the connection.'
  if (code === 'model_not_allowed') return 'Your translation key cannot access this model. Choose a model included in your provider account and test again.'
  if (code === 'insufficient_balance') return 'Your translation provider needs available credits.'
  if (code === 'empty_response') return 'The translation model returned no text. Try a fast, non-reasoning text model in Settings > Caption translation, then retry.'
  if (code === 'truncated_response') return 'The translation model used its response limit before finishing. Choose a fast, non-reasoning text model or translate shorter passages.'
  if (code === 'content_policy_violation') return 'The translation provider declined this passage. Original captions will continue.'
  if (code === 'daily_rpd_limit_exceeded' || code === 'daily_usd_limit_exceeded') return 'Your translation provider daily limit was reached. Check your account allowance before retrying.'
  if (status === 400 || status === 422) return 'The translation provider rejected the request. Check that the translation model supports text chat and is available to your key, then test the connection in Settings.'
  if (status === 408 || status === 504) return 'The translation provider timed out. Retry or choose a faster translation model; original captions will continue.'
  if (status >= 500 || code === 'model_not_available' || code === 'all_fallbacks_failed' || code === 'no_fallback_available') return 'The translation service or model is temporarily unavailable. Retry shortly, or choose another translation model.'
  if (status === 200) return 'The translation provider returned an invalid response. Choose another text translation model and test the connection in Settings.'
  return status === 401 ? 'Check your translation API key in Settings, then retry.'
    : status === 403 ? 'Translation access was denied. Check the API key, Azure region, API permissions, and remaining quota in Settings.'
      : status === 402 ? 'Your translation provider needs available credits.'
        : status === 429 ? 'Translation quota or request limit reached. Check your provider allowance and retry later.'
          : 'Translation failed. Check Caption translation in Settings and retry. Original captions will continue.'
}
