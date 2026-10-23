/** Update the shell taskbar without hiding or re-showing the target window. */
interface NativeLibrary {
  func(signature: string): (...args: unknown[]) => unknown
}

export interface TaskbarNativeModule {
  load(name: string): NativeLibrary
  proto(signature: string): unknown
  decode(address: unknown, type: string): unknown
  decode(address: unknown, offset: number, type: string): unknown
  call(address: unknown, prototype: unknown, ...args: unknown[]): unknown
}

// CLSID_TaskbarList and IID_ITaskbarList, in native GUID byte order.
const TASKBAR_CLASS = new Uint8Array([0x44, 0xf3, 0xfd, 0x56, 0x6d, 0xfd, 0xd0, 0x11, 0x95, 0x8a, 0, 0x60, 0x97, 0xc9, 0xa0, 0x90])
const TASKBAR_INTERFACE = new Uint8Array([0x42, 0xf3, 0xfd, 0x56, 0x6d, 0xfd, 0xd0, 0x11, 0x95, 0x8a, 0, 0x60, 0x97, 0xc9, 0xa0, 0x90])
const RPC_E_CHANGED_MODE = -2147417850

export function createTaskbarVisibility(native: TaskbarNativeModule): (hwnd: number, visible: boolean) => boolean {
  const ole32 = native.load('ole32.dll')
  const initialize = ole32.func('int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)')
  const uninitialize = ole32.func('void __stdcall CoUninitialize()')
  const create = ole32.func('int32_t __stdcall CoCreateInstance(const uint8_t *classId, void *outer, uint32_t context, const uint8_t *interfaceId, _Out_ void **object)')
  const initMethod = native.proto('int32_t __stdcall StudioTaskbarInit(void *self)')
  const visibilityMethod = native.proto('int32_t __stdcall StudioTaskbarVisibility(void *self, uintptr hwnd)')
  const releaseMethod = native.proto('uint32_t __stdcall StudioTaskbarRelease(void *self)')
  const pointerSize = process.arch === 'ia32' ? 4 : 8

  return (hwnd, visible) => {
    const initialized = Number(initialize(null, 2))
    if (initialized < 0 && initialized !== RPC_E_CHANGED_MODE) return false
    const output: unknown[] = [null]
    let object: unknown = null
    let table: unknown
    try {
      if (Number(create(TASKBAR_CLASS, null, 1, TASKBAR_INTERFACE, output)) < 0) return false
      object = output[0]
      if (!object) return false
      table = native.decode(object, 'void *')
      const method = (index: number) => native.decode(table, index * pointerSize, 'void *')
      if (Number(native.call(method(3), initMethod, object)) < 0) return false
      return Number(native.call(method(visible ? 4 : 5), visibilityMethod, object, hwnd)) >= 0
    } catch (error) {
      console.error('Taskbar visibility update failed:', error)
      return false
    } finally {
      try {
        if (object && table) native.call(native.decode(table, 2 * pointerSize, 'void *'), releaseMethod, object)
      } catch (error) {
        console.error('Taskbar interface cleanup failed:', error)
      } finally {
        // Do not uninitialize an apartment owned by Electron.
        if (initialized >= 0) uninitialize()
      }
    }
  }
}
