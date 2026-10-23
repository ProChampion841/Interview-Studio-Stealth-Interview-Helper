import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as Record<string, unknown>
}

describe('product boundary', () => {
  it('ships the stealth window-privacy feature and keeps it wired to the main process', () => {
    const main = readSource('electron/main/index.ts')
    const preload = readSource('electron/preload/index.ts')

    expect(main).toMatch(/function applyStealth\(\)/)
    expect(main).toMatch(/function togglePanicHide\(\)/)
    expect(main).toMatch(/window\.setContentProtection\(/)
    expect(main).toMatch(/window\.setSkipTaskbar\(/)
    expect(main).toMatch(/page-title-updated/)
    expect(main).toMatch(/globalShortcut\.register\(PANIC_SHORTCUT/)
    expect(preload).toMatch(/IPC\.stealthSet/)
    expect(preload).toMatch(/panicHide/)
  })

  it('enforces live-session consent in the main process for the requesting renderer', () => {
    const main = readSource('electron/main/index.ts')
    const preload = readSource('electron/preload/index.ts')

    expect(main).toMatch(/function parseCoachRequest\(value: unknown, ownerId: number\)/)
    expect(main).toMatch(/mode === 'live'\s*&&\s*!validateConsent\(consentToken, 'session', ownerId\)/)
    expect(main).toMatch(/parseCoachRequest\(rawRequest, event\.sender\.id\)/)
    expect(preload).toMatch(/consentToken:\s*input\.consentToken/)
  })

  it('binds microphone consent to its renderer and permits only one token claim', () => {
    const main = readSource('electron/main/index.ts')

    expect(main).toMatch(/ownerId:\s*event\.sender\.id/)
    expect(main).toMatch(/claimed:\s*false/)
    expect(main).toMatch(/grant\.ownerId !== ownerId \|\| grant\.claimed/)
    expect(main).toMatch(/grant\.claimed = true/)
    expect(main).toMatch(/claimConsent\(input\.consentToken, 'microphone', ownerId\)/)
    expect(main).toMatch(/createRealtimeToken\(request, event\.sender\.id\)/)
    expect(main).toMatch(/hasActiveConsent\('microphone', webContents\.id, true\)/)
    expect(main).toMatch(/grant\?\.ownerId === event\.sender\.id\) consentGrants\.delete\(token\)/)
  })

  it('consumes capture consent once and binds it to the requesting renderer', () => {
    const main = readSource('electron/main/index.ts')
    const preload = readSource('electron/preload/index.ts')

    expect(main).toMatch(/if \(consume\) consentGrants\.delete\(token\)/)
    expect(main).toMatch(/validateConsent\(token, 'capture', event\.sender\.id, true\)/)
    expect(preload).toMatch(/invoke\(IPC\.consentRequest, 'capture'\)/)
    expect(preload).toMatch(/invoke\(IPC\.captureListSources, grant\.token\)/)
  })

  it('carries the selected job context into coach requests in the main process', () => {
    const main = readSource('electron/main/index.ts')

    expect(main).toMatch(/const jobId = cleanString\(input\.jobId, LIMITS\.jobIdChars\)/)
    expect(main).toMatch(/jobId: jobId \|\| undefined/)
    expect(main).toMatch(/const job = request\.jobId/)
    expect(main).toMatch(/jobDescription: job\?\.jobDescription/)
  })

  it('restores every modified foreign window when the application quits', () => {
    const main = readSource('electron/main/index.ts')
    const stealth = readSource('electron/main/window-stealth.ts')

    const quitHandler = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('will-quit'"))
    expect(quitHandler).toContain('await flushConversationHistory()')
    expect(quitHandler).toContain('await restoreAllForeignWindows()')
    expect(quitHandler.indexOf('await flushConversationHistory()')).toBeLessThan(quitHandler.indexOf('await restoreAllForeignWindows()'))
    expect(main).toMatch(/event\.preventDefault\(\)/)
    expect(main).toMatch(/foreignWindowsRestoredForQuit = true\s*app\.quit\(\)/)
    expect(main).toMatch(/primeForeignWindowBindings\(\)/)
    expect(stealth).toMatch(/export function restoreAllForeignWindows/)
    expect(stealth).toMatch(/captureExclusion: changed\.includes\('capture'\)/)
    expect(stealth).toMatch(/refreshTaskbarPresence|applyStyleAndRefresh/)
    expect(stealth).toMatch(/applyStyleAndRefresh\(hwnd, computeForeignExStyle\(originalExStyle\)\)/)
    expect(stealth).toMatch(/createTaskbarVisibility/)
    expect(stealth).toMatch(/bindings\.redrawWindow\(hwnd\)/)
    expect(stealth).not.toMatch(/ShowWindow|showWindow\(/)
    expect(main).toMatch(/captureProtection: stealth\.enabled && stealth\.captureProtection/)
    expect(main).toMatch(/hideFromTaskbar: stealth\.enabled && stealth\.hideFromTaskbar/)
  })

  it('excludes the focused foreign window from capture through an in-process helper call', () => {
    const inject = readSource('electron/main/foreign-inject.ts')
    const stealth = readSource('electron/main/window-stealth.ts')
    const settings = readSource('src/App.tsx')

    expect(stealth).toMatch(/import \{ setForeignDisplayAffinity \} from '\.\/foreign-inject'/)
    expect(stealth).toMatch(/displayAffinityFor\(osBuildNumber\(\), true\)/)
    expect(stealth).toMatch(/captureExclusion: changed\.includes\('capture'\)/)
    expect(inject).toMatch(/CreateRemoteThread/)
    expect(inject).toMatch(/SetWindowDisplayAffinity/)
    expect(inject).not.toMatch(/ShellExecute|runas/i)
    expect(settings).toMatch(/Interview Studio asks the focused application to apply the exclusion itself/)
    expect(settings).toMatch(/excluded from screen shares and hidden from the taskbar and Alt-Tab/)
  })

  it('toggles the focused foreign window from a configurable global hotkey', () => {
    const main = readSource('electron/main/index.ts')
    const settings = readSource('src/App.tsx')
    const bridge = readSource('src/global.d.ts')

    expect(main).toMatch(/const FOREIGN_SHORTCUT_CANDIDATES/)
    expect(main).toMatch(/const RESTORE_SHORTCUT_CANDIDATES/)
    expect(main).not.toMatch(/CommandOrControl\+Alt\+/)
    expect(main).toMatch(/globalShortcut\.register\(candidate/)
    expect(main).toMatch(/foreignShortcutActive = candidate/)
    expect(main).toMatch(/toggleForeignWindowStealth\(ownHwndString\(\), process\.pid, foreignApplyPlan\(\)\)/)
    expect(main).toMatch(/sendStealthEvent\(\{ foreign: result\.message \}\)/)
    expect(main).toMatch(/foreignShortcut: shortcutLabel\(foreignShortcutActive \|\| FOREIGN_SHORTCUT_CANDIDATES\[0\]\)/)
    expect(main).toMatch(/restoreShortcut: shortcutLabel\(restoreShortcutActive \|\| RESTORE_SHORTCUT_CANDIDATES\[0\]\)/)
    expect(main).toMatch(/IPC\.stealthForeignSetHotkey, \(event[\s\S]{0,140}assertTrustedSender\(event\)/)
    expect(main).toMatch(/restoreHotkey: requested \}/)
    expect(main).toMatch(/foreignHotkey: requested \}/)
    expect(main).toMatch(/restoreAllForeignHotkey\(\)/)
    expect(settings).toMatch(/payload\.foreign === 'string'/)
    expect(bridge).toMatch(/setForeignHotkey: \(accelerator: string, kind\?: "toggle" \| "restore"\) => Promise<StudioForeignHotkeyResult>/)
  })

  it('keeps the foreign-window disclosure honest in the interface', () => {
    const settings = readSource('src/App.tsx')
    const preload = readSource('electron/preload/index.ts')

    expect(settings).toMatch(/every modified window is restored when the app closes/)
    expect(settings).toMatch(/Interview Studio asks the focused application to apply the exclusion itself/)
    expect(settings).toMatch(/ForeignHotkeyCapture/)
    expect(preload).toMatch(/IPC\.stealthForeignSetHotkey/)
    expect(preload).toMatch(/setForeignHotkey: \(accelerator: string, kind\?: 'toggle' \| 'restore'\)/)
  })

  it('ships koffi as a production dependency and unpacks it from the asar', () => {
    const pkg = readJson('package.json') as { dependencies?: Record<string, string>; build?: Record<string, unknown> }
    expect(pkg.dependencies?.koffi).toMatch(/^\^?\d+\./)
    expect(JSON.stringify(pkg.build?.asarUnpack)).toContain('koffi')
  })

  it('keeps the realtime OpenAI HTTP exchange behind the trusted desktop bridge', () => {
    const realtime = readSource('src/lib/realtime.ts')
    const preload = readSource('electron/preload/index.ts')
    const main = readSource('electron/main/index.ts')

    expect(realtime).not.toMatch(/\bfetch\s*\(\s*['"`]https:\/\/api\.openai\.com/i)
    expect(preload).toMatch(/IPC\.realtimeExchangeSdp/)
    expect(main).toMatch(/ipcMain\.handle\(IPC\.realtimeExchangeSdp/)
    expect(main).toMatch(/https:\/\/api\.openai\.com\/v1\/realtime\/calls/)
  })

  it('allows a manual API key to override an environment fallback', () => {
    const main = readSource('electron/main/index.ts')
    const settings = readSource('src/App.tsx')

    expect(main).toMatch(/return resolveApiKey\(\{[\s\S]*memory: memoryApiKey,[\s\S]*stored: storedApiKey\(\),[\s\S]*environment: process\.env\.OPENAI_API_KEY/)
    expect(main).not.toMatch(/OPENAI_API_KEY is already set by the environment/)
    expect(settings).toMatch(/replacingKey \|\| props\.apiKeySource === "environment"/)
    expect(settings).toMatch(/Use manual API key/)
  })
})
