import type { CaptionTranslation } from './caption-translation'
export type CaptionSource = 'microphone' | 'computer'
export const CAPTION_SOURCE_LABELS: Record<CaptionSource, string> = { microphone: 'YOU', computer: 'Professional' }
export type CaptionInput = CaptionSource | 'both'
export type CaptionProvider = 'openai' | 'openrouter' | 'offline'
export const CAPTION_PROVIDER_NAMES: Record<CaptionProvider, string> = { openai: 'OpenAI', openrouter: 'OpenRouter', offline: 'Offline (local)' }
export function normalizeCaptionProvider(value: unknown): CaptionProvider {
  if (value === 'openai' || value === 'openrouter' || value === 'offline') return value
  throw new Error('Choose OpenAI, OpenRouter, or Offline for captions.')
}
export interface OfflineModelStatus {
  state: 'missing' | 'checking' | 'downloading' | 'ready' | 'error'
  downloadedBytes: number
  totalBytes: number
  message: string
}
export interface LocalCaptionResult {
  text?: string
  segments?: Array<{ id?: string; groupId?: string; start: number; end: number; text: string; isFinal?: boolean }>
  absoluteTimes?: boolean
}
export interface LocalCaptionEngine {
  prepare?(): Promise<void>
  transcribe(source: CaptionSource, pcm: Int16Array, signal: AbortSignal, timing?: { startMs: number; streaming: boolean }): Promise<LocalCaptionResult>
  stop(): void
}
export type CaptionStatus = 'idle' | 'starting' | 'listening' | 'paused' | 'error'
export interface CaptionLine {
  translation?: CaptionTranslation
  isFinal?: boolean
  groupId?: string
  id: string
  source: CaptionSource
  text: string
  startMs: number
  endMs: number
}

/** A restarted recognizer reuses phrase IDs; persisted conversations must not. */
export function namespaceCaptionLines(lines: CaptionLine[], captureId: string, offset: number): CaptionLine[] {
  return lines.map(line => ({ ...line, id: `${captureId}:${line.id}`, ...(line.groupId ? { groupId: `${captureId}:${line.groupId}` } : {}), text: formatCaptionText(line.text), startMs: line.startMs + offset, endMs: line.endMs + offset }))
}
export interface CaptionChunk {
  streaming?: boolean
  sessionId: string
  source: CaptionSource
  sequence: number
  startMs: number
  pcm: ArrayBuffer
}
export const CAPTION_SAMPLE_RATE = 24_000
export const CAPTION_MAX_SECONDS = 12
export const CAPTION_MAX_BYTES = CAPTION_SAMPLE_RATE * CAPTION_MAX_SECONDS * 2

const CAPTION_ACRONYMS: Record<string, string> = {
  ai: 'AI', api: 'API', apis: 'APIs', sdk: 'SDK', sql: 'SQL', cpu: 'CPU', gpu: 'GPU',
  ui: 'UI', ux: 'UX', url: 'URL', urls: 'URLs', http: 'HTTP', https: 'HTTPS',
  html: 'HTML', css: 'CSS', json: 'JSON', xml: 'XML', pdf: 'PDF', id: 'ID', ids: 'IDs',
  aws: 'AWS', gcp: 'GCP', dns: 'DNS', tcp: 'TCP', udp: 'UDP', usb: 'USB', llm: 'LLM', llms: 'LLMs',
  gpt: 'GPT', nasa: 'NASA', usa: 'USA', uk: 'UK', ceo: 'CEO', cto: 'CTO', hr: 'HR'
}

/** Add readable casing to uncased ASR output; leave already-cased text intact. */
export function formatCaptionText(text: string): string {
  if (text !== text.toUpperCase() || !/\p{Lu}/u.test(text)) return text
  return text.toLowerCase()
    .replace(/\b[a-z]+\b/g, word => word === 'i' ? 'I' : CAPTION_ACRONYMS[word] ?? word)
    .replace(/(^|[.!?]\s+|\n\s*)([\s"'“‘(]*)(\p{Ll})/gu, (_match, boundary: string, quote: string, letter: string) => boundary + quote + letter.toUpperCase())
}

/** Close an offline utterance when speech ends or the user stops capture. */
export function finishCaptionText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const [, body, closing] = trimmed.match(/^(.*?)(["'”’)\]]*)$/s)!
  if (/[.!?:;]$/.test(body)) return trimmed
  const sentence = body.split(/[.!?]\s+/).at(-1)!.replace(/,+$/, '')
  // Only clear question openings; "what I did" and "how we work" are not
  // enough evidence to turn a statement into a question.
  const question = /^(?:(?:who|what|which|when|where|why|how)\s+(?:(?:much|many|long|often|far|old)\s+)?(?:am|is|are|was|were|do|does|did|can|could|will|would|should|have|has|had)\b|(?:am|is|are|was|were|do|does|did|can|could|will|would|should|have|has|had)\s+(?:i|you|he|she|it|we|they|there)\b)/i.test(sentence)
  return body.replace(/,+$/, '') + (question ? '?' : '.') + closing
}

/** Replace a developing caption in place; cloud captions still append by unique ID. */
export function mergeCaptionLines(current: CaptionLine[], incoming: CaptionLine[]): CaptionLine[] {
  if (!incoming.length) return current
  const groups = new Set(incoming.flatMap(line => line.groupId ? [line.groupId] : []))
  const previous = new Map(current.map(line => [line.id, line]))
  const updates = new Map(incoming.map(line => {
    const prior = previous.get(line.id)
    return [line.id, !line.translation && prior?.translation && prior.source === line.source ? { ...line, translation: prior.translation } : line]
  }))
  const merged = current.filter(line => !line.groupId || !groups.has(line.groupId)).map(line => { const next = updates.get(line.id); updates.delete(line.id); return next ?? line })
  return [...merged, ...updates.values()].sort((a, b) => a.startMs - b.startMs)
}

/** Present consecutive segments as one turn, keeping raw segments for revisions. */
export function splitCaptionTurns(lines: readonly CaptionLine[]): CaptionLine[][] {
  const turns: CaptionLine[][] = []
  for (const line of lines) {
    if (!line.text.trim()) continue
    const previous = turns.at(-1)
    if (previous?.[0].source === line.source) previous.push(line)
    else turns.push([line])
  }
  return turns
}

export function groupCaptionTurns(lines: readonly CaptionLine[]): CaptionLine[] {
  const turns: CaptionLine[] = []
  for (const line of lines) {
    const text = line.text.trim()
    if (!text) continue
    const previous = turns[turns.length - 1]
    if (previous?.source === line.source) {
      previous.text += ` ${text}`
      previous.startMs = Math.min(previous.startMs, line.startMs)
      previous.endMs = Math.max(previous.endMs, line.endMs)
      previous.isFinal = previous.isFinal !== false && line.isFinal !== false
    } else {
      turns.push({ id: line.id, source: line.source, text, startMs: line.startMs, endMs: line.endMs, isFinal: line.isFinal })
    }
  }
  return turns
}

/** Continuous, sample-exact batches for the local streaming recognizer. */
export class StreamingAudioBatcher {
  private samples = new Int16Array(12_288) // 512 ms at 24 kHz
  private count = 0
  reset(): void { this.count = 0 }
  push(frame: Float32Array): Int16Array | null {
    // The worklet emits 1024 samples, an exact divisor of the batch size.
    if (this.count + frame.length > this.samples.length) throw new Error('Unexpected audio worklet frame size.')
    for (const value of frame) this.samples[this.count++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
    if (this.count < this.samples.length) return null
    const complete = this.samples
    this.samples = new Int16Array(12_288); this.count = 0
    return complete
  }
}

/** Mono 16-bit PCM WAV; audio is never written to a file by the app. */
export function pcmToWav(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, CAPTION_SAMPLE_RATE, true); view.setUint32(28, CAPTION_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true)
  return bytes
}

/** Segment speech at pauses; do not upload silence or retain an unbounded recording. */
export class SpeechChunker {
  private preRoll: Float32Array[] = []
  private frames: Float32Array[] = []
  private count = 0
  private silence = 0
  private voiced = 0
  reset(): void { this.preRoll = []; this.frames = []; this.count = 0; this.silence = 0; this.voiced = 0 }
  push(frame: Float32Array): { pcm: Int16Array; samples: number } | null {
    const rms = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / Math.max(1, frame.length))
    const speech = rms > 0.008
    if (!this.frames.length) {
      this.preRoll.push(frame.slice())
      while (this.preRoll.length > 6) this.preRoll.shift()
      if (!speech) return null
      this.frames = this.preRoll
      this.preRoll = []
      this.count = this.frames.reduce((sum, f) => sum + f.length, 0)
      this.voiced = frame.length
    } else {
      this.frames.push(frame.slice()); this.count += frame.length
      if (speech) this.voiced += frame.length
    }
    this.silence = speech ? 0 : this.silence + frame.length
    if (this.count < CAPTION_SAMPLE_RATE * CAPTION_MAX_SECONDS && this.silence < CAPTION_SAMPLE_RATE * 0.65) return null
    if (this.voiced < CAPTION_SAMPLE_RATE * 0.3) { this.reset(); return null }
    const samples = Math.min(this.count, CAPTION_SAMPLE_RATE * CAPTION_MAX_SECONDS)
    const pcm = new Int16Array(samples)
    let at = 0
    for (const values of this.frames) {
      for (const value of values) {
        if (at === samples) break
        pcm[at++] = Math.round(Math.max(-1, Math.min(1, value)) * 32767)
      }
    }
    this.reset()
    return { pcm, samples }
  }
}
