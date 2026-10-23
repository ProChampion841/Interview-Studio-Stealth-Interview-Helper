import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { CaptionLine, CaptionStatus } from '../../shared/captions'
import type { ProviderId } from '../../shared/contracts'
import type { TranslationTarget } from '../../shared/caption-translation'
import { CaptionTranslationClient } from './caption-translation-client'
import { TRANSLATION_PROVIDER_NAMES, type PublicTranslationSettings } from '../../shared/translation-settings'
import { PROVIDER_NAMES } from '../../shared/contracts'
import { useOfflineTranslationPacks } from './use-offline-translation-packs'
import { CaptionPassageRetries, type PassageRetryError } from './caption-passage-retries'

export function useCaptionTranslation(lines: CaptionLine[], setLines: Dispatch<SetStateAction<CaptionLine[]>>, status: CaptionStatus, sessionId: string | undefined, provider: ProviderId, settings: PublicTranslationSettings) {
  const engine = settings.provider === 'chat' ? `chat:${provider}:${settings.revision}` : `${settings.provider}:${settings.revision}`
  const [target, setTarget] = useState<TranslationTarget>('off')
  const [view, setView] = useState<'both' | 'translated'>('both')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [retry, setRetry] = useState(0)
  const [manualGeneration, setManualGeneration] = useState(0)
  const [retryPending, setRetryPending] = useState<ReadonlySet<string>>(new Set())
  const [retryErrors, setRetryErrors] = useState<ReadonlyMap<string, PassageRetryError>>(new Map())
  const manual = useRef<CaptionPassageRetries | null>(null)
  const offlinePacks = useOfflineTranslationPacks(settings.provider === 'offline' || target !== 'off')
  const offlinePack = offlinePacks.status?.packs.find(pack => pack.language === target)
  const offlineReady = settings.provider !== 'offline' || target === 'en' || offlinePack?.state === 'ready'
  const client = useRef<CaptionTranslationClient | null>(null)
  const latest = useRef(lines); latest.current = lines
  const active = status === 'listening' || status === 'paused'
  useEffect(() => {
    setError(''); setPending(new Set())
    if (target === 'off' || !active || !sessionId || !offlineReady) return
    const api = window.studio
    if (!api?.translateCaption) { setError('Translation requires the updated desktop app. Fully exit and reopen it.'); return }
    const next = new CaptionTranslationClient({
      sessionId, language: target, engine, waitForPhrase: settings.provider === 'offline', translate: request => api.translateCaption(request),
      cancel: () => { void api.cancelCaptionTranslations().catch(() => {}) },
      onTranslation: (id, translation) => setLines(current => current.map(line => line.id === id ? { ...line, translation } : line)),
      onPending: setPending, onError: setError
    })
    client.current = next; next.update(latest.current)
    return () => { next.stop(); if (client.current === next) client.current = null }
  }, [target, active, sessionId, engine, retry, setLines, offlineReady])
  useEffect(() => { client.current?.update(lines) }, [lines])
  useEffect(() => {
    setRetryErrors(new Map())
    const api = window.studio
    if (target === 'off' || !api?.retryCaptionTranslation) return
    const next = new CaptionPassageRetries({
      language: target, engine, lines: () => latest.current,
      translate: request => api.retryCaptionTranslation(request),
      cancel: () => { void api.cancelCaptionTranslations().catch(() => {}) },
      onPending: setRetryPending,
      onError: (id, error) => setRetryErrors(current => { const next = new Map(current); if (error) next.set(id, error); else next.delete(id); return next }),
      onTranslation: (id, translation) => setLines(current => current.map(line => line.id === id && line.text === translation.sourceText ? { ...line, translation } : line))
    })
    manual.current = next
    return () => { next.stop(); if (manual.current === next) manual.current = null }
  }, [target, engine, active, sessionId, retry, manualGeneration, setLines])
  const changeTarget = useCallback((next: TranslationTarget) => {
    if (next === target) return
    client.current?.stop(); client.current = null
    manual.current?.stop(); manual.current = null
    setError(''); setPending(new Set()); setTarget(next)
  }, [target])
  const retryTranslation = useCallback(() => { client.current?.stop(); setRetry(value => value + 1) }, [])
  const stopTranslationWork = useCallback(() => { client.current?.stop(); client.current = null; manual.current?.stop(); manual.current = null; setManualGeneration(value => value + 1) }, [])
  const retryTranslationPassage = useCallback((id: string) => {
    if (manual.current) void manual.current.retry(id)
    else setRetryErrors(current => new Map(current).set(id, { message: 'Restart the desktop app to enable passage translation retries.' }))
  }, [])
  const allPending = useMemo(() => new Set([...pending, ...retryPending]), [pending, retryPending])
  return { translationTarget: target, setTranslationTarget: changeTarget, translationView: view, setTranslationView: setView, translationError: error, translationPending: allPending, retryTranslation, retryTranslationPassage, translationRetryPending: retryPending, translationRetryErrors: retryErrors, translationProvider: settings.provider === 'chat' ? provider : settings.provider, translationUsesChat: settings.provider === 'chat', translationProviderName: settings.provider === 'chat' ? PROVIDER_NAMES[provider] : TRANSLATION_PROVIDER_NAMES[settings.provider], translationEngine: engine, stopTranslationWork, offlinePacks, offlinePack, offlineReady }
}
