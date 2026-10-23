import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { CaptureArea } from '../shared/contracts'

type Point = { x: number; y: number }
export default function AreaCapture() {
  const [snapshot, setSnapshot] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [area, setArea] = useState<CaptureArea | null>(null)
  const [dragging, setDragging] = useState(false)
  const start = useRef<Point | null>(null)
  const submitting = useRef(false)
  useEffect(() => {
    let mounted = true
    window.studioArea?.getSnapshot().then(value => { if (mounted) setSnapshot(value.imageDataUrl) }).catch(() => { if (mounted) setError('The screen preview could not be loaded. Press Esc to cancel.') })
    return () => { mounted = false }
  }, [])
  useEffect(() => {
    const stopDragging = () => { start.current = null; setDragging(false); setArea(null) }
    window.addEventListener('blur', stopDragging)
    return () => window.removeEventListener('blur', stopDragging)
  }, [])
  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) }
  }
  const rectangle = (end: Point): CaptureArea => ({ x: Math.min(start.current!.x, end.x), y: Math.min(start.current!.y, end.y), width: Math.abs(end.x - start.current!.x), height: Math.abs(end.y - start.current!.y) })
  const cancel = () => { void window.studioArea?.cancel().catch(() => undefined) }
  return (
    <div className={`area-capture${dragging ? ' is-dragging' : ''}`} aria-label="Screenshot area selection"
      onContextMenu={event => { event.preventDefault(); cancel() }}
      onPointerDown={event => {
        if (!ready || submitting.current || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
        start.current = point(event)
        setDragging(true)
        setError('')
        setArea({ ...start.current, width: 0, height: 0 })
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => { if (start.current) setArea(rectangle(point(event))) }}
      onPointerCancel={() => { start.current = null; setDragging(false); setArea(null) }}
      onLostPointerCapture={() => { if (start.current) { start.current = null; setDragging(false); setArea(null) } }}
      onPointerUp={event => {
        if (!start.current || submitting.current) return
        const selection = rectangle(point(event))
        start.current = null
        setDragging(false)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        if (selection.width * innerWidth < 6 || selection.height * innerHeight < 6) { setArea(null); setError('Drag a larger rectangle to select an area.'); return }
        submitting.current = true
        void window.studioArea?.select(selection).catch(err => { submitting.current = false; setError(err instanceof Error ? err.message : 'Could not attach this area. Try again.'); setArea(null) })
      }}>
      {snapshot && <img className="area-snapshot" src={snapshot} alt="Screen snapshot for area selection" onLoad={() => setReady(true)} draggable={false} />}
      {area ? <div className="area-selection" style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%` }} /> : <div className="area-shade" />}
      <div className="area-instructions"><strong>{ready ? 'Drag to select an area' : 'Preparing your screen…'}</strong><span>{error || 'Release to attach · Esc or right-click to cancel'}</span><button onPointerDown={event => event.stopPropagation()} onClick={cancel}>Cancel</button></div>
    </div>
  )
}
