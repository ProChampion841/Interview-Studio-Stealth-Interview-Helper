import { useEffect, useRef, useState } from 'react'
import { hasConversationContent, type ConversationRecord, type ConversationSummary } from '../../shared/conversation-history'
import { ConversationAutosave } from './conversation-autosave'

export function useConversationHistory(record: ConversationRecord) {
  const [sessions, setSessions] = useState<ConversationSummary[]>([])
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
  const [error, setError] = useState('')
  const [fileWarning, setFileWarning] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const writer = useRef<ConversationAutosave | null>(null)
  const latest = useRef(record); latest.current = record
  const loaded = useRef(false)
  const renamedTitles = useRef(new Map<string, string>())
  const mergeSummary = (summary: ConversationSummary) => setSessions(current => [summary, ...current.filter(item => item.id !== summary.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  useEffect(() => {
    let cancelled = false
    loaded.current = false
    setReady(false); setStatus('loading')
    const api = window.studio
    if (!api?.listHistory || !api.saveHistory) { setStatus('error'); setError('Restart the desktop app to enable saved conversation history.'); return }
    const next = new ConversationAutosave({
      save: record => api.saveHistory({ ...record, title: renamedTitles.current.get(record.id) ?? record.title }), onSaving: () => { if (!cancelled) setStatus('saving') },
      onSaved: summary => { if (!cancelled) { mergeSummary(summary); setStatus('saved'); setError('') } },
      onError: () => { if (!cancelled) { setStatus('error'); setError('Conversation history could not be saved. Check available disk space, retry saving, or export your conversation.') } }
    })
    writer.current = next
    void (async () => {
      try {
        const list = await api.listHistory()
        if (cancelled) return
        setSessions(list.conversations)
        loaded.current = true; setReady(true); setStatus('saved'); setError('')
        setFileWarning(list.unreadable ? `${list.unreadable} conversation file(s) could not be opened. They were kept unchanged.` : '')
      } catch { if (!cancelled) { setStatus('error'); setError('Saved conversation history could not be opened. Your existing files were kept unchanged. Retry to open it again.') } }
    })()
    const unsubscribe = api.onHistoryFlush?.(async () => {
      // Let caption-stop and final answer events settle before taking the last snapshot.
      await new Promise(resolve => setTimeout(resolve, 0))
      if (loaded.current) await next.flush(latest.current)
    })
    return () => { cancelled = true; next.dispose(); unsubscribe?.(); if (writer.current === next) writer.current = null }
  }, [loadAttempt])
  useEffect(() => { if (ready) writer.current?.update(record) }, [ready, record.id, record.title, record.captions, record.threads, record.selectedThreadId, record.draft, record.draftCaptionIds, record.pendingContext, record.role, record.interviewType, record.responseStyle])
  const saveNow = async () => { if (loaded.current) await writer.current?.flush(latest.current) }
  const refresh = async () => { const list = await window.studio!.listHistory(); setSessions(list.conversations); setFileWarning(list.unreadable ? `${list.unreadable} conversation file(s) could not be opened. They were kept unchanged.` : '') }
  const rename = async (id: string, title: string) => {
    await saveNow()
    const previous = renamedTitles.current.get(id)
    renamedTitles.current.set(id, title)
    try { const summary = await window.studio!.renameHistory(id, title); renamedTitles.current.set(id, summary.title); mergeSummary(summary) }
    catch (error) { if (previous === undefined) renamedTitles.current.delete(id); else renamedTitles.current.set(id, previous); throw error }
  }
  const remove = async (id: string) => {
    writer.current?.drop(id)
    try { await writer.current?.flush(); await window.studio!.deleteHistory(id); setSessions(current => current.filter(item => item.id !== id)); renamedTitles.current.delete(id) }
    catch (error) { writer.current?.keep(id); if (latest.current.id === id) writer.current?.update(latest.current); throw error }
  }
  const retry = async () => { if (!ready) setLoadAttempt(value => value + 1); else { await saveNow(); if (fileWarning) await refresh() } }
  return { sessions, ready, status, error: error || fileWarning, saveNow, retry, refresh, rename, remove, hasContent: hasConversationContent(record) }
}
