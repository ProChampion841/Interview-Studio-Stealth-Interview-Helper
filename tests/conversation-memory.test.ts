import { describe, expect, it } from 'vitest'
import { ConversationMemory, memoryText } from '../shared/conversation-memory'
import { parseConversation, questionThreadContext, exportConversation, type ConversationRecord } from '../shared/conversation-history'
import type { CaptionLine } from '../shared/captions'
import { randomUUID } from 'node:crypto'

const line = (id: string, text: string, startMs = 0, source: CaptionLine['source'] = 'microphone'): CaptionLine => ({ id, text, startMs, endMs: startMs + 1000, source, isFinal: true })
describe('source grounded interview memory', () => {
  it('recalls a specific early technical detail after three hours of unrelated discussion', () => {
    const memory = new ConversationMemory()
    memory.update([line('early', 'We used PostgreSQL advisory locks and an outbox for payments because events must not be lost.', 10000), ...Array.from({ length: 3600 }, (_, n) => line('filler-' + n, 'Discussing CSS colors, margins and accessibility for the frontend interface.', 30000 + n * 2990))])
    const context = memory.retrieve('How would the PostgreSQL outbox prevent lost payment events?')
    expect(context.relevant[0].id).toBe('early')
    expect(memoryText(context.relevant)).toContain('advisory locks')
    expect(memory.size).toBe(3601)
  })
  it('updates recognition revisions and removes deleted or stale speech from the index', () => {
    const memory = new ConversationMemory()
    memory.update([line('same', 'We used MongoDB transactions for the catalog.')])
    memory.update([line('same', 'We used PostgreSQL advisory locks for the catalog.')])
    expect(memory.retrieve('MongoDB').relevant).toEqual([])
    expect(memory.retrieve('PostgreSQL').relevant[0].text).toContain('advisory locks')
    memory.update([]); expect(memory.retrieve('PostgreSQL').relevant).toEqual([]); expect(memory.summary()).toEqual([])
  })
  it('ignores interim speech and translations and excludes passages already selected', () => {
    const memory = new ConversationMemory()
    memory.update([{ ...line('draft', 'Kafka phantom detail'), isFinal: false }, { ...line('original', 'We worked on a database cache.'), translation: { language: 'es', sourceText: 'We worked on a database cache.', text: 'Secrettranslatedterm' } }])
    expect(memory.retrieve('Kafka').relevant).toEqual([])
    expect(memory.retrieve('Secrettranslatedterm').relevant).toEqual([])
    expect(memory.retrieve('cache', ['original']).relevant).toEqual([])
  })
  it('uses technical aliases while preserving source labels and elapsed time', () => {
    const memory = new ConversationMemory()
    memory.update([line('you', 'We scaled Postgres to handle payment transactions.', 7_200_000), line('professional', 'The requirement is to deploy on Kubernetes.', 7_210_000, 'computer')])
    expect(memoryText(memory.retrieve('PostgreSQL').relevant)).toContain('[120:00 YOU]')
    expect(memoryText(memory.retrieve('k8s').relevant)).toContain('Professional')
  })
  it('keeps an extractive, bounded, diverse overview and retrieves details outside that overview', () => {
    const memory = new ConversationMemory()
    const lines = Array.from({ length: 100 }, (_, n) => line('passage-' + n, `We designed component${n} for account${n} with requirement${n} and ${n + 20} replicas. ` + 'Additional notes. '.repeat(50), n * 108000))
    memory.update(lines)
    expect(memory.summary().length).toBeLessThanOrEqual(8)
    expect(memoryText(memory.summary()).length).toBeLessThanOrEqual(2800)
    expect(memoryText(memory.retrieve('component47 account47').relevant).length).toBeLessThanOrEqual(6000)
    expect(memory.retrieve('component47 account47').relevant[0].id).toBe('passage-47')
    for (const excerpt of memory.summary()) expect(lines.find(line => line.id === excerpt.id)?.text).toContain(excerpt.text.replace(/…$/u, ''))
  })
  it('does not invent a relevant passage for an unrelated or empty question', () => {
    const memory = new ConversationMemory(); memory.update([line('known', 'We used a queue to process Kafka messages.')])
    expect(memory.retrieve('').relevant).toEqual([])
    expect(memory.retrieve('chlorophyll photosynthesis').relevant).toEqual([])
  })
  it('avoids sending the same passage in nearby context, retrieved speech and summary', () => {
    const memory = new ConversationMemory(); memory.update([line('same', 'We designed a queue with Kafka and retries.')])
    const selected = memory.retrieve('Kafka')
    expect(selected.relevant).toHaveLength(1); expect(selected.overview).toEqual([])
    expect(memory.retrieve('Kafka', ['same'])).toEqual({ overview: [], relevant: [] })
  })
  it('can recall CJK text without relying on whitespace', () => {
    const memory = new ConversationMemory(); memory.update([line('ja', 'データベースの障害復旧を設計しました。')])
    expect(memory.retrieve('障害復旧').relevant[0].id).toBe('ja')
  })
  it('bounds the complete API context while keeping recent thread answers and relevant speech', () => {
    const memory = new ConversationMemory(); memory.update([line('old', 'The database used idempotency keys and retries.')])
    const thread = { id: randomUUID(), question: 'Database? '.repeat(1000), captionIds: [], exchanges: Array.from({ length: 10 }, (_, n) => ({ id: randomUUID(), question: `Step ${n}`, answer: `${n === 9 ? 'Newest response' : 'Old response'} ` + 'Details '.repeat(12000), status: 'ready' as const, createdAt: new Date().toISOString(), context: [], sourceNames: [] })) }
    thread.exchanges[9].answer += ' IMPORTANT NEWEST END'
    const context = questionThreadContext(thread, [line('nearby', 'Nearby '.repeat(1000))], memory.retrieve('idempotency'))
    expect(context.length).toBeLessThanOrEqual(24000)
    expect(context).toContain('idempotency keys')
    expect(context).toContain('IMPORTANT NEWEST END')
    expect(context).toContain('not verified facts')
  })
  it('persists and exports exactly the memory used by an answer while reading older files', () => {
    const memory = new ConversationMemory(); memory.update([line('evidence', 'We designed a payment queue with Kafka and retries.')])
    const item: ConversationRecord = { version: 1, id: randomUUID(), title: 'Practice', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), captions: [], threads: [{ id: randomUUID(), question: 'Queue?', captionIds: [], exchanges: [{ id: randomUUID(), question: 'Queue?', answer: 'Use retries.', createdAt: new Date().toISOString(), status: 'ready', context: [], sourceNames: [], memory: memory.retrieve('Kafka') }] }], selectedThreadId: null, draft: '', pendingContext: [], role: '', interviewType: '', responseStyle: '' }
    const restored = parseConversation(item)
    expect(restored.threads[0].exchanges[0].memory).toEqual(item.threads[0].exchanges[0].memory)
    expect(exportConversation(restored)).toContain('Relevant earlier speech used:')
    delete item.threads[0].exchanges[0].memory
    expect(parseConversation(item).threads[0].exchanges[0].memory).toBeUndefined()
  })
})
