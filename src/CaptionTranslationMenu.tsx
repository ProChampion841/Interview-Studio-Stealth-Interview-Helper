import { useState } from 'react'
import { Check, Languages } from 'lucide-react'
import { TRANSLATION_LANGUAGES, translationLanguage } from '../shared/caption-translation'
import type { CaptionControls } from './lib/use-captions'
import ActionMenu from './ActionMenu'

export default function CaptionTranslationMenu({ captions }: { captions: CaptionControls }) {
  const [search, setSearch] = useState('')
  const target = captions.translationTarget
  const current = target === 'off' ? undefined : translationLanguage(target)
  const languages = TRANSLATION_LANGUAGES.filter(language => `${language.name} ${language.native}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <ActionMenu label="Translate captions" icon={<Languages size={14} />} text={current?.native ?? 'Translate'}>
    <div className="translation-menu-content">
      <strong>Translate captions</strong>
      <p>{captions.translationProvider === 'offline' ? 'English caption text is translated on this PC. Download a language pack once before using it offline.' : captions.translationProvider === 'lmstudio' ? 'Uses your configured LM Studio server.' : `Caption text will be sent to ${captions.translationProviderName}.`} Choose a language for recent passages and new speech.</p>
      <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search languages…" aria-label="Search translation languages" />
      <div className="translation-language-list" role="group" aria-label="Translation languages">
        <button type="button" aria-pressed={target === 'off'} onClick={() => { captions.setTranslationTarget('off'); setSearch('') }}>Translation off{target === 'off' && <Check size={13} />}</button>
        {languages.map(language => {
          const pack = captions.offlinePacks.status?.packs.find(pack => pack.language === language.id)
          const offline = captions.translationProvider === 'offline'
          const unavailable = offline && language.id !== 'en' && Boolean(captions.offlinePacks.status) && !pack
          return <button type="button" key={language.id} disabled={unavailable} aria-label={`Translate to ${language.name}`} aria-pressed={target === language.id} onClick={() => { captions.setTranslationTarget(language.id); setSearch('') }}><span>{language.name}{language.name !== language.native && <small>{language.native}</small>}{offline && <small>{language.id === 'en' ? 'Original English · no pack needed' : unavailable ? 'Offline pack unavailable' : !pack ? 'Checking packs…' : pack.state === 'ready' ? 'Installed · offline ready' : pack.state === 'downloading' || pack.state === 'installing' ? 'Downloading…' : `Download pack · ${Math.ceil(pack.bytes / 1_000_000)} MB`}</small>}</span>{target === language.id && <Check size={13} />}</button>
        })}
        {!languages.length && <span className="translation-no-match">No matching language.</span>}
      </div>
      <div className="translation-view-options" role="group" aria-label="Translation reading view">
        <button type="button" aria-pressed={captions.translationView === 'both'} onClick={() => captions.setTranslationView('both')}>Original + translation</button>
        <button type="button" aria-pressed={captions.translationView === 'translated'} onClick={() => captions.setTranslationView('translated')}>Translation only</button>
      </div>
      <p className="translation-provider-note">{captions.translationProvider === 'offline' ? 'Manage downloaded packs in Settings → AI connection → Caption translation. Only pack downloads use internet; translation has no cloud fallback.' : captions.translationProvider === 'lmstudio' ? 'Caption text is translated by your configured LM Studio server.' : captions.translationProvider === 'azure' || captions.translationProvider === 'google' ? `Uses your saved ${captions.translationProviderName} key. Free allowances depend on your provider plan. Configure it in Settings → AI connection → Caption translation.` : captions.translationUsesChat ? `Uses your selected chat model at ${captions.translationProviderName} and may incur API charges.` : `Uses your separate ${captions.translationProviderName} translation key and model. Provider charges and limits apply.`}</p>
    </div>
  </ActionMenu>
}
