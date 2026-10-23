import { CAPTION_SOURCE_LABELS, type CaptionLine, type CaptionSource } from './captions'

export interface MemoryPassage { id: string; source: CaptionSource; startMs: number; text: string }
export interface InterviewMemory { overview: MemoryPassage[]; relevant: MemoryPassage[] }
export const MEMORY_OVERVIEW_CHARS = 2800
export const MEMORY_RETRIEVAL_CHARS = 6000
const STOP = new Set('a an the and or but so to of in on at by for with from as is are was were be been being it its this that these those i me my we our you your he she they their do does did can could would should will have has had what which who how why when where please tell explain describe about earlier before again more question interview answer'.split(' '))
const ALIASES: Record<string, string> = { postgres: 'postgresql', k8s: 'kubernetes', caching: 'cache', cached: 'cache', caches: 'cache', retries: 'retry', retrying: 'retry', failures: 'failure', failed: 'failure', scaling: 'scale', scaled: 'scale', queues: 'queue', queued: 'queue', messages: 'message', messaging: 'message', services: 'service', databases: 'database', indexes: 'index', indexing: 'index', partitions: 'partition', partitioning: 'partition', latencies: 'latency' }
const RELATED: Record<string, string[]> = { queue: ['kafka', 'rabbitmq', 'broker', 'message'], failure: ['retry', 'timeout', 'recovery', 'outage'], reliability: ['retry', 'replica', 'recovery', 'availability'], performance: ['latency', 'throughput', 'cache'], scale: ['partition', 'shard', 'throughput'], database: ['postgresql', 'mysql', 'sql', 'transaction'] }
function terms(text: string): string[] {
  const words = (text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_+#.-]*/gu) ?? []).map(word => word.replace(/[.-]+$/, '')).filter(word => word.length > 1 && !STOP.has(word))
  // Also index adjacent CJK characters, where words need not use spaces.
  for (const run of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []) for (let n = 0; n < run.length - 1; n++) words.push(run.slice(n, n + 2))
  return words.map(word => ALIASES[word] ?? word)
}
function excerpt(text: string, max: number, query: string[] = []): string {
  const cleaned = text.replace(/\u0000/g, '').trim()
  if (cleaned.length <= max) return cleaned
  const lower = cleaned.toLocaleLowerCase()
  const positions = query.map(word => lower.indexOf(word)).filter(index => index >= 0)
  const start = positions.length ? Math.max(0, Math.min(...positions) - Math.floor(max / 4)) : 0
  return `${start ? '…' : ''}${cleaned.slice(start, start + max - 2)}…`
}
export function memoryPassageText(item: MemoryPassage): string {
  const seconds = Math.floor(item.startMs / 1000)
  return `[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} ${CAPTION_SOURCE_LABELS[item.source]}] ${item.text}`
}
export function memoryText(items: readonly MemoryPassage[]): string { return items.map(memoryPassageText).join('\n') }
function bound(items: MemoryPassage[], max: number): MemoryPassage[] {
  let left = max
  return items.flatMap(item => {
    const prefix = memoryPassageText({ ...item, text: '' }).length + 1
    if (left <= prefix + 40) return []
    const next = { ...item, text: excerpt(item.text, Math.min(1000, left - prefix)) }
    left -= memoryPassageText(next).length + 1
    return [next]
  })
}
interface Document { line: CaptionLine; words: Set<string>; importance: number }

/** Local, extractive memory: only original speech, never generated answers.
 * Updates posting lists for changed ASR segments; no embeddings or summary API.
 */
export class ConversationMemory {
  private docs = new Map<string, Document>()
  private postings = new Map<string, Set<string>>()
  private overview: MemoryPassage[] = []
  private dirty = true
  update(lines: readonly CaptionLine[]): void {
    const live = new Set(lines.map(line => line.id))
    for (const [id, doc] of this.docs) if (!live.has(id)) { this.remove(id, doc); this.dirty = true }
    for (const line of lines) {
      const old = this.docs.get(line.id)
      if (old && old.line.text === line.text && old.line.source === line.source && old.line.startMs === line.startMs && old.line.isFinal === line.isFinal) continue
      if (old) this.remove(line.id, old)
      if (!line.text.trim()) continue
      const words = new Set(terms(line.text))
      const importance = (line.source === 'microphone' ? 2 : 0) + (/\b(?:built|designed|implemented|worked|project|system|architecture|decided|chose|requirement|constraint|must|need|cannot|can't|million|percent|latency|throughput|tradeoff|trade-off)\b/i.test(line.text) ? 3 : 0) + (/\d/.test(line.text) ? 1 : 0) + Math.min(2, words.size / 12)
      this.docs.set(line.id, { line, words, importance })
      for (const word of words) { let ids = this.postings.get(word); if (!ids) this.postings.set(word, ids = new Set()); ids.add(line.id) }
      this.dirty = true
    }
    if (this.dirty) this.summarize()
  }
  private remove(id: string, doc: Document): void {
    this.docs.delete(id)
    for (const word of doc.words) { const ids = this.postings.get(word); ids?.delete(id); if (!ids?.size) this.postings.delete(word) }
  }
  private summarize(): void {
    // Final speech only. Keep diverse, informative excerpts across the whole
    // timeline, so early facts do not disappear merely because time passes.
    const eligible = [...this.docs.values()].filter(doc => doc.line.isFinal !== false && doc.words.size >= 4)
    const duration = eligible.reduce((end, doc) => Math.max(end, doc.line.startMs), 1)
    const ranked = eligible.sort((a, b) => b.importance - a.importance || a.line.startMs - b.line.startMs)
    const chosen: Document[] = [], slots = new Set<number>()
    const diverse = (doc: Document) => !chosen.some(prior => {
      let shared = 0; for (const word of doc.words) if (prior.words.has(word)) shared++
      return shared / Math.max(1, Math.min(prior.words.size, doc.words.size)) > .75
    })
    for (const doc of ranked) {
      const slot = Math.min(5, Math.floor(doc.line.startMs / duration * 6))
      if (!slots.has(slot) && diverse(doc)) { chosen.push(doc); slots.add(slot) }
      if (chosen.length === 6) break
    }
    for (const doc of ranked) { if (chosen.length >= 8) break; if (!chosen.includes(doc) && diverse(doc)) chosen.push(doc) }
    this.overview = bound(chosen.sort((a, b) => a.line.startMs - b.line.startMs).map(doc => ({ id: doc.line.id, source: doc.line.source, startMs: doc.line.startMs, text: excerpt(doc.line.text, 340) })), MEMORY_OVERVIEW_CHARS)
    this.dirty = false
  }
  summary(): MemoryPassage[] { return this.overview }
  retrieve(question: string, excludedIds: readonly string[] = []): InterviewMemory {
    const direct = [...new Set(terms(question))], query = new Map(direct.map(word => [word, 1]))
    for (const word of direct) for (const related of RELATED[word] ?? []) if (!query.has(related)) query.set(related, .35)
    const scores = new Map<string, number>(), excluded = new Set(excludedIds)
    for (const [word, weight] of query) {
      const ids = this.postings.get(word)
      if (!ids) continue
      const rarity = Math.log(1 + this.docs.size / ids.size)
      for (const id of ids) if (!excluded.has(id)) scores.set(id, (scores.get(id) ?? 0) + weight * rarity)
    }
    const ranked = [...scores].map(([id, score]) => ({ doc: this.docs.get(id)!, score })).filter(item => item.doc.line.isFinal !== false)
      .sort((a, b) => b.score - a.score || b.doc.line.startMs - a.doc.line.startMs)
    const relevant: MemoryPassage[] = [], textSeen = new Set<string>()
    for (const { doc } of ranked) {
      if (textSeen.has(doc.line.text)) continue
      textSeen.add(doc.line.text)
      relevant.push({ id: doc.line.id, source: doc.line.source, startMs: doc.line.startMs, text: excerpt(doc.line.text, 1000, direct) })
      if (relevant.length === 6) break
    }
    const selected = bound(relevant, MEMORY_RETRIEVAL_CHARS)
    const alreadyIncluded = new Set([...excludedIds, ...selected.map(item => item.id)])
    return { overview: this.overview.filter(item => !alreadyIncluded.has(item.id)), relevant: selected }
  }
  get size(): number { return this.docs.size }
}
