import { describe, expect, it, vi } from 'vitest'
import { CaptionPunctuation } from '../electron/main/offline-punctuation'
import { finishCaptionText } from '../shared/captions'

describe('offline caption punctuation', () => {
  it('keeps internal punctuation live and finishes the same utterance at its endpoint', () => {
    const model = vi.fn(() => 'Well, I think we should begin. Can you tell me about yourself?')
    const punctuator = new CaptionPunctuation(model)
    const raw = 'WELL I THINK WE SHOULD BEGIN CAN YOU TELL ME ABOUT YOURSELF'
    expect(punctuator.restore(raw, false)).toBe('Well, I think we should begin. Can you tell me about yourself')
    expect(punctuator.restore(raw, true)).toBe('Well, I think we should begin. Can you tell me about yourself?')
    expect(model).toHaveBeenCalledOnce()
  })
  it('revises a growing phrase without adding words or discarding acronyms', () => {
    const punctuator = new CaptionPunctuation(text => text === 'i built' ? 'I built' : 'I built an AI API using SQL and JSON')
    expect(punctuator.restore('I BUILT', false)).toBe('I built')
    expect(punctuator.restore('I BUILT AN AI API USING SQL AND JSON', true)).toBe('I built an AI API using SQL and JSON.')
  })
  it('rejects rewritten words and survives a punctuation model exception', () => {
    expect(new CaptionPunctuation(() => 'I use cloud services.').restore('I USE LOCAL MODELS', true)).toBe('I use local models.')
    expect(new CaptionPunctuation(() => { throw new Error('inference failed') }).restore('CAN YOU HELP ME', true)).toBe('Can you help me?')
    expect(new CaptionPunctuation(() => 'Invented speech.').restore('  ', true)).toBe('')
  })
  it('keeps sentence marks, commas, numbers, and quotes without doubled punctuation', () => {
    expect(finishCaptionText('Hello!')).toBe('Hello!')
    expect(finishCaptionText('Are you ready?')).toBe('Are you ready?')
    expect(finishCaptionText('He said "hello"')).toBe('He said "hello."')
    expect(finishCaptionText('First,')).toBe('First.')
    const punctuator = new CaptionPunctuation(() => 'It costs 1,000 dollars. Is that okay?')
    expect(punctuator.restore('IT COSTS 1000 DOLLARS IS THAT OKAY', true)).toBe('It costs 1,000 dollars. Is that okay?')
  })
  it('recognizes clear question openings but keeps descriptive clauses as statements', () => {
    for (const input of ['What is your biggest strength', 'How long have you worked here', 'Can you explain the API']) expect(finishCaptionText(input)).toBe(input + '?')
    for (const input of ['What I did was build an API', 'How we work is important', 'I know what you mean']) expect(finishCaptionText(input)).toBe(input + '.')
  })
  it('capitalizes a new sentence even when the model leaves its first word lowercase', () => {
    const punctuator = new CaptionPunctuation(() => 'first thought. and another thought. "are you ready?"')
    expect(punctuator.restore('FIRST THOUGHT AND ANOTHER THOUGHT "ARE YOU READY"', true)).toBe('First thought. And another thought. "Are you ready?"')
  })
})
