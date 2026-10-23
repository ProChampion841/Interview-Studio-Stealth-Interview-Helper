import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionTranslationClient } from '../../src/lib/caption-translation-client'
import type { CaptionLine } from '../../shared/captions'
import type { CaptionTranslationRequest, CaptionTranslationResult } from '../../shared/caption-translation'

afterEach(() => vi.useRealTimers())
const line = (id: string, text: string, source: 'computer' | 'microphone' = 'computer'): CaptionLine => ({ id, text, source, startMs: 0, endMs: 1000, isFinal: false })
function fixture(waitForPhrase = false) {
  const pending: Array<{ request: CaptionTranslationRequest; resolve: (value: CaptionTranslationResult) => void; reject: (error: Error) => void }> = []
  const translate = vi.fn((request: CaptionTranslationRequest) => new Promise<CaptionTranslationResult>((resolve, reject) => pending.push({ request, resolve, reject })))
  const onTranslation = vi.fn(), onPending = vi.fn(), onError = vi.fn(), cancel = vi.fn()
  const client = new CaptionTranslationClient({ sessionId: 'session', language: 'ko', translate, onTranslation, onPending, onError, cancel, waitForPhrase })
  return { client, translate, pending, onTranslation, onPending, onError, cancel }
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
describe('live translation scheduling', () => {
  it('skips a declined passage and keeps translating both sources and following passages', async () => {
    vi.useFakeTimers(); const f = fixture()
    const originals = [line('declined', 'First question'), line('mic', 'My answer', 'microphone')]
    f.client.update(originals)
    const declined = f.pending.find(item => item.request.text === 'First question')!
    const microphone = f.pending.find(item => item.request.text === 'My answer')!
    declined.resolve({ text: '', skipped: 'content_filter' }); await settle()
    expect(f.onTranslation).toHaveBeenCalledWith('declined', expect.objectContaining({ text: '', sourceText: 'First question', skipped: 'content_filter' }))
    expect(f.onPending).toHaveBeenLastCalledWith(new Set(['mic']))
    expect(f.cancel).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled()
    // A revision arriving after rejection must never resubmit that passage.
    const following = [...originals.map(item => item.id === 'declined' ? { ...item, text: 'First question revised.' } : item), line('next', 'Next question')]
    f.client.update(following)
    microphone.resolve({ text: 'Translated answer' }); await settle()
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.pending.at(-1)?.request.text).toBe('Next question')
    f.pending.at(-1)!.resolve({ text: 'Translated next question' }); await settle()
    f.client.update(following); await vi.advanceTimersByTimeAsync(60_000)
    expect(f.translate).toHaveBeenCalledTimes(3)
    expect(f.onPending).toHaveBeenLastCalledWith(new Set())
    expect(originals[0].text).toBe('First question')
    expect(f.onError).not.toHaveBeenCalled(); f.client.stop()
  })
  it('does not resubmit recognition revisions that arrived while the declined request was in flight', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.client.update([line('a', 'First words')])
    f.client.update([line('a', 'First words revised.')])
    f.pending[0].resolve({ text: '', skipped: 'content_filter' }); await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.translate).toHaveBeenCalledOnce()
    expect(f.onPending).toHaveBeenLastCalledWith(new Set())
    f.client.stop()
  })
  it('reuses a saved skipped marker and can translate it under a different configuration', () => {
    const f = fixture()
    const original = { ...line('a', 'Revised original'), translation: { language: 'ko' as const, text: '', sourceText: 'Original', skipped: 'content_filter' as const } }
    f.client.update([original]); expect(f.translate).not.toHaveBeenCalled()
    expect(f.onError).not.toHaveBeenCalled(); f.client.stop()
    const fresh = fixture()
    fresh.client.update([{ ...original, translation: { ...original.translation, engine: 'other-provider:1' } }])
    expect(fresh.translate).toHaveBeenCalledOnce(); fresh.client.stop()
  })
  it('ignores a late skipped result after stop just as it ignores late translations', async () => {
    const f = fixture()
    f.client.update([line('a', 'Original')]); f.client.stop()
    f.pending[0].resolve({ text: '', skipped: 'content_filter' }); await settle()
    expect(f.onTranslation).not.toHaveBeenCalled(); expect(f.onError).not.toHaveBeenCalled()
  })
  it('ends a cancelled session without retrying it or displaying an error', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.client.update([line('a', 'Question'), line('b', 'Answer', 'microphone')])
    f.pending[0].resolve({ text: '', cancelled: true }); await settle()
    f.pending[1].resolve({ text: 'obsolete' }); await settle()
    f.client.update([line('a', 'More speech')])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.translate).toHaveBeenCalledTimes(2)
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.onPending).toHaveBeenLastCalledWith(new Set())
    expect(f.onTranslation).not.toHaveBeenCalled()
    expect(f.onError).not.toHaveBeenCalled()
  })
  it('gives offline translation a stable phrase, then submits a final revision promptly', async () => {
    vi.useFakeTimers(); const f = fixture(true)
    f.client.update([line('a', 'I have')])
    await vi.advanceTimersByTimeAsync(500)
    f.client.update([line('a', 'I have five years of experience')])
    await vi.advanceTimersByTimeAsync(799)
    expect(f.translate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.pending[0].request.text).toBe('I have five years of experience')
    f.pending[0].resolve({ text: 'translated phrase' }); await settle()
    await vi.advanceTimersByTimeAsync(1500)
    f.client.update([{ ...line('a', 'I have five years of experience building software.'), isFinal: true }])
    expect(f.pending[1].request.text).toBe('I have five years of experience building software.')
    f.client.stop()
  })
  it('bounds offline phrase buffering during continuous revisions and cancels its timer on Stop', async () => {
    vi.useFakeTimers(); const f = fixture(true)
    f.client.update([line('a', 'One')])
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(500)
      f.client.update([line('a', `One developing phrase ${i}`)])
    }
    expect(f.translate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.translate).toHaveBeenCalledOnce()
    expect(f.pending[0].request.text).toBe('One developing phrase 4')
    f.pending[0].resolve({ text: 'translated' }); await settle()
    f.client.update([line('a', 'One longer developing phrase')]); f.client.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.translate).toHaveBeenCalledOnce()
  })
  it('does not buffer completed sentences or finalized short passages offline', () => {
    const f = fixture(true)
    f.client.update([line('a', 'Can you explain your experience?'), { ...line('b', 'Yes', 'microphone'), isFinal: true }])
    expect(f.translate).toHaveBeenCalledTimes(2)
    f.client.stop()
  })
  it('does not reuse a translation from another provider or credential revision', () => {
    const translate = vi.fn(() => new Promise<{ text: string }>(() => {}))
    const client = new CaptionTranslationClient({ sessionId: 'session', language: 'ko', engine: 'google:2', translate, cancel: vi.fn(), onTranslation: vi.fn(), onPending: vi.fn(), onError: vi.fn() })
    client.update([{ ...line('a', 'Hello'), translation: { language: 'ko', text: 'old', sourceText: 'Hello', engine: 'azure:1' } }])
    expect(translate).toHaveBeenCalledOnce()
    client.stop()
  })
  it('coalesces developing text instead of uploading every recognition revision', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.client.update([line('a', 'Hello')])
    for (const text of ['Hello there', 'Hello there how', 'Hello there how are you']) f.client.update([line('a', text)])
    expect(f.translate).toHaveBeenCalledTimes(1)
    f.pending[0].resolve({ text: '안녕하세요' }); await settle()
    expect(f.onTranslation).toHaveBeenCalledWith('a', expect.objectContaining({ sourceText: 'Hello', text: '안녕하세요' }))
    expect(f.onPending.mock.calls.at(-1)?.[0].has('a')).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(f.translate).toHaveBeenCalledTimes(2)
    expect(f.pending[1].request.text).toBe('Hello there how are you')
    f.pending[1].resolve({ text: '안녕하세요, 어떻게 지내세요?' }); await settle()
    f.client.update([line('a', 'Hello there how are you')]); await vi.advanceTimersByTimeAsync(10_000)
    expect(f.translate).toHaveBeenCalledTimes(2)
    f.client.stop()
  })
  it('translates both sources without letting either source create concurrent requests', () => {
    const f = fixture()
    f.client.update([line('a', 'Question'), line('b', 'Answer', 'microphone')])
    f.client.update([line('a', 'Longer question'), line('b', 'Longer answer', 'microphone')])
    expect(f.pending).toHaveLength(2)
    expect(f.pending.map(item => item.request.text)).toEqual(['Answer', 'Question'])
    f.client.stop()
  })
  it('backfills only recent passages and ignores late results after language switch or stop', async () => {
    const f = fixture()
    f.client.update(Array.from({ length: 100 }, (_, i) => line(String(i), `Passage ${i}`)))
    expect(f.pending[0].request.text).toBe('Passage 98')
    expect(f.onPending.mock.calls.at(-1)?.[0].size).toBe(2)
    f.client.stop(); f.pending[0].resolve({ text: 'late Korean' }); await settle()
    expect(f.onTranslation).not.toHaveBeenCalled()
    expect(f.cancel).toHaveBeenCalledOnce()
  })
  it('stops translation on failure without stopping or modifying original captions', async () => {
    const f = fixture(), original = [line('a', 'Original words')]
    f.client.update(original); f.pending[0].reject(new Error('Provider unavailable')); await settle()
    expect(f.onError).toHaveBeenCalledWith('Provider unavailable')
    expect(original[0].text).toBe('Original words')
    f.client.update([line('a', 'More original words')])
    expect(f.translate).toHaveBeenCalledOnce()
  })
  it('reuses saved translations in the same language without new requests', () => {
    const f = fixture()
    f.client.update([{ ...line('a', 'Hello'), translation: { language: 'ko', text: '안녕하세요', sourceText: 'Hello' } }])
    expect(f.translate).not.toHaveBeenCalled()
    f.client.stop()
  })
})
