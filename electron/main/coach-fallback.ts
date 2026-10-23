import { PROVIDER_NAMES, type ProviderId } from '../../shared/contracts'
import { isCreditLimitError } from '../../shared/chat-completion-error'

export interface CoachConnection { provider: ProviderId; model: string; apiKey: string; baseUrl: string }
export interface CoachFallback { from: ProviderId; to: ProviderId; model: string; message: string }

/** The caller supplies only configured connections. No provider is visited twice. */
export async function runCoachWithFallback(options: {
  connections: CoachConnection[]; signal: AbortSignal
  attempt: (connection: CoachConnection, onDelta: (text: string) => void) => Promise<void>
  onStarted: (connection: CoachConnection) => void
  onDelta: (text: string) => void
  onFallback: (event: CoachFallback) => void
}): Promise<void> {
  const connections = options.connections.filter((connection, index, all) => all.findIndex(item => item.provider === connection.provider) === index).slice(0, 4)
  let recovering = false
  for (let index = 0; index < connections.length; index++) {
    options.signal.throwIfAborted()
    const connection = connections[index]
    options.onStarted(connection)
    try {
      let received = false
      await options.attempt(connection, text => {
        options.signal.throwIfAborted()
        if (text) { received = true; options.onDelta(text) }
      })
      options.signal.throwIfAborted()
      if (!received) throw new Error('The AI service returned an empty answer.')
      return
    } catch (error) {
      options.signal.throwIfAborted()
      if (!recovering && !isCreditLimitError(error)) throw error
      recovering = true
      const next = connections[index + 1]
      if (!next) {
        const message = connections.length === 1
          ? `${error instanceof Error ? error.message : 'The provider reached its credit or quota limit.'} No other saved provider is configured. Add one in Settings > AI connection, then retry.`
          : `No saved provider could complete this answer. Tried ${connections.map(item => PROVIDER_NAMES[item.provider]).join(', ')}. Check their credits, connection and model settings, then retry.`
        throw new Error(message)
      }
      options.onFallback({ from: connection.provider, to: next.provider, model: next.model, message: `Switched to ${PROVIDER_NAMES[next.provider]} after a credit or quota error. Your preferred provider is unchanged.` })
    }
  }
  throw new Error('No saved provider is configured. Add one in Settings > AI connection.')
}
