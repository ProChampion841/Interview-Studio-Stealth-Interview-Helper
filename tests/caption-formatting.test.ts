import { describe, expect, it } from 'vitest'
import { formatCaptionText } from '../shared/captions'

describe('readable caption casing', () => {
  it('converts uncased speech to sentences and keeps pronouns and common acronyms', () => {
    expect(formatCaptionText("I BUILT AN AI API. I'M USING SQL AND JSON! HOW CAN I TEST IT?"))
      .toBe("I built an AI API. I'm using SQL and JSON! How can I test it?")
    expect(formatCaptionText('HELLO THERE\nWELCOME BACK')).toBe('Hello there\nWelcome back')
    expect(formatCaptionText('ÉCOUTEZ. ДАВАЙТЕ НАЧНЁМ.')).toBe('Écoutez. Давайте начнём.')
  })
  it('preserves already-cased words, code, and provider punctuation', () => {
    expect(formatCaptionText('OpenAI uses JSON. I use TypeScript and parseHTTP().')).toBe('OpenAI uses JSON. I use TypeScript and parseHTTP().')
    expect(formatCaptionText('')).toBe('')
    expect(formatCaptionText('123')).toBe('123')
    expect(formatCaptionText('API')).toBe('API')
  })
})
