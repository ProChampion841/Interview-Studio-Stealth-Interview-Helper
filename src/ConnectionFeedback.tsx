import { useEffect, useRef } from 'react'
import { CheckCircle2, CircleAlert, Info, LoaderCircle } from 'lucide-react'

export interface ConnectionStatus {
  tone: 'neutral' | 'working' | 'success' | 'error'
  message: string
}

export default function ConnectionFeedback({ status, hint }: { status: ConnectionStatus | null; hint: string }) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = root.current?.closest('.connection-action-area') ?? root.current
    if (!status || !target) return
    const reveal = () => target.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    reveal()
    // Saving the first key can add a Remove button and wrap the action row.
    // Keep both the result and controls visible after that layout change.
    const resize = new ResizeObserver(reveal)
    resize.observe(target)
    return () => resize.disconnect()
  }, [status])
  const tone = status?.tone ?? 'neutral'
  const Icon = tone === 'working' ? LoaderCircle : tone === 'success' ? CheckCircle2 : tone === 'error' ? CircleAlert : Info
  return <div ref={root} className={`connection-status connection-feedback ${tone}`} role="status" aria-live="polite" aria-atomic="true">
    <Icon size={16} aria-hidden="true" className={tone === 'working' ? 'connection-spinner' : undefined} />
    <span>{status?.message ?? hint}</span>
  </div>
}
