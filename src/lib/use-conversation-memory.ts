import { useEffect, useRef, useState } from 'react'
import { ConversationMemory, memoryText, type MemoryPassage } from '../../shared/conversation-memory'
import type { CaptionLine } from '../../shared/captions'

export function useConversationMemory(id: string, lines: CaptionLine[]) {
  const index = useRef<{ id: string; memory: ConversationMemory } | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [summary, setSummary] = useState<{ id: string; items: MemoryPassage[] }>({ id, items: [] })
  const current = () => {
    if (!index.current || index.current.id !== id) index.current = { id, memory: new ConversationMemory() }
    return index.current.memory
  }
  // Throttle developing captions. A question always synchronously indexes the
  // latest text, so it never waits for the background summary timer.
  const latest = useRef(lines); latest.current = lines
  useEffect(() => () => { clearTimeout(timer.current); timer.current = undefined }, [id])
  useEffect(() => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      const memory = current(); memory.update(latest.current)
      setSummary(previous => previous.id === id && memoryText(previous.items) === memoryText(memory.summary()) ? previous : { id, items: memory.summary() })
    }, 2000)
  }, [id, lines])
  return {
    summary: summary.id === id ? summary.items : [],
    forQuestion: (question: string, excluded: string[] = []) => { const memory = current(); memory.update(lines); return memory.retrieve(question, excluded) }
  }
}
