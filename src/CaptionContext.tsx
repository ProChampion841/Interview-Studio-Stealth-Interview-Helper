import { MessageSquareText, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { CAPTION_SOURCE_LABELS } from '../shared/captions'
import type { CaptionContextItem } from '../shared/caption-question'

export default function CaptionContext({ items, label, inline = false, onRemove, onClear }: {
  items: readonly CaptionContextItem[]; label?: string; inline?: boolean; onRemove?: (id: string) => void; onClear?: () => void
}) {
  const root = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (root.current?.open && !root.current.contains(event.target as Node)) root.current.open = false }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !root.current?.open) return
      event.stopPropagation(); root.current.open = false
      root.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [])
  if (!items.length) return null
  return <details ref={root} className={`caption-context${inline ? ' inline' : ''}`}>
    <summary title={`${label ?? 'Caption context'}: ${items.length} passage${items.length === 1 ? '' : 's'}`}><MessageSquareText size={13} /><span>{label ?? (inline ? 'Context' : 'Caption context')}</span><small>{inline ? items.length : `${items.length} passage${items.length === 1 ? '' : 's'}`}</small></summary>
    <div className="caption-context-content">
      {onClear && <button className="caption-context-clear" type="button" onClick={onClear}>Clear context</button>}
      {items.map((item, index) => <article key={item.id}>
        <strong>{CAPTION_SOURCE_LABELS[item.source]}</strong>
        {onRemove && <button type="button" aria-label={`Remove caption context ${index + 1}`} title="Remove this caption" onClick={() => onRemove(item.id)}><X size={13} /></button>}
        <p dir="auto">{item.text}</p>
      </article>)}
    </div>
  </details>
}
