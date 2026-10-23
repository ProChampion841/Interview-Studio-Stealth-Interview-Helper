import { describe, expect, it, vi } from 'vitest'
import { CaptionPassageRetries } from '../../src/lib/caption-passage-retries'
import type { CaptionLine } from '../../shared/captions'
import type { CaptionTranslationResult } from '../../shared/caption-translation'
const line = (id = 'one'): CaptionLine => ({ id, source: 'computer', text: 'Explain the queue design.', startMs: 0, endMs: 1000, translation: { language: 'es', engine: 'azure:1', text: '', sourceText: 'Explain the queue design.', skipped: 'content_filter' } })
function fixture() {
  let lines = [line()]
  const pending: Array<(result: CaptionTranslationResult) => void> = []
  const translate = vi.fn(() => new Promise<CaptionTranslationResult>(done => pending.push(done)))
  const onTranslation = vi.fn(), onPending = vi.fn(), onError = vi.fn(), cancel = vi.fn()
  const client = new CaptionPassageRetries({ language: 'es', engine: 'azure:1', lines: () => lines, translate, onTranslation, onPending, onError, cancel })
  return { client, translate, pending, onTranslation, onPending, onError, cancel, setLines: (next: CaptionLine[]) => { lines = next } }
}
describe('per-passage retry state', () => {
  it('only retries the selected passage, coalesces duplicate clicks and removes its skipped marker', async () => {
    const f = fixture(), first = f.client.retry('one')
    await f.client.retry('one'); expect(f.translate).toHaveBeenCalledOnce()
    f.pending[0]({ text: 'Diseño de cola.' }); await first
    expect(f.onTranslation).toHaveBeenCalledWith('one', { language: 'es', engine: 'azure:1', text: 'Diseño de cola.', sourceText: 'Explain the queue design.' })
    expect(f.onPending).toHaveBeenLastCalledWith(new Set())
  })
  it('retains the selected engine for reuse while marking successful offline output', async () => {
    const f = fixture(), pending = f.client.retry('one')
    f.pending[0]({ text: 'Offline text', via: 'offline' }); await pending
    expect(f.onTranslation).toHaveBeenCalledWith('one', expect.objectContaining({ engine: 'azure:1', via: 'offline' }))
  })
  it('keeps a failure local to the selected passage with a pack-download hint', async () => {
    const f = fixture(), pending = f.client.retry('one')
    f.pending[0]({ text: '', retryError: 'Download pack', offlineIssue: 'missing_pack' }); await pending
    expect(f.onError).toHaveBeenLastCalledWith('one', { message: 'Download pack', offlineIssue: 'missing_pack' })
    expect(f.onTranslation).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled()
  })
  it('ignores late results after language, provider or conversation changes', async () => {
    const f = fixture(), pending = f.client.retry('one'); f.client.stop()
    f.pending[0]({ text: 'Late text' }); await pending
    expect(f.onTranslation).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledOnce()
  })
  it('does not overwrite recognition revisions or a deleted passage with stale retry text', async () => {
    const f = fixture(), pending = f.client.retry('one')
    f.setLines([{ ...line(), text: 'Revised speech' }]); f.pending[0]({ text: 'Old text' }); await pending
    expect(f.onTranslation).not.toHaveBeenCalled(); expect(f.onError).toHaveBeenLastCalledWith('one', expect.objectContaining({ message: expect.stringMatching(/changed/) }))
    const next = f.client.retry('one'); f.setLines([]); f.pending[1]({ text: 'Deleted' }); await next
    expect(f.onTranslation).not.toHaveBeenCalled()
  })
})
