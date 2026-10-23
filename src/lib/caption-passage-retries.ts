import type { CaptionLine } from '../../shared/captions'
import type { CaptionTranslation, CaptionTranslationResult, CaptionTranslationRetryRequest, OfflineRetryIssue, TranslationLanguage } from '../../shared/caption-translation'
import { TRANSLATION_TEXT_LIMIT } from '../../shared/caption-translation'

export interface PassageRetryError { message: string; offlineIssue?: OfflineRetryIssue }
/** Explicit per-passage work is separate from the automatic speech queue. */
export class CaptionPassageRetries {
  private pending = new Set<string>()
  private stopped = false
  constructor(private options: {
    language: TranslationLanguage; engine: string
    lines: () => readonly CaptionLine[]
    translate: (request: CaptionTranslationRetryRequest) => Promise<CaptionTranslationResult>
    cancel: () => void
    onPending: (ids: ReadonlySet<string>) => void
    onError: (id: string, error: PassageRetryError | undefined) => void
    onTranslation: (id: string, translation: CaptionTranslation) => void
  }) {}
  async retry(id: string): Promise<void> {
    if (this.stopped || this.pending.has(id)) return
    const line = this.options.lines().find(line => line.id === id)
    if (!line) return
    if (this.pending.size >= 2) { this.options.onError(id, { message: 'Wait for the current passage retries to finish.' }); return }
    if (!line.text.trim() || line.text.length > TRANSLATION_TEXT_LIMIT) { this.options.onError(id, { message: 'This passage cannot be retried. Translation accepts up to 6,000 characters.' }); return }
    const sourceText = line.text
    this.pending.add(id); this.options.onPending(new Set(this.pending)); this.options.onError(id, undefined)
    const current = () => this.options.lines().find(currentLine => currentLine.id === id && currentLine.source === line.source)
    try {
      const result = await this.options.translate({ requestId: crypto.randomUUID(), text: sourceText, language: this.options.language })
      if (this.stopped || !current() || result.cancelled) return
      if (current()!.text !== sourceText) { this.options.onError(id, { message: 'The caption changed while retrying. Retry this passage again when speech settles.' }); return }
      if (result.retryError || result.skipped || !result.text?.trim()) {
        this.options.onError(id, { message: result.retryError || 'The passage could not be translated. Retry again shortly.', offlineIssue: result.offlineIssue }); return
      }
      this.options.onTranslation(id, { language: this.options.language, text: result.text, sourceText, engine: this.options.engine, ...(result.via === 'offline' ? { via: 'offline' } : {}) })
    } catch (error) {
      if (!this.stopped && current()) this.options.onError(id, { message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Retry failed. Try this passage again.' })
    } finally {
      this.pending.delete(id)
      if (!this.stopped) this.options.onPending(new Set(this.pending))
    }
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.pending.size) this.options.cancel()
    this.pending.clear(); this.options.onPending(new Set())
  }
}
