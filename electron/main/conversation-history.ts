import { mkdir, open, readFile, readdir, rename, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HISTORY_MAX_BYTES, conversationSummary, historyId, matchesConversation, parseConversation, type ConversationList, type ConversationRecord, type ConversationSummary } from '../../shared/conversation-history'

/** Each conversation is atomic and independent of settings/cache/model folders. */
export class ConversationHistory {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private directory: () => string) {}
  private queue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action)
    this.tail = next.catch(() => {})
    return next
  }
  private async read(id: string): Promise<ConversationRecord> {
    const file = join(this.directory(), `${historyId(id)}.json`)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > HISTORY_MAX_BYTES) throw new Error('Conversation file cannot be read safely.')
    const record = parseConversation(JSON.parse(await readFile(file, 'utf8')))
    if (record.id !== id) throw new Error('Conversation ID does not match its file.')
    return record
  }
  private async write(record: ConversationRecord): Promise<ConversationSummary> {
    const payload = JSON.stringify(record)
    if (Buffer.byteLength(payload) > HISTORY_MAX_BYTES) throw new Error('This conversation is too large to save. Export it and start a new conversation.')
    await mkdir(this.directory(), { recursive: true })
    const temporary = join(this.directory(), `${record.id}.${randomUUID()}.tmp`)
    const target = join(this.directory(), `${record.id}.json`)
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(payload, 'utf8'); await handle.sync(); await handle.close(); handle = undefined
      await rename(temporary, target)
    } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
    return conversationSummary(record)
  }
  save(raw: unknown): Promise<ConversationSummary> { const record = parseConversation(raw); return this.queue(() => this.write(record)) }
  get(id: string): Promise<ConversationRecord> { historyId(id); return this.queue(() => this.read(id)) }
  list(query = ''): Promise<ConversationList> {
    if (typeof query !== 'string' || query.length > 300) throw new Error('Search text is too long.')
    return this.queue(async () => {
      const names = await readdir(this.directory()).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      const conversations: ConversationSummary[] = []; let unreadable = 0
      for (const name of names) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
        try { const item = await this.read(name.slice(0, -5)); if (matchesConversation(item, query)) conversations.push(conversationSummary(item)) }
        catch { unreadable++ }
      }
      return { conversations: conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), unreadable }
    })
  }
  rename(id: string, title: string): Promise<ConversationSummary> {
    historyId(id)
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\u0000')) throw new Error('Enter a conversation name of at most 120 characters.')
    return this.queue(async () => this.write({ ...await this.read(id), title: title.trim(), updatedAt: new Date().toISOString() }))
  }
  remove(id: string): Promise<void> {
    historyId(id)
    return this.queue(async () => { await unlink(join(this.directory(), `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error }) })
  }
  flush(): Promise<unknown> { return this.tail }
}
