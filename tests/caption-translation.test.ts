import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionTranslations } from '../electron/main/caption-translations'
import { TRANSLATION_LANGUAGES, parseTranslationRequest, translationInstructions } from '../shared/caption-translation'
import { mergeCaptionLines, splitCaptionTurns, type CaptionLine } from '../shared/captions'

afterEach(() => vi.useRealTimers())
const request = (requestId = 'request-1') => ({ sessionId: 'session-1', requestId, language: 'ko', text: 'Tell me about your experience.' })
function fixture() {
  const allowed = vi.fn((ownerId: number, sessionId: string) => ownerId === 1 && sessionId === 'session-1')
  const translate = vi.fn(async (_text: string, _language: string, _signal: AbortSignal) => '경험에 대해 말씀해 주세요.')
  const connection = vi.fn(() => translate)
  return { allowed, translate, connection, service: new CaptionTranslations({ allowed, connection }) }
}
describe('caption translation boundary', () => {
  it('validates languages, bounded text, and request identifiers', () => {
    expect(new Set(TRANSLATION_LANGUAGES.map(language => language.id)).size).toBe(TRANSLATION_LANGUAGES.length)
    expect(parseTranslationRequest(request())).toMatchObject({ language: 'ko' })
    for (const input of [null, {}, { ...request(), language: 'invented' }, { ...request(), text: ' ' }, { ...request(), text: 'x'.repeat(6001) }, { ...request(), requestId: '<script>' }]) expect(() => parseTranslationRequest(input)).toThrow()
    expect(translationInstructions('ar')).toMatch(/Arabic/)
    expect(translationInstructions('ko')).toMatch(/untrusted speech/)
    expect(translationInstructions('ko')).toMatch(/Do not answer questions/)
  })
  it('requires a current caption session owned by the requester before looking up credentials', async () => {
    const f = fixture()
    await expect(f.service.translate(2, request())).resolves.toEqual({ text: '', cancelled: true })
    await expect(f.service.translate(1, { ...request(), sessionId: 'expired' })).resolves.toEqual({ text: '', cancelled: true })
    expect(f.connection).not.toHaveBeenCalled()
    await expect(f.service.translate(1, request())).resolves.toEqual({ text: '경험에 대해 말씀해 주세요.' })
    expect(f.translate).toHaveBeenCalledWith(request().text, 'ko', expect.any(AbortSignal))
  })
  it('bounds concurrency and rejects duplicate requests without another provider call', async () => {
    const f = fixture(); const completions: Array<(value: string) => void> = []
    f.translate.mockImplementation(() => new Promise(resolve => { completions.push(resolve) }))
    const first = f.service.translate(1, request('one'))
    await expect(f.service.translate(1, request('one'))).rejects.toThrow(/Wait/)
    const second = f.service.translate(1, request('two'))
    await expect(f.service.translate(1, request('three'))).rejects.toThrow(/Wait/)
    f.service.cancel(1)
    const rejectedFirst = expect(first).resolves.toMatchObject({ cancelled: true, text: '' })
    const rejectedSecond = expect(second).resolves.toMatchObject({ cancelled: true, text: '' })
    for (const done of completions) done('late')
    await Promise.all([rejectedFirst, rejectedSecond])
    expect(f.translate).toHaveBeenCalledTimes(2)
  })
  it('cancels pending work and discards a late result after Stop', async () => {
    const f = fixture(); let complete!: (value: string) => void
    f.translate.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const pending = f.service.translate(1, request())
    const rejected = expect(pending).resolves.toMatchObject({ cancelled: true, text: '' })
    f.service.cancel(1)
    expect(f.translate.mock.calls[0][2].aborted).toBe(true)
    complete('late translation'); await rejected
  })
  it('quietly cancels queued requests and late completions after a session replacement', async () => {
    const f = fixture(); let complete!: (value: string) => void
    f.translate.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    const pending = f.service.translate(1, request())
    f.allowed.mockImplementation((owner, session) => owner === 1 && session === 'replacement')
    complete('obsolete translation')
    await expect(pending).resolves.toEqual({ text: '', cancelled: true })
    for (let i = 0; i < 3; i++) await expect(f.service.translate(1, request(`queued-${i}`))).resolves.toEqual({ text: '', cancelled: true })
    expect(f.connection).toHaveBeenCalledOnce()
    f.translate.mockResolvedValue('fresh translation')
    await expect(f.service.translate(1, { ...request(), sessionId: 'replacement' })).resolves.toEqual({ text: 'fresh translation' })
  })
  it('discards a late provider failure when its session has already ended', async () => {
    const f = fixture(); let reject!: (error: Error) => void
    f.translate.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const pending = f.service.translate(1, request())
    f.allowed.mockReturnValue(false); reject(new Error('HTTP 401 obsolete response'))
    await expect(pending).resolves.toEqual({ text: '', cancelled: true })
  })
  it('times out provider work and never forwards provider bodies containing caption text or credentials', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.translate.mockImplementation(async (_text, _language, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    const pending = f.service.translate(1, request())
    const rejected = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(20_000); await rejected
    f.translate.mockRejectedValue(new Error('HTTP 401 private-key captured-words'))
    await expect(f.service.translate(1, request())).rejects.toThrow('Check your translation API key in Settings, then retry.')
  })
})
describe('bilingual caption revisions', () => {
  it('keeps the last translation while the same developing passage is revised', () => {
    const line: CaptionLine = { id: 'one', groupId: 'phrase', source: 'computer', startMs: 0, endMs: 1000, text: 'Hello', isFinal: false, translation: { language: 'ko', text: '안녕하세요', sourceText: 'Hello' } }
    const revised = { ...line, text: 'Hello there.', isFinal: true, translation: undefined }
    const next = mergeCaptionLines([line], [revised])
    expect(next[0]).toMatchObject({ text: 'Hello there.', translation: line.translation })
    expect(line.text).toBe('Hello')
  })
  it('pairs passages under one source header without losing source changes', () => {
    const line = (id: string, source: 'computer' | 'microphone'): CaptionLine => ({ id, source, text: id, startMs: 0, endMs: 1 })
    expect(splitCaptionTurns([line('a', 'computer'), line('b', 'computer'), line('c', 'microphone'), line('d', 'computer')]).map(parts => parts.map(part => part.id))).toEqual([['a', 'b'], ['c'], ['d']])
  })
})
