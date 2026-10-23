// Real native inference check. Requires downloaded models and an explicit WAV
// fixture; never accesses recording devices or downloads anything.
const electron = require('electron')
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
const { app, utilityProcess } = electron
const { resolve, join } = require('node:path')
const { existsSync, mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const sherpa = require('sherpa-onnx-node')
const args = process.argv.slice(2)
const models = args[args.indexOf('--models') + 1]
const audio = args[args.indexOf('--audio') + 1]
if (!args.includes('--models') || !args.includes('--audio') || !models || !audio) {
  console.error('Usage: npm run test:offline -- --models <model-directory> --audio <spoken-WAV-fixture>')
  app.exit(1)
}
app.setPath('userData', mkdtempSync(join(tmpdir(), 'interview-offline-inference-')))
const paths = Object.fromEntries(['encoder', 'decoder', 'joiner', 'tokens'].map(name => [name, resolve(models, name === 'tokens' ? 'tokens.txt' : `${name}.onnx`)]))
paths.punctuation = resolve(models, 'punctuation.onnx')
paths.punctuationVocab = resolve(models, 'punctuation.vocab')
let child, next = 1
const pending = new Map()
const request = data => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); child.postMessage({ ...data, id }) })
const deadline = setTimeout(() => { console.error('Offline inference test timed out.'); child?.kill(); app.exit(1) }, 120_000)
app.whenReady().then(async () => {
  try {
    for (const path of [...Object.values(paths), resolve(audio), resolve(__dirname, '../out/main/offline-caption-worker.js')]) assert.ok(existsSync(path), `Missing fixture or compiled worker: ${path}`)
    child = utilityProcess.fork(resolve(__dirname, '../out/main/offline-caption-worker.js'), [], { stdio: 'pipe' })
    child.stdout?.resume(); child.stderr?.resume()
    child.on('message', message => {
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.result)
    })
    child.on('exit', () => { for (const item of pending.values()) item.reject(new Error('Local engine exited.')); pending.clear() })
    const started = Date.now()
    await request({ type: 'init', paths })
    const punctuator = new sherpa.OnlinePunctuation({ model: { cnnBilstm: paths.punctuation, bpeVocab: paths.punctuationVocab, numThreads: 1, provider: 'cpu' } })
    assert.equal(punctuator.addPunct('how are you i am fine thank you'), 'How are you? I am fine. Thank you.', 'Real local punctuation must restore sentence boundaries and questions.')
    const wave = sherpa.readWave(resolve(audio), false)
    const samples = new sherpa.LinearResampler(wave.sampleRate, 24000).flush(wave.samples).slice(0, 24000 * 12)
    assert.ok(samples.length >= 24000 * 3, 'Use a spoken fixture at least three seconds long.')
    const pcm = Int16Array.from(samples, value => Math.max(-32768, Math.min(32767, Math.round(value * 32768))))
    const mic = await request({ type: 'transcribe', source: 'microphone', pcm })
    assert.ok(mic.text?.trim(), 'Expected microphone transcription text.')
    assert.match(mic.text, /[.!?]$/, 'Completed captions must end with sentence punctuation.')
    const first = await request({ type: 'transcribe', source: 'computer', pcm })
    assert.equal(first.text, mic.text, 'Both sources must use the same full-quality recognition.')
    const silent = await request({ type: 'transcribe', source: 'microphone', pcm: new Int16Array(24000 * 12) })
    assert.equal(silent.text, '', 'Silent microphone audio must not become caption text.')
    const silentComputer = await request({ type: 'transcribe', source: 'computer', pcm: new Int16Array(24000 * 12) })
    assert.equal(silentComputer.text, '', 'Silent computer audio must not become caption text.')
    const quiet = await request({ type: 'transcribe', source: 'microphone', pcm: Int16Array.from(pcm, value => Math.round(value * 0.15)) })
    assert.ok(quiet.text?.trim(), 'Quiet real speech must still be recognized.')
    const captions = { microphone: new Map(), computer: new Map() }
    let early = false, final = false
    const stream = async (offset, sources, scale = 1) => {
      const ids = new Set()
      for (let from = 0; from < pcm.length + 48000; from += 12288) {
        const batch = new Int16Array(12288)
        batch.set(pcm.subarray(from, Math.min(pcm.length, from + batch.length)))
        if (scale !== 1) for (let i = 0; i < batch.length; i++) batch[i] = Math.round(batch[i] * scale)
        for (const source of sources) {
          const result = await request({ type: 'transcribe', source, pcm: batch, timing: { startMs: offset + from / 24, streaming: true } })
          assert.equal(result.absoluteTimes, true, 'Streaming results use the session clock.')
          const groups = new Set(result.segments.map(segment => segment.groupId))
          for (const group of groups) captions[source].set(group, result.segments.filter(segment => segment.groupId === group))
          for (const segment of result.segments) {
            ids.add(segment.groupId)
            assert.ok(segment.start >= offset / 1000 && segment.end <= (offset + (from + batch.length) / 24) / 1000 + 0.1, 'Caption timestamps must stay inside captured audio.')
            assert.ok(!('speaker' in segment), 'Recognition must not perform speaker identification.')
            if (from + batch.length < pcm.length && segment.text && !segment.isFinal) early = true
            if (segment.isFinal) final = true
            if (segment.isFinal) assert.match(segment.text, /[.!?]$/, 'Final streaming captions must have sentence-ending punctuation.')
          }
        }
      }
      return ids
    }
    const initialIds = await stream(1000, ['microphone', 'computer'])
    assert.ok(early, 'Expected interim text before the complete recording is supplied.')
    assert.ok(final, 'Silence should finalize the developing phrase.')
    for (const source of ['microphone', 'computer']) assert.ok([...captions[source].values()].flat().some(segment => segment.text.trim()), `Expected persistent ${source} recognition.`)
    const text = source => [...captions[source].values()].flat().map(segment => segment.text).join(' ')
    assert.equal(text('microphone'), text('computer'), 'Speech checks must preserve every word of the clear speech fixture.')
    for (const source of ['microphone', 'computer']) {
      const quietIds = await stream(100000, [source], 0.15)
      const quietWords = [...quietIds].flatMap(id => captions[source].get(id) || []).map(segment => segment.text).join(' ').split(/\s+/).filter(Boolean)
      const clearWords = [...initialIds].flatMap(id => captions[source].get(id) || []).map(segment => segment.text).join(' ').split(/\s+/).filter(Boolean)
      assert.ok(quietWords.length >= clearWords.length * 0.8, `Quiet live ${source} speech must retain at least 80% of the clear fixture words.`)
    }
    const resumedIds = await stream(60000, ['computer'])
    assert.ok([...resumedIds].every(id => !initialIds.has(id)), 'Resuming after a timestamp gap must use fresh phrase IDs.')
    const endMs = 60000 + Math.ceil((pcm.length + 48000) / 12288) * 12288 / 24
    const shortPauseIds = await stream(endMs + 50, ['computer'])
    assert.ok([...shortPauseIds].every(id => !resumedIds.has(id)), 'Even a short pause must reset the recognition clock.')
    for (let n = 0; n < 120; n++) {
      for (const source of ['microphone', 'computer']) {
        const result = await request({ type: 'transcribe', source, pcm: new Int16Array(12288), timing: { startMs: 2000000 + n * 512, streaming: true } })
        assert.equal(result.segments.length, 0, `Prolonged ${source} silence must not produce live captions.`)
      }
    }
    let seed = 1
    for (let n = 0; n < 24; n++) {
      const noise = Int16Array.from({ length: 12288 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.round((seed / 2 ** 32 * 2 - 1) * 26) })
      for (const source of ['microphone', 'computer']) {
        const result = await request({ type: 'transcribe', source, pcm: noise, timing: { startMs: 3000000 + n * 512, streaming: true } })
        assert.equal(result.segments.length, 0, `Low ${source} hiss must not produce captions.`)
      }
    }
    console.log(JSON.stringify({ success: true, elapsedMs: Date.now() - started, checks: ['native recognition and punctuation models load in Electron', 'same-quality microphone and computer recognition', 'local sentence boundaries and questions', 'final caption punctuation', 'silent and quiet audio from both sources', 'one minute of silence per source', 'low hiss from both sources', 'no speaker identification', 'interim text before recording ends', 'separate persistent source streams', 'endpoint finalization', 'pause/resume clock continuity'] }))
    clearTimeout(deadline); child.kill(); app.quit()
  } catch (error) { clearTimeout(deadline); console.error(error); child?.kill(); app.exit(1) }
})
