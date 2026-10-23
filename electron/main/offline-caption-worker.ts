import { OnlineRecognizer, OnlinePunctuation, LinearResampler, type Stream } from 'sherpa-onnx-node'
import type { OfflineModelPaths } from './offline-models'
import { captionWords, recognizedWords } from './offline-words'
import { prepareSpeechDetection, SpeechActivity } from './speech-activity'
import { CaptionPunctuation } from './offline-punctuation'
import { CAPTION_MAX_BYTES, CAPTION_SAMPLE_RATE, type CaptionSource, type LocalCaptionResult } from '../../shared/captions'

let recognizer: OnlineRecognizer
let punctuation: OnlinePunctuation
interface SourceState {
  stream: Stream
  resampler: LinearResampler
  base: number
  received: number
  expectedMs: number
  epoch: number
  phrase: number
  signature: string
  speech: SpeechActivity
  punctuation: CaptionPunctuation
}
const sources = new Map<CaptionSource, SourceState>()
let epoch = 0

function batch(raw: Int16Array): LocalCaptionResult {
  const samples = new LinearResampler(CAPTION_SAMPLE_RATE, 16000).flush(Float32Array.from(raw, sample => sample / 32768))
  const speech = new SpeechActivity()
  try { speech.accept(samples); if (!speech.hasSpeech) return { text: '' } }
  finally { speech.destroy() }
  const stream = recognizer.createStream(), padded = new Float32Array(samples.length + 8000)
  padded.set(samples); stream.acceptWaveform({ sampleRate: 16000, samples: padded }); stream.inputFinished()
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  return { text: new CaptionPunctuation(text => punctuation.addPunct(text)).restore(result.text.trim(), true) }
}

function currentLines(source: CaptionSource, state: SourceState, final: boolean) {
  const result = recognizer.getResult(state.stream)
  const words = recognizedWords(result, state.base + (result.start_time ?? 0))
  const last = state.base + state.received / 16000
  for (const word of words) word.end = Math.min(word.end, last)
  const lines = captionWords(words.filter(word => word.start < word.end && state.speech.allows(word.start - state.base, word.end - state.base)), `${source}-${state.epoch}-${state.phrase}`, final)
  return lines.map(line => ({ ...line, text: state.punctuation.restore(line.text, final) }))
}

function streaming(source: CaptionSource, raw: Int16Array, startMs: number): LocalCaptionResult {
  const output = new Map<string, ReturnType<typeof currentLines>>()
  const emit = (lines: ReturnType<typeof currentLines>) => { if (lines.length) output.set(lines[0].groupId, lines) }
  let state = sources.get(source)
  // Input timestamps are sample-count based, so even a short pause is a gap.
  if (state && Math.abs(startMs - state.expectedMs) > 1) {
    state.stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(8000) }); state.stream.inputFinished()
    while (recognizer.isReady(state.stream)) recognizer.decode(state.stream)
    emit(currentLines(source, state, true)); state.speech.destroy(); sources.delete(source); state = undefined
  }
  if (!state) {
    state = { stream: recognizer.createStream(), resampler: new LinearResampler(CAPTION_SAMPLE_RATE, 16000), base: startMs / 1000, received: 0, expectedMs: startMs, epoch: epoch++, phrase: 0, signature: '', speech: new SpeechActivity(), punctuation: new CaptionPunctuation(text => punctuation.addPunct(text)) }
    sources.set(source, state)
  }
  const samples = state.resampler.resample(Float32Array.from(raw, sample => sample / 32768))
  state.received += samples.length; state.expectedMs = startMs + raw.length / CAPTION_SAMPLE_RATE * 1000
  state.speech.accept(samples)
  state.stream.acceptWaveform({ sampleRate: 16000, samples })
  while (recognizer.isReady(state.stream)) {
    recognizer.decode(state.stream)
    if (recognizer.isEndpoint(state.stream)) {
      emit(currentLines(source, state, true)); recognizer.reset(state.stream); state.phrase++; state.signature = ''
    }
  }
  const lines = currentLines(source, state, false), signature = JSON.stringify(lines)
  if (signature !== state.signature) { emit(lines); state.signature = signature }
  return { absoluteTimes: true, segments: [...output.values()].flat() }
}

process.parentPort.on('message', async ({ data }: { data: { id: number; type: 'init' | 'transcribe'; paths?: OfflineModelPaths; source?: CaptionSource; pcm?: Int16Array; timing?: { startMs: number; streaming: boolean } } }) => {
  try {
    if (data.type === 'init') {
      const paths = data.paths!
      await prepareSpeechDetection()
      recognizer = new OnlineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner }, tokens: paths.tokens, numThreads: 2, provider: 'cpu', modelType: 'zipformer2' }, decodingMethod: 'modified_beam_search', maxActivePaths: 4, enableEndpoint: true, rule1MinTrailingSilence: 1.6, rule2MinTrailingSilence: 0.7, rule3MinUtteranceLength: 30 })
      punctuation = new OnlinePunctuation({ model: { cnnBilstm: paths.punctuation, bpeVocab: paths.punctuationVocab, numThreads: 1, provider: 'cpu' } })
      process.parentPort.postMessage({ id: data.id, result: {} })
    } else {
      if (!recognizer || (data.source !== 'microphone' && data.source !== 'computer') || !(data.pcm instanceof Int16Array) || data.pcm.byteLength > CAPTION_MAX_BYTES) throw new Error('Invalid local caption request.')
      process.parentPort.postMessage({ id: data.id, result: data.timing?.streaming ? streaming(data.source, data.pcm, data.timing.startMs) : batch(data.pcm) })
    }
  } catch {
    process.parentPort.postMessage({ id: data.id, error: 'Local transcription failed. Restart captions or download the models again.' })
  }
})
