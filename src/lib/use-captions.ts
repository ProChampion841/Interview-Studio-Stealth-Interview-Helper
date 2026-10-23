import { useCallback, useEffect, useRef, useState } from 'react'
import { finishCaptionText, formatCaptionText, mergeCaptionLines, namespaceCaptionLines, type CaptionInput, type CaptionLine, type CaptionSource, type CaptionStatus, type CaptionProvider } from '../../shared/captions'
import { CaptionClient } from './caption-client'
import { useCaptionTranslation } from './use-caption-translation'
import type { ProviderId } from '../../shared/contracts'
import type { PublicTranslationSettings } from '../../shared/translation-settings'

export function useCaptions(provider: CaptionProvider, chatProvider: ProviderId, translationSettings: PublicTranslationSettings) {
  const [{ status, sessionId }, setSession] = useState<{ status: CaptionStatus; sessionId?: string }>({ status: 'idle' })
  const [input, setInput] = useState<CaptionInput>('both')
  const [error, setError] = useState('')
  const [microphoneMuted, setMicrophoneMuted] = useState(false)
  const [lines, setLines] = useState<CaptionLine[]>([])
  const [levels, setLevels] = useState<Record<CaptionSource, number>>({ microphone: 0, computer: 0 })
  const client = useRef<CaptionClient | null>(null)
  const timeline = useRef(performance.now())
  const translation = useCaptionTranslation(lines, setLines, status, sessionId, chatProvider, translationSettings)
  const stop = useCallback(() => { translation.stopTranslationWork(); client.current?.stop(); client.current = null }, [translation.stopTranslationWork])
  const start = useCallback(async () => {
    stop(); setError('')
    if (!lines.length) timeline.current = performance.now()
    const offset = Math.max(0, performance.now() - timeline.current)
    const next = new CaptionClient({
      onStatus: nextStatus => {
        if (client.current !== next) return
        setSession({ status: nextStatus, sessionId: next.sessionId })
        if (nextStatus === 'idle' || nextStatus === 'error') {
          translation.stopTranslationWork()
          setLines(current => current.map(line => line.isFinal === false ? { ...line, isFinal: true, text: provider === 'offline' ? finishCaptionText(line.text) : line.text } : line))
        }
      },
      onLines: incoming => { if (client.current === next && next.sessionId) setLines(current => mergeCaptionLines(current, namespaceCaptionLines(incoming, next.sessionId!, offset))) },
      onError: message => { if (client.current === next) setError(message) },
      onLevel: (source, level) => { if (client.current === next) setLevels(current => ({ ...current, [source]: level })) }
    })
    client.current = next
    next.setMicrophoneMuted(microphoneMuted)
    try { await next.start(input, provider) }
    catch (err) { if (client.current === next) { setError(err instanceof Error ? err.message : 'Could not start captions.'); setSession({ status: 'error' }) } }
  }, [input, provider, microphoneMuted, stop, lines.length])
  const toggleMicrophone = useCallback(() => {
    const muted = !microphoneMuted
    client.current?.setMicrophoneMuted(muted); setMicrophoneMuted(muted)
    if (muted) setLines(current => current.map(line => line.source === 'microphone' && line.isFinal === false ? { ...line, isFinal: true, text: provider === 'offline' ? finishCaptionText(line.text) : line.text } : line))
  }, [microphoneMuted, provider])
  const pause = useCallback(() => client.current?.pause(), [])
  const resume = useCallback(() => { void client.current?.resume() }, [])
  const clear = useCallback(() => { translation.retryTranslation(); setLines([]); setError(''); timeline.current = performance.now() }, [translation.retryTranslation])
  const restore = useCallback((saved: CaptionLine[]) => {
    stop(); setError(''); setLines(saved.map(line => ({ ...line, text: formatCaptionText(line.text) })))
    timeline.current = performance.now() - saved.reduce((latest, line) => Math.max(latest, line.endMs), 0)
  }, [stop])
  useEffect(() => () => { client.current?.stop() }, [])
  return { provider, status, input, setInput, error, lines, levels, microphoneMuted, toggleMicrophone, start, stop, pause, resume, clear, restore, ...translation }
}
export type CaptionControls = ReturnType<typeof useCaptions>
