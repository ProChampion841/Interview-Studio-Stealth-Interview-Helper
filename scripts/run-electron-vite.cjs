const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const electronViteCli = resolve(projectRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const environment = { ...process.env }

// Cursor and VS Code terminals can inherit this flag from their Electron host.
// Leaving it set makes the child Electron process start as plain Node, where
// Electron APIs such as `app` and `BrowserWindow` are unavailable.
delete environment.ELECTRON_RUN_AS_NODE

const result = spawnSync(process.execPath, [electronViteCli, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: environment,
  stdio: 'inherit'
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
