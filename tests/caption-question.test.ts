import { describe, expect, it } from 'vitest'
import { CAPTION_CONTEXT_CHARS, captionContextText, captionExcerpt, captionQuestion, latestCaptionQuestion, mergeCaptionContext } from '../shared/caption-question'
import { LIMITS } from '../shared/contracts'
import type { CaptionLine } from '../shared/captions'

const line = (id: string, source: CaptionLine['source'], text: string, startMs: number, isFinal = true): CaptionLine => ({ id, source, text, startMs, endMs: startMs + 500, isFinal })
describe('caption questions and context', () => {
  it('resolves a follow-up with nearby turns but excludes later conversation', () => {
    const lines = [line('old', 'microphone', 'Unrelated old conversation.', 0), line('q', 'computer', 'Describe a project.', 100000), line('a', 'microphone', 'I chose a queue to handle bursts.', 110000), line('why', 'computer', 'Why did you choose that approach?', 120000), line('future', 'microphone', 'A later answer.', 130000)]
    const request = captionQuestion(lines, ['why'])
    expect(request.question).toBe('Why did you choose that approach?')
    expect(captionContextText(request.context)).toBe('Professional: Describe a project.\nYOU: I chose a queue to handle bursts.')
    expect(captionContextText(request.context)).not.toMatch(/old conversation|later answer/)
  })
  it('uses exactly the selected text and includes earlier passages in the same turn', () => {
    const lines = [line('intro', 'computer', 'Some background.', 0), line('questions', 'computer', 'Explain caching. Why use a queue?', 1000)]
    expect(captionQuestion(lines, ['questions'], 'Why use a queue?')).toEqual({ question: 'Why use a queue?', captionIds: ['questions'], context: [{ id: 'intro', source: 'computer', text: 'Some background.' }] })
  })
  it('snapshots excerpts so subsequent recognition revisions cannot change a request', () => {
    const lines = [line('you', 'microphone', 'My own explanation.', 0), line('q', 'computer', 'Why?', 1000)]
    const request = captionQuestion(lines, ['q'])
    const excerpt = captionExcerpt(lines, ['you'])
    lines[0].text = 'A recognition revision.'; lines[1].text = 'Another question.'
    expect(request.question).toBe('Why?')
    expect(request.context[0].text).toBe('My own explanation.')
    expect(excerpt.text).toBe('My own explanation.')
  })
  it('rejects missing, mixed-source, empty, or oversized questions', () => {
    const lines = [line('a', 'computer', 'Question.', 0), line('b', 'microphone', 'Answer.', 1000)]
    expect(() => captionQuestion(lines, ['missing'])).toThrow(/one caption turn/)
    expect(() => captionQuestion(lines, ['a', 'b'])).toThrow(/one caption turn/)
    expect(() => captionQuestion(lines, ['a'], ' ')).toThrow(/with text/)
    expect(() => captionQuestion(lines, ['a'], 'x'.repeat(LIMITS.questionChars + 1))).toThrow(/Highlight/)
    expect(captionQuestion(lines, ['a'], 'x'.repeat(LIMITS.questionChars)).question.length).toBe(LIMITS.questionChars)
  })
  it('keeps at most three previous speaking turns as automatic context', () => {
    const lines = Array.from({ length: 6 }, (_, i) => line(String(i), i % 2 ? 'microphone' : 'computer', `Speech ${i}`, i * 1000))
    expect(captionQuestion(lines, ['5']).context.map(item => item.id)).toEqual(['2', '3', '4'])
  })
  it('deduplicates explicit context, bounds the entire labeled transcript, and strips nulls', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: String(i), source: 'microphone' as const, text: `Speech ${i}` }))
    const merged = mergeCaptionContext(items, [{ ...items[7], text: 'Updated\u0000 speech' }])
    expect(merged.map(item => item.id)).toEqual(['2', '3', '4', '5', '6', '7'])
    expect(merged[5].text).toBe('Updated speech')
    const bounded = mergeCaptionContext(items.map(item => ({ ...item, text: 'x'.repeat(5000) })))
    expect(captionContextText(bounded).length).toBeLessThanOrEqual(CAPTION_CONTEXT_CHARS)
    expect(bounded.at(-1)?.id).toBe('7')
    expect(items[7].text).toBe('Speech 7')
  })
  it('does not answer stale professional text while the newest passage is developing', () => {
    const lines = [line('q', 'computer', 'Finished question?', 0), line('you', 'microphone', 'My reply.', 1000)]
    expect(latestCaptionQuestion(lines)?.question).toBe('Finished question?')
    expect(latestCaptionQuestion([...lines, line('next', 'computer', 'Developing follow-up', 2000, false)])).toBeUndefined()
    expect(latestCaptionQuestion([lines[1]])).toBeUndefined()
  })
})
