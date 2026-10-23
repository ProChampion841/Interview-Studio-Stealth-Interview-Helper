import type { AppSettings } from './contracts'

export interface ApiKeyCandidates {
  memory?: string
  stored?: string
  environment?: string
}

export function resolveApiKey(candidates: ApiKeyCandidates): {
  value: string
  source: AppSettings['apiKeySource']
} {
  const choices: Array<[string | undefined, AppSettings['apiKeySource']]> = [
    [candidates.memory, 'memory'],
    [candidates.stored, 'secure-storage'],
    [candidates.environment, 'environment']
  ]
  for (const [candidate, source] of choices) {
    const value = candidate?.trim() ?? ''
    if (value) return { value, source }
  }
  return { value: '', source: 'none' }
}
