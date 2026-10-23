import { useEffect, useMemo, useRef, useState } from 'react'
import { Captions, ChevronDown, Download, Info, LoaderCircle, MessageSquarePlus, Mic, MicOff, MonitorUp, Pause, Pencil, Play, RotateCcw, ShieldCheck, SlidersHorizontal, Sparkles, Square, X } from 'lucide-react'
import { CAPTION_PROVIDER_NAMES, CAPTION_SOURCE_LABELS, groupCaptionTurns, splitCaptionTurns, type CaptionInput } from '../shared/captions'
import { translationLanguage } from '../shared/caption-translation'
import type { CaptionControls } from './lib/use-captions'
import ActionMenu from './ActionMenu'
import CaptionTranslationMenu from './CaptionTranslationMenu'
import OfflineTranslationNotice from './OfflineTranslationNotice'
import { captionExcerpt, captionQuestion, latestCaptionQuestion, type CaptionContextItem, type CaptionQuestion } from '../shared/caption-question'
import { captionSelection, type CaptionSelection } from './lib/caption-selection'
import { memoryPassageText, type MemoryPassage } from '../shared/conversation-memory'
import CaptionContext from './CaptionContext'

export interface CaptionActions {
  onDraft: (question: CaptionQuestion) => void
  onEdit: (question: CaptionQuestion) => void
  onAddContext: (item: CaptionContextItem) => void
  onNotice: (message: string) => void
  busy: boolean
  shortcutEnabled: boolean
  onShortcutChange: (enabled: boolean) => void
  selectedCaptionIds?: readonly string[]
  hasSavedQuestion?: (text: string, ids: string[]) => boolean
  canRetryQuestion?: (text: string, ids: string[]) => boolean
  summary?: MemoryPassage[]
}

export default function CaptionsPanel({ captions, actions, onClose, compact = false }: {
  captions: CaptionControls; actions: CaptionActions; onClose: () => void; compact?: boolean
}) {
  const [filter, setFilter] = useState<'all' | 'others' | 'me'>('all')
  const [fontSize, setFontSize] = useState(18)
  const [follow, setFollow] = useState(true)
  const [visibleCount, setVisibleCount] = useState(200)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<CaptionSelection>()
  const busy = captions.status === 'starting'
  const providerName = CAPTION_PROVIDER_NAMES[captions.provider]
  const running = captions.status === 'listening' || captions.status === 'paused'
  const startingLabel = captions.provider === 'offline' ? 'Loading models…' : 'Connecting…'
  const status = { idle: 'Off', starting: startingLabel, listening: 'Listening', paused: 'Paused', error: 'Stopped' }[captions.status]
  const filtered = useMemo(() => {
    const parts = splitCaptionTurns(captions.lines)
    return groupCaptionTurns(captions.lines).map((line, index) => ({ ...line, parts: parts[index] }))
      .filter(line => filter === 'all' || (filter === 'me' ? line.source === 'microphone' : line.source === 'computer'))
  }, [captions.lines, filter])
  const target = captions.translationTarget === 'off' ? undefined : translationLanguage(captions.translationTarget)
  const shown = filtered.slice(compact ? -3 : -visibleCount)
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [captions.lines, filter, follow, target?.id, captions.translationView, captions.translationPending])
  useEffect(() => {
    const read = () => {
      if (!scrollRef.current) return
      const next = captionSelection(scrollRef.current)
      setSelection(next)
      if (next) setFollow(false)
    }
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [])
  const latest = useMemo(() => { try { return latestCaptionQuestion(captions.lines) } catch { return undefined } }, [captions.lines])
  const act = (kind: 'draft' | 'edit' | 'context', articleId: string, ids: string[]) => {
    try {
      const chosen = selection?.articleId === articleId ? selection : undefined
      if (kind === 'context') actions.onAddContext(captionExcerpt(captions.lines, chosen?.ids ?? ids, chosen?.text))
      else {
        const input = captionQuestion(captions.lines, chosen?.ids ?? ids, chosen?.text)
        if (kind === 'draft') actions.onDraft(input)
        else actions.onEdit(input)
      }
    } catch (error) { actions.onNotice(error instanceof Error ? error.message : 'Could not use this caption. Select it again.') }
  }
  const choices: Array<{ value: CaptionInput; label: string }> = [{ value: 'both', label: 'Microphone + computer' }, { value: 'computer', label: 'Computer audio' }, { value: 'microphone', label: 'Microphone' }]
  return <section className={`captions-panel ${compact ? 'compact-captions' : ''}`} aria-label="Live captions">
    <div className="captions-heading"><div><Captions size={17} /><strong>Live captions</strong><span className={`caption-status ${captions.status}`} role="status"><i />{status}</span></div><div className="caption-heading-actions">
      <ActionMenu label="Caption options" icon={<SlidersHorizontal size={15} />} closeOnSelect={false}>
        <div className="caption-option-section"><strong>Audio source</strong><div className="caption-source-options" role="group" aria-label="Caption audio sources">{choices.map(choice => <button type="button" key={choice.value} disabled={running || busy} aria-pressed={captions.input === choice.value} onClick={() => captions.setInput(choice.value)}>{choice.label}</button>)}</div></div>
        <div className="caption-option-section"><strong>Show captions</strong><div className="caption-filters" aria-label="Filter captions">{(['all', 'others', 'me'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setFollow(true) }}>{value === 'all' ? 'All' : value === 'others' ? 'Professional' : 'YOU'}</button>)}</div></div>
        <div className="caption-option-section caption-size-option"><strong>Text size</strong><div className="caption-font"><button type="button" aria-label="Smaller caption text" disabled={fontSize <= 13} onClick={() => setFontSize(size => size - 1)}>A−</button><span>{fontSize}</span><button type="button" aria-label="Larger caption text" disabled={fontSize >= 24} onClick={() => setFontSize(size => size + 1)}>A+</button></div></div>
        <div className="caption-option-section caption-question-options">
          <button type="button" disabled={!latest || actions.busy} onClick={() => latest && actions.onDraft(latest)}><Sparkles size={13} /> Draft latest question</button>
          <label><input type="checkbox" checked={actions.shortcutEnabled} onChange={event => actions.onShortcutChange(event.target.checked)} /> Enable keyboard shortcut</label>
          <small>Ctrl / Cmd + Shift + Enter · while this app is focused</small>
        </div>
        <div className="caption-meters"><span><Mic size={12} /> YOU <meter min="0" max="1" value={captions.levels.microphone} aria-label="Your microphone level" /></span><span><MonitorUp size={12} /> Professional <meter min="0" max="1" value={captions.levels.computer} aria-label="Computer audio level" /></span></div>
        <CaptionContext items={(actions.summary ?? []).map(item => ({ ...item, text: memoryPassageText(item) }))} label="Conversation summary" />
        <p className="caption-help">Microphone audio is labeled YOU; computer audio is labeled Professional. When using PC speakers, mute your mic while listening to help prevent duplicate captions. Use captions with participants’ permission.</p>
      </ActionMenu>
      <button type="button" className="icon-button" aria-label="Collapse live captions" title="Collapse captions" onClick={onClose}><X size={15} /></button>
    </div></div>
    <div className="caption-controls">
      {!running ? <button type="button" className="caption-start" title={`Start captions with ${providerName}`} disabled={busy} onClick={() => void captions.start()}><Play size={13} />{busy ? startingLabel : 'Start captions'}</button> : <>
        <button type="button" onClick={captions.status === 'paused' ? captions.resume : captions.pause}>{captions.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}{captions.status === 'paused' ? 'Resume' : 'Pause'}</button>
      </>}
      {(running || busy) && <button type="button" onClick={captions.stop}><Square size={12} /> Stop</button>}
      {captions.input !== 'computer' && <button type="button" className={captions.microphoneMuted ? 'mic-muted' : ''} aria-label={captions.microphoneMuted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={captions.microphoneMuted} disabled={busy} title="Control microphone captions while computer captions continue" onClick={captions.toggleMicrophone}>{captions.microphoneMuted ? <MicOff size={13} /> : <Mic size={13} />}{captions.microphoneMuted ? 'Unmute mic' : 'Mute mic'}</button>}
      <CaptionTranslationMenu captions={captions} />
      {filter !== 'all' && <button type="button" className="caption-filter-indicator" title="Show all captions" onClick={() => setFilter('all')}>{filter === 'me' ? 'YOU' : 'Professional'} <X size={11} /></button>}
    </div>
    {captions.error && <p className="caption-error" role="alert">{captions.error}</p>}
    <OfflineTranslationNotice captions={captions} />
    {captions.translationError && <div className="caption-translation-error" role="status"><span>{captions.translationError}</span><button type="button" onClick={captions.retryTranslation}>Retry translation</button></div>}
    <div className="caption-lines" ref={scrollRef} role="log" aria-label="Your captions and professional captions" aria-live="polite" onScroll={event => { const el = event.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 45) }} style={{ fontSize }}>
      {!compact && filtered.length > visibleCount && <button type="button" className="caption-earlier" onClick={() => { setFollow(false); setVisibleCount(count => count + 200) }}>Show earlier captions</button>}
      {!shown.length && <div className="captions-empty"><Captions size={26} strokeWidth={1.4} /><strong>{running ? 'Listening for speech' : 'Your conversation, in words'}</strong><span>{running ? 'YOU and Professional captions will appear here.' : 'Start captions to follow your microphone and computer audio.'}</span></div>}
      {shown.map(line => {
        const chosen = selection?.articleId === line.id ? selection : undefined
        const saved = actions.hasSavedQuestion?.(chosen?.text ?? line.text, chosen?.ids ?? line.parts.map(part => part.id))
        const retry = actions.canRetryQuestion?.(chosen?.text ?? line.text, chosen?.ids ?? line.parts.map(part => part.id))
        return <article key={line.id} data-caption-article={line.id} className={`caption-line ${line.source === 'microphone' ? 'self' : 'other'} ${line.parts.some(part => actions.selectedCaptionIds?.includes(part.id)) ? 'question-selected' : ''}`}>
        <div className="caption-source">
          <span>{CAPTION_SOURCE_LABELS[line.source]}</span>
          {line.isFinal === false && <small className="caption-draft">{captions.status === 'paused' ? 'Draft' : 'Live'}</small>}
          <time>{Math.floor(line.startMs / 60_000)}:{String(Math.floor(line.startMs / 1000) % 60).padStart(2, '0')}</time>
        </div>
        {!target ? <p data-caption-selectable>{line.parts.map((part, index) => <span key={part.id} data-caption-part={part.id}>{index > 0 ? ' ' : ''}{part.text}</span>)}</p> : line.parts.map(part => {
          const current = part.translation?.language === target.id && (!part.translation.engine || part.translation.engine === captions.translationEngine) ? part.translation : undefined
          const skipped = current?.skipped === 'content_filter'
          const translated = skipped ? undefined : current
          const pending = captions.translationPending.has(part.id)
          const retrying = captions.translationRetryPending.has(part.id)
          const retryError = captions.translationRetryErrors.get(part.id)
          const download = captions.offlinePacks.status?.packs.find(pack => pack.language === target.id)
          const downloading = download?.state === 'downloading' || download?.state === 'installing'
          return <div key={part.id} className={`caption-pair ${translated ? 'has-translation' : ''}`}>
            {(captions.translationView === 'both' || !translated) && <p className="caption-original" dir="auto" data-caption-selectable data-caption-part={part.id}>{part.text}</p>}
            {(translated || (pending && !skipped)) && <div className="caption-translated" lang={target.id} dir="auto"><span className="caption-translation-label">{target.native}{translated?.via === 'offline' && <small>Offline · English source</small>}{pending ? <small>{translated ? 'Updating…' : 'Translating…'}</small> : translated?.sourceText !== part.text && translated ? <small>Partial translation</small> : null}</span>{translated && <p data-caption-selectable data-caption-part={part.id}>{translated.text}</p>}</div>}
            {skipped && <span className="caption-translation-skipped" title="The provider declined this passage. New captions will continue translating."><Info size={12} aria-hidden="true" /><span>{retrying ? 'Retrying translation…' : 'Translation skipped for this passage'}</span><button type="button" className="caption-passage-retry" aria-label="Retry translation for this passage" title="Retry with your selected provider, then try offline if needed. Offline packs require English source captions." disabled={pending} onClick={() => captions.retryTranslationPassage(part.id)}>{retrying ? <LoaderCircle size={13} className="spin" /> : <RotateCcw size={13} />}</button></span>}
            {skipped && retryError && <div className="caption-passage-error" role="status">
              <span>{retryError.message}</span>
              {retryError.offlineIssue === 'missing_pack' && download && download.state !== 'ready' && <>
                <button type="button" disabled={captions.offlinePacks.busy || downloading || captions.offlinePacks.status?.packs.some(pack => pack.state === 'downloading' || pack.state === 'installing')} onClick={() => void captions.offlinePacks.download(target.id)}><Download size={12} />{downloading ? download.state === 'installing' ? 'Installing pack…' : `Downloading · ${Math.floor(download.downloadedBytes / download.bytes * 100)}%` : `Download pack · ${Math.ceil(download.bytes / 1_000_000)} MB`}</button>
                {downloading && <button type="button" disabled={captions.offlinePacks.busy} onClick={() => void captions.offlinePacks.cancel()}>Cancel download</button>}
                {download.state === 'error' && <small>{download.message}</small>}
              </>}
              {retryError.offlineIssue === 'missing_pack' && download?.state === 'ready' && <small>Pack installed. Use the retry icon to translate this passage.</small>}
              {captions.offlinePacks.error && <small>{captions.offlinePacks.error}</small>}
            </div>}
          </div>
        })}
        <div className="caption-actions" onPointerDown={event => { if (selection?.articleId === line.id) event.preventDefault() }}>
          <button type="button" className="caption-use" disabled={line.source === 'computer' && actions.busy && !saved} title={line.source === 'computer' ? saved ? 'Show the saved answers for this question' : 'Draft an answer using this caption and nearby conversation' : 'Add this caption as context for your next question'} onClick={() => act(line.source === 'computer' ? 'draft' : 'context', line.id, line.parts.map(part => part.id))}>
            {line.source === 'computer' ? retry ? <RotateCcw size={12} /> : <Sparkles size={12} /> : <MessageSquarePlus size={12} />}
            {line.source === 'computer' ? saved ? 'View answers' : retry ? 'Retry answer' : selection?.articleId === line.id ? 'Draft selection' : 'Draft answer' : selection?.articleId === line.id ? 'Add selection as context' : 'Add as context'}
          </button>
          <ActionMenu label="More caption actions" icon={<ChevronDown size={13} />}>
            <button type="button" onClick={() => act('edit', line.id, line.parts.map(part => part.id))}><Pencil size={13} /> Edit before sending</button>
            {line.source === 'computer' && <button type="button" onClick={() => act('context', line.id, line.parts.map(part => part.id))}><MessageSquarePlus size={13} /> Add as context</button>}
          </ActionMenu>
        </div>
      </article>})}
    </div>
    {!follow && !compact && <button type="button" className="caption-latest" onClick={() => setFollow(true)}>Jump to latest</button>}
    {!compact && <p className="caption-disclosure"><ShieldCheck size={12} />{captions.provider === 'offline' ? 'Audio stays on this PC.' : `Audio is sent to ${providerName} while captions run.`}{target && <span>Translation: {captions.translationProviderName} · text only</span>}</p>}
  </section>
}
