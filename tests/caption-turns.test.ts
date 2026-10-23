import { describe, expect, it } from 'vitest'
import { groupCaptionTurns, mergeCaptionLines, type CaptionLine, type CaptionSource } from '../shared/captions'

const line = (id: string, source: CaptionSource, text: string, startMs: number, isFinal = true): CaptionLine => ({ id, source, text, startMs, endMs: startMs + 1000, isFinal })

describe('conversation caption turns', () => {
  it('keeps one message through pauses and recognition endpoints until the source changes', () => {
    const input = [line('a', 'computer', 'First thought.', 0), line('b', 'computer', 'Another thought.', 5000), line('c', 'computer', 'Still speaking.', 20000)]
    const turns = groupCaptionTurns(input)
    expect(turns).toEqual([{ ...input[0], text: 'First thought. Another thought. Still speaking.', endMs: 21000 }])
    expect(input[0].text).toBe('First thought.')
  })
  it('renders Other / Me / Other, preserving source changes and complete text', () => {
    const input = [line('a', 'computer', 'Question.', 0), line('b', 'computer', 'More context.', 1000), line('c', 'microphone', 'My answer.', 2000), line('d', 'microphone', 'More detail.', 3000), line('e', 'computer', 'Follow-up.', 4000)]
    expect(groupCaptionTurns(input).map(turn => [turn.source, turn.text])).toEqual([
      ['computer', 'Question. More context.'], ['microphone', 'My answer. More detail.'], ['computer', 'Follow-up.']
    ])
    expect(groupCaptionTurns(input.filter(part => part.source === 'computer')).map(turn => turn.text)).toEqual(['Question. More context. Follow-up.'])
  })
  it('updates an interim segment without duplicating it or creating another message', () => {
    const first = line('a', 'computer', 'Already said.', 0)
    const draft = { ...line('b', 'computer', 'Develop', 1000, false), groupId: 'utterance-2' }
    const current = mergeCaptionLines([first], [draft])
    expect(groupCaptionTurns(current)[0]).toMatchObject({ id: 'a', text: 'Already said. Develop', isFinal: false })
    const final = mergeCaptionLines(current, [{ ...draft, text: 'Developing caption.', isFinal: true, endMs: 3000 }])
    expect(groupCaptionTurns(final)).toEqual([{ ...first, text: 'Already said. Developing caption.', endMs: 3000 }])
  })
  it('groups after timestamp ordering and ignores empty results', () => {
    const current = [line('a', 'computer', 'First.', 0), line('c', 'computer', 'Last.', 2000)]
    const ordered = mergeCaptionLines(current, [line('b', 'microphone', 'Between.', 1000)])
    expect(groupCaptionTurns(ordered).map(turn => turn.source)).toEqual(['computer', 'microphone', 'computer'])
    expect(groupCaptionTurns([current[0], line('empty', 'microphone', '  ', 1000), current[1]])).toHaveLength(1)
    expect(groupCaptionTurns([])).toEqual([])
  })
})
