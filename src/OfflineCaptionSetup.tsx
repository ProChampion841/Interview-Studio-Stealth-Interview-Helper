import { useEffect, useState } from 'react'
import { Check, Download, HardDrive, LoaderCircle } from 'lucide-react'
import type { OfflineModelStatus } from '../shared/captions'

export default function OfflineCaptionSetup() {
  const [status, setStatus] = useState<OfflineModelStatus | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  useEffect(() => {
    const studio = window.studio
    if (!studio) { setError('Offline captions require the desktop app.'); return }
    let mounted = true
    const update = (value: OfflineModelStatus) => { if (mounted) setStatus(value) }
    const unsubscribe = studio.onOfflineModelStatus(update)
    void studio.getOfflineModels().then(update).catch(() => { if (mounted) setError('Could not check local models. Reopen Settings to try again.') })
    return () => { mounted = false; unsubscribe() }
  }, [])
  const downloading = status?.state === 'downloading'
  const checking = !status || status.state === 'checking'
  const ready = status?.state === 'ready'
  const act = async (cancel: boolean) => {
    setWorking(true); setError('')
    try {
      const studio = window.studio!
      setStatus(await (cancel ? studio.cancelOfflineModelDownload() : studio.downloadOfflineModels()))
    } catch { setError('Could not update the model download. Check your connection and try again.') }
    finally { setWorking(false) }
  }
  const progress = status?.totalBytes ? Math.round(status.downloadedBytes / status.totalBytes * 100) : 0
  return <div className="offline-caption-setup">
    <div className="offline-model-heading"><HardDrive size={18} /><div><strong>Live English captions</strong><span>Runs on your CPU · No API key · Audio stays on this PC</span></div>{ready ? <Check size={18} /> : checking ? <LoaderCircle className="spin" size={18} /> : null}</div>
    <p role="status">{status?.message ?? 'Checking local models…'}</p>
    {downloading && <div className="offline-model-progress"><progress max={status.totalBytes} value={status.downloadedBytes} aria-label="Offline model download" /><span>{progress}% · {(status.downloadedBytes / 1_000_000).toFixed(1)} / {(status.totalBytes / 1_000_000).toFixed(1)} MB</span></div>}
    {!ready && <div className="settings-actions"><button type="button" className={downloading ? 'secondary-button' : 'primary-button'} disabled={working || checking} onClick={() => void act(Boolean(downloading))}>{downloading ? 'Cancel download' : <><Download size={14} />{status?.state === 'error' ? 'Retry model download' : `Download models (about ${Math.ceil((status?.totalBytes ?? 81_000_000) / 1_000_000)} MB)`}</>}</button></div>}
    {(error || status?.state === 'error') && <div className="connection-status error" role="alert">{error || status?.message}</div>}
    <p className="offline-model-note">Only model setup needs internet. Captions update as speech is recognized; speed depends on your CPU. Microphone audio is labeled YOU; computer audio is labeled Professional. Your chat provider stays unchanged and may still use an online service.</p>
  </div>
}
