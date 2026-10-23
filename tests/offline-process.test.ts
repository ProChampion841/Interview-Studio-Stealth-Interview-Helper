import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork } }))
import { OfflineCaptions } from '../electron/main/offline-captions'

class Worker extends EventEmitter {
  stdout = { resume: vi.fn() }
  stderr = new EventEmitter()
  postMessage = vi.fn()
  kill = vi.fn()
  reply(result: object = {}) { this.emit('message', { id: this.postMessage.mock.calls.at(-1)![0].id, result }) }
}
const paths = { encoder: 'encoder', decoder: 'decoder', joiner: 'joiner', tokens: 'tokens', punctuation: 'punctuation', punctuationVocab: 'vocab' }
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe('offline caption process lifecycle', () => {
  let workers: Worker[]
  beforeEach(() => {
    workers = []
    fork.mockReset().mockImplementation(() => { const worker = new Worker(); workers.push(worker); return worker })
  })
  it('recovers from one startup exit before sending any audio', async () => {
    const engine = new OfflineCaptions(paths), ready = engine.prepare()
    workers[0].emit('exit', 1)
    await tick()
    expect(workers).toHaveLength(2)
    expect(workers[1].postMessage.mock.calls[0][0]).toMatchObject({ type: 'init', paths })
    workers[1].reply()
    await ready
    const result = engine.transcribe('microphone', new Int16Array(100), new AbortController().signal)
    await tick(); workers[1].reply({ text: 'hello' })
    await expect(result).resolves.toEqual({ text: 'hello' })
    engine.stop()
  })
  it('bounds retries and reports an exit code instead of repeatedly asking to start again', async () => {
    const engine = new OfflineCaptions(paths), ready = engine.prepare()
    const rejected = expect(ready).rejects.toThrow(/could not start \(exit code 7\).*Fully exit/)
    workers[0].emit('exit', 1); await tick(); workers[1].emit('exit', 7)
    await rejected
    expect(workers).toHaveLength(2)
  })
  it('reports a safe startup category without exposing raw stderr', async () => {
    const engine = new OfflineCaptions(paths), ready = engine.prepare()
    const rejected = expect(ready).rejects.toThrow('A caption engine file is missing. Fully exit and reopen Interview Studio.')
    workers[0].emit('exit', 1); await tick()
    workers[1].stderr.emit('data', Buffer.from("Error: Cannot find module 'private/path/secret'"))
    workers[1].emit('exit', 1)
    await rejected
  })
  it('stops during startup without launching a replacement process', async () => {
    const engine = new OfflineCaptions(paths), ready = engine.prepare()
    const rejected = expect(ready).rejects.toMatchObject({ name: 'AbortError' })
    engine.stop(); workers[0].emit('exit', 0)
    await rejected
    expect(workers).toHaveLength(1)
    expect(workers[0].kill).toHaveBeenCalledOnce()
  })
  it('never silently restarts a recognizer after audio was sent', async () => {
    const engine = new OfflineCaptions(paths), ready = engine.prepare()
    workers[0].reply(); await ready
    const result = engine.transcribe('computer', new Int16Array(100), new AbortController().signal)
    const rejected = expect(result).rejects.toThrow(/stopped \(exit code 9\)/)
    await tick(); workers[0].emit('exit', 9)
    await rejected
    expect(workers).toHaveLength(1)
  })
  it('cleans up a rejected initialization without retrying invalid models', async () => {
    const engine = new OfflineCaptions(paths), ready = engine.prepare()
    const rejected = expect(ready).rejects.toThrow('Invalid models.')
    workers[0].emit('message', { id: 1, error: 'Invalid models.' })
    await rejected
    expect(workers[0].kill).toHaveBeenCalledOnce()
    expect(workers).toHaveLength(1)
  })
})
