import { randomUUID } from 'node:crypto'
import { BrowserWindow, desktopCapturer, ipcMain, screen, type IpcMainInvokeEvent, type NativeImage } from 'electron'
import { IPC, LIMITS, type CaptureSource } from '../../shared/contracts'
import { areaToPixels } from '../../shared/screenshots'

interface OverlayEntry { window: BrowserWindow; image: NativeImage; name: string }
interface AreaSession {
  entries: Map<number, OverlayEntry>
  finish(result: CaptureSource | null, error?: Error, restoreOwner?: boolean): void
}
let active: AreaSession | null = null

export function isAreaCaptureActive(): boolean { return active !== null }
export function cancelAreaCapture(): void { active?.finish(null, undefined, false) }

/** These handlers trust only the main frame of an overlay created by this session. */
export function registerAreaCaptureHandlers(isAllowedUrl: (url: string) => boolean): void {
  const entryFor = (event: IpcMainInvokeEvent): OverlayEntry => {
    const entry = active?.entries.get(event.sender.id)
    if (!entry || entry.window.isDestroyed() || event.senderFrame !== event.sender.mainFrame || !event.senderFrame || !isAllowedUrl(event.senderFrame.url)) {
      throw new Error('The area selection is no longer active.')
    }
    return entry
  }
  ipcMain.handle(IPC.captureAreaSnapshot, event => {
    const entry = entryFor(event)
    return { imageDataUrl: entry.image.toDataURL(), name: entry.name }
  })
  ipcMain.handle(IPC.captureAreaSelect, (event, area: unknown) => {
    const entry = entryFor(event)
    const size = entry.image.getSize()
    const crop = entry.image.crop(areaToPixels(area, size.width, size.height))
    const croppedSize = crop.getSize()
    const scale = Math.min(1, 1600 / Math.max(croppedSize.width, croppedSize.height))
    const image = scale < 1 ? crop.resize({ width: Math.max(1, Math.round(croppedSize.width * scale)), height: Math.max(1, Math.round(croppedSize.height * scale)) }) : crop
    const thumbnail = `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`
    if (thumbnail.length > LIMITS.imageDataUrlChars) throw new Error('This area is too large. Select a smaller area.')
    // Resolve the request back to the owner; no full-screen snapshot is returned there.
    active?.finish({ id: randomUUID(), name: `${entry.name} · selected area`, thumbnail })
  })
  ipcMain.handle(IPC.captureAreaCancel, event => { entryFor(event); active?.finish(null) })
}

export async function captureScreenArea(owner: BrowserWindow, options: {
  preload: string
  rendererUrl: string
  captureProtection: boolean
  shouldRestoreOwner: () => boolean
}): Promise<CaptureSource | null> {
  if (active) throw new Error('An area selection is already open. Finish or cancel it first.')
  let resolveResult!: (value: CaptureSource | null) => void
  let rejectResult!: (error: Error) => void
  const result = new Promise<CaptureSource | null>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  void result.catch(() => undefined)
  const wasVisible = owner.isVisible()
  const ownerContents = owner.webContents
  const ownerClosed = () => session.finish(null, undefined, false)
  const timer = setTimeout(() => session.finish(null), 120_000)
  const session: AreaSession = {
    entries: new Map(),
    finish(value, error, restoreOwner = true) {
      if (active !== session) return
      active = null
      clearTimeout(timer)
      owner.removeListener('closed', ownerClosed)
      ownerContents.removeListener('destroyed', ownerClosed)
      for (const entry of session.entries.values()) if (!entry.window.isDestroyed()) entry.window.destroy()
      session.entries.clear()
      if (restoreOwner && wasVisible && !owner.isDestroyed() && options.shouldRestoreOwner()) { owner.show(); owner.focus() }
      if (error) rejectResult(error)
      else resolveResult(value)
    }
  }
  active = session
  owner.once('closed', ownerClosed)
  ownerContents.once('destroyed', ownerClosed)
  try {
    owner.hide()
    // Let the compositor remove the app before taking the one-time snapshots.
    await new Promise(resolve => setTimeout(resolve, 120))
    if (active !== session) return result
    const displays = screen.getAllDisplays()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.min(8192, Math.max(...displays.map(d => Math.ceil(d.size.width * d.scaleFactor)))),
        height: Math.min(8192, Math.max(...displays.map(d => Math.ceil(d.size.height * d.scaleFactor))))
      }
    })
    if (active !== session) return result
    const loads: Promise<void>[] = []
    const cursor = screen.getCursorScreenPoint()
    let focusWindow: BrowserWindow | undefined
    for (const display of displays) {
      const source = sources.find(s => s.display_id === String(display.id)) ?? (displays.length === 1 ? sources[0] : undefined)
      if (!source || source.thumbnail.isEmpty()) throw new Error('A screen snapshot is unavailable. Try attaching a screenshot file instead.')
      const window = new BrowserWindow({
        ...display.bounds, show: false, frame: false, fullscreen: true, resizable: false,
        skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#111111',
        title: 'Select screenshot area',
        webPreferences: { preload: options.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
      })
      session.entries.set(window.webContents.id, { window, image: source.thumbnail, name: source.name || 'Screen' })
      window.setContentProtection(options.captureProtection)
      window.setAlwaysOnTop(true, 'screen-saver')
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', event => event.preventDefault())
      window.webContents.on('will-attach-webview', event => event.preventDefault())
      window.webContents.on('render-process-gone', () => session.finish(null, new Error('The area selector closed unexpectedly. Try again.')))
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); session.finish(null) }
      })
      window.on('closed', () => session.finish(null))
      window.once('ready-to-show', () => { if (active === session) window.showInactive() })
      if (cursor.x >= display.bounds.x && cursor.x < display.bounds.x + display.bounds.width && cursor.y >= display.bounds.y && cursor.y < display.bounds.y + display.bounds.height) focusWindow = window
      loads.push(window.loadURL(options.rendererUrl))
    }
    await Promise.all(loads)
    if (active === session) (focusWindow ?? session.entries.values().next().value?.window)?.focus()
  } catch (error) {
    session.finish(null, error instanceof Error ? error : new Error('Could not capture a screen area.'))
  }
  return result
}
