import { CAPTION_SAMPLE_RATE, SpeechChunker, StreamingAudioBatcher, type CaptionProvider, type CaptionInput, type CaptionLine, type CaptionSource, type CaptionStatus } from '../../shared/captions'

export class CaptionClient {
  sessionId?: string
  private generation = 0
  private context?: AudioContext
  private streams: MediaStream[] = []
  private nodes: AudioNode[] = []
  private chunkers: Array<{ reset(): void }> = []
  private clockResets: Array<() => void> = []
  private unsubscribe?: () => void
  private paused = false
  private started = 0
  private microphone?: MediaStream
  private microphoneMuted = false
  private microphoneGeneration = 0
  private microphoneMinimumStart = 0
  private resetMicrophone?: () => void
  private sequences = { microphone: 0, computer: 0 }
  private pending = { microphone: 0, computer: 0 }
  private tails: Record<CaptionSource, Promise<void>> = { microphone: Promise.resolve(), computer: Promise.resolve() }
  constructor(private callbacks: { onStatus: (status: CaptionStatus) => void; onLines: (lines: CaptionLine[]) => void; onError: (message: string) => void; onLevel: (source: CaptionSource, level: number) => void }) {}

  async start(input: CaptionInput, provider: CaptionProvider = 'openai'): Promise<void> {
    const api = window.studio
    if (!api?.startCaptions) throw new Error('Captions require the updated desktop app.')
    const generation = ++this.generation
    this.callbacks.onStatus('starting')
    try {
      const context = new AudioContext({ sampleRate: CAPTION_SAMPLE_RATE })
      this.context = context
      await context.resume()
      const { sessionId } = await api.startCaptions(input)
      if (generation !== this.generation) { await api.stopCaptions(sessionId); return }
      this.sessionId = sessionId
      this.started = performance.now()
      this.microphoneMinimumStart = 0
      this.unsubscribe = api.onCaptionsStopped(id => { if (id === this.sessionId) this.stop(false) })
      // Video is required by getDisplayMedia; drop its track immediately. Only
      // computer audio enters the processing graph or leaves the renderer.
      const acquire = async (source: CaptionSource): Promise<[CaptionSource, MediaStream]> => {
        const stream = source === 'microphone'
          ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
          : await navigator.mediaDevices.getDisplayMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: { width: 1, height: 1, frameRate: 1 } })
        stream.getVideoTracks().forEach(track => track.stop())
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Caption start cancelled.', 'AbortError') }
        if (!stream.getAudioTracks().length) { stream.getTracks().forEach(track => track.stop()); throw new Error(`No ${source === 'computer' ? 'computer audio' : 'microphone audio'} was available. Check your audio device and try again.`) }
        this.streams.push(stream)
        if (source === 'microphone') { this.microphone = stream; stream.getAudioTracks().forEach(track => { track.enabled = !this.microphoneMuted && !this.paused }) }
        return [source, stream]
      }
      const selected: CaptionSource[] = input === 'both' ? ['computer', 'microphone'] : [input]
      const captures = await Promise.all(selected.map(acquire))
      if (generation !== this.generation) return
      await context.audioWorklet.addModule(new URL('./caption-worklet.js?no-inline', import.meta.url).href)
      if (generation !== this.generation) return
      for (const [source, stream] of captures) {
        const node = context.createMediaStreamSource(stream)
        const processor = new AudioWorkletNode(context, 'caption-audio')
        processor.onprocessorerror = () => { if (generation === this.generation) this.fail('Audio processing stopped. Start captions again.') }
        const mute = context.createGain()
        mute.gain.value = 0
        node.connect(processor).connect(mute).connect(context.destination)
        this.nodes.push(node, processor, mute)
        const streaming = provider === 'offline'
        const chunker = new SpeechChunker(), batcher = new StreamingAudioBatcher()
        this.chunkers.push(chunker)
        this.chunkers.push(batcher)
        let anchor: number | undefined, samplesSent = 0
        const resetInput = () => { anchor = undefined; samplesSent = 0; chunker.reset(); batcher.reset() }
        this.clockResets.push(resetInput)
        if (source === 'microphone') this.resetMicrophone = resetInput
        let lastMeter = 0
        processor.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
          if (generation !== this.generation || this.paused || (source === 'microphone' && this.microphoneMuted)) return
          const now = performance.now()
          if (streaming && anchor === undefined) anchor = Math.max(0, now - this.started - data.length / CAPTION_SAMPLE_RATE * 1000)
          if (now - lastMeter > 150) {
            const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / Math.max(1, data.length))
            this.callbacks.onLevel(source, Math.min(1, rms * 8)); lastMeter = now
          }
          const batch = streaming ? batcher.push(data) : null
          const chunk = streaming ? batch ? { pcm: batch, samples: batch.length } : null : chunker.push(data)
          if (!chunk) return
          if (this.pending[source] >= 3) { this.fail('Transcription is falling behind. Captions stopped to avoid building up an audio recording.'); return }
          this.pending[source]++
          const sequence = this.sequences[source]++
          const startMs = streaming ? anchor! + samplesSent / CAPTION_SAMPLE_RATE * 1000 : Math.max(0, now - this.started - chunk.samples / CAPTION_SAMPLE_RATE * 1000)
          samplesSent += chunk.samples
          const microphoneGeneration = this.microphoneGeneration
          this.tails[source] = this.tails[source].then(async () => {
            if (generation !== this.generation || (source === 'microphone' && microphoneGeneration !== this.microphoneGeneration)) return
            const lines = await api.transcribeCaption({ sessionId, source, sequence, startMs, ...(streaming ? { streaming: true } : {}), pcm: chunk.pcm.buffer as ArrayBuffer })
            if (generation === this.generation && (source !== 'microphone' || microphoneGeneration === this.microphoneGeneration)) this.callbacks.onLines(source === 'microphone' ? lines.filter(line => line.startMs >= this.microphoneMinimumStart - 100) : lines)
          }).catch(error => { if (generation === this.generation && (source !== 'microphone' || microphoneGeneration === this.microphoneGeneration)) this.fail(error instanceof Error ? error.message : 'Caption transcription failed.') }).finally(() => { this.pending[source]-- })
        }
        stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (generation === this.generation) this.fail('The audio source disconnected. Start captions to reconnect.') }, { once: true }))
      }
      this.callbacks.onStatus('listening')
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : 'Could not start captions.')
    }
  }
  setMicrophoneMuted(muted: boolean): void {
    if (this.microphoneMuted === muted) return
    this.microphoneMuted = muted; this.microphoneGeneration++
    this.microphoneMinimumStart = this.sessionId ? Math.max(0, performance.now() - this.started) : 0
    this.microphone?.getAudioTracks().forEach(track => { track.enabled = !muted && !this.paused })
    this.resetMicrophone?.()
    this.callbacks.onLevel('microphone', 0)
  }
  pause(): void {
    const generation = this.generation
    this.paused = true
    this.streams.forEach(stream => stream.getAudioTracks().forEach(track => { track.enabled = false }))
    this.chunkers.forEach(chunker => chunker.reset())
    this.clockResets.forEach(reset => reset())
    this.callbacks.onLevel('microphone', 0); this.callbacks.onLevel('computer', 0)
    void this.context?.suspend().catch(() => { if (generation === this.generation) this.fail('Could not pause the audio device.') })
    this.callbacks.onStatus('paused')
  }
  async resume(): Promise<void> {
    const generation = this.generation
    try {
      await this.context?.resume()
      if (generation !== this.generation || !this.sessionId) return
      this.streams.forEach(stream => stream.getAudioTracks().forEach(track => { track.enabled = stream !== this.microphone || !this.microphoneMuted }))
      this.paused = false
      this.callbacks.onStatus('listening')
    } catch { if (generation === this.generation) this.fail('Could not resume the audio device. Start captions again.') }
  }
  stop(notify = true): void {
    ++this.generation
    const sessionId = this.sessionId
    this.sessionId = undefined
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop())); this.streams = []
    this.microphone = undefined; this.resetMicrophone = undefined
    this.nodes.forEach(node => node.disconnect()); this.nodes = []
    this.chunkers.forEach(chunker => chunker.reset()); this.chunkers = []
    this.clockResets = []
    void this.context?.close().catch(() => undefined); this.context = undefined
    if (notify && sessionId) void window.studio?.stopCaptions(sessionId).catch(() => undefined)
    this.callbacks.onLevel('microphone', 0); this.callbacks.onLevel('computer', 0)
    this.callbacks.onStatus('idle')
  }
  private fail(message: string): void { this.stop(); this.callbacks.onError(message); this.callbacks.onStatus('error') }
}
