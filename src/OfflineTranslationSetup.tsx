import { useState } from 'react'
import { Check, Download, HardDrive, LoaderCircle, Trash2 } from 'lucide-react'
import { translationLanguage } from '../shared/caption-translation'
import { useOfflineTranslationPacks } from './lib/use-offline-translation-packs'

export default function OfflineTranslationSetup() {
  const packs = useOfflineTranslationPacks(true)
  const [search, setSearch] = useState('')
  const downloading = packs.status?.packs.find(pack => pack.state === 'downloading' || pack.state === 'installing')
  const rows = packs.status?.packs.filter(pack => {
    const language = translationLanguage(pack.language)
    return `${language.name} ${language.native}`.toLowerCase().includes(search.toLowerCase().trim())
  })
  return <div className="offline-translation-setup">
    <div className="offline-model-heading"><HardDrive size={18} /><div><strong>Offline language packs</strong><span>English captions → your target language · CPU · No API key</span></div></div>
    <p>Download only the languages you need. Installed packs work without internet. This version translates English captions; other source languages need an online provider.</p>
    <input type="search" aria-label="Search offline languages" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a language…" />
    {!packs.status && !packs.error && <p role="status"><LoaderCircle size={14} className="connection-spinner" /> Checking local packs…</p>}
    <div className="offline-pack-list" aria-label="Offline language packs">
      {rows?.map(pack => {
        const language = translationLanguage(pack.language), active = downloading?.language === pack.language, ready = pack.state === 'ready'
        return <div className="offline-pack-row" key={pack.language}>
          <div className="offline-pack-name"><strong>{language.name}{ready && <Check size={13} />}</strong><small>{language.native} · {Math.ceil(pack.bytes / 1_000_000)} MB {ready ? '· Installed' : ''}</small></div>
          {active ? <div className="offline-pack-download"><progress aria-label={`${language.name} download progress`} max={pack.bytes} value={pack.downloadedBytes} /><span>{pack.state === 'installing' ? 'Installing…' : `${Math.floor(pack.downloadedBytes / pack.bytes * 100)}%`}</span><button type="button" className="secondary-button" disabled={packs.busy} onClick={() => void packs.cancel()}>Cancel</button></div> : ready ? <button type="button" className="danger-text" aria-label={`Remove ${language.name} offline pack`} disabled={packs.busy || Boolean(downloading)} onClick={() => void packs.remove(pack.language)}><Trash2 size={14} />Remove</button> : <button type="button" className="secondary-button" aria-label={`Download ${language.name} offline pack`} disabled={packs.busy || Boolean(downloading)} onClick={() => void packs.download(pack.language)}><Download size={14} />{pack.state === 'error' ? 'Retry' : 'Download'}</button>}
          {pack.message && (pack.state === 'error' || active) && <p className={pack.state === 'error' ? 'field-error' : ''} role="status">{pack.message}</p>}
        </div>
      })}
      {rows?.length === 0 && <p>No matching offline pack. Tamil and Telugu are currently available through online translation only.</p>}
    </div>
    {packs.error && <p className="connection-status error" role="alert">{packs.error}</p>}
    <p>Pack sizes are download sizes. You can cancel a download or remove a pack to free space. For fully offline captions and translation, also select Offline under Caption transcription. Speed and translation quality depend on the language and your CPU.</p>
  </div>
}
