import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork } }))
import { OfflineTranslations } from '../electron/main/offline-translations'

class Worker extends EventEmitter {
  stdout = { resume: vi.fn() }; stderr = { resume: vi.fn() }
  postMessage = vi.fn(); kill = vi.fn()
  reply(text = '', error?: string) { this.emit('message', { id: this.postMessage.mock.calls.at(-1)![0].id, text, error }) }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
describe('offline translation isolation and cancellation', () => {
  let workers: Worker[]
  beforeEach(() => { workers = []; fork.mockReset().mockImplementation(() => { const worker = new Worker(); workers.push(worker); return worker }) })
  it('loads one model, serializes both sources, and reuses the worker', async () => {
    const engine = new OfflineTranslations(async () => 'pack'), signal = new AbortController().signal
    const first = engine.translate('question', 'es', signal), second = engine.translate('answer', 'es', signal)
    await tick(); workers[0].reply(); await tick()
    expect(workers[0].postMessage.mock.calls.at(-1)![0]).toMatchObject({ text: 'question' })
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    workers[0].reply('pregunta'); await expect(first).resolves.toBe('pregunta'); await tick()
    expect(workers[0].postMessage.mock.calls.at(-1)![0]).toMatchObject({ text: 'answer' })
    workers[0].reply('respuesta'); await expect(second).resolves.toBe('respuesta')
    expect(workers).toHaveLength(1); engine.stop()
  })
  it('aborts active and queued translations, kills native inference, and discards late output', async () => {
    const engine = new OfflineTranslations(async () => 'pack'), controller = new AbortController()
    const first = engine.translate('question', 'ko', controller.signal), second = engine.translate('answer', 'ko', controller.signal)
    const rejected = [expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(second).rejects.toMatchObject({ name: 'AbortError' })]
    await tick(); workers[0].reply(); await tick(); controller.abort()
    workers[0].reply('late text')
    await Promise.all(rejected)
    expect(workers[0].kill).toHaveBeenCalledOnce(); expect(workers).toHaveLength(1)
  })
  it('releases a failed startup and starts a clean worker on retry', async () => {
    const engine = new OfflineTranslations(async () => 'pack'), signal = new AbortController().signal
    const first = engine.translate('hello', 'es', signal)
    const failed = expect(first).rejects.toThrow('pack failed')
    await tick(); workers[0].reply('', 'pack failed'); await failed
    expect(workers[0].kill).toHaveBeenCalledOnce()
    const retry = engine.translate('hello', 'es', signal)
    await tick(); expect(workers).toHaveLength(2)
    workers[1].reply(); await tick(); workers[1].reply('hola'); await expect(retry).resolves.toBe('hola')
    engine.stop()
  })
})
