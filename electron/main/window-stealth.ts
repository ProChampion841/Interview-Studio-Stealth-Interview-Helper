/**
 * Win32 bridge for foreign-window stealth, mirroring WinHider's behavior: a
 * global hotkey toggles the focused window between normal and stealthed,
 * where stealthed means excluded from screen shares (display affinity) and
 * hidden from the taskbar and Alt-Tab (window style). The exact pre-change
 * state of every modified window is kept so restore is exact; all modified
 * windows are restored when the application exits.
 *
 * Capture exclusion runs inside the target process via foreign-inject.ts
 * (Windows rejects the call from any other process).
 */
import { release as osRelease } from 'node:os'
import { LIMITS, type ForeignWindowMutationResult } from '../../shared/contracts'
import {
  computeForeignExStyle,
  computeNormalExStyle,
  displayAffinityFor,
  foreignWindowRejection,
  rejectionReason,
  restoreForeignExStyle,
  sanitizeWindowTitle,
  summarizeApplyPlan,
  WDA_NONE,
  WS_EX_APPWINDOW,
  WS_EX_TOOLWINDOW,
  type AppliedForeignWindow,
  type StealthApplyPlan
} from '../../shared/foreign-window'
import { setForeignDisplayAffinity } from './foreign-inject'
import { createTaskbarVisibility, type TaskbarNativeModule } from './taskbar-visibility'

const GWL_EXSTYLE = -16
const DWMWA_CLOAKED = 14
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
// SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
const SWP_FLAGS = 0x1 | 0x2 | 0x4 | 0x10 | 0x20
// Invalidate the frame and child controls without erasing their backgrounds.
const REDRAW_FLAGS = 0x1 | 0x80 | 0x400

interface KoffiModule extends TaskbarNativeModule {
  alias(name: string, type: string): unknown
}

interface ForeignBindings {
  enumWindows(callback: (hwnd: number, lParam: number) => boolean): boolean
  getForegroundWindow(): number
  isWindow(hwnd: number): boolean
  isWindowVisible(hwnd: number): boolean
  windowTitle(hwnd: number): string
  windowClass(hwnd: number): string
  windowPid(hwnd: number): number
  windowExStyle(hwnd: number): number
  windowOwner(hwnd: number): number
  processName(pid: number): string
  isCloaked(hwnd: number): boolean
  setWindowLongPtrW(hwnd: number, index: number, value: number): number
  setWindowPos(hwnd: number, after: number, flags: number): boolean
  setTaskbarVisibility(hwnd: number, visible: boolean): boolean
  redrawWindow(hwnd: number): boolean
  getWindowDisplayAffinity(hwnd: number): number | null
  lastError(): number
}

let bindings: ForeignBindings | null = null
let bindingsFailure = ''
let bindingsPromise: Promise<boolean> | null = null

const appliedWindows = new Map<string, AppliedForeignWindow>()
let mutationQueue: Promise<void> = Promise.resolve()

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

/** Starts the lazy native load early so later calls find it ready. */
export function primeForeignWindowBindings(): void {
  if (process.platform === 'win32') void loadBindings()
}

export function foreignWindowSupport(): { supported: boolean; reason: string } {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'Foreign-window stealth works on Windows only.' }
  }
  if (bindings) return { supported: true, reason: '' }
  if (bindingsFailure) return { supported: false, reason: bindingsFailure }
  return { supported: false, reason: 'Native window access is still loading. Try again in a moment.' }
}

async function loadBindings(): Promise<boolean> {
  if (bindings || bindingsFailure) return Boolean(bindings)
  if (!bindingsPromise) {
    bindingsPromise = (async () => {
      try {
        const imported = (await import('koffi')) as { default?: unknown } & KoffiModule
        const koffi = ((imported.default ?? imported) as KoffiModule)
        bindings = buildBindings(koffi)
        return true
      } catch (error) {
        bindingsFailure = 'Native window access could not be loaded on this system.'
        console.error('Foreign-window stealth unavailable:', error)
        return false
      }
    })()
  }
  return bindingsPromise
}

function buildBindings(koffi: KoffiModule): ForeignBindings {
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  koffi.alias('StudioForeignHwnd', 'uintptr')
  koffi.proto('bool __stdcall StudioForeignEnumProc(uintptr hwnd, intptr_t lParam)')

  const enumWindowsRaw = user32.func('bool __stdcall EnumWindows(StudioForeignEnumProc *cb, intptr_t lParam)')
  const getForegroundWindowRaw = user32.func('StudioForeignHwnd __stdcall GetForegroundWindow()')
  const isWindowRaw = user32.func('bool __stdcall IsWindow(StudioForeignHwnd hWnd)')
  const isWindowVisibleRaw = user32.func('bool __stdcall IsWindowVisible(StudioForeignHwnd hWnd)')
  const getWindowTextLengthRaw = user32.func('int __stdcall GetWindowTextLengthW(StudioForeignHwnd hWnd)')
  const getWindowTextRaw = user32.func('int __stdcall GetWindowTextW(StudioForeignHwnd hWnd, _Out_ uint16_t *text, int maxCount)')
  const getClassNameRaw = user32.func('int __stdcall GetClassNameW(StudioForeignHwnd hWnd, _Out_ uint16_t *name, int maxCount)')
  const getWindowLongPtrRaw = user32.func('intptr_t __stdcall GetWindowLongPtrW(StudioForeignHwnd hWnd, int nIndex)')
  const getWindowRaw = user32.func('StudioForeignHwnd __stdcall GetWindow(StudioForeignHwnd hwnd, uint32_t command)')
  const setWindowLongPtrRaw = user32.func('intptr_t __stdcall SetWindowLongPtrW(StudioForeignHwnd hWnd, int nIndex, intptr_t value)')
  const getWindowThreadProcessIdRaw = user32.func('uint32_t __stdcall GetWindowThreadProcessId(StudioForeignHwnd hWnd, _Out_ uint32_t *pid)')
  const setWindowPosRaw = user32.func('bool __stdcall SetWindowPos(StudioForeignHwnd hWnd, StudioForeignHwnd after, int x, int y, int cx, int cy, uint32_t flags)')
  const redrawWindowRaw = user32.func('bool __stdcall RedrawWindow(StudioForeignHwnd hwnd, const void *rect, uintptr region, uint32_t flags)')
  const setTaskbarVisibility = createTaskbarVisibility(koffi)
  const getWindowDisplayAffinityRaw = user32.func('bool __stdcall GetWindowDisplayAffinity(StudioForeignHwnd hWnd, _Out_ uint32_t *affinity)')
  const dwmGetWindowAttributeRaw = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(StudioForeignHwnd hwnd, uint32_t attr, _Out_ uint32_t *value, uint32_t cb)')
  const openProcessRaw = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
  const closeHandleRaw = kernel32.func('bool __stdcall CloseHandle(void *handle)')
  const queryFullProcessImageNameRaw = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *proc, uint32_t flags, _Out_ uint16_t *path, _Inout_ uint32_t *size)')
  const getLastErrorRaw = kernel32.func('uint32_t __stdcall GetLastError()')

  // koffi's string layer is avoided on purpose: buffers plus TextDecoder are
  // deterministic across koffi versions.
  const decoder = new TextDecoder('utf-16le')
  const readUtf16 = (typed: Uint16Array, chars: number): string => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)
    return decoder.decode(bytes.subarray(0, Math.max(0, Math.min(bytes.length, chars * 2)))).split('\u0000')[0] ?? ''
  }
  const title = (hwnd: number): string => {
    const length = Number(getWindowTextLengthRaw(hwnd))
    if (length <= 0) return ''
    const buffer = new Uint16Array(Math.min(length, 512) + 1)
    return readUtf16(buffer, Number(getWindowTextRaw(hwnd, buffer, buffer.length)))
  }
  const className = (hwnd: number): string => {
    const buffer = new Uint16Array(256)
    return readUtf16(buffer, Number(getClassNameRaw(hwnd, buffer, buffer.length)))
  }
  const pidOf = (hwnd: number): number => {
    const out = new Uint32Array(1)
    Number(getWindowThreadProcessIdRaw(hwnd, out))
    return out[0]
  }
  const processName = (pid: number): string => {
    const handle = openProcessRaw(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (!handle) return 'Unknown'
    try {
      const size = new Uint32Array([512])
      const buffer = new Uint16Array(512)
      if (!queryFullProcessImageNameRaw(handle, 0, buffer, size)) return 'Unknown'
      return readUtf16(buffer, size[0]).split('\\').pop() || 'Unknown'
    } finally {
      closeHandleRaw(handle)
    }
  }
  const cloaked = (hwnd: number): boolean => {
    const out = new Uint32Array(1)
    const rc = Number(dwmGetWindowAttributeRaw(hwnd, DWMWA_CLOAKED, out, 4))
    return rc === 0 && out[0] !== 0
  }

  return {
    enumWindows: (callback) => Boolean(enumWindowsRaw(callback, 0)),
    getForegroundWindow: () => Number(getForegroundWindowRaw()),
    isWindow: (hwnd) => Boolean(isWindowRaw(hwnd)),
    isWindowVisible: (hwnd) => Boolean(isWindowVisibleRaw(hwnd)),
    windowTitle: title,
    windowClass: className,
    windowPid: pidOf,
    windowExStyle: (hwnd) => Number(getWindowLongPtrRaw(hwnd, GWL_EXSTYLE)),
    windowOwner: (hwnd) => Number(getWindowRaw(hwnd, 4)),
    processName,
    isCloaked: cloaked,
    setWindowLongPtrW: (hwnd, index, value) => Number(setWindowLongPtrRaw(hwnd, index, value)),
    setWindowPos: (hwnd, after, flags) => Boolean(setWindowPosRaw(hwnd, after, 0, 0, 0, 0, flags)),
    setTaskbarVisibility,
    redrawWindow: (hwnd) => Boolean(redrawWindowRaw(hwnd, null, 0, REDRAW_FLAGS)),
    getWindowDisplayAffinity: (hwnd) => {
      const out = new Uint32Array(1)
      return getWindowDisplayAffinityRaw(hwnd, out) ? out[0] : null
    },
    lastError: () => Number(getLastErrorRaw())
  }
}

function osBuildNumber(): number {
  return Number(osRelease().split('.')[2]) || 0
}

function unsupportedResult(): ForeignWindowMutationResult {
  const support = foreignWindowSupport()
  return { ok: false, message: support.reason || 'Foreign-window stealth is unavailable.', appliedCount: appliedWindows.size }
}

function pruneDeadEntries(): void {
  if (!bindings) return
  for (const key of appliedWindows.keys()) {
    if (!bindings.isWindow(Number(key))) appliedWindows.delete(key)
  }
}

/** Preserve the target's visibility and rendering surface while updating the shell. */
function applyStyleAndRefresh(hwnd: number, exStyle: number): boolean {
  if (!bindings) return false
  bindings.setWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle)
  const ok = bindings.setWindowPos(hwnd, 0, SWP_FLAGS)
  const visibleInTaskbar = !((exStyle >>> 0) & WS_EX_TOOLWINDOW) &&
    (Boolean((exStyle >>> 0) & WS_EX_APPWINDOW) || !bindings.windowOwner(hwnd))
  const taskbarUpdated = bindings.setTaskbarVisibility(hwnd, visibleInTaskbar)
  return ok && taskbarUpdated && (bindings.windowExStyle(hwnd) >>> 0) === (exStyle >>> 0)
}

/** Applies the plan to one hwnd, rolling everything back if any step fails. */
async function applyToHwnd(hwnd: number, plan: StealthApplyPlan): Promise<ForeignWindowMutationResult> {
  if (!bindings) return unsupportedResult()
  const key = String(hwnd)
  if (appliedWindows.has(key)) {
    return {
      ok: true,
      message: 'Stealth is already applied to this window. Press the hotkey again to remove it.',
      appliedCount: appliedWindows.size
    }
  }
  if (appliedWindows.size >= LIMITS.foreignWindowCount) {
    return {
      ok: false,
      message: `You can stealth up to ${LIMITS.foreignWindowCount} windows. Restore one first.`,
      appliedCount: appliedWindows.size
    }
  }

  const originalExStyle = bindings.windowExStyle(hwnd)
  const originalAffinity = plan.captureProtection ? bindings.getWindowDisplayAffinity(hwnd) : null
  const changed: string[] = []
  let failure = ''
  let styleAttempted = false

  if (plan.captureProtection) {
    const outcome = await setForeignDisplayAffinity(hwnd, displayAffinityFor(osBuildNumber(), true))
    if (outcome.ok) changed.push('capture')
    else failure = outcome.message
  }
  if (!failure && plan.hideFromTaskbar) {
    styleAttempted = true
    if (applyStyleAndRefresh(hwnd, computeForeignExStyle(originalExStyle))) {
      changed.push('style')
    } else failure = 'The window style could not be updated.'
  }

  if (failure) {
    // Roll back everything already changed so no window is left half-applied.
    let rolledBack = true
    if (changed.includes('capture')) {
      const undo = await setForeignDisplayAffinity(hwnd, originalAffinity ?? WDA_NONE)
      rolledBack = undo.ok && rolledBack
    }
    // A failed style refresh can still have changed EXSTYLE.
    if (styleAttempted) {
      rolledBack = applyStyleAndRefresh(hwnd, restoreForeignExStyle(originalExStyle)) && rolledBack
    }
    if (!rolledBack) {
      appliedWindows.set(key, {
        hwnd: key,
        process: sanitizeWindowTitle(bindings.processName(bindings.windowPid(hwnd)), LIMITS.foreignProcessChars),
        applied: { hideFromTaskbar: styleAttempted, captureExclusion: changed.includes('capture') },
        original: { exStyle: originalExStyle, affinity: originalAffinity },
        appliedAt: Date.now()
      })
    }
    return {
      ok: false,
      message: `${failure} ${rolledBack ? 'The changes were rolled back.' : 'Some changes remain. Focus this window and press the hotkey again, or use restore-all to retry.'}`,
      appliedCount: appliedWindows.size
    }
  }

  appliedWindows.set(key, {
    hwnd: key,
    process: sanitizeWindowTitle(bindings.processName(bindings.windowPid(hwnd)), LIMITS.foreignProcessChars),
    applied: { hideFromTaskbar: changed.includes('style'), captureExclusion: changed.includes('capture') },
    original: { exStyle: originalExStyle, affinity: originalAffinity },
    appliedAt: Date.now()
  })
  const steps = summarizeApplyPlan({
    captureProtection: changed.includes('capture'),
    hideFromTaskbar: changed.includes('style')
  })
  return {
    ok: true,
    message: `The window is now ${steps.join(' and ')} Press the hotkey again to restore it.`,
    appliedCount: appliedWindows.size
  }
}

async function restoreEntry(key: string, entry: AppliedForeignWindow): Promise<boolean> {
  if (!bindings) return false
  const hwnd = Number(key)
  if (!bindings.isWindow(hwnd)) return true // The window is gone; nothing left to restore.
  let ok = true
  if (entry.applied.captureExclusion) {
    const outcome = await setForeignDisplayAffinity(hwnd, entry.original.affinity ?? WDA_NONE)
    ok = outcome.ok && ok
  }
  if (entry.applied.hideFromTaskbar) {
    ok = applyStyleAndRefresh(hwnd, restoreForeignExStyle(entry.original.exStyle)) && ok
  }
  if (entry.applied.captureExclusion) {
    const affinity = bindings.getWindowDisplayAffinity(hwnd)
    if (affinity !== null && affinity !== (entry.original.affinity ?? WDA_NONE)) ok = false
  }
  ok = bindings.redrawWindow(hwnd) && ok
  return ok
}

export function restoreAllForeignWindows(): Promise<{ ok: boolean; message: string; restored: number; appliedCount: number }> {
  return serializeMutation(restoreAllEntries)
}

async function restoreAllEntries(): Promise<{ ok: boolean; message: string; restored: number; appliedCount: number }> {
  await loadBindings()
  if (!bindings || !appliedWindows.size) {
    return { ok: true, message: 'No windows are currently modified.', restored: 0, appliedCount: 0 }
  }
  let restored = 0
  let attempted = 0
  let allOk = true
  for (const [key, entry] of [...appliedWindows]) {
    attempted += 1
    if (await restoreEntry(key, entry)) {
      restored += 1
      appliedWindows.delete(key)
    } else allOk = false
  }
  return {
    ok: allOk,
    message: allOk
      ? `Restored ${restored} window${restored === 1 ? '' : 's'} to their previous state.`
      : `Restored ${restored} of ${attempted} windows. ${appliedWindows.size} remain tracked; use restore-all again to retry.`,
    restored,
    appliedCount: appliedWindows.size
  }
}

/**
 * The global hotkey action: toggles stealth on the window that currently has
 * keyboard focus.
 */
export function toggleForeignWindowStealth(
  ownHwnd: string,
  ownPid: number,
  plan: StealthApplyPlan
): Promise<ForeignWindowMutationResult> {
  // Remember the focused window before waiting for an earlier mutation.
  const focusedHwnd = bindings?.getForegroundWindow()
  const capturedPlan = { ...plan }
  return serializeMutation(() => toggleFocusedWindow(ownHwnd, ownPid, capturedPlan, focusedHwnd))
}

async function toggleFocusedWindow(
  ownHwnd: string,
  ownPid: number,
  plan: StealthApplyPlan,
  focusedHwnd?: number
): Promise<ForeignWindowMutationResult> {
  await loadBindings()
  if (!bindings) return unsupportedResult()
  pruneDeadEntries()

  const activeHwnd = Number(focusedHwnd ?? bindings.getForegroundWindow())
  if (!activeHwnd) {
    return { ok: false, message: 'No window is currently focused. Click the window you want to stealth first.', appliedCount: appliedWindows.size }
  }
  const key = String(activeHwnd)
  if (key === ownHwnd) {
    return {
      ok: false,
      message: 'Interview Studio is focused — focus the window you want to stealth first.',
      appliedCount: appliedWindows.size
    }
  }
  if (appliedWindows.has(key)) {
    const entry = appliedWindows.get(key)
    if (entry) {
      const ok = await restoreEntry(key, entry)
      if (ok) appliedWindows.delete(key)
      return {
        ok,
        message: ok ? 'The window was restored to its previous state.' : 'The window could not be fully restored. It remains tracked; press the hotkey again or use restore-all to retry.',
        appliedCount: appliedWindows.size
      }
    }
  }

  // A window stealthed outside this session (or before a restart) has no
  // stored original: toggle it back to the standard visible state instead of
  // demanding the exact previous values.
  const currentExStyle = bindings.windowExStyle(activeHwnd)
  const currentAffinity = bindings.getWindowDisplayAffinity(activeHwnd)
  const alreadyStealthed = Boolean((currentExStyle >>> 0) & WS_EX_TOOLWINDOW) ||
    (currentAffinity !== null && currentAffinity !== WDA_NONE)
  if (alreadyStealthed) {
    let ok = true
    // GetWindowDisplayAffinity can fail on non-layered windows (including
    // Notepad). A failed read does not mean capture protection is off.
    const outcome = await setForeignDisplayAffinity(activeHwnd, WDA_NONE)
    ok = outcome.ok && ok
    ok = applyStyleAndRefresh(activeHwnd, computeNormalExStyle(currentExStyle)) && ok
    ok = bindings.redrawWindow(activeHwnd) && ok
    if (!ok) {
      appliedWindows.set(key, {
        hwnd: key,
        process: sanitizeWindowTitle(bindings.processName(bindings.windowPid(activeHwnd)), LIMITS.foreignProcessChars),
        applied: { captureExclusion: true, hideFromTaskbar: true },
        original: { exStyle: computeNormalExStyle(currentExStyle), affinity: WDA_NONE },
        appliedAt: Date.now()
      })
    }
    return {
      ok,
      message: ok
        ? 'The window was restored to standard visibility. Its exact previous style was not tracked by this session.'
        : 'The window could not be fully restored. It remains tracked; press the hotkey again or use restore-all to retry.',
      appliedCount: appliedWindows.size
    }
  }

  const candidate = {
    visible: bindings.isWindowVisible(activeHwnd),
    cloaked: bindings.isCloaked(activeHwnd),
    title: bindings.windowTitle(activeHwnd),
    windowClass: bindings.windowClass(activeHwnd),
    pid: bindings.windowPid(activeHwnd),
    ownPid,
    exStyle: bindings.windowExStyle(activeHwnd)
  }
  const rejection = foreignWindowRejection(candidate)
  if (rejection) {
    const label = candidate.title.trim()
      ? `"${sanitizeWindowTitle(candidate.title, LIMITS.foreignWindowTitleChars)}"`
      : `a "${sanitizeWindowTitle(candidate.windowClass, 60)}" window`
    return {
      ok: false,
      message: `Cannot stealth ${label} — ${rejectionReason(rejection)}. Click inside the window you want to stealth, then press the hotkey again.`,
      appliedCount: appliedWindows.size
    }
  }
  if (!summarizeApplyPlan(plan).length) {
    return { ok: true, message: 'Stealth mode is off in settings — nothing to apply to this window.', appliedCount: appliedWindows.size }
  }
  return applyToHwnd(activeHwnd, plan)
}
