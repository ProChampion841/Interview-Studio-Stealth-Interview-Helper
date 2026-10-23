import { parseChatCompletionError } from './chat-completion-error'

export interface ChatDeltaParser {
  push(chunk: string): string[]
}

interface DeltaChoice {
  delta?: { content?: unknown }
}

interface DeltaPayload {
  choices?: DeltaChoice[]
  error?: { message?: unknown; code?: unknown }
}

/**
 * Parses OpenAI-compatible `chat/completions` SSE streams (`data:` lines with
 * JSON payloads, terminated by `data: [DONE]`). Tolerates chunks split mid-line
 * by carrying partial lines between `push` calls, and ignores reasoning-only
 * delta fields such as `reasoning_content`.
 */
export function createChatDeltaParser(): ChatDeltaParser {
  let pending = ''

  const extractLine = (line: string): string[] => {
    const deltas: string[] = []
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return deltas
    const payload = trimmed.slice(5).trim()
    if (!payload) return deltas
    if (payload === '[DONE]') return deltas
    let parsed: DeltaPayload
    try {
      parsed = JSON.parse(payload) as DeltaPayload
    } catch {
      return deltas
    }
    if (!parsed || typeof parsed !== 'object') return deltas
    if (parsed.error) {
      const status = typeof parsed.error.code === 'number' && Number.isInteger(parsed.error.code) && parsed.error.code >= 400 && parsed.error.code <= 599 ? parsed.error.code : 200
      throw parseChatCompletionError(status, parsed)
    }
    const content = parsed.choices?.[0]?.delta?.content
    if (typeof content === 'string' && content) deltas.push(content)
    return deltas
  }

  return {
    push(chunk: string): string[] {
      pending += chunk
      const deltas: string[] = []
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) deltas.push(...extractLine(line))
      return deltas
    }
  }
}
