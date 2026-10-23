import { describe, expect, it, vi } from 'vitest'
import { createTaskbarVisibility, type TaskbarNativeModule } from '../electron/main/taskbar-visibility'

function mockNative(options: { initialization?: number; creation?: number; method?: number; shellInit?: number } = {}) {
  const uninitialize = vi.fn()
  const calls: string[] = []
  const initialize = vi.fn(() => options.initialization ?? 0)
  const create = vi.fn((...args: unknown[]) => {
    if ((options.creation ?? 0) < 0) { return options.creation! }
    (args[4] as unknown[])[0] = { object: true }
    return 0
  })
  const native: TaskbarNativeModule = {
    load: () => ({ func: signature => signature.includes('CoInitializeEx') ? initialize : signature.includes('CoUninitialize') ? uninitialize : create }),
    proto: signature => signature,
    decode: (_address: unknown, offset: string | number) => typeof offset === 'string' ? { table: true } : offset / (process.arch === 'ia32' ? 4 : 8),
    call: (address: unknown) => {
      const method = Number(address)
      calls.push(['QueryInterface', 'AddRef', 'Release', 'HrInit', 'AddTab', 'DeleteTab'][method])
      return method === 3 ? options.shellInit ?? 0 : options.method ?? 0
    }
  }
  return { native, calls, initialize, uninitialize, create }
}

describe('taskbar visibility without a window visibility cycle', () => {
  it('removes and restores a taskbar button while releasing both COM interfaces', () => {
    const fixture = mockNative()
    const setVisibility = createTaskbarVisibility(fixture.native)
    expect(setVisibility(100, false)).toBe(true)
    expect(setVisibility(100, true)).toBe(true)
    expect(fixture.calls).toEqual(['HrInit', 'DeleteTab', 'Release', 'HrInit', 'AddTab', 'Release'])
    expect(fixture.uninitialize).toHaveBeenCalledTimes(2)
  })

  it('uses an existing Electron COM apartment without uninitializing it', () => {
    const fixture = mockNative({ initialization: -2147417850 })
    expect(createTaskbarVisibility(fixture.native)(100, false)).toBe(true)
    expect(fixture.calls).toEqual(['HrInit', 'DeleteTab', 'Release'])
    expect(fixture.uninitialize).not.toHaveBeenCalled()
  })

  it('reports a shell rejection so the caller can roll back the window style', () => {
    const fixture = mockNative({ method: -1 })
    expect(createTaskbarVisibility(fixture.native)(100, false)).toBe(false)
    expect(fixture.calls.at(-1)).toBe('Release')
    expect(fixture.uninitialize).toHaveBeenCalledOnce()
  })

  it('releases a shell interface that fails to initialize without using it', () => {
    const fixture = mockNative({ shellInit: -1 })
    expect(createTaskbarVisibility(fixture.native)(100, false)).toBe(false)
    expect(fixture.calls).toEqual(['HrInit', 'Release'])
  })

  it('balances COM initialization when the shell object cannot be created', () => {
    const fixture = mockNative({ creation: -1 })
    expect(createTaskbarVisibility(fixture.native)(100, false)).toBe(false)
    expect(fixture.calls).toEqual([])
    expect(fixture.uninitialize).toHaveBeenCalledOnce()
  })
})
