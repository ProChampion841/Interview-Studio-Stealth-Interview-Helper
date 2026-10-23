import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** An in-window menu, including while screen-capture protection is enabled. */
export default function ActionMenu({ label, children, icon, text, above = false, closeOnSelect = true }: {
  label: string; children: ReactNode; icon: ReactNode; text?: string; above?: boolean; closeOnSelect?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState<CSSProperties>()
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect()
      if (!bounds) return
      const width = Math.min(280, innerWidth - 24)
      const below = innerHeight - bounds.bottom - 20, over = bounds.top - 20
      const upward = above || (below < 220 && over > below)
      setPosition({ position: 'fixed', width, maxWidth: width, maxHeight: Math.max(100, Math.min(480, upward ? over : below)), left: Math.max(12, Math.min(innerWidth - width - 12, bounds.right - width)), right: 'auto', top: upward ? 'auto' : bounds.bottom + 8, bottom: upward ? innerHeight - bounds.top + 8 : 'auto' })
    }
    place(); window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, above])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  return <div className={`action-menu ${above ? 'opens-above' : ''}`} ref={root}>
    <button ref={trigger} type="button" className={`action-menu-trigger ${text ? 'with-label' : 'icon-button'}`} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)} title={label}>{icon}{text && <span>{text}</span>}</button>
    {open && <div className="action-menu-panel" style={position} role="group" aria-label={label} onClick={event => {
      if (closeOnSelect && (event.target as Element).closest('button')) setOpen(false)
    }}>{children}</div>}
  </div>
}
