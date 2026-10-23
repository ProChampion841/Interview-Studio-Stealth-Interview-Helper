export interface RecognizedWord { text: string; start: number; end: number }

/** Rejoin subword pieces without changing the recognizer's text. */
export function recognizedWords(result: { tokens: string[]; timestamps: number[] }, offset = 0): RecognizedWord[] {
  const words: RecognizedWord[] = []
  let boundary = true
  result.tokens.forEach((token, index) => {
    const at = result.timestamps[index]
    if (!Number.isFinite(at)) return
    for (const part of token.replaceAll('▁', ' ').split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) { boundary = true; continue }
      if (boundary || !words.length) words.push({ text: part, start: offset + at, end: offset + at + 0.08 })
      else { words[words.length - 1].text += part; words[words.length - 1].end = offset + at + 0.08 }
      boundary = false
    }
  })
  return words
}

export function captionWords(words: RecognizedWord[], groupId: string, isFinal: boolean) {
  return words.length ? [{ id: `${groupId}:0`, groupId, start: words[0].start, end: words[words.length - 1].end, text: words.map(word => word.text).join(' '), isFinal }] : []
}
