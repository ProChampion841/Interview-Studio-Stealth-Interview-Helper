const { open } = require('node:fs/promises')
const { join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

module.exports = async function waitForWindowsExecutable(context) {
  if (context.electronPlatformName !== 'win32') return

  const executable = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  )

  // Antivirus scanners can briefly lock a newly unpacked Electron binary.
  // Let the initial scan begin, then wait until resource editing can open it.
  await delay(3_000)
  let lastError

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const handle = await open(executable, 'r+')
      await handle.close()
      return
    } catch (error) {
      if (!error || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error
      lastError = error
      await delay(1_000)
    }
  }

  throw lastError ?? new Error(`Timed out waiting for ${executable} to become writable.`)
}
