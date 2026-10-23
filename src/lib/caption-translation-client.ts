import type { CaptionLine, CaptionSource } from '../../shared/captions'
import type { CaptionTranslation, CaptionTranslationRequest, CaptionTranslationResult, TranslationLanguage } from '../../shared/caption-translation'

interface Job { id: string; source: CaptionSource; text: string; translated: string; skipped: boolean; inFlight: boolean; final: boolean; changedAt: number; waitingSince: number }
export class CaptionTranslationClient {
  private jobs = new Map<string, Job>()
  private seen = new Set<string>()
  private seeded = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private active = { microphone: false, computer: false }
  private started = { microphone: -Infinity, computer: -Infinity }
  private pending = ''
  constructor(private options: {
    sessionId: string; language: TranslationLanguage; engine?: string
    translate: (request: CaptionTranslationRequest) => Promise<CaptionTranslationResult>
    cancel: () => void
    onTranslation: (id: string, translation: CaptionTranslation) => void
    onPending: (ids: ReadonlySet<string>) => void
    onError: (message: string) => void
    intervalMs?: number
    waitForPhrase?: boolean
  }) {}
  update(lines: readonly CaptionLine[]): void {
    if (this.stopped) return
    const present = new Set(lines.map(line => line.id))
    for (const id of this.jobs.keys()) if (!present.has(id)) this.jobs.delete(id)
    // Enabling translation backfills just the two latest passages per source,
    // rather than uploading the entire history or creating a large backlog.
    const seed = new Set(!this.seeded ? (['microphone', 'computer'] as const).flatMap(source => lines.filter(line => line.source === source).slice(-2).map(line => line.id)) : [])
    for (const line of lines) {
      const job = this.jobs.get(line.id)
      if (job) {
        if (job.text !== line.text) {
          if (job.text === job.translated) job.waitingSince = Date.now()
          job.text = line.text; job.changedAt = Date.now()
        }
        job.final = line.isFinal !== false
      }
      else if ((!this.seeded && seed.has(line.id)) || (this.seeded && !this.seen.has(line.id))) {
        const saved = line.translation?.language === this.options.language && line.translation.engine === this.options.engine ? line.translation : undefined
        this.jobs.set(line.id, { id: line.id, source: line.source, text: line.text, translated: saved?.sourceText ?? '', skipped: saved?.skipped === 'content_filter', inFlight: false, final: line.isFinal !== false, changedAt: Date.now(), waitingSince: Date.now() })
      }
      this.seen.add(line.id)
    }
    this.seeded = true
    if ([...this.jobs.values()].filter(job => !job.skipped && job.text !== job.translated).length > 40) {
      this.fail('Translation is falling behind. Check your translation connection and retry; original captions will continue.')
      return
    }
    this.pump()
  }
  private publishPending(): void {
    const ids = [...this.jobs.values()].filter(job => job.inFlight || (!job.skipped && job.text !== job.translated)).map(job => job.id)
    const signature = JSON.stringify(ids)
    if (signature !== this.pending) { this.pending = signature; this.options.onPending(new Set(ids)) }
  }
  private pump(): void {
    if (this.stopped) return
    clearTimeout(this.timer); this.timer = undefined
    let delay = Infinity
    for (const source of ['microphone', 'computer'] as const) {
      if (this.active[source]) continue
      const job = [...this.jobs.values()].find(job => job.source === source && !job.skipped && job.text.trim() && job.text !== job.translated)
      if (!job) continue
      // Lightweight offline packs need more context than the first few words.
      // Prefer sentence endings or a short stable phrase, with a bounded delay
      // for continuous speech. Original captions remain immediate.
      const phraseWait = this.options.waitForPhrase && !job.final && !/[.!?…]["')\]]*\s*$/.test(job.text)
        ? Math.min(800 - (Date.now() - job.changedAt), 2500 - (Date.now() - job.waitingSince)) : 0
      const wait = Math.max(phraseWait, (this.options.intervalMs ?? 1500) - (Date.now() - this.started[source]))
      if (wait > 0) { delay = Math.min(delay, wait); continue }
      this.active[source] = true; this.started[source] = Date.now(); job.inFlight = true
      job.waitingSince = Date.now()
      const sourceText = job.text
      void this.options.translate({ sessionId: this.options.sessionId, requestId: crypto.randomUUID(), text: sourceText, language: this.options.language }).then(result => {
        if (this.stopped || this.jobs.get(job.id) !== job) return
        // An expired session is terminal. Re-pumping the same job would keep
        // submitting requests for a session that can never become valid again.
        if (result.cancelled) { this.stop(); return }
        if (result.skipped === 'content_filter') {
          // Mark the whole passage, including later ASR revisions, as handled.
          // Do not re-submit rejected text or cancel the other audio source.
          job.skipped = true
          this.options.onTranslation(job.id, { language: this.options.language, text: '', sourceText, skipped: 'content_filter', ...(this.options.engine ? { engine: this.options.engine } : {}) })
          return
        }
        if (!result.text?.trim()) throw new Error('The translation provider returned no text. Retry to continue.')
        job.translated = sourceText
        this.options.onTranslation(job.id, { language: this.options.language, text: result.text, sourceText, ...(this.options.engine ? { engine: this.options.engine } : {}) })
      }).catch(error => {
        if (!this.stopped) this.fail(error instanceof Error ? error.message : 'Translation failed. Retry to continue.')
      }).finally(() => {
        job.inFlight = false; this.active[source] = false
        this.pump()
      })
    }
    this.publishPending()
    if (Number.isFinite(delay)) this.timer = setTimeout(() => this.pump(), delay)
  }
  private fail(message: string): void {
    this.stop()
    this.options.onError(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true; clearTimeout(this.timer)
    this.options.cancel(); this.options.onPending(new Set())
  }
}
