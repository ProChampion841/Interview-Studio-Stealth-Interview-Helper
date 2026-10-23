import { finishCaptionText, formatCaptionText } from '../../shared/captions'

const words = (text: string) => text.replace(/[.,!?]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Text-only local restoration. Recognition words and timings stay unchanged. */
export class CaptionPunctuation {
  private input = ''
  private output = ''
  constructor(private addPunct: (text: string) => string) {}
  restore(text: string, isFinal: boolean): string {
    if (!text.trim()) return ''
    if (text !== this.input) {
      let restored: string
      try { restored = this.addPunct(text.toLowerCase()).trim() }
      catch { restored = '' }
      // Punctuation must never add, remove, or substitute recognized words.
      this.output = (words(restored) === words(text) ? restored : formatCaptionText(text))
        .replace(/(^|[.!?]\s+)([\s"'“‘(]*)(\p{Ll})/gu, (_match, boundary: string, quote: string, letter: string) => boundary + quote + letter.toUpperCase())
      this.input = text
    }
    return isFinal ? finishCaptionText(this.output) : this.output.replace(/[.,!?]+(["'”’)\]]*)$/, '$1')
  }
}
