import { randomUUID } from 'node:crypto'
import OpenAI, { toFile } from 'openai'
import { CAPTION_MAX_BYTES, CAPTION_SAMPLE_RATE, pcmToWav, type CaptionChunk, type CaptionProvider, type CaptionLine, type CaptionSource, type LocalCaptionEngine } from '../../shared/captions'

interface CaptionConnection {
  local?: LocalCaptionEngine
  provider: CaptionProvider
  apiKey: string
  baseUrl: string
  fetch: typeof fetch
}

interface Session {
  connection: CaptionConnection
  id: string
  ownerId: number
  sources: Set<CaptionSource>
  displayAvailable: boolean
  expires: number
  controllers: Map<CaptionSource, AbortController>
  sequences: Map<CaptionSource, number>
  timer: ReturnType<typeof setTimeout>
}

export class CaptionSessions {
  private session: Session | null = null
  constructor(private options: { getConnection: () => CaptionConnection; onStop: (ownerId: number, sessionId: string) => void }) {}
  get active(): boolean { return this.session !== null }
  get sessionId(): string | null { return this.session?.id ?? null }
  start(ownerId: number, input: unknown): { sessionId: string } {
    if (!['both', 'computer', 'microphone'].includes(input as string)) throw new Error('Choose a caption audio source.')
    const connection = this.options.getConnection()
    if (connection.provider === 'offline') {
      if (!connection.local) throw new Error('Download the offline models in Settings > AI connection > Caption transcription first.')
    } else if (!connection.apiKey) throw new Error(`Add an ${connection.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key in Settings > AI connection > Caption transcription to start captions. Your chat provider can stay unchanged.`)
    this.stop()
    const sources = new Set<CaptionSource>(input === 'both' ? ['microphone', 'computer'] : [input as CaptionSource])
    const id = randomUUID()
    this.session = {
      id, ownerId, connection: { ...connection }, sources, displayAvailable: sources.has('computer'), expires: Date.now() + 4 * 60 * 60_000,
      controllers: new Map(), sequences: new Map(),
      timer: setTimeout(() => this.stop(), 4 * 60 * 60_000)
    }
    return { sessionId: id }
  }
  allows(ownerId: number, source: CaptionSource): boolean {
    return Boolean(this.session && this.session.ownerId === ownerId && this.session.expires > Date.now() && this.session.sources.has(source))
  }
  claimDisplay(ownerId: number): boolean {
    if (!this.allows(ownerId, 'computer') || !this.session!.displayAvailable) return false
    this.session!.displayAvailable = false
    return true
  }
  async prepare(ownerId: number, sessionId: string): Promise<void> {
    const current = this.session
    if (!current || current.id !== sessionId || current.ownerId !== ownerId) throw new Error('Caption session expired. Start captions again.')
    if (current.connection.provider !== 'offline') return
    const timeout = setTimeout(() => { if (this.session === current) this.stop() }, 120_000)
    try {
      await current.connection.local?.prepare?.()
      if (this.session !== current) throw new DOMException('Captioning stopped.', 'AbortError')
    } catch (error) {
      if (this.session === current) this.stop()
      throw error
    } finally { clearTimeout(timeout) }
  }
  stop(ownerId?: number): void {
    const current = this.session
    if (!current || (ownerId !== undefined && current.ownerId !== ownerId)) return
    this.session = null
    clearTimeout(current.timer)
    for (const controller of current.controllers.values()) controller.abort()
    current.connection.local?.stop()
    this.options.onStop(current.ownerId, current.id)
  }
  async transcribe(ownerId: number, raw: unknown): Promise<CaptionLine[]> {
    const input = raw as Partial<CaptionChunk> | null
    const current = this.session
    if (!input || !current || current.id !== input.sessionId || current.ownerId !== ownerId || current.expires <= Date.now()) throw new Error('Caption session expired. Start captions again.')
    const source = input.source
    if ((source !== 'microphone' && source !== 'computer') || !current.sources.has(source)) throw new Error('This audio source is not enabled.')
    if (!Number.isSafeInteger(input.sequence) || input.sequence! < 0 || input.sequence! <= (current.sequences.get(source) ?? -1)) throw new Error('This audio chunk is no longer current.')
    if (!Number.isFinite(input.startMs) || input.startMs! < 0 || input.startMs! > 4 * 60 * 60_000) throw new Error('Invalid audio timestamp.')
    if (input.streaming !== undefined && (typeof input.streaming !== 'boolean' || current.connection.provider !== 'offline')) throw new Error('Streaming audio requires offline captions.')
    if (!(input.pcm instanceof ArrayBuffer) || input.pcm.byteLength < CAPTION_SAMPLE_RATE * 0.3 * 2 || input.pcm.byteLength > CAPTION_MAX_BYTES || input.pcm.byteLength % 2) throw new Error('Invalid caption audio. Send up to 12 seconds of mono PCM audio.')
    if (current.controllers.has(source)) throw new Error('Wait for this audio source to finish transcribing.')
    current.sequences.set(source, input.sequence!)
    const pcm = new Int16Array(input.pcm)
    const duration = pcm.length / CAPTION_SAMPLE_RATE
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), current.connection.provider === 'offline' ? 120_000 : 30_000)
    current.controllers.set(source, controller)
    try {
      const { provider, apiKey, baseUrl, fetch: fetchImpl } = current.connection
      let result: unknown
      if (provider === 'offline') {
        result = await current.connection.local!.transcribe(source, pcm, controller.signal, { startMs: input.startMs!, streaming: input.streaming === true })
      } else if (provider === 'openrouter') {
        const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
          method: 'POST', signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'microsoft/mai-transcribe-2',
            input_audio: { data: Buffer.from(pcmToWav(pcm)).toString('base64'), format: 'wav' },
            response_format: 'json'
          })
        })
        if (!response.ok) {
          // Do not echo upstream bodies: they can contain audio or credentials.
          await response.body?.cancel()
          throw new Error(response.status === 401 || response.status === 403 ? 'OpenRouter rejected the caption API key. Check it in Settings > AI connection.'
            : response.status === 402 ? 'OpenRouter captions need available credits on your account.'
              : response.status === 429 ? 'OpenRouter caption rate limit reached. Wait a moment before starting again.'
                : `OpenRouter caption transcription failed (HTTP ${response.status}). Try again or choose OpenAI for captions.`)
        }
        result = await response.json()
        if (result && typeof result === 'object' && 'error' in result) throw new Error('OpenRouter could not transcribe this audio. Try again or choose OpenAI for captions.')
      } else {
        const client = new OpenAI({ apiKey, baseURL: baseUrl, fetch: fetchImpl, maxRetries: 0 })
        const file = await toFile(pcmToWav(pcm), 'caption.wav', { type: 'audio/wav' })
        result = await client.audio.transcriptions.create({ file, model: 'gpt-4o-transcribe', response_format: 'json' }, { signal: controller.signal })
      }
      if (this.session !== current || controller.signal.aborted) throw new DOMException('Captioning stopped.', 'AbortError')
      const data = result && typeof result === 'object' ? result as Record<string, unknown> : {}
      const offset = input.startMs!
      if (provider === 'offline' && input.streaming && data.absoluteTimes === true) {
        if (!Array.isArray(data.segments)) throw new Error('The offline engine returned invalid captions.')
        return data.segments.flatMap(segment => {
          if (!segment || typeof segment !== 'object') return []
          const { id, groupId, start, end, text, isFinal } = segment as Record<string, unknown>
          if (typeof id !== 'string' || !/^[a-z0-9:-]{1,100}$/.test(id) || typeof groupId !== 'string' || !/^[a-z0-9:-]{1,100}$/.test(groupId) || typeof isFinal !== 'boolean'
            || typeof start !== 'number' || !Number.isFinite(start) || start < 0 || typeof end !== 'number' || !Number.isFinite(end) || end <= start || end * 1000 > offset + duration * 1000 + 100
            || typeof text !== 'string' || !text.trim()) return []
          return [{ id: `${current.id}:${id}`, groupId: `${current.id}:${groupId}`, isFinal, source, text: text.trim().slice(0, 12_000), startMs: start * 1000, endMs: end * 1000 }]
        })
      }
      if (typeof data.text !== 'string') throw new Error('The transcription service returned an invalid caption response.')
      const text = data.text.trim().slice(0, 12_000)
      return text ? [{ id: randomUUID(), source, text, startMs: offset, endMs: offset + duration * 1000 }] : []
    } finally {
      clearTimeout(timeout)
      current.controllers.delete(source)
    }
  }
}
