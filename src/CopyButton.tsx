import { Check, Copy, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copyResponseText } from './lib/clipboard'

export default function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const version = useRef(0)
  useEffect(() => { version.current++; setState('idle'); return () => { version.current++ } }, [text])
  useEffect(() => {
    if (state !== 'copied') return
    const timer = window.setTimeout(() => setState('idle'), 1800)
    return () => window.clearTimeout(timer)
  }, [state])
  const copy = async () => {
    const current = version.current
    setState('copying')
    try {
      await copyResponseText(text)
      if (version.current === current) setState('copied')
    } catch { if (version.current === current) setState('error') }
  }
  return <span className="copy-response">
    <button type="button" className={`copy-button ${state}`} aria-label="Copy response" disabled={!text || state === 'copying'} title={state === 'error' ? 'Copy failed. Try again or select and copy the answer text.' : 'Copy response'} onClick={() => void copy()}>
      {state === 'copied' ? <Check size={14} /> : state === 'error' ? <TriangleAlert size={14} /> : <Copy size={14} />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'error' ? 'Retry copy' : state === 'copying' ? 'Copying…' : 'Copy'}</span>
    </button>
    {state === 'error' && <small className="copy-error" role="status">Couldn’t copy. Select the answer and press Ctrl+C.</small>}
  </span>
}
