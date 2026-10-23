import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyResponseText } from '../../src/lib/clipboard'

afterEach(() => vi.unstubAllGlobals())
describe('copying interview responses', () => {
  it('copies the complete response through the desktop bridge when browser clipboard access is denied', async () => {
    const copyText = vi.fn(async () => {})
    const writeText = vi.fn(async () => { throw new DOMException('Not focused', 'NotAllowedError') })
    vi.stubGlobal('window', { studio: { copyText } })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const answer = '## Answer\n\nI built the API.\n\n- Result: 25% faster.\n- 日本語 ✅'
    await copyResponseText(answer)
    expect(copyText).toHaveBeenCalledWith(answer)
    expect(writeText).not.toHaveBeenCalled()
  })
  it('propagates a failed native copy so the button can show failure instead of a false confirmation', async () => {
    vi.stubGlobal('window', { studio: { copyText: vi.fn(async () => { throw new Error('Clipboard busy') }) } })
    await expect(copyResponseText('Answer')).rejects.toThrow('Clipboard busy')
  })
  it('supports browser previews without a desktop bridge', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await copyResponseText('Preview answer')
    expect(writeText).toHaveBeenCalledWith('Preview answer')
  })
})
