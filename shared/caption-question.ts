import { CAPTION_SOURCE_LABELS, splitCaptionTurns, type CaptionLine, type CaptionSource } from './captions'
import { LIMITS } from './contracts'

export interface CaptionContextItem { id: string; source: CaptionSource; text: string }
export interface CaptionQuestion { question: string; context: CaptionContextItem[]; captionIds?: string[] }
export const CAPTION_CONTEXT_CHARS = 6000

/** Snapshot and bound only the conversation the user chose to use. */
export function mergeCaptionContext(...groups: readonly CaptionContextItem[][]): CaptionContextItem[] {
  const unique = new Map<string, CaptionContextItem>()
  for (const item of groups.flat()) {
    const text = item.text.replace(/\u0000/g, '').trim()
    if (!text) continue
    unique.delete(item.id); unique.set(item.id, { ...item, text })
  }
  const result: CaptionContextItem[] = []
  let remaining = CAPTION_CONTEXT_CHARS
  for (const item of [...unique.values()].slice(-6).reverse()) {
    const available = remaining - CAPTION_SOURCE_LABELS[item.source].length - 3
    if (available <= 3) break
    const text = item.text.length > available ? '...' + item.text.slice(-(available - 3)) : item.text
    result.unshift({ ...item, text })
    remaining -= text.length + CAPTION_SOURCE_LABELS[item.source].length + 3
  }
  return result
}

export function captionContextText(items: readonly CaptionContextItem[]): string {
  return items.map(item => `${CAPTION_SOURCE_LABELS[item.source]}: ${item.text}`).join('\n')
}

export function captionExcerpt(lines: readonly CaptionLine[], ids: readonly string[], selectedText?: string): CaptionContextItem {
  const selected = lines.filter(line => ids.includes(line.id) && line.text.trim())
  if (!selected.length || selected.some(line => line.source !== selected[0].source)) throw new Error('Select text from one caption turn.')
  const text = (selectedText ?? selected.map(line => line.text.trim()).join(' ')).replace(/\u0000/g, '').trim()
  if (!text) throw new Error('Select a caption with text first.')
  return { id: selected[0].id, source: selected[0].source, text }
}

export function captionQuestion(lines: readonly CaptionLine[], ids: readonly string[], selectedText?: string): CaptionQuestion {
  const excerpt = captionExcerpt(lines, ids, selectedText)
  if (excerpt.text.length > LIMITS.questionChars) throw new Error('This caption is too long. Highlight the question you want to answer, then try again.')
  const anchor = lines.findIndex(line => line.id === excerpt.id)
  const earliest = lines[anchor].startMs - 90_000
  const nearby = splitCaptionTurns(lines.slice(0, anchor).filter(line => line.endMs >= earliest)).slice(-3)
    .map(parts => ({ id: parts[0].id, source: parts[0].source, text: parts.map(line => line.text.trim()).join(' ') }))
  return { question: excerpt.text, context: mergeCaptionContext(nearby), captionIds: lines.filter(line => ids.includes(line.id)).map(line => line.id) }
}

/** Do not submit an older question while the latest Professional passage develops. */
export function latestCaptionQuestion(lines: readonly CaptionLine[]): CaptionQuestion | undefined {
  const latest = [...lines].reverse().find(line => line.source === 'computer' && line.text.trim())
  if (!latest || latest.isFinal === false) return undefined
  return captionQuestion(lines, [latest.id])
}
