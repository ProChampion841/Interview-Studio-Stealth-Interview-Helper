import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationAutosave } from '../../src/lib/conversation-autosave'
import { conversationSummary, type ConversationRecord } from '../../shared/conversation-history'

afterEach(() => vi.useRealTimers())
const record = (id = 'conversation'): ConversationRecord => ({ version: 1, id, title: 'Interview', createdAt: 'now', updatedAt: 'now', captions: [], threads: [], selectedThreadId: null, draft: 'Draft', pendingContext: [], role: '', interviewType: '', responseStyle: '' })
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve() }
function fixture() {
  const save = vi.fn(async (item: ConversationRecord) => conversationSummary(item)), onSaving = vi.fn(), onSaved = vi.fn(), onError = vi.fn()
  return { save, onSaving, onSaved, onError, client: new ConversationAutosave({ save, onSaving, onSaved, onError }) }
}
describe('streaming conversation autosave', () => {
  it('saves the newest streaming revision at a bounded interval instead of writing every update', async () => {
    vi.useFakeTimers(); const f = fixture()
    for (let n = 0; n < 50; n++) f.client.update({ ...record(), draft: `Revision ${n}` })
    await vi.advanceTimersByTimeAsync(999); expect(f.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.save).toHaveBeenCalledOnce(); expect(f.save.mock.calls[0][0].draft).toBe('Revision 49')
  })
  it('flushes the final draft immediately on close and retains separate conversations during a switch', async () => {
    const f = fixture()
    f.client.update(record('first')); f.client.update(record('second'))
    await f.client.flush({ ...record('second'), draft: 'Last instant edit' })
    expect(f.save.mock.calls.map(([item]) => [item.id, item.draft])).toEqual([['first', 'Draft'], ['second', 'Last instant edit']])
    f.client.dispose()
  })
  it('coalesces revisions during an in-flight write and never publishes a deleted conversation again', async () => {
    const f = fixture(); let complete!: () => void
    f.save.mockImplementationOnce(item => new Promise(resolve => { complete = () => resolve(conversationSummary(item)) }))
    f.client.update(record('old')); const pending = f.client.flush()
    f.client.drop('old'); f.client.update({ ...record('old'), draft: 'Should not resurrect' }); f.client.update(record('new'))
    complete(); await pending
    expect(f.save.mock.calls.map(([item]) => item.id)).toEqual(['old', 'new'])
    expect(f.onSaved.mock.calls.map(([item]) => item.id)).toEqual(['new'])
    f.client.dispose()
  })
  it('retains unsaved data after failure so retry can save it', async () => {
    const f = fixture(); f.save.mockRejectedValueOnce(new Error('Disk full'))
    f.client.update(record()); await expect(f.client.flush()).rejects.toThrow('Disk full')
    expect(f.onError).toHaveBeenCalledOnce()
    await f.client.flush(); expect(f.save).toHaveBeenCalledTimes(2)
    expect(f.onSaved).toHaveBeenCalledOnce(); f.client.dispose()
  })
  it('resumes saving when a deletion fails', async () => {
    const f = fixture()
    f.client.drop('kept'); f.client.update(record('kept')); await f.client.flush()
    expect(f.save).not.toHaveBeenCalled()
    f.client.keep('kept'); await f.client.flush({ ...record('kept'), draft: 'Still retained' })
    expect(f.save.mock.calls[0][0].draft).toBe('Still retained'); f.client.dispose()
  })
  it('does not create empty history records or leave a timer after disposal', async () => {
    vi.useFakeTimers(); const f = fixture()
    f.client.update({ ...record(), draft: '' }); await f.client.flush()
    expect(f.save).not.toHaveBeenCalled()
    f.client.update(record()); f.client.dispose(); await vi.advanceTimersByTimeAsync(3000); await settle()
    expect(f.save).not.toHaveBeenCalled()
  })
  it('does not restore an erased draft after typing and clearing before the first save', async () => {
    const f = fixture()
    f.client.update(record()); await f.client.flush({ ...record(), draft: '' })
    expect(f.save.mock.calls.at(-1)?.[0].draft).toBe(''); f.client.dispose()
  })
  it('persists clearing the only draft while an earlier save is still in flight', async () => {
    const f = fixture(); let complete!: () => void
    f.save.mockImplementationOnce(item => new Promise(resolve => { complete = () => resolve(conversationSummary(item)) }))
    f.client.update(record()); const saving = f.client.flush()
    f.client.update({ ...record(), draft: '' }); complete(); await saving
    expect(f.save.mock.calls.at(-1)?.[0].draft).toBe(''); f.client.dispose()
  })
  it('batches a long interview into five-second writes and still flushes the final edit immediately', async () => {
    vi.useFakeTimers(); const f = fixture()
    const long = { ...record(), captions: Array.from({ length: 500 }, (_, n) => ({ id: String(n), source: 'computer' as const, text: 'Speech', startMs: n, endMs: n + 1 })) }
    for (let n = 0; n < 150; n++) { f.client.update({ ...long, draft: `Streaming ${n}` }); await vi.advanceTimersByTimeAsync(200) }
    expect(f.save).toHaveBeenCalledTimes(6)
    await f.client.flush({ ...long, draft: 'Last instant edit' })
    expect(f.save.mock.calls.at(-1)?.[0].draft).toBe('Last instant edit'); f.client.dispose()
  })
  it('does not rewrite an acknowledged revision just because the UI rendered or close requested a flush', async () => {
    const f = fixture(), item = record()
    await f.client.flush(item); await f.client.flush({ ...item, updatedAt: 'later render' })
    expect(f.save).toHaveBeenCalledOnce(); f.client.dispose()
  })
  it('does not write continuously when streaming revisions arrive during disk I/O', async () => {
    vi.useFakeTimers(); const f = fixture(); let complete!: () => void
    f.save.mockImplementationOnce(item => new Promise(resolve => { complete = () => resolve(conversationSummary(item)) }))
    f.client.update(record()); await vi.advanceTimersByTimeAsync(1000)
    f.client.update({ ...record(), draft: 'Newest while writing' }); complete(); await settle()
    expect(f.save).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.save).toHaveBeenCalledTimes(2)
    expect(f.save.mock.calls[1][0].draft).toBe('Newest while writing'); f.client.dispose()
  })
  it('preserves undo back to the acknowledged text while a newer revision is still writing', async () => {
    const f = fixture(), original = record()
    await f.client.flush(original)
    let complete!: () => void
    f.save.mockImplementationOnce(item => new Promise(resolve => { complete = () => resolve(conversationSummary(item)) }))
    const saving = f.client.flush({ ...original, draft: 'Newer text still writing' })
    f.client.update(original); complete(); await saving
    expect(f.save.mock.calls.at(-1)?.[0].draft).toBe(original.draft); f.client.dispose()
  })
})
