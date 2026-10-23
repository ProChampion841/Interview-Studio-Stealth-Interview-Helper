import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionSessions } from '../electron/main/captions'
import { CAPTION_MAX_BYTES, CAPTION_SAMPLE_RATE, SpeechChunker, normalizeCaptionProvider, pcmToWav, CAPTION_SOURCE_LABELS } from '../shared/captions'

describe('caption audio preparation', () => {
  it('encodes signed mono PCM at 24 kHz without changing the samples', () => {
    const bytes = pcmToWav(new Int16Array([-32768, 0, 32767]))
    const view = new DataView(bytes.buffer)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(24_000)
    expect(view.getUint16(22, true)).toBe(1)
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([-32768, 0, 32767])
  })
  it('does not send silence or very short noises for transcription', () => {
    const chunker = new SpeechChunker()
    for (let i = 0; i < 100; i++) expect(chunker.push(new Float32Array(1024))).toBeNull()
    expect(chunker.push(new Float32Array(1024).fill(0.1))).toBeNull()
    for (let i = 0; i < 30; i++) expect(chunker.push(new Float32Array(1024))).toBeNull()
  })
  it('segments speech at pauses and bounds continuously spoken chunks', () => {
    const chunker = new SpeechChunker()
    const speech = new Float32Array(1024).fill(0.15)
    for (let i = 0; i < 30; i++) expect(chunker.push(speech)).toBeNull()
    const results = Array.from({ length: 20 }, () => chunker.push(new Float32Array(1024))).filter(Boolean)
    expect(results).toHaveLength(1)
    expect(results[0]!.pcm.length).toBeGreaterThan(CAPTION_SAMPLE_RATE)
    let bounded: ReturnType<SpeechChunker['push']> = null
    for (let i = 0; i < 300 && !bounded; i++) bounded = chunker.push(speech)
    expect(bounded!.pcm.byteLength).toBeLessThanOrEqual(CAPTION_MAX_BYTES)
    chunker.reset()
    expect(chunker.push(new Float32Array(1024))).toBeNull()
  })
})

const managers: CaptionSessions[] = []
afterEach(() => { managers.forEach(manager => manager.stop()); managers.length = 0 })
function fixture(payload: unknown = { text: 'My answer.' }) {
  const requests: FormData[] = []
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key')
    const form = await new Request('https://api.openai.com/v1/audio/transcriptions', init).formData()
    requests.push(form)
    return Response.json(payload)
  })
  const stopped = vi.fn()
  const manager = new CaptionSessions({ getConnection: () => ({ provider: 'openai', apiKey: 'fixture-key', baseUrl: 'https://api.openai.com/v1', fetch: fetchImpl }), onStop: stopped })
  managers.push(manager)
  const { sessionId } = manager.start(100, 'both')
  const chunk = { sessionId, source: 'microphone' as const, sequence: 0, startMs: 2000, pcm: new Int16Array(CAPTION_SAMPLE_RATE * 6).buffer }
  return { manager, requests, fetchImpl, stopped, chunk }
}

describe('caption sessions and audio sources', () => {
  it('requires a key and explicitly selected source, and binds display permission to one owner', () => {
    const manager = new CaptionSessions({ getConnection: () => ({ provider: 'openai', apiKey: '', baseUrl: 'https://api.openai.com/v1', fetch }), onStop: () => {} })
    expect(() => manager.start(100, 'both')).toThrow(/OpenAI API key/)
    expect(() => manager.start(100, 'unknown')).toThrow(/audio source/)
    const f = fixture()
    expect(f.manager.claimDisplay(999)).toBe(false)
    expect(f.manager.claimDisplay(100)).toBe(true)
    expect(f.manager.claimDisplay(100)).toBe(false)
    f.manager.stop(999)
    expect(f.manager.active).toBe(true)
    f.manager.stop(100)
    expect(f.manager.allows(100, 'microphone')).toBe(false)
    expect(f.stopped).toHaveBeenCalledWith(100, f.chunk.sessionId)
  })
  it('labels microphone transcription as YOU independently of the answer provider', async () => {
    const f = fixture()
    const lines = await f.manager.transcribe(100, f.chunk)
    expect(lines[0]).toMatchObject({ source: 'microphone', text: 'My answer.', startMs: 2000, endMs: 8000 })
    expect(CAPTION_SOURCE_LABELS[lines[0].source]).toBe('YOU')
    expect(f.requests[0].get('model')).toBe('gpt-4o-transcribe')
    expect(f.requests[0].get('file')).toBeInstanceOf(File)
  })
  it('rejects unauthorized, replayed, malformed, and excessive audio chunks', async () => {
    const f = fixture()
    await expect(f.manager.transcribe(999, f.chunk)).rejects.toThrow(/expired/)
    await expect(f.manager.transcribe(100, { ...f.chunk, source: 'other' })).rejects.toThrow(/source/)
    await expect(f.manager.transcribe(100, { ...f.chunk, startMs: NaN })).rejects.toThrow(/timestamp/)
    await expect(f.manager.transcribe(100, { ...f.chunk, pcm: new ArrayBuffer(CAPTION_MAX_BYTES + 2) })).rejects.toThrow(/Invalid caption audio/)
    await f.manager.transcribe(100, f.chunk)
    await expect(f.manager.transcribe(100, f.chunk)).rejects.toThrow(/no longer current/)
  })
  it('transcribes both sources without speaker identification or voice references', async () => {
    const f = fixture({ text: 'Complete computer speech.' })
    const first = await f.manager.transcribe(100, { ...f.chunk, source: 'computer' })
    const second = await f.manager.transcribe(100, { ...f.chunk, source: 'computer', sequence: 1 })
    expect(first[0]).toMatchObject({ source: 'computer', text: 'Complete computer speech.', startMs: 2000, endMs: 8000 })
    expect(CAPTION_SOURCE_LABELS[first[0].source]).toBe('Professional')
    expect(first[0]).not.toHaveProperty('speakerId')
    expect(second[0]).not.toHaveProperty('speakerLabel')
    for (const form of f.requests) {
      expect(form.get('model')).toBe('gpt-4o-transcribe')
      expect(form.get('response_format')).toBe('json')
      expect([...form.keys()].some(key => key.includes('speaker'))).toBe(false)
      expect(form.get('chunking_strategy')).toBeNull()
    }
  })
  it('revokes in-flight requests and ignores late responses when stopped', async () => {
    const f = fixture()
    let release!: () => void
    f.fetchImpl.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return Response.json({ text: 'Late text' }) })
    const request = f.manager.transcribe(100, f.chunk)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.manager.stop(100)
    release()
    await expect(request).rejects.toThrow()
    expect(f.manager.active).toBe(false)
  })
})

function routerFixture(payload: unknown = { text: 'My OpenRouter answer.' }) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(payload))
  const connection = { provider: 'openrouter' as const, apiKey: 'router-caption-key', baseUrl: 'https://openrouter.ai/api/v1/', fetch: fetchImpl }
  const getConnection = vi.fn(() => connection)
  const manager = new CaptionSessions({ getConnection, onStop: vi.fn() })
  managers.push(manager)
  const { sessionId } = manager.start(100, 'both')
  const chunk = { sessionId, source: 'microphone' as const, sequence: 0, startMs: 2000, pcm: new Int16Array(CAPTION_SAMPLE_RATE * 6).buffer }
  return { manager, fetchImpl, connection, getConnection, chunk }
}

describe('OpenRouter captions', () => {
  it('validates the independent caption provider selection', () => {
    expect(normalizeCaptionProvider('openrouter')).toBe('openrouter')
    expect(normalizeCaptionProvider('openai')).toBe('openai')
    expect(normalizeCaptionProvider('offline')).toBe('offline')
    for (const bad of ['lmstudio', 'nanogpt', undefined, { provider: 'openrouter' }]) expect(() => normalizeCaptionProvider(bad)).toThrow(/Choose OpenAI, OpenRouter, or Offline/)
  })
  it('requires the OpenRouter key without silently using an OpenAI key', () => {
    const f = routerFixture()
    f.manager.stop()
    f.connection.apiKey = ''
    expect(() => f.manager.start(100, 'microphone')).toThrow(/OpenRouter API key/)
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
  it('uploads WAV JSON with the saved OpenRouter key and labels microphone speech YOU', async () => {
    const f = routerFixture()
    // Changes to settings must not move an already authorized audio session.
    f.connection.apiKey = 'replacement-key'
    f.connection.baseUrl = 'https://other.example/v1'
    const lines = await f.manager.transcribe(100, f.chunk)
    expect(lines[0]).toMatchObject({ source: 'microphone', text: 'My OpenRouter answer.' })
    const [url, init] = f.fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer router-caption-key')
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({ model: 'microsoft/mai-transcribe-2', input_audio: { format: 'wav' }, response_format: 'json' })
    expect(body.provider).toBeUndefined()
    const wav = Buffer.from(body.input_audio.data, 'base64')
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.length).toBe(f.chunk.pcm.byteLength + 44)
    expect(f.getConnection).toHaveBeenCalledOnce()
  })
  it('transcribes computer speech without requesting diarization or depending on speaker output', async () => {
    const f = routerFixture({ text: 'First. Second. Follow-up.' })
    const first = await f.manager.transcribe(100, { ...f.chunk, source: 'computer' })
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ source: 'computer', text: 'First. Second. Follow-up.', startMs: 2000, endMs: 8000 })
    expect(first[0]).not.toHaveProperty('speakerId')
    const body = JSON.parse(f.fetchImpl.mock.calls[0][1]!.body as string)
    expect(body.response_format).toBe('json')
    expect(body.provider).toBeUndefined()
    expect(body.timestamp_granularities).toBeUndefined()
    const next = await f.manager.transcribe(100, { ...f.chunk, source: 'computer', sequence: 1 })
    expect(next[0].source).toBe('computer')
  })
  it('accepts silence and rejects malformed output without silently dropping speech', async () => {
    const f = routerFixture({ text: '' })
    expect(await f.manager.transcribe(100, { ...f.chunk, source: 'computer' })).toEqual([])
    f.fetchImpl.mockResolvedValueOnce(Response.json({ segments: [{ text: 'Unexpected format.' }] }))
    await expect(f.manager.transcribe(100, { ...f.chunk, source: 'computer', sequence: 1 })).rejects.toThrow(/invalid caption response/)
  })
  it.each([[401, /API key/], [402, /credits/], [429, /rate limit/], [503, /HTTP 503/]] as const)('reports HTTP %s without exposing upstream secrets or falling back', async (status, message) => {
    const f = routerFixture()
    f.fetchImpl.mockResolvedValueOnce(new Response('secret-key-and-audio', { status }))
    const request = f.manager.transcribe(100, f.chunk)
    await expect(request).rejects.toThrow(message)
    await expect(request).rejects.not.toThrow(/secret-key-and-audio/)
    expect(f.fetchImpl).toHaveBeenCalledOnce()
  })
  it('aborts OpenRouter requests on stop and rejects a late response', async () => {
    const f = routerFixture()
    let release!: () => void
    let signal: AbortSignal | null | undefined
    f.fetchImpl.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal
      await new Promise<void>(resolve => { release = resolve })
      return Response.json({ text: 'Late.' })
    })
    const request = f.manager.transcribe(100, f.chunk)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.manager.stop(100)
    expect(signal?.aborted).toBe(true)
    release()
    await expect(request).rejects.toThrow(/stopped/)
  })
})

describe('offline caption routing', () => {
  it('uses local inference without a key or network, keeps audio sources separate, and stops the engine', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const local = { transcribe: vi.fn(async () => ({ text: 'Local speech.' })), stop: vi.fn() }
    const manager = new CaptionSessions({ getConnection: () => ({ provider: 'offline', apiKey: '', baseUrl: '', fetch: fetchImpl, local }), onStop: vi.fn() })
    managers.push(manager)
    const { sessionId } = manager.start(100, 'both')
    const chunk = { sessionId, source: 'computer' as const, sequence: 0, startMs: 0, pcm: new Int16Array(CAPTION_SAMPLE_RATE * 6).buffer }
    const first = await manager.transcribe(100, chunk)
    const second = await manager.transcribe(100, { ...chunk, sequence: 1 })
    expect(first[0].source).toBe('computer')
    expect(second[0]).toMatchObject({ source: 'computer', text: 'Local speech.' })
    expect(first[0]).not.toHaveProperty('speakerId')
    expect((await manager.transcribe(100, { ...chunk, source: 'microphone' }))[0]).toMatchObject({ text: 'Local speech.' })
    expect(local.transcribe).toHaveBeenCalledTimes(3)
    expect(fetchImpl).not.toHaveBeenCalled()
    manager.stop(100)
    expect(local.stop).toHaveBeenCalledOnce()
  })
  it('does not fall back to the cloud if local inference fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const local = { transcribe: vi.fn(async () => { throw new Error('Offline engine failed.') }), stop: vi.fn() }
    const manager = new CaptionSessions({ getConnection: () => ({ provider: 'offline', apiKey: 'unused-key', baseUrl: 'https://unused.example', fetch: fetchImpl, local }), onStop: vi.fn() })
    managers.push(manager)
    const { sessionId } = manager.start(100, 'microphone')
    await expect(manager.transcribe(100, { sessionId, source: 'microphone', sequence: 0, startMs: 0, pcm: new Int16Array(CAPTION_SAMPLE_RATE).buffer })).rejects.toThrow(/Offline engine failed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
