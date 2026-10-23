/**
 * Toolchain-free capture exclusion for foreign windows.
 *
 * Windows rejects SetWindowDisplayAffinity from any process other than the
 * window's owner, so this module runs the call inside the target process: it
 * locates the target's user32!SetWindowDisplayAffinity, allocates one small
 * executable page in the target, and starts a remote thread that executes a
 * 22-byte stub calling the API with the requested affinity. The thread exits
 * immediately; nothing stays resident and no elevation is used.
 */
import {
  buildAffinityShellcode,
  computeRemoteAddress
} from '../../shared/foreign-window'

const PROCESS_ACCESS =
  0x0002 | // PROCESS_CREATE_THREAD
  0x0008 | // PROCESS_VM_OPERATION
  0x0010 | // PROCESS_VM_READ
  0x0020 | // PROCESS_VM_WRITE
  0x0400 // PROCESS_QUERY_INFORMATION
const MEM_COMMIT_RESERVE = 0x3000
const MEM_RELEASE = 0x8000
const PAGE_EXECUTE_READWRITE = 0x40
const LIST_MODULES_ALL = 0x03
const INJECT_TIMEOUT_MS = 4_000

interface KoffiLib {
  func(signature: string): (...args: unknown[]) => unknown
}

interface KoffiModule {
  load(name: string): KoffiLib
  alias(name: string, type: string): unknown
}

interface InjectBindings {
  getWindowThreadProcessId(hwnd: number): number
  openProcess(pid: number): bigint
  isWow64Process(handle: bigint): boolean | null
  closeHandle(handle: bigint): void
  getLastError(): number
  localUser32Base(): bigint | null
  getProcAddress(moduleBase: bigint, name: string): bigint | null
  remoteModuleBase(handle: bigint, baseName: string): bigint | null
  virtualAllocEx(handle: bigint, size: number): bigint | null
  writeProcessMemory(handle: bigint, address: bigint, buffer: Uint8Array): boolean
  createRemoteThread(handle: bigint, start: bigint, param: bigint): bigint | null
  waitForSingleObject(handle: bigint, timeoutMs: number): number
  getExitCodeThread(handle: bigint): number | null
  virtualFreeEx(handle: bigint, address: bigint): boolean
}

let bindings: InjectBindings | null = null
let bindingsFailure = ''
let bindingsPromise: Promise<boolean> | null = null

export interface ForeignInjectResult {
  ok: boolean
  message: string
}

async function loadBindings(): Promise<boolean> {
  if (bindings || bindingsFailure) return Boolean(bindings)
  if (!bindingsPromise) {
    bindingsPromise = (async () => {
      try {
        const imported = (await import('koffi')) as { default?: unknown } & KoffiModule
        const koffi = (imported.default ?? imported) as KoffiModule
        bindings = buildBindings(koffi)
        return true
      } catch (error) {
        bindingsFailure = 'The injection helper could not be loaded on this system.'
        console.error('Foreign-window injection unavailable:', error)
        return false
      }
    })()
  }
  return bindingsPromise
}

function buildBindings(koffi: KoffiModule): InjectBindings {
  const kernel32 = koffi.load('kernel32.dll')
  const user32 = koffi.load('user32.dll')
  koffi.alias('InjectHwnd', 'uintptr')

  const getWindowThreadProcessIdRaw = user32.func('uint32_t __stdcall GetWindowThreadProcessId(InjectHwnd hWnd, _Out_ uint32_t *pid)')

  const openProcessRaw = kernel32.func('uint64_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)')
  const isWow64Raw = kernel32.func('bool __stdcall IsWow64Process(uint64_t proc, _Out_ int32_t *wow64)')
  const closeHandleRaw = kernel32.func('bool __stdcall CloseHandle(uint64_t handle)')
  const getLastErrorRaw = kernel32.func('uint32_t __stdcall GetLastError()')
  const getModuleHandleRaw = kernel32.func('uint64_t __stdcall GetModuleHandleW(str16 name)')
  const getProcAddressRaw = kernel32.func('uint64_t __stdcall GetProcAddress(uint64_t module, str name)')
  const enumModulesRaw = kernel32.func('bool __stdcall K32EnumProcessModulesEx(uint64_t proc, _Out_ uint64_t *mods, uint32_t cb, _Out_ uint32_t *needed, uint32_t filter)')
  const getModuleBaseNameRaw = kernel32.func('uint32_t __stdcall K32GetModuleBaseNameW(uint64_t proc, uint64_t hmod, _Out_ uint16_t *name, uint32_t size)')
  const virtualAllocRaw = kernel32.func('uint64_t __stdcall VirtualAllocEx(uint64_t proc, uint64_t addr, size_t size, uint32_t type, uint32_t protect)')
  const writeMemoryRaw = kernel32.func('bool __stdcall WriteProcessMemory(uint64_t proc, uint64_t addr, const void *buf, size_t size, void *written)')
  const createThreadRaw = kernel32.func('uint64_t __stdcall CreateRemoteThread(uint64_t proc, void *attr, size_t stack, uint64_t start, uintptr_t param, uint32_t flags, void *tid)')
  const waitForRaw = kernel32.func('uint32_t __stdcall WaitForSingleObject(uint64_t handle, uint32_t ms)')
  const exitCodeRaw = kernel32.func('bool __stdcall GetExitCodeThread(uint64_t thread, _Out_ uint32_t *code)')
  const virtualFreeRaw = kernel32.func('bool __stdcall VirtualFreeEx(uint64_t proc, uint64_t addr, size_t size, uint32_t type)')

  const decoder = new TextDecoder('utf-16le')
  const readUtf16 = (typed: Uint16Array, chars: number): string => {
    const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength)
    return decoder.decode(bytes.subarray(0, Math.max(0, Math.min(bytes.length, chars * 2)))).split('\u0000')[0] ?? ''
  }

  const remoteModuleBase = (handle: bigint, baseName: string): bigint | null => {
    const mods = new BigUint64Array(1024)
    const needed = new Uint32Array(1)
    if (!enumModulesRaw(handle, mods, mods.byteLength, needed, LIST_MODULES_ALL)) return null
    const count = Math.floor(Math.min(needed[0], mods.byteLength) / 8)
    for (let index = 0; index < count; index += 1) {
      const nameBuffer = new Uint16Array(260)
      getModuleBaseNameRaw(handle, mods[index], nameBuffer, 260)
      const name = readUtf16(nameBuffer, 260)
      if (name.toLowerCase() === baseName) return mods[index]
    }
    return null
  }

  return {
    getWindowThreadProcessId: (hwnd) => {
      const out = new Uint32Array(1)
      Number(getWindowThreadProcessIdRaw(hwnd, out))
      return out[0]
    },
    openProcess: (pid) => BigInt(Number(openProcessRaw(PROCESS_ACCESS, false, pid))),
    isWow64Process: (handle) => {
      const out = new Int32Array(1)
      return isWow64Raw(handle, out) ? out[0] !== 0 : null
    },
    closeHandle: (handle) => void closeHandleRaw(handle),
    getLastError: () => Number(getLastErrorRaw()),
    localUser32Base: () => {
      const base = Number(getModuleHandleRaw('user32.dll'))
      return base ? BigInt(base) : null
    },
    getProcAddress: (moduleBase, name) => {
      const address = Number(getProcAddressRaw(moduleBase, name))
      return address ? BigInt(address) : null
    },
    remoteModuleBase,
    virtualAllocEx: (handle, size) => {
      const address = Number(virtualAllocRaw(handle, 0n, size, MEM_COMMIT_RESERVE, PAGE_EXECUTE_READWRITE))
      return address ? BigInt(address) : null
    },
    writeProcessMemory: (handle, address, buffer) =>
      Boolean(writeMemoryRaw(handle, address, buffer, buffer.length, null)),
    createRemoteThread: (handle, start, param) => {
      const thread = Number(createThreadRaw(handle, null, 0n, start, param, 0, null))
      return thread ? BigInt(thread) : null
    },
    waitForSingleObject: (handle, timeoutMs) => Number(waitForRaw(handle, timeoutMs)),
    getExitCodeThread: (handle) => {
      const out = new Uint32Array(1)
      return exitCodeRaw(handle, out) ? out[0] : null
    },
    virtualFreeEx: (handle, address) => Boolean(virtualFreeRaw(handle, address, 0n, MEM_RELEASE))
  }
}

function unsupported(): ForeignInjectResult {
  return { ok: false, message: bindingsFailure || 'The injection helper is unavailable.' }
}

/** Applies a display affinity to a foreign window from inside its own process. */
export async function setForeignDisplayAffinity(hwnd: number, affinity: number): Promise<ForeignInjectResult> {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Screen-share exclusion for other windows works on Windows only.' }
  }
  if (!(await loadBindings()) || !bindings) return unsupported()

  const api = bindings
  const pid = api.getWindowThreadProcessId(hwnd)
  if (!pid) return { ok: false, message: 'The window could not be identified.' }

  const handle = api.openProcess(pid)
  if (!handle) {
    return api.getLastError() === 5
      ? { ok: false, message: 'This application runs elevated, so its windows cannot be changed. Restart Interview Studio as administrator to include it.' }
      : { ok: false, message: 'The application could not be opened for the capture change.' }
  }

  try {
    const wow64 = api.isWow64Process(handle)
    if (wow64) {
      return { ok: false, message: 'This application is 32-bit; screen-share exclusion is unavailable for it.' }
    }

    const localBase = api.localUser32Base()
    const localAddress = localBase ? api.getProcAddress(localBase, 'SetWindowDisplayAffinity') : null
    const remoteBase = localBase ? api.remoteModuleBase(handle, 'user32.dll') : null
    if (!localBase || !localAddress || !remoteBase) {
      return { ok: false, message: 'The capture-exclusion entry point could not be located in this application.' }
    }

    const code = buildAffinityShellcode(affinity, computeRemoteAddress(remoteBase, localBase, localAddress))
    const codeAddress = api.virtualAllocEx(handle, code.length)
    if (!codeAddress || !api.writeProcessMemory(handle, codeAddress, code)) {
      return { ok: false, message: 'The capture change could not be prepared in the application.' }
    }

    const thread = api.createRemoteThread(handle, codeAddress, BigInt(hwnd))
    if (!thread) {
      api.virtualFreeEx(handle, codeAddress)
      return { ok: false, message: 'The application rejected the capture change (it may be protected or elevated).' }
    }

    const wait = api.waitForSingleObject(thread, INJECT_TIMEOUT_MS)
    const exitCode = api.getExitCodeThread(thread)
    api.closeHandle(thread)
    api.virtualFreeEx(handle, codeAddress)
    if (wait !== 0) {
      return { ok: false, message: 'The application did not respond to the capture change in time.' }
    }
    if (exitCode === null || exitCode === 0) {
      return { ok: false, message: 'The application refused the capture-exclusion change.' }
    }
    return { ok: true, message: 'ok' }
  } finally {
    api.closeHandle(handle)
  }
}
