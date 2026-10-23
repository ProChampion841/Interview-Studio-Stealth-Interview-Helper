/**
 * Pure helpers for applying Interview Studio's window-privacy treatment to
 * another top-level window on Windows. No Electron or native imports: this
 * module stays unit-testable in plain Node and performs no OS calls.
 *
 * Scope note: Windows reserves capture exclusion (SetWindowDisplayAffinity)
 * for a window's own process, so foreign windows receive the taskbar/Alt-Tab
 * hiding and the decoy title only. Verified cross-process on Win11.
 */
import { LIMITS } from './contracts'

export const WS_EX_TOOLWINDOW = 0x80
export const WS_EX_APPWINDOW = 0x40000
export const WDA_NONE = 0x0
export const WDA_EXCLUDEFROMCAPTURE = 0x11
export const WDA_MONITOR = 0x1

/** Windows 10 version 2004 (build 19041) introduced WDA_EXCLUDEFROMCAPTURE. */
const WDA_EXCLUDEFROMCAPTURE_BUILD = 19041

export function displayAffinityFor(buildNumber: number, captureProtection: boolean): number {
  if (!captureProtection) return WDA_NONE
  if (Number.isFinite(buildNumber) && buildNumber >= WDA_EXCLUDEFROMCAPTURE_BUILD) return WDA_EXCLUDEFROMCAPTURE
  return WDA_MONITOR
}

/**
 * Builds the 64-bit shellcode a remote thread executes to call
 * SetWindowDisplayAffinity(hwnd, affinity) inside the target process. The
 * thread's start parameter (rcx on x64) carries the hwnd; the affinity and the
 * absolute address of user32!SetWindowDisplayAffinity in the target are baked
 * into the code. The thread's exit code is the API's BOOL result.
 */
export function buildAffinityShellcode(affinity: number, functionAddress: bigint): Uint8Array {
  const code = new Uint8Array(26)
  const view = new DataView(code.buffer)
  code[0] = 0xBA // mov edx, affinity
  view.setUint32(1, affinity >>> 0, true)
  code.set([0x48, 0x83, 0xEC, 0x28], 5) // sub rsp, 0x28 (shadow space + alignment)
  code[9] = 0x48
  code[10] = 0xB8 // mov rax, imm64
  view.setBigUint64(11, functionAddress & 0xffff_ffff_ffff_ffffn, true)
  code[19] = 0xFF
  code[20] = 0xD0 // call rax
  code.set([0x48, 0x83, 0xC4, 0x28], 21) // add rsp, 0x28 — restore the stack before returning
  code[25] = 0xC3 // ret — eax (the API's BOOL) becomes the thread exit code
  return code
}

/** Remote absolute address of an export, from the remote module base and the local (base, address) pair. */
export function computeRemoteAddress(remoteModuleBase: bigint, localModuleBase: bigint, localAddress: bigint): bigint {
  return remoteModuleBase + (localAddress - localModuleBase)
}

export interface ForeignWindowOriginalState {
  /** GWL_EXSTYLE read before any modification. */
  exStyle: number
  /** Display affinity read before any modification; null when it could not be read. */
  affinity: number | null
}

export interface AppliedForeignWindow {
  hwnd: string
  process: string
  applied: { hideFromTaskbar: boolean; captureExclusion: boolean }
  original: ForeignWindowOriginalState
  appliedAt: number
}

export interface StealthApplyPlan {
  captureProtection: boolean
  hideFromTaskbar: boolean
}

/** Windows shell and system surfaces that must never appear as stealth targets. */
const SHELL_WINDOW_CLASSES = [
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
  'XamlExplorerHostIslandWindow',
  'Windows.UI.Core.CoreWindow',
  'PopupHost'
]

export interface ForeignWindowCandidate {
  visible: boolean
  cloaked: boolean
  title: string
  windowClass: string
  pid: number
  ownPid: number
  exStyle: number
}

export type ForeignWindowRejection =
  | 'invisible'
  | 'cloaked'
  | 'untitled'
  | 'own-process'
  | 'already-tool-window'
  | 'shell-surface'

const REJECTION_REASONS: Record<ForeignWindowRejection, string> = {
  invisible: 'it is not visible',
  cloaked: 'it is a system surface',
  untitled: 'it has no title',
  'own-process': 'it belongs to Interview Studio',
  'already-tool-window': 'it is already hidden from the taskbar',
  'shell-surface': 'it is part of the Windows shell'
}

/** Why a window cannot be stealthed, or null when it is eligible. */
export function foreignWindowRejection(candidate: ForeignWindowCandidate): ForeignWindowRejection | null {
  if (!candidate.visible) return 'invisible'
  if (candidate.cloaked) return 'cloaked'
  if (!candidate.title.trim()) return 'untitled'
  if (candidate.pid === candidate.ownPid) return 'own-process'
  if ((candidate.exStyle >>> 0) & WS_EX_TOOLWINDOW) return 'already-tool-window'
  if (SHELL_WINDOW_CLASSES.includes(candidate.windowClass)) return 'shell-surface'
  return null
}

export function rejectionReason(rejection: ForeignWindowRejection): string {
  return REJECTION_REASONS[rejection]
}

export function isEligibleForeignWindow(candidate: ForeignWindowCandidate): boolean {
  return foreignWindowRejection(candidate) === null
}

/** Adds WS_EX_TOOLWINDOW and clears WS_EX_APPWINDOW, preserving every other bit. */
export function computeForeignExStyle(original: number): number {
  const style = original >>> 0
  return ((style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW) >>> 0
}

/** The standard visible style: clears WS_EX_TOOLWINDOW and restores WS_EX_APPWINDOW. */
export function computeNormalExStyle(original: number): number {
  const style = original >>> 0
  return ((style | WS_EX_APPWINDOW) & ~WS_EX_TOOLWINDOW) >>> 0
}

/** The exact original style, normalized to its unsigned 32-bit pattern. */
export function restoreForeignExStyle(original: number): number {
  return original >>> 0
}

export function sanitizeWindowTitle(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, max) : ''
}

/** HWND keys cross IPC as decimal strings and are re-validated before every use. */
export function normalizeHwndKey(value: unknown): string | null {
  const key = typeof value === 'string' ? value.trim() : ''
  return /^\d{1,12}$/.test(key) ? key : null
}

/** The steps a plan would perform, used for user-facing messages. */
export function summarizeApplyPlan(plan: StealthApplyPlan): string[] {
  const steps: string[] = []
  if (plan.captureProtection) steps.push('excluded from screen shares')
  if (plan.hideFromTaskbar) steps.push('hidden from the taskbar and Alt-Tab')
  return steps
}
