import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeForeignExStyle, WDA_EXCLUDEFROMCAPTURE, WDA_NONE } from '../shared/foreign-window'

const native = vi.hoisted(() => ({
  foreground: 100,
  style: 0x40000,
  affinity: 0,
  readable: true,
  exists: true,
  visible: true,
  frameFailures: 0,
  affinityFailures: [] as boolean[],
  changes: [] as number[],
  affinityCall: vi.fn(),
  taskbarCall: vi.fn(),
  redraws: 0,
  visibilityChanges: 0,
  pauseNext: null as null | Promise<void>
}))

vi.mock('node:os', () => ({ release: () => '10.0.22631' }))
vi.mock('../electron/main/foreign-inject', () => ({ setForeignDisplayAffinity: native.affinityCall }))
vi.mock('../electron/main/taskbar-visibility', () => ({ createTaskbarVisibility: () => native.taskbarCall }))
vi.mock('koffi', () => ({
  default: {
    alias: () => undefined,
    proto: () => undefined,
    load: () => ({
      func: (signature: string) => (...args: unknown[]) => {
        const name = signature.match(/(\w+)\(/)?.[1]
        switch (name) {
          case 'GetForegroundWindow': return native.foreground
          case 'IsWindow': return native.exists
          case 'IsWindowVisible': return native.visible
          case 'GetWindowLongPtrW': return native.style
          case 'GetWindow': return 0
          case 'SetWindowLongPtrW': native.style = Number(args[2]); return 0
          case 'SetWindowPos':
            if (native.frameFailures > 0) { native.frameFailures--; return false }
            return true
          case 'ShowWindow': native.visibilityChanges++; native.visible = args[1] !== 0; return true
          case 'RedrawWindow': native.redraws++; return true
          case 'GetWindowDisplayAffinity':
            if (!native.readable) { return false }
            (args[1] as Uint32Array)[0] = native.affinity
            return true
          case 'GetWindowThreadProcessId': (args[1] as Uint32Array)[0] = 4242; return 1
          case 'GetWindowTextLengthW': return 7
          case 'GetWindowTextW':
          case 'GetClassNameW': {
            const text = 'Notepad'
            const out = args[1] as Uint16Array
            for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
            return text.length
          }
          case 'DwmGetWindowAttribute': return 0
          case 'OpenProcess': return 0
          case 'GetLastError': return 0
          default: throw new Error(`Unexpected native call: ${name}`)
        }
      }
    })
  }
}))

const plan = { captureProtection: true, hideFromTaskbar: true }
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'win32' }))
afterAll(() => Object.defineProperty(process, 'platform', platformDescriptor))

beforeEach(() => {
  vi.resetModules()
  Object.assign(native, {
    foreground: 100, style: 0x40000, affinity: 0, readable: true,
    exists: true, visible: true, frameFailures: 0,
    affinityFailures: [], changes: [], pauseNext: null, redraws: 0, visibilityChanges: 0
  })
  native.taskbarCall.mockReset().mockReturnValue(true)
  native.affinityCall.mockReset().mockImplementation(async (_hwnd: number, affinity: number) => {
    native.changes.push(affinity)
    const pause = native.pauseNext
    native.pauseNext = null
    if (pause) await pause
    if (native.affinityFailures.shift()) return { ok: false, message: 'Target refused restoration.' }
    native.affinity = affinity
    return { ok: true, message: 'ok' }
  })
})

describe('foreign-window restoration lifecycle', () => {
  it('restores both capture permission and the exact original taskbar style', async () => {
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    expect((await toggleForeignWindowStealth('999', 1337, plan)).appliedCount).toBe(1)
    expect(native.affinity).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(native.style).toBe(computeForeignExStyle(0x40000))
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: true, appliedCount: 0 })
    expect(native.affinity).toBe(WDA_NONE)
    expect(native.style).toBe(0x40000)
    expect(native.visible).toBe(true)
    expect(native.visibilityChanges).toBe(0)
    expect(native.taskbarCall.mock.calls.map(args => args[1])).toEqual([false, true])
    expect(native.redraws).toBe(1)
  })

  it('does not show or unminimize a window that was hidden after application', async () => {
    const { toggleForeignWindowStealth, restoreAllForeignWindows } = await import('../electron/main/window-stealth')
    await toggleForeignWindowStealth('999', 1337, plan)
    native.visible = false
    expect(await restoreAllForeignWindows()).toMatchObject({ ok: true, appliedCount: 0 })
    expect(native.visible).toBe(false)
    expect(native.visibilityChanges).toBe(0)
  })

  it('clears capture protection on an untracked tool window even when its affinity cannot be read', async () => {
    native.readable = false
    native.style = computeForeignExStyle(0x40000)
    native.affinity = WDA_EXCLUDEFROMCAPTURE
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    expect((await toggleForeignWindowStealth('999', 1337, plan)).ok).toBe(true)
    expect(native.changes).toEqual([WDA_NONE])
    expect(native.affinity).toBe(WDA_NONE)
    expect(native.style).toBe(0x40000)
  })

  it('retains a failed toggle restore so the same hotkey retries clearing protection', async () => {
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    await toggleForeignWindowStealth('999', 1337, plan)
    native.affinityFailures.push(true)
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: false, appliedCount: 1 })
    expect(native.affinity).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: true, appliedCount: 0 })
    expect(native.affinity).toBe(WDA_NONE)
  })

  it('keeps untracked recovery retryable when the affinity read and first clear both fail', async () => {
    native.readable = false
    native.style = computeForeignExStyle(0x40000)
    native.affinity = WDA_EXCLUDEFROMCAPTURE
    native.affinityFailures.push(true)
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: false, appliedCount: 1 })
    expect(native.affinity).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: true, appliedCount: 0 })
    expect(native.changes).toEqual([WDA_NONE, WDA_NONE])
    expect(native.affinity).toBe(WDA_NONE)
  })

  it('retains failed restore-all entries for another restore-all attempt', async () => {
    const { toggleForeignWindowStealth, restoreAllForeignWindows } = await import('../electron/main/window-stealth')
    await toggleForeignWindowStealth('999', 1337, plan)
    native.affinityFailures.push(true)
    expect(await restoreAllForeignWindows()).toMatchObject({ ok: false, restored: 0, appliedCount: 1 })
    expect(await restoreAllForeignWindows()).toMatchObject({ ok: true, restored: 1, appliedCount: 0 })
    expect(native.affinity).toBe(WDA_NONE)
  })

  it('checks the restored capture flag before forgetting a window', async () => {
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    await toggleForeignWindowStealth('999', 1337, plan)
    native.affinityCall.mockImplementationOnce(async () => ({ ok: true, message: 'ok' }))
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: false, appliedCount: 1 })
    expect(native.affinity).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: true, appliedCount: 0 })
  })

  it('leaves visibility and style alone when capture application fails before any style change', async () => {
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    native.affinityFailures.push(true)
    native.frameFailures = 1
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: false, appliedCount: 0 })
    expect(native.frameFailures).toBe(1)
    expect(native.style).toBe(0x40000)
    expect(native.visible).toBe(true)
  })

  it('rolls back a partially changed style when its frame refresh fails', async () => {
    const { toggleForeignWindowStealth } = await import('../electron/main/window-stealth')
    native.frameFailures = 1
    expect(await toggleForeignWindowStealth('999', 1337, plan)).toMatchObject({ ok: false, appliedCount: 0 })
    expect(native.style).toBe(0x40000)
    expect(native.affinity).toBe(WDA_NONE)
  })

  it('tracks failed rollback so restore-all can recover its remaining capture change', async () => {
    const { toggleForeignWindowStealth, restoreAllForeignWindows } = await import('../electron/main/window-stealth')
    native.frameFailures = 1
    native.affinityFailures.push(false, true)
    const result = await toggleForeignWindowStealth('999', 1337, plan)
    expect(result).toMatchObject({ ok: false, appliedCount: 1 })
    expect(result.message).not.toContain('left unchanged')
    expect(native.affinity).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(await restoreAllForeignWindows()).toMatchObject({ ok: true, appliedCount: 0 })
    expect(native.affinity).toBe(WDA_NONE)
  })

  it('waits for an in-flight apply before restore-all, including shutdown cleanup', async () => {
    const { toggleForeignWindowStealth, restoreAllForeignWindows } = await import('../electron/main/window-stealth')
    let release!: () => void
    native.pauseNext = new Promise<void>(resolve => { release = resolve })
    const apply = toggleForeignWindowStealth('999', 1337, plan)
    await vi.waitFor(() => expect(native.changes).toEqual([WDA_EXCLUDEFROMCAPTURE]))
    const restore = restoreAllForeignWindows()
    await Promise.resolve()
    expect(native.changes).toEqual([WDA_EXCLUDEFROMCAPTURE])
    release()
    await apply
    expect(await restore).toMatchObject({ ok: true, restored: 1, appliedCount: 0 })
    expect(native.affinity).toBe(WDA_NONE)
  })
})
