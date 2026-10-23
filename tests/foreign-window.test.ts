import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../shared/contracts'
import {
  buildAffinityShellcode,
  computeForeignExStyle,
  computeNormalExStyle,
  computeRemoteAddress,
  displayAffinityFor,
  foreignWindowRejection,
  normalizeHwndKey,
  rejectionReason,
  restoreForeignExStyle,
  sanitizeWindowTitle,
  summarizeApplyPlan,
  WDA_EXCLUDEFROMCAPTURE,
  WDA_MONITOR,
  WDA_NONE,
  WS_EX_APPWINDOW,
  WS_EX_TOOLWINDOW,
  type ForeignWindowRejection
} from '../shared/foreign-window'

describe('foreign window ex-style math', () => {
  it('sets WS_EX_TOOLWINDOW and clears WS_EX_APPWINDOW while preserving other bits', () => {
    const original = 0x14cb0000 // has WS_EX_APPWINDOW, no WS_EX_TOOLWINDOW
    const next = computeForeignExStyle(original)
    expect(next & WS_EX_TOOLWINDOW).toBe(WS_EX_TOOLWINDOW)
    expect(next & WS_EX_APPWINDOW).toBe(0)
    const preservedMask = ~(WS_EX_TOOLWINDOW | WS_EX_APPWINDOW)
    expect(next & preservedMask).toBe((original & preservedMask) >>> 0)
  })

  it('is idempotent and treats sign-extended values as 32-bit styles', () => {
    const original = -127 // 0xFFFFFF81 sign-extended
    const once = computeForeignExStyle(original)
    expect(computeForeignExStyle(once)).toBe(once)
    expect(once >>> 0).toBe(((0xFFFFFF81 | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW) >>> 0)
  })

  it('restores the exact original style', () => {
    for (const original of [0x14cb0000, -127, 0, 0x80]) {
      expect(restoreForeignExStyle(original)).toBe(original >>> 0)
    }
  })

  it('computes the standard visible style for untracked stealthed windows', () => {
    const stealthed = computeForeignExStyle(0x14cf0000)
    const restored = computeNormalExStyle(stealthed)
    expect(restored & WS_EX_TOOLWINDOW).toBe(0)
    expect(restored & WS_EX_APPWINDOW).toBe(WS_EX_APPWINDOW)
    expect(restored).toBe(0x14cf0000 >>> 0) // round-trips for a normally styled window
  })
})

describe('foreign window eligibility', () => {
  const base = {
    visible: true,
    cloaked: false,
    title: 'Untitled - Notepad',
    windowClass: 'Notepad',
    pid: 4242,
    ownPid: 1337,
    exStyle: 0x100
  }

  it('accepts an ordinary application window', () => {
    expect(foreignWindowRejection(base)).toBeNull()
  })

  it.each([
    ['invisible windows', { ...base, visible: false }, 'invisible'],
    ['cloaked UWP ghosts', { ...base, cloaked: true }, 'cloaked'],
    ['untitled windows', { ...base, title: '   ' }, 'untitled'],
    ['the app itself', { ...base, pid: 1337 }, 'own-process'],
    ['existing tool windows', { ...base, exStyle: WS_EX_TOOLWINDOW | 0x100 }, 'already-tool-window'],
    ['shell surfaces', { ...base, windowClass: 'Shell_TrayWnd' }, 'shell-surface'],
    ['the desktop', { ...base, windowClass: 'Progman' }, 'shell-surface']
  ])('rejects %s with reason %p', (_label, candidate, reason) => {
    expect(foreignWindowRejection(candidate)).toBe(reason)
    expect(rejectionReason(reason as ForeignWindowRejection)).not.toBe('')
  })
})

describe('foreign window input hygiene', () => {
  it('sanitizes window titles like other persisted text', () => {
    expect(sanitizeWindowTitle('  Codex \u0000 window  ', 50)).toBe('Codex  window')
    expect(sanitizeWindowTitle('x'.repeat(200), LIMITS.foreignWindowTitleChars)).toHaveLength(LIMITS.foreignWindowTitleChars)
    expect(sanitizeWindowTitle(42, 10)).toBe('')
  })

  it('accepts only decimal hwnd keys and re-validates every use', () => {
    expect(normalizeHwndKey(' 132448 ')).toBe('132448')
    expect(normalizeHwndKey('0')).toBe('0')
    expect(normalizeHwndKey('abc')).toBeNull()
    expect(normalizeHwndKey('-12')).toBeNull()
    expect(normalizeHwndKey('1'.repeat(13))).toBeNull()
    expect(normalizeHwndKey(132448)).toBeNull()
    expect(normalizeHwndKey(null)).toBeNull()
  })
})

describe('display affinity policy', () => {
  it('uses WDA_EXCLUDEFROMCAPTURE from Windows 10 2004 onward', () => {
    expect(displayAffinityFor(19_041, true)).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(displayAffinityFor(22_631, true)).toBe(WDA_EXCLUDEFROMCAPTURE)
    expect(displayAffinityFor(18_363, true)).toBe(WDA_MONITOR)
    expect(displayAffinityFor(22_631, false)).toBe(WDA_NONE)
    expect(displayAffinityFor(Number.NaN, true)).toBe(WDA_MONITOR)
  })
})

describe('affinity shellcode', () => {
  it('emits the exact 26-byte remote-thread stub with a balanced stack', () => {
    const code = buildAffinityShellcode(0x11, 0x7ffea53b1234n)
    const view = new DataView(code.buffer)
    expect(code).toHaveLength(26)
    expect(code[0]).toBe(0xBA) // mov edx, affinity
    expect(view.getUint32(1, true)).toBe(0x11)
    expect([...code.subarray(5, 9)]).toEqual([0x48, 0x83, 0xEC, 0x28]) // sub rsp, 0x28
    expect([...code.subarray(9, 11)]).toEqual([0x48, 0xB8]) // mov rax, imm64
    expect(view.getBigUint64(11, true)).toBe(0x7ffea53b1234n)
    expect([...code.subarray(19, 21)]).toEqual([0xFF, 0xD0]) // call rax
    expect([...code.subarray(21, 25)]).toEqual([0x48, 0x83, 0xC4, 0x28]) // add rsp, 0x28
    expect(code[25]).toBe(0xC3) // ret
  })

  it('maps a local export to its remote address through the module bases', () => {
    const localBase = 0x7ffea53b0000n
    const localAddress = 0x7ffea53f1234n
    expect(computeRemoteAddress(0x7ffe90000000n, localBase, localAddress))
      .toBe(0x7ffe90000000n + (localAddress - localBase))
    expect(computeRemoteAddress(localBase, localBase, localAddress)).toBe(localAddress)
  })
})

describe('apply plan summary', () => {
  it('mirrors the sub-features including capture exclusion', () => {
    expect(summarizeApplyPlan({ captureProtection: true, hideFromTaskbar: true }))
      .toEqual(['excluded from screen shares', 'hidden from the taskbar and Alt-Tab'])
    expect(summarizeApplyPlan({ captureProtection: false, hideFromTaskbar: true }))
      .toEqual(['hidden from the taskbar and Alt-Tab'])
    expect(summarizeApplyPlan({ captureProtection: false, hideFromTaskbar: false }))
      .toEqual([])
  })
})

describe('shared foreign-window module purity', () => {
  it('imports neither Electron nor koffi', () => {
    const source = readFileSync(resolve(process.cwd(), 'shared/foreign-window.ts'), 'utf8')
    expect(source).not.toMatch(/from ['"]electron['"]/)
    expect(source).not.toMatch(/koffi/)
  })
})
