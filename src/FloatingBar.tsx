import { Captions, Maximize2, MicOff, Sparkles, X } from 'lucide-react'
import { CAPTION_SOURCE_LABELS } from '../shared/captions'
import { translationLanguage } from '../shared/caption-translation'
import type { CaptionControls } from './lib/use-captions'
import logoUrl from '../build/logo.svg'

export default function FloatingBar({ captions, answerStatus, historyError }: {
  captions: CaptionControls; answerStatus: 'idle' | 'thinking' | 'ready' | 'error'; historyError?: string
}) {
  const latest = [...captions.lines].reverse().find(line => line.text.trim())
  const translated = latest?.translation
  const preview = translated && !translated.skipped && translated.language === captions.translationTarget
    && (!translated.engine || translated.engine === captions.translationEngine) ? translated.text : latest?.text
  const captionStatus = { idle: 'Captions off', starting: 'Starting captions', listening: 'Listening', paused: 'Captions paused', error: 'Captions stopped' }[captions.status]
  const answer = { idle: 'Chat ready', thinking: 'Generating answer', ready: 'Answer ready', error: 'Answer issue' }[answerStatus]
  return <main className="floating-bar" aria-label="Minimized Interview Studio">
    <div className="floating-bar-heading">
      <div className="floating-bar-brand"><img src={logoUrl} width="20" height="20" alt="" draggable={false} /><strong>Interview Studio</strong><span title={historyError || 'Always on top'}>{historyError ? 'History issue' : 'On top'}</span></div>
      <div className="window-controls no-drag">
        <button type="button" aria-label="Restore workspace" title="Restore workspace" onClick={() => void window.studio?.restoreWindow()}><Maximize2 size={14} /></button>
        <button type="button" className="window-close" aria-label="Exit Interview Studio" title="Exit Interview Studio" onClick={() => void window.studio?.close()}><X size={15} /></button>
      </div>
    </div>
    <div className="floating-bar-status" role="status">
      <span className={captions.status === 'listening' ? 'is-active' : captions.status === 'error' ? 'has-error' : ''} title={captions.error || captionStatus}><Captions size={12} />{captionStatus}</span>
      <span className={answerStatus === 'thinking' ? 'is-active' : answerStatus === 'error' ? 'has-error' : ''}><Sparkles size={12} />{answer}</span>
      {captions.microphoneMuted && captions.input !== 'computer' && <span title="Your microphone captions are muted"><MicOff size={12} />Mic muted</span>}
      {captions.translationTarget !== 'off' && <span className={captions.translationError ? 'has-error' : ''} title={captions.translationError || 'Caption translation'}>{captions.translationError ? 'Translation paused' : translationLanguage(captions.translationTarget).native}</span>}
    </div>
    <p className="floating-bar-preview" dir="auto" title={preview || 'Drag this bar to move it. Restore the workspace to view the conversation.'}>{latest && <strong>{CAPTION_SOURCE_LABELS[latest.source]}:</strong>} {preview || 'Your conversation stays here. Restore to continue.'}</p>
  </main>
}
