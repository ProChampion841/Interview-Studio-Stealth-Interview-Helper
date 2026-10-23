import createVAD, { VADMode } from '@ozymandiasthegreat/vad/lib/embedded.js'

interface Detector { processFrame(frame: Int16Array): number; destroy(): void }
let DetectorClass: (new (mode: number, rate: number) => Detector) | undefined
export async function prepareSpeechDetection(): Promise<void> { DetectorClass ??= await createVAD() }

/** Session-only speech timing; no voice identities or recordings. */
export class SpeechActivity {
  private detector: Detector
  private frame = new Int16Array(320) // 20 ms at 16 kHz, including across batch boundaries.
  private used = 0
  private processed = 0
  private ranges: Array<{ start: number; end: number }> = []
  private candidate?: { start: number; end: number; frames: number; range?: { start: number; end: number } }
  constructor(detector?: Detector) {
    if (!detector && !DetectorClass) throw new Error('Speech detection is not ready.')
    this.detector = detector ?? new DetectorClass!(VADMode.AGGRESSIVE, 16000)
  }
  accept(samples: Float32Array): void {
    for (const sample of samples) {
      this.frame[this.used++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)))
      if (this.used !== this.frame.length) continue
      const start = this.processed / 16000, end = start + 0.02
      const detected = this.detector.processFrame(this.frame)
      if (detected < 0) throw new Error('Caption speech detection failed.')
      const rms = Math.sqrt(this.frame.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / this.frame.length)
      if (detected === 1 && rms >= 0.001) {
        if (!this.candidate || start - this.candidate.end > 0.12) this.candidate = { start, end, frames: 0 }
        this.candidate.end = end; this.candidate.frames++
        // Require sustained speech; a single click or VAD startup transient is insufficient.
        if (this.candidate.frames >= 5) {
          if (!this.candidate.range) { this.candidate.range = { start: this.candidate.start, end }; this.ranges.push(this.candidate.range) }
          else this.candidate.range.end = end
        }
      }
      this.processed += this.frame.length; this.used = 0
      this.ranges = this.ranges.filter(range => range.end > end - 40)
    }
  }
  get hasSpeech(): boolean { return this.ranges.length > 0 }
  allows(start: number, end: number): boolean {
    // Keep soft consonants and word boundaries next to confirmed voiced speech.
    return this.ranges.some(range => end >= range.start - 0.2 && start <= range.end + 0.2)
  }
  destroy(): void { this.detector.destroy() }
}
