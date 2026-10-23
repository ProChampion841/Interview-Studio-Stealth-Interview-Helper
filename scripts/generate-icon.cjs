// Render the editable SVG source into the PNG used by the Windows app.
const electron = require('electron')
if (typeof electron === 'string') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = electron
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const { resolve, join } = require('node:path')
app.setPath('userData', mkdtempSync(join(require('node:os').tmpdir(), 'studio-icon-')))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 512, height: 512, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000', webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    const svg = readFileSync(resolve(__dirname, '../build/logo.svg'), 'utf8')
    const html = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:512px;height:512px;background:transparent;overflow:hidden}svg{display:block}</style>' + svg
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const bitmap = await window.webContents.capturePage()
    if (bitmap.isEmpty()) throw new Error('Logo rendering failed.')
    writeFileSync(resolve(__dirname, '../build/icon.png'), bitmap.toPNG())
    console.log('Generated build/icon.png from build/logo.svg (512 × 512).')
    window.destroy(); app.quit()
  } catch (error) { console.error(error); window.destroy(); app.exit(1) }
})
