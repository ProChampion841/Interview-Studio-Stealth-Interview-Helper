import { AlertCircle, ChevronDown, LoaderCircle, MessageSquareText, Pencil, RotateCcw, Sparkles } from 'lucide-react'
import type { QuestionExchange, QuestionThread } from '../shared/conversation-history'
import { renderCoachMarkdown } from '../shared/markdown'
import ActionMenu from './ActionMenu'
import CopyButton from './CopyButton'
import CaptionContext from './CaptionContext'
import { useEffect, useRef } from 'react'
import { memoryPassageText } from '../shared/conversation-memory'
import { PROVIDER_NAMES } from '../shared/contracts'

export function QuestionPicker({ threads, selectedId, onSelect }: { threads: QuestionThread[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!threads.length) return null
  return <ActionMenu label="Choose a saved question" text={`Questions · ${threads.length}`} icon={<ChevronDown size={13} />}>
    {threads.map((thread, index) => <button type="button" key={thread.id} title={thread.question} aria-current={selectedId === thread.id ? 'true' : undefined} onClick={() => onSelect(thread.id)}><span className="question-picker-label">{index + 1}. {thread.question}</span></button>)}
  </ActionMenu>
}

export default function QuestionAnswers({ thread, onStop, onRetry, onEdit, busy, retryWithImagesId }: {
  thread?: QuestionThread; onStop: () => void; busy: boolean; retryWithImagesId?: string
  onRetry: (thread: QuestionThread, exchange: QuestionExchange) => void
  onEdit: (thread: QuestionThread, exchange: QuestionExchange) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    const scroller = root.current?.parentElement
    if (!scroller) return
    follow.current = true
    scroller.scrollTop = scroller.scrollHeight
    const scroll = () => { follow.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 }
    scroller.addEventListener('scroll', scroll)
    return () => scroller.removeEventListener('scroll', scroll)
  }, [thread?.id, thread?.exchanges.length])
  useEffect(() => {
    const scroller = root.current?.parentElement
    if (scroller && follow.current) scroller.scrollTop = scroller.scrollHeight
  }, [thread?.exchanges])
  if (!thread) return <div className="coach-empty"><MessageSquareText size={24} strokeWidth={1.4} /><strong>Select a question</strong><span>Choose a caption or type a question. Its answers and follow-ups stay together.</span></div>
  return <div ref={root} className="question-thread" data-thread-id={thread.id}>
    {thread.exchanges.map((exchange, index) => <section key={exchange.id} className="question-exchange" data-exchange-id={exchange.id}>
      <div className="prompt-card"><div><span>{index ? 'Follow-up' : thread.captionIds.length ? 'Selected question' : 'Question'}</span><p>{exchange.question}</p></div></div>
      <CaptionContext items={exchange.context} label="Conversation used" />
      {exchange.memory && <>
        <CaptionContext items={exchange.memory.overview.map(item => ({ ...item, text: memoryPassageText(item) }))} label="Interview summary used" />
        <CaptionContext items={exchange.memory.relevant.map(item => ({ ...item, text: memoryPassageText(item) }))} label="Earlier speech used" />
      </>}
      {!!exchange.sourceNames.length && <div className="submitted-reference"><span>References: {exchange.sourceNames.join(', ')}</span></div>}
      {exchange.status === 'thinking' && <div className="coach-thinking" role="status"><LoaderCircle size={16} /><strong>Writing your answer</strong><button type="button" aria-label="Stop answer" onClick={onStop}>Stop</button></div>}
      {(exchange.answer || exchange.fallbackNotice || exchange.status !== 'thinking') && <div className={`generated-answer ${exchange.status === 'error' ? 'error' : ''}`}>
        <div className="answer-label"><Sparkles size={14} /><span>{exchange.status === 'stopped' ? 'Saved partial answer' : exchange.demo ? 'Offline demo response' : 'Answer'}</span>{exchange.provider && <small className="answer-provider" title={exchange.model}>{PROVIDER_NAMES[exchange.provider]}</small>}{exchange.answer && <CopyButton text={exchange.answer} />}</div>
        {exchange.fallbackNotice && <p className="answer-fallback" role="status">{exchange.fallbackNotice}</p>}
        {exchange.previousAnswers?.map((previous, index) => <details className="answer-previous" key={index}><summary>Previous partial answer · {PROVIDER_NAMES[previous.provider]}</summary><p>{previous.answer}</p></details>)}
        {exchange.answer && <div className="answer-markdown" dangerouslySetInnerHTML={{ __html: renderCoachMarkdown(exchange.answer) }} />}
        {exchange.status === 'error' && <div className="answer-error" role="status"><AlertCircle size={15} /><span>{exchange.error || (exchange.answer ? 'This answer was interrupted. You can try again.' : 'The answer could not be completed. You can try again.')}</span></div>}
        {exchange.status === 'stopped' && !exchange.answer && <p className="answer-stopped">Generation stopped before an answer arrived.</p>}
        {(exchange.status === 'error' || exchange.status === 'stopped') && <div className="answer-recovery">
          <button type="button" disabled={busy} onClick={() => onRetry(thread, exchange)} title={exchange.sourceNames.length && retryWithImagesId !== exchange.id ? 'Screenshots are not saved. Edit and reattach them before sending.' : 'Try this question again using the selected AI connection'}><RotateCcw size={13} />{exchange.sourceNames.length && retryWithImagesId !== exchange.id ? 'Edit & resend' : 'Retry answer'}</button>
          <button type="button" disabled={busy} onClick={() => onEdit(thread, exchange)}><Pencil size={13} />Edit question</button>
        </div>}
      </div>}
    </section>)}
  </div>
}
