import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptionClient } from '../../src/lib/caption-client'
import type { CaptionChunk, CaptionLine } from '../../shared/captions'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function fixture() {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const track = () => ({ enabled: true, stop: vi.fn(), addEventListener: vi.fn() })
  const microphone = track(), computer = track()
  const stream = (audio: typeof microphone) => ({ getAudioTracks: () => [audio], getVideoTracks: () => [], getTracks: () => [audio] })
  const nodes: Array<{ port: { onmessage?: (event: { data: Float32Array }) => void } }> = []
  const connect = (destination: unknown) => destination
  class Worklet {
    port: { onmessage?: (event: { data: Float32Array }) => void } = {}
    connect = connect; disconnect = vi.fn()
    constructor() { nodes.push(this) }
  }
  class Context {
    destination = {}; audioWorklet = { addModule: async () => {} }
    resume = async () => {}; suspend = async () => {}; close = async () => {}
    createMediaStreamSource = () => ({ connect, disconnect: vi.fn() })
    createGain = () => ({ gain: { value: 0 }, connect, disconnect: vi.fn() })
  }
  const transcribe = vi.fn<(input: CaptionChunk) => Promise<CaptionLine[]>>(async () => [])
  const api = { startCaptions: async () => ({ sessionId: 'session' }), stopCaptions: async () => {}, onCaptionsStopped: () => () => {}, transcribeCaption: transcribe }
  vi.stubGlobal('window', { studio: api })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => stream(microphone), getDisplayMedia: async () => stream(computer) } })
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet)
  const callbacks = { onStatus: vi.fn(), onLines: vi.fn<(lines: CaptionLine[]) => void>(), onError: vi.fn(), onLevel: vi.fn() }
  const client = new CaptionClient(callbacks)
  const send = (source: 'computer' | 'microphone') => { const node = nodes[source === 'computer' ? 0 : 1]; for (let i = 0; i < 12; i++) node.port.onmessage?.({ data: new Float32Array(1024).fill(0.1) }) }
  return { client, microphone, computer, transcribe, callbacks, send, time: (value: number) => { now = value } }
}

describe('microphone mute during captions', () => {
  it('discards late microphone results, keeps computer capture running, and preserves mute through pause/resume', async () => {
    const f = fixture()
    let release!: (value: CaptionLine[]) => void
    f.transcribe.mockImplementation(async input => input.source === 'microphone' ? await new Promise(resolve => { release = resolve }) : [{ id: 'other', source: 'computer', text: 'Other speech.', startMs: 0, endMs: 500 }])
    await f.client.start('both', 'offline')
    try {
      f.time(600); f.send('microphone'); f.send('computer')
      await vi.waitFor(() => expect(f.transcribe).toHaveBeenCalledTimes(2))
      f.time(610); f.client.setMicrophoneMuted(true)
      release([{ id: 'late', source: 'microphone', text: 'Unwanted caption.', startMs: 0, endMs: 500 }])
      await vi.waitFor(() => expect(f.callbacks.onLines).toHaveBeenCalledOnce())
      expect(f.callbacks.onLines.mock.calls[0][0][0].source).toBe('computer')
      expect(f.microphone.enabled).toBe(false); expect(f.computer.enabled).toBe(true)
      f.send('microphone'); f.send('computer')
      await vi.waitFor(() => expect(f.transcribe).toHaveBeenCalledTimes(3))
      expect(f.transcribe.mock.calls.filter(([request]) => request.source === 'microphone')).toHaveLength(1)
      f.client.pause(); await f.client.resume()
      expect(f.microphone.enabled).toBe(false); expect(f.computer.enabled).toBe(true)
      f.time(2000); f.client.setMicrophoneMuted(false)
      expect(f.microphone.enabled).toBe(true)
      f.transcribe.mockImplementation(async input => [{ id: 'fresh', source: input.source, text: 'My real speech.', startMs: input.startMs, endMs: input.startMs + 400 }])
      f.time(2500); f.send('microphone')
      await vi.waitFor(() => expect(f.callbacks.onLines.mock.calls.some(([lines]) => lines.some(line => line.text === 'My real speech.'))).toBe(true))
      expect(f.callbacks.onError).not.toHaveBeenCalled()
    } finally { f.client.stop() }
  })
  it('respects microphone mute selected before capture starts', async () => {
    const f = fixture(); f.client.setMicrophoneMuted(true)
    await f.client.start('both', 'offline')
    try {
      expect(f.microphone.enabled).toBe(false); expect(f.computer.enabled).toBe(true)
      f.time(600); f.send('microphone'); f.send('computer')
      await vi.waitFor(() => expect(f.transcribe).toHaveBeenCalledOnce())
      expect(f.transcribe.mock.calls[0][0].source).toBe('computer')
    } finally { f.client.stop() }
  })
})
