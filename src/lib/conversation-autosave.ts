import { hasConversationContent, type ConversationRecord, type ConversationSummary } from '../../shared/conversation-history'

/** Coalesce streaming revisions, with one writer and at most one pending copy per conversation. */
export class ConversationAutosave {
  private pending = new Map<string, ConversationRecord>()
  private removed = new Set<string>()
  private edited = new Set<string>()
  private acknowledged = new Map<string, ConversationRecord>()
  private running?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  constructor(private options: { save: (record: ConversationRecord) => Promise<ConversationSummary>; onSaving: () => void; onSaved: (summary: ConversationSummary) => void; onError: (error: unknown) => void }) {}
  update(record: ConversationRecord): void {
    if (this.removed.has(record.id)) return
    // A fresh blank workspace needs no file, but clearing an existing draft is
    // an edit too. Persist it instead of reviving the previous nonempty value.
    if (!hasConversationContent(record) && !this.edited.has(record.id)) return
    this.edited.add(record.id)
    const prior = this.acknowledged.get(record.id)
    // updatedAt changes on harmless renders; those are not new text revisions.
    if (prior && this.same(prior, record) && !this.pending.has(record.id) && !this.running) return
    this.pending.set(record.id, record)
    this.options.onSaving()
    this.schedule()
  }
  private same(a: ConversationRecord, b: ConversationRecord): boolean {
    return a.title === b.title && a.createdAt === b.createdAt && a.captions === b.captions && a.threads === b.threads && a.selectedThreadId === b.selectedThreadId && a.draft === b.draft && a.draftCaptionIds === b.draftCaptionIds && a.pendingContext === b.pendingContext && a.role === b.role && a.interviewType === b.interviewType && a.responseStyle === b.responseStyle
  }
  private schedule(): void {
    if (this.disposed || this.timer || this.running || !this.pending.size) return
    const long = [...this.pending.values()].some(record => record.captions.length >= 500 || record.threads.length >= 50)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.write(false).catch(() => {})
    }, long ? 5000 : 1000)
  }
  drop(id: string): void { this.removed.add(id); this.pending.delete(id); this.acknowledged.delete(id) }
  keep(id: string): void { this.removed.delete(id) }
  async flush(record?: ConversationRecord): Promise<void> {
    if (record) this.update(record)
    clearTimeout(this.timer); this.timer = undefined
    if (this.running) await this.running
    while (this.pending.size) await this.write(true)
    clearTimeout(this.timer); this.timer = undefined
  }
  private async write(force: boolean): Promise<void> {
    if (this.running) { await this.running; return }
    const run = async () => {
      // Periodic writes process one batch. Revisions arriving during disk I/O
      // wait for the next interval; explicit exit/switch flushes drain all edits.
      for (const id of [...this.pending.keys()]) {
        const item = this.pending.get(id)
        if (!item) continue
        this.pending.delete(id)
        try {
          const saved = await this.options.save(item)
          if (!this.removed.has(id)) {
            this.acknowledged.delete(id); this.acknowledged.set(id, item)
            // Retain at most two snapshots, not every conversation ever opened.
            if (this.acknowledged.size > 2) this.acknowledged.delete(this.acknowledged.keys().next().value!)
            this.options.onSaved(saved)
            if (this.pending.size) this.options.onSaving()
          }
        }
        catch (error) { if (!this.removed.has(id) && !this.pending.has(id)) this.pending.set(id, item); this.options.onError(error); throw error }
      }
    }
    this.running = run()
    try { await this.running } finally { this.running = undefined; if (!force) this.schedule() }
  }
  dispose(): void { this.disposed = true; clearTimeout(this.timer) }
}
