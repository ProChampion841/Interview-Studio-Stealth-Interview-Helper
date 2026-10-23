import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationHistory } from '../electron/main/conversation-history'
import { conversationSummary, exportConversation, parseConversation, questionThreadContext, type ConversationRecord } from '../shared/conversation-history'
import { mergeCaptionLines, namespaceCaptionLines, type CaptionLine } from '../shared/captions'

const control = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async importActual => {
  const actual = await importActual<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => { if (control.failRename) throw new Error('Synthetic write failure'); return actual.rename(...args) } }
})
const directories: string[] = []
afterEach(() => { control.failRename = false; for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function record(): ConversationRecord {
  const threadId = randomUUID()
  return { version: 1, id: randomUUID(), title: 'Interview conversation', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:01:00Z', captions: [{ id: 'speech-1', source: 'computer', text: 'Why use a queue?', startMs: 0, endMs: 500, isFinal: true, translation: { language: 'es', sourceText: 'Why use a queue?', text: 'Cola traducida.' } }], threads: [{ id: threadId, question: 'Why use a queue?', captionIds: ['speech-1'], exchanges: [{ id: randomUUID(), question: 'Why use a queue?', answer: 'It absorbs bursts.', status: 'ready', context: [{ id: 'context', source: 'microphone', text: 'I handle traffic bursts.' }], sourceNames: ['selected.png'], createdAt: '2026-10-20T10:01:00Z' }] }], selectedThreadId: threadId, draft: 'Explain reliability.', pendingContext: [], role: 'Software engineer', interviewType: 'Technical', responseStyle: 'Simple & professional' }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'studio-history-test-')); directories.push(root)
  const directory = join(root, 'conversations')
  writeFileSync(join(root, 'settings.json'), 'keep-settings')
  mkdirSync(join(root, 'caption-models')); writeFileSync(join(root, 'caption-models', 'model.bin'), 'keep-model')
  return { root, directory, store: new ConversationHistory(() => directory) }
}
describe('durable conversation storage', () => {
  it('retains captions, translations, question links, follow-ups and drafts across fresh store instances', async () => {
    const f = fixture(), item = record()
    item.threads[0].exchanges.push({ ...item.threads[0].exchanges[0], id: randomUUID(), question: 'How do you recover?', answer: 'Use retries.', status: 'stopped' })
    await f.store.save(item)
    const reopened = new ConversationHistory(() => f.directory)
    expect(await reopened.get(item.id)).toEqual(parseConversation(item))
    expect((await reopened.list()).conversations).toEqual([conversationSummary(item)])
  })
  it('replaces revisions atomically, leaving the previous file intact when replacement fails', async () => {
    const f = fixture(), item = record(); await f.store.save(item)
    const before = readFileSync(join(f.directory, item.id + '.json'), 'utf8')
    control.failRename = true
    await expect(f.store.save({ ...item, draft: 'New unsaved draft' })).rejects.toThrow(/Synthetic/)
    expect(readFileSync(join(f.directory, item.id + '.json'), 'utf8')).toBe(before)
    expect(readdirSync(f.directory)).toEqual([item.id + '.json'])
    control.failRename = false
    await f.store.save({ ...item, draft: 'Recovered draft' })
    expect((await f.store.get(item.id)).draft).toBe('Recovered draft')
  })
  it('persists failure details separately from partial answer text and excludes failed attempts from follow-up API context', async () => {
    const f = fixture(), item = record(), thread = item.threads[0]
    const failed = { ...thread.exchanges[0], id: randomUUID(), question: 'A failed follow-up?', answer: 'Unfinished response.', error: 'The provider credit limit was reached.', status: 'error' as const }
    thread.exchanges.push(failed)
    await f.store.save(item)
    const reopened = await f.store.get(item.id)
    expect(reopened.threads[0].exchanges[1]).toMatchObject({ answer: 'Unfinished response.', error: 'The provider credit limit was reached.' })
    for (const memory of [undefined, { overview: [], relevant: [] }]) {
      const context = questionThreadContext(reopened.threads[0], failed.context, memory)
      expect(context).toContain('It absorbs bursts.')
      expect(context).not.toMatch(/Unfinished response|credit limit|A failed follow-up/)
    }
    expect(exportConversation(reopened)).toContain('Response interrupted: The provider credit limit was reached.')
    expect(() => parseConversation({ ...item, threads: [{ ...thread, exchanges: [{ ...failed, error: 'x'.repeat(1001) }] }] })).toThrow(/text/)
  })
  it('serializes overlapping saves and deletion without touching credentials, models, or other conversations', async () => {
    const f = fixture(), first = record(), second = record()
    await Promise.all([f.store.save(first), f.store.save({ ...first, draft: 'Latest revision' }), f.store.save(second)])
    expect((await f.store.get(first.id)).draft).toBe('Latest revision')
    await f.store.remove(first.id)
    expect((await f.store.list()).conversations.map(item => item.id)).toEqual([second.id])
    expect(readFileSync(join(f.root, 'settings.json'), 'utf8')).toBe('keep-settings')
    expect(readFileSync(join(f.root, 'caption-models', 'model.bin'), 'utf8')).toBe('keep-model')
    await f.store.remove(first.id)
  })
  it('searches original captions, translations and answers and persists renamed titles', async () => {
    const f = fixture(), item = record(); await f.store.save(item)
    for (const query of ['QUEUE', 'traducida', 'absorbs bursts']) expect((await f.store.list(query)).conversations.map(item => item.id)).toEqual([item.id])
    expect((await f.store.list('missing text')).conversations).toEqual([])
    await f.store.rename(item.id, '  Practice interview  ')
    expect((await new ConversationHistory(() => f.directory).get(item.id)).title).toBe('Practice interview')
  })
  it('preserves unreadable or future-version files instead of silently overwriting them', async () => {
    const f = fixture(), item = record(); await f.store.save(item)
    const broken = join(f.directory, randomUUID() + '.json'), future = join(f.directory, randomUUID() + '.json')
    writeFileSync(broken, '{unfinished'); writeFileSync(future, JSON.stringify({ ...record(), version: 2 }))
    expect((await f.store.list()).unreadable).toBe(2)
    expect(readFileSync(broken, 'utf8')).toBe('{unfinished')
    expect(JSON.parse(readFileSync(future, 'utf8')).version).toBe(2)
  })
  it('rejects path traversal and invalid schemas and strips unrelated fields before writing', async () => {
    const f = fixture(), item = record()
    for (const bad of ['../settings', 'C:\\outside', '', 'not-a-uuid']) {
      expect(() => f.store.get(bad)).toThrow(/ID/)
      expect(() => f.store.remove(bad)).toThrow(/ID/)
      expect(() => f.store.save({ ...item, id: bad })).toThrow(/ID/)
    }
    expect(() => f.store.save({ ...item, captions: [...item.captions, item.captions[0]] })).toThrow(/Duplicate/)
    expect(() => f.store.save({ ...item, draft: 'x'.repeat(12001) })).toThrow(/text/)
    await f.store.save({ ...item, apiKey: 'must-not-persist', audio: [1], screenshots: ['not-an-attachment'] })
    expect(readFileSync(join(f.directory, item.id + '.json'), 'utf8')).not.toMatch(/must-not-persist|not-an-attachment|"audio"/)
  })
  it('exports every question and follow-up with original captions and saved translations', () => {
    const item = record(); const content = exportConversation(item)
    expect(content).toContain('Professional:')
    expect(content).toContain('Cola traducida.')
    expect(content).toContain('It absorbs bursts.')
    expect(content).toContain('Linked captions: speech-1')
    expect(content).toContain('Explain reliability.')
    item.captions[0].translation = { language: 'es', text: '', sourceText: 'Why use a queue?', skipped: 'content_filter' }
    expect(exportConversation(item)).toContain('Translation skipped: provider declined this passage')
    item.captions[0].translation = { language: 'es', text: 'Traducción local.', sourceText: 'Why use a queue?', via: 'offline' }
    expect(parseConversation(item).captions[0].translation?.via).toBe('offline')
    expect(exportConversation(item)).toContain('Spanish (offline, English source)')
  })
  it('saves provider fallback and prior partial answers without mixing them into follow-up context', () => {
    const item = record(), exchange = item.threads[0].exchanges[0]
    exchange.provider = 'nanogpt'; exchange.model = 'saved/model'; exchange.fallbackNotice = 'Switched to NanoGPT after a credit or quota error.'
    const previousAnswer = { provider: 'openrouter' as const, answer: 'Unfinished old-provider response.' }
    exchange.previousAnswers = [previousAnswer]
    const restored = parseConversation(item)
    expect(restored.threads[0].exchanges[0]).toMatchObject({ provider: 'nanogpt', model: 'saved/model', previousAnswers: exchange.previousAnswers })
    expect(exportConversation(restored)).toContain('Answer provider: NanoGPT (saved/model)')
    expect(exportConversation(restored)).toContain('Unfinished old-provider response.')
    expect(questionThreadContext(restored.threads[0], [])).not.toContain('Unfinished old-provider response.')
    expect(() => parseConversation({ ...item, threads: [{ ...item.threads[0], exchanges: [{ ...exchange, previousAnswers: Array(4).fill(previousAnswer) }] }] })).toThrow(/entries/)
    expect(() => parseConversation({ ...item, threads: [{ ...item.threads[0], exchanges: [{ ...exchange, provider: 'unknown-provider' }] }] })).toThrow(/provider/)
  })
  it('includes only the selected question thread in follow-up context, with a bounded history', () => {
    const item = record(), thread = item.threads[0]
    const input = questionThreadContext(thread, thread.exchanges[0].context)
    expect(input).toContain('Selected question: Why use a queue?')
    expect(input).toContain('Assistant: It absorbs bursts.')
    expect(input).toContain('YOU: I handle traffic bursts.')
    const long = { ...thread, exchanges: Array.from({ length: 30 }, () => ({ ...thread.exchanges[0], answer: 'long'.repeat(10000) })) }
    long.exchanges[0] = { ...long.exchanges[0], answer: 'Unrelated old response' }
    long.exchanges[29] = { ...long.exchanges[29], answer: 'Newest response' }
    const bounded = questionThreadContext(long, [])
    expect(bounded.length).toBeLessThanOrEqual(24000)
    expect(bounded).toContain('Selected question: Why use a queue?')
    expect(bounded).toContain('Newest response')
    expect(bounded).not.toContain('Unrelated old response')
  })
  it('namespaces restarted recognition so new speech never replaces historical caption IDs or question links', () => {
    const raw: CaptionLine = { id: 'computer-0-0:0', groupId: 'computer-0-0', source: 'computer', text: 'OLD QUESTION', startMs: 0, endMs: 500 }
    const old = namespaceCaptionLines([raw], 'capture-before-restart', 0)
    const fresh = namespaceCaptionLines([{ ...raw, text: 'NEW QUESTION' }], 'capture-after-restart', 1000)
    const merged = mergeCaptionLines(old, fresh)
    expect(merged.map(line => line.text)).toEqual(['Old question', 'New question'])
    expect(merged.map(line => line.startMs)).toEqual([0, 1000])
    expect(merged[0].id).toBe(old[0].id)
    expect(mergeCaptionLines(merged, namespaceCaptionLines([{ ...raw, text: 'NEW QUESTION REVISED' }], 'capture-after-restart', 1000))).toHaveLength(2)
  })
})
