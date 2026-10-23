import { describe, expect, it } from 'vitest'
import { prepareSpeechDetection, SpeechActivity } from '../electron/main/speech-activity'

const frame = (level = 0.02) => new Float32Array(320).fill(level)
describe('caption speech evidence', () => {
  it('rejects words in later silence after a real speech interval', () => {
    let voice = 1
    const activity = new SpeechActivity({ processFrame: () => voice, destroy: () => {} })
    try {
      activity.accept(new Float32Array(16000).fill(0.02))
      voice = 0; activity.accept(new Float32Array(16000 * 3))
      expect(activity.allows(0.3, 0.5)).toBe(true)
      expect(activity.allows(2, 2.1)).toBe(false)
      expect(activity.allows(3, 3.1)).toBe(false)
    } finally { activity.destroy() }
  })
  it('requires sustained speech and preserves the beginning of a confirmed utterance', () => {
    const activity = new SpeechActivity({ processFrame: () => 1, destroy: () => {} })
    for (let i = 0; i < 4; i++) activity.accept(frame())
    expect(activity.hasSpeech).toBe(false)
    activity.accept(frame())
    expect(activity.hasSpeech).toBe(true)
    expect(activity.allows(0, 0.04)).toBe(true)
    expect(activity.allows(3, 3.2)).toBe(false)
  })
  it('does not interpret isolated clicks or inaudible input as speech', () => {
    let voice = 1
    const activity = new SpeechActivity({ processFrame: () => voice, destroy: () => {} })
    activity.accept(frame()); voice = 0
    for (let i = 0; i < 15; i++) activity.accept(frame(0))
    voice = 1; activity.accept(frame())
    expect(activity.hasSpeech).toBe(false)
    for (let i = 0; i < 20; i++) activity.accept(frame(0.0001))
    expect(activity.hasSpeech).toBe(false)
  })
  it('processes the same speech timing across arbitrary input batch boundaries', () => {
    const detector = () => ({ processFrame: () => 1, destroy: () => {} })
    const first = new SpeechActivity(detector()), second = new SpeechActivity(detector())
    const speech = new Float32Array(3200).fill(0.02)
    first.accept(speech)
    for (let i = 0; i < speech.length; i += 127) second.accept(speech.slice(i, i + 127))
    for (const time of [0, 0.1, 0.3, 1]) expect(second.allows(time, time + 0.02)).toBe(first.allows(time, time + 0.02))
  })
  it('uses the real bundled detector locally and rejects prolonged silence and low hiss', async () => {
    await prepareSpeechDetection()
    const activity = new SpeechActivity()
    try {
      activity.accept(new Float32Array(16000 * 10))
      let seed = 1
      const noise = Float32Array.from({ length: 16000 * 10 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed / 2 ** 32 * 2 - 1) * 0.0008 })
      activity.accept(noise)
      expect(activity.hasSpeech).toBe(false)
      expect(activity.allows(1, 19)).toBe(false)
    } finally { activity.destroy() }
  })
})
