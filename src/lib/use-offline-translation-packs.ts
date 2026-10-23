import { useCallback, useEffect, useState } from 'react'
import type { OfflineTranslationStatus } from '../../shared/offline-translation'

export function useOfflineTranslationPacks(enabled: boolean) {
  const [status, setStatus] = useState<OfflineTranslationStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const api = window.studio
    if (!api?.getTranslationPacks) { setError('Offline translation requires the updated desktop app.'); return }
    let mounted = true
    const update = (status: OfflineTranslationStatus) => { if (mounted) setStatus(status) }
    const unsubscribe = api.onTranslationPackStatus(update)
    void api.getTranslationPacks().then(update).catch(() => { if (mounted) setError('Could not check downloaded language packs.') })
    return () => { mounted = false; unsubscribe() }
  }, [enabled])
  const download = useCallback(async (language: string) => {
    setError(''); setBusy(true)
    try { setStatus(await window.studio!.downloadTranslationPack(language)) }
    catch { setError('Could not start the download. Finish or cancel any current download and try again.') }
    finally { setBusy(false) }
  }, [])
  const cancel = useCallback(async () => {
    setError(''); setBusy(true)
    try { await window.studio!.cancelTranslationPackDownload() }
    catch { setError('Could not cancel the download. Try again.') }
    finally { setBusy(false) }
  }, [])
  const remove = useCallback(async (language: string) => {
    setError(''); setBusy(true)
    try { setStatus(await window.studio!.removeTranslationPack(language)) }
    catch { setError('Could not remove this pack. Finish or cancel any download and try again.') }
    finally { setBusy(false) }
  }, [])
  return { status, error, busy, download, cancel, remove }
}
