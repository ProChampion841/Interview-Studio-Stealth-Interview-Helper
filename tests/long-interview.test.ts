import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CaptionSessions } from '../electron/main/captions'
import { ConversationHistory } from '../electron/main/conversation-history'
import { ConversationMemory } from '../shared/conversation-memory'
import { questionThreadContext, type ConversationRecord } from '../shared/conversation-history'
import type { CaptionLine } from '../shared/captions'

afterEach(() => vi.useRealTimers())
describe('accelerated three-hour interview', () => {
  it('keeps the real caption session valid through hour three and expires at the four-hour boundary', async () => {
    vi.useFakeTimers()
    const local = { prepare: vi.fn(async () => {}), stop: vi.fn(), transcribe: vi.fn(async () => ({ text: 'Still captioning.' })) }
    const stopped = vi.fn(), manager = new CaptionSessions({ getConnection: () => ({ provider: 'offline', apiKey: '', baseUrl: '', fetch, local }), onStop: stopped })
    try {
      const { sessionId } = manager.start(1, 'both')
      await manager.prepare(1, sessionId)
      for (let hour = 1; hour <= 3; hour++) {
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(manager.allows(1, 'microphone')).toBe(true); expect(manager.allows(1, 'computer')).toBe(true)
        for (const source of ['microphone', 'computer'] as const) expect(await manager.transcribe(1, { sessionId, source, sequence: hour, startMs: hour * 60 * 60_000 - 1000, pcm: new Int16Array(24000).buffer })).not.toEqual([])
      }
      expect(stopped).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(manager.active).toBe(false); expect(stopped).toHaveBeenCalledOnce()
    } finally { manager.stop() }
  })
  it('retrieves early facts and persists 10,800 speech segments with 180 questions without expanding API context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'interview-three-hour-'))
    const directory = join(root, 'conversations'), store = new ConversationHistory(() => directory), memory = new ConversationMemory()
    const started = performance.now(), heapBefore = process.memoryUsage().heapUsed
    const item: ConversationRecord = { version: 1, id: randomUUID(), title: 'Three-hour synthetic technical interview', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), captions: [], threads: [], selectedThreadId: null, draft: '', pendingContext: [], role: 'Engineer', interviewType: 'Technical', responseStyle: 'Concise structure' }
    let maximumQueryMs = 0, maximumSaveMs = 0, maximumContext = 0
    try {
      for (let minute = 0; minute < 180; minute++) {
        const incoming: CaptionLine[] = Array.from({ length: 60 }, (_, n) => ({ id: `speech-${minute}-${n}`, source: n % 2 ? 'microphone' : 'computer', startMs: (minute * 60 + n) * 1000, endMs: (minute * 60 + n) * 1000 + 500, isFinal: true, text: minute === 2 && n === 1 ? 'I designed the cerulean-ledger payment outbox in PostgreSQL. We needed atomic event publishing and idempotency keys to prevent duplicate charges.' : `We are discussing component${minute}, accessibility, deployment and engineering tradeoffs for feature${n}.`, ...(n % 10 === 0 ? { translation: { language: 'es', sourceText: 'Fixture speech.', text: 'Texto de prueba para traducción.' } } : {}) }))
        item.captions.push(...incoming); memory.update(item.captions)
        const question = minute >= 3 ? 'How did the cerulean-ledger outbox prevent duplicate charges?' : 'What are the deployment tradeoffs?'
        const before = performance.now(), selected = memory.retrieve(question)
        maximumQueryMs = Math.max(maximumQueryMs, performance.now() - before)
        const context = questionThreadContext(undefined, [], selected)
        maximumContext = Math.max(maximumContext, context.length)
        if (minute >= 3) expect(context).toContain('atomic event publishing')
        expect(context.length).toBeLessThanOrEqual(24000)
        const id = randomUUID()
        item.threads.push({ id, question, captionIds: [], exchanges: [{ id: randomUUID(), question, answer: 'Synthetic answer. '.repeat(70), status: 'ready', createdAt: new Date().toISOString(), context: [], sourceNames: [], memory: selected }] })
        item.selectedThreadId = id
        if ((minute + 1) % 15 === 0) {
          const beforeSave = performance.now(); await store.save(item)
          maximumSaveMs = Math.max(maximumSaveMs, performance.now() - beforeSave)
        }
      }
      const restored = await new ConversationHistory(() => directory).get(item.id)
      expect(restored.captions).toHaveLength(10800); expect(restored.threads).toHaveLength(180)
      const reopenedMemory = new ConversationMemory(); reopenedMemory.update(restored.captions)
      expect(reopenedMemory.retrieve('cerulean-ledger outbox').relevant[0].text).toContain('idempotency keys')
      expect(restored.threads[179].exchanges[0].memory?.relevant.some(item => item.id === 'speech-2-1')).toBe(true)
      expect(maximumQueryMs).toBeLessThan(1000)
      console.info(JSON.stringify({ test: 'accelerated-three-hour', simulatedMinutes: 180, captions: restored.captions.length, questions: restored.threads.length, maximumContextChars: maximumContext, maxRetrievalMs: Math.round(maximumQueryMs), maxAtomicSaveMs: Math.round(maximumSaveMs), fileBytes: statSync(join(directory, item.id + '.json')).size, elapsedMs: Math.round(performance.now() - started), heapDeltaMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1048576), realTimeSoak: false }))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 30000)
})
