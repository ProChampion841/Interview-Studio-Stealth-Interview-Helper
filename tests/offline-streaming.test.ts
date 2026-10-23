import { describe, expect, it, vi } from 'vitest'
import { mergeCaptionLines, StreamingAudioBatcher, type CaptionLine, type LocalCaptionResult } from '../shared/captions'
import { recognizedWords, captionWords } from '../electron/main/offline-words'
import { CaptionSessions } from '../electron/main/captions'

describe('continuous local caption audio', () => {
  it('preserves every sample across batches, including silence, and discards partial audio on pause', () => {
    const batcher = new StreamingAudioBatcher(), batches: Int16Array[] = [], expected: number[] = []
    for (let frame = 0; frame < 36; frame++) {
      const samples = Float32Array.from({ length: 1024 }, (_, i) => frame < 12 ? 0 : Math.sin((frame * 1024 + i) / 100))
      expected.push(...samples.map(value => Math.round(value * 32767)))
      const batch = batcher.push(samples)
      if (batch) batches.push(batch)
    }
    expect(batches.map(batch => batch.length)).toEqual([12288, 12288, 12288])
    expect(batches.flatMap(batch => [...batch])).toEqual(expected)
    batcher.push(new Float32Array(1024).fill(1)); batcher.reset()
    let complete: Int16Array | null = null
    for (let i = 0; i < 12; i++) complete = batcher.push(new Float32Array(1024))
    expect(complete).toEqual(new Int16Array(12288))
  })
})

describe('whole words and developing captions', () => {
  it('preserves every recognized word and timestamp without speaker segmentation', () => {
    const words = recognizedWords({ tokens: [' A', 'RO', 'UND', ' THE', ' FOL', 'DER', ' ', 'NOW'], timestamps: [0, 0.1, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9] }, 10)
    expect(words.map(word => word.text)).toEqual(['AROUND', 'THE', 'FOLDER', 'NOW'])
    expect(captionWords(words, 'phrase-1', false)).toEqual([{ id: 'phrase-1:0', groupId: 'phrase-1', start: 10, end: 10.98, text: 'AROUND THE FOLDER NOW', isFinal: false }])
    expect(captionWords([], 'phrase-1', true)).toEqual([])
  })
  it('replaces all turns of a revised phrase without duplicating text or losing other sources', () => {
    const line: CaptionLine = { id: 'a', groupId: 'phrase-1', isFinal: false, source: 'computer', startMs: 0, endMs: 1000, text: 'HELLO' }
    const other = { ...line, id: 'mic', groupId: undefined, source: 'microphone' as const, startMs: 500, text: 'MY ANSWER' }
    const updated = mergeCaptionLines([line, other], [{ ...line, text: 'HELLO WORLD', isFinal: true }, { ...line, id: 'b', text: 'HI', startMs: 1200, isFinal: true }])
    expect(updated.map(line => line.text)).toEqual(['HELLO WORLD', 'MY ANSWER', 'HI'])
    const combined = mergeCaptionLines(updated, [{ ...line, text: 'HELLO WORLD HI', isFinal: true }])
    expect(combined.map(line => line.text)).toEqual(['HELLO WORLD HI', 'MY ANSWER'])
    expect(mergeCaptionLines(combined, [])).toBe(combined)
  })
})

describe('local streaming session updates', () => {
  it('prepares models before capture and cannot revive a stopped run or stop its replacement', async () => {
    let ready!: () => void
    const first = { prepare: vi.fn(() => new Promise<void>(resolve => { ready = resolve })), transcribe: vi.fn(), stop: vi.fn() }
    const second = { prepare: vi.fn(async () => {}), transcribe: vi.fn(), stop: vi.fn() }
    let local = first
    const sessions = new CaptionSessions({ getConnection: () => ({ provider: 'offline', local, apiKey: '', baseUrl: '', fetch }), onStop: vi.fn() })
    const run = sessions.start(1, 'computer')
    await expect(sessions.prepare(2, run.sessionId)).rejects.toThrow(/expired/)
    const warming = sessions.prepare(1, run.sessionId)
    const rejected = expect(warming).rejects.toThrow(/stopped/)
    expect(first.prepare).toHaveBeenCalledOnce()
    sessions.stop(); local = second
    const replacement = sessions.start(1, 'computer')
    ready(); await rejected
    expect(sessions.sessionId).toBe(replacement.sessionId)
    await sessions.prepare(1, replacement.sessionId)
    expect(second.prepare).toHaveBeenCalledOnce()
    expect(second.stop).not.toHaveBeenCalled()
    sessions.stop()
  })
  it('releases a failed model startup and its capture permissions without sending audio', async () => {
    const local = { prepare: vi.fn(async () => { throw new Error('Model loading failed.') }), transcribe: vi.fn(), stop: vi.fn() }
    const sessions = new CaptionSessions({ getConnection: () => ({ provider: 'offline', local, apiKey: '', baseUrl: '', fetch }), onStop: vi.fn() })
    const run = sessions.start(1, 'both')
    await expect(sessions.prepare(1, run.sessionId)).rejects.toThrow(/Model loading failed/)
    expect(sessions.active).toBe(false)
    expect(sessions.claimDisplay(1)).toBe(false)
    expect(local.stop).toHaveBeenCalledOnce()
    expect(local.transcribe).not.toHaveBeenCalled()
  })
  it('preserves stable phrase IDs, absolute times, source labels and finality without network access', async () => {
    const segment = { id: 'computer-0-1:0', groupId: 'computer-0-1', start: 10, end: 10.4, text: 'HELLO', isFinal: false }
    const transcribe = vi.fn(async (): Promise<LocalCaptionResult> => ({ absoluteTimes: true, segments: [segment] }))
    const local = { transcribe, stop: vi.fn() }, fetchImpl = vi.fn<typeof fetch>()
    const sessions = new CaptionSessions({ getConnection: () => ({ provider: 'offline', local, apiKey: '', baseUrl: '', fetch: fetchImpl }), onStop: vi.fn() })
    const { sessionId } = sessions.start(1, 'both')
    try {
      const chunk = { sessionId, source: 'computer', sequence: 0, startMs: 10000, streaming: true, pcm: new Int16Array(12288).buffer }
      const first = await sessions.transcribe(1, chunk)
      expect(first[0]).toMatchObject({ startMs: 10000, endMs: 10400, isFinal: false })
      segment.text = 'HELLO WORLD'; segment.isFinal = true
      const second = await sessions.transcribe(1, { ...chunk, startMs: 10512, sequence: 1 })
      expect(second[0]).toMatchObject({ id: first[0].id, groupId: first[0].groupId, isFinal: true })
      expect(transcribe.mock.calls[0]).toHaveLength(4)
      expect((await sessions.transcribe(1, { ...chunk, source: 'microphone' }))[0].source).toBe('microphone')
      expect(second[0]).not.toHaveProperty('speakerId')
      segment.end = Infinity
      expect(await sessions.transcribe(1, { ...chunk, source: 'microphone', sequence: 1 })).toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally { sessions.stop() }
    expect(local.stop).toHaveBeenCalledOnce()
  })
})
