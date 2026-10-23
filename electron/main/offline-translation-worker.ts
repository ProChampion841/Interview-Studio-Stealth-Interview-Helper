import { Ct2Translator } from 'ctranslate2'

let translator: Ct2Translator
function chunks(text: string): string[] {
  const result: string[] = []
  for (const sentence of new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)) {
    let part = ''
    for (const word of sentence.segment.split(/\s+/)) {
      if (part.length + word.length > 450 && part) { result.push(part); part = '' }
      // A malformed extremely long token must not consume the entire decoder.
      if (word.length > 450) throw new Error('Caption contains an unusually long word.')
      part += (part ? ' ' : '') + word
    }
    if (part.trim()) result.push(part.trim())
  }
  return result
}
process.parentPort.on('message', async ({ data }: { data: { id: number; type: 'init' | 'translate'; path?: string; text?: string } }) => {
  try {
    if (data.type === 'init') {
      translator = new Ct2Translator({ modelPath: data.path!, device: 'cpu', threads: 2 })
      process.parentPort.postMessage({ id: data.id, text: '' })
    } else {
      const result = await translator.translateBatch(chunks(data.text!), { beamSize: 2, maxBatchSize: 1, returnScores: false })
      process.parentPort.postMessage({ id: data.id, text: result.map(item => item.text.trim()).join(' ') })
    }
  } catch {
    process.parentPort.postMessage({ id: data.id, error: data.type === 'init' ? 'The offline translation pack could not load. Remove it and download it again.' : 'Offline translation failed. Try a shorter caption or restart translation.' })
  }
})
