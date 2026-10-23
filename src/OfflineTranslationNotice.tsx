import { Download } from 'lucide-react'
import { translationLanguage } from '../shared/caption-translation'
import type { CaptionControls } from './lib/use-captions'

export default function OfflineTranslationNotice({ captions }: { captions: CaptionControls }) {
  if (captions.translationProvider !== 'offline' || captions.translationTarget === 'off' || captions.offlineReady) return null
  const target = translationLanguage(captions.translationTarget), pack = captions.offlinePack
  const active = pack?.state === 'downloading' || pack?.state === 'installing'
  const anyDownload = captions.offlinePacks.status?.packs.some(pack => pack.state === 'downloading' || pack.state === 'installing')
  return <div className="offline-translation-notice" role="status">
    <div><strong>English → {target.name}</strong><span>{!captions.offlinePacks.status ? 'Checking downloaded packs…' : !pack ? 'No offline pack is available for this language. Choose another target or an online provider.' : pack.state === 'error' ? pack.message : active ? `${pack.state === 'installing' ? 'Installing' : 'Downloading'} language pack · ${Math.floor(pack.downloadedBytes / pack.bytes * 100)}%` : 'Download this language pack once to translate offline.'}</span>{captions.offlinePacks.error && <span>{captions.offlinePacks.error}</span>}</div>
    {pack && (active ? <button type="button" disabled={captions.offlinePacks.busy} onClick={() => void captions.offlinePacks.cancel()}>Cancel download</button> : <button type="button" disabled={captions.offlinePacks.busy || anyDownload} onClick={() => void captions.offlinePacks.download(pack.language)}><Download size={13} />{pack.state === 'error' ? 'Retry' : 'Download'} · {Math.ceil(pack.bytes / 1_000_000)} MB</button>)}
  </div>
}
