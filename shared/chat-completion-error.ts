export const CREDIT_ERROR_CODES = new Set(['insufficient_balance', 'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'billing_hard_limit_reached', 'daily_usd_limit_exceeded', 'daily_rpd_limit_exceeded'])
const ERROR_CODES = new Set([...CREDIT_ERROR_CODES, 'model_not_found', 'model_not_allowed', 'model_not_available', 'all_fallbacks_failed', 'no_fallback_available', 'invalid_api_key', 'rate_limit_exceeded', 'missing_required_parameter', 'invalid_parameter_value', 'unsupported_parameter', 'context_length_exceeded', 'content_policy_violation'])
const LIMIT_SOURCES = new Set(['openrouter_credits', 'openrouter_key_limit', 'openrouter_in_flight_budget'])

/** Safe metadata only: upstream messages can echo keys or private input. */
export class ChatCompletionError extends Error {
  constructor(
    public status: number,
    public code?: string,
    public retryAfterMs?: number,
    public limitSource?: string,
    public affordableTokens?: number
  ) {
    const message = status === 402 || (code && CREDIT_ERROR_CODES.has(code)) || limitSource === 'openrouter_key_limit'
      ? limitSource === 'openrouter_in_flight_budget'
        ? 'OpenRouter has other requests still processing or settling. Wait a moment and try again.'
        : limitSource === 'openrouter_key_limit'
          ? 'The OpenRouter API key spending limit was reached. Check its limit in OpenRouter settings and try again.'
          : 'This request exceeds the available AI credits or key spending limit. Check the selected provider\'s credit settings and try again.'
      : status === 200
        ? 'The AI service could not finish the response.'
        : `The AI service returned HTTP ${status}${code ? ` (${code})` : ''}.`
    super(message)
    this.name = 'ChatCompletionError'
  }
}

/** Inspect provider text locally, retaining only allowlisted metadata and a bounded integer. */
export function parseChatCompletionError(status: number, data: unknown, retryAfterMs?: number): ChatCompletionError {
  const body = data as { error?: { code?: unknown; type?: unknown; message?: unknown; metadata?: { limit_source?: unknown } } | string } | null
  const error = typeof body?.error === 'object' && body.error ? body.error : undefined
  const raw = error?.code
  let code = typeof raw === 'string' && ERROR_CODES.has(raw) ? raw : undefined
  if (!code && error?.type === 'insufficient_quota') code = 'insufficient_quota'
  const message = (typeof body?.error === 'string' ? body.error : typeof error?.message === 'string' ? error.message : '').slice(0, 4_000)
  if (!code && /model.*(?:not found|does not exist|unknown model)|unknown model/i.test(message)) code = 'model_not_found'
  if (!code && /insufficient.*(?:balance|credit)|(?:balance|credit).*insufficient/i.test(message)) code = 'insufficient_balance'
  const rawSource = error?.metadata?.limit_source
  const limitSource = typeof rawSource === 'string' && LIMIT_SOURCES.has(rawSource) ? rawSource : undefined
  // Unknown limit sources must not opt into the legacy-message recovery path.
  const creditLimit = rawSource === undefined || limitSource === 'openrouter_credits'
  const match = status === 402 && creditLimit ? /\bcan only afford\s+((?:\d{1,3}(?:,\d{3})+|\d+))(?:\s+tokens)?(?=[.!?,](?:\s|$)|\s*$)/i.exec(message) : null
  const amount = match ? Number(match[1].replace(/,/g, '')) : NaN
  const affordableTokens = Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000 ? amount : undefined
  return new ChatCompletionError(status, code, retryAfterMs, limitSource, affordableTokens)
}

export function isCreditLimitError(error: unknown): boolean {
  return error instanceof ChatCompletionError && (error.status === 402 || error.limitSource === 'openrouter_key_limit' || (!!error.code && CREDIT_ERROR_CODES.has(error.code)))
}
