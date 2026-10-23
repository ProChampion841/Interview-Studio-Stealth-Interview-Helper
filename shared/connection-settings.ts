import {
  COACHING_MODELS,
  LIMITS,
  type CoachingModel,
  type ProxyMode,
  type SetProxyRequest
} from './contracts'

export type NormalizedProxySettings =
  | { mode: 'system' | 'direct'; host: ''; port?: undefined; username: ''; password: ''; clearPassword: boolean }
  | { mode: 'http' | 'socks5'; host: string; port: number; username: string; password: string; clearPassword: boolean }

const MODEL_IDS = new Set<string>(COACHING_MODELS.map(({ id }) => id))
const HOST_FORBIDDEN = /[\s\u0000-\u001f\u007f\/@?#;,=\\]/
const AUTH_CONTROL = /[\u0000-\u001f\u007f]/

export function normalizeCoachingModel(value: unknown): CoachingModel {
  const model = typeof value === 'string' ? value.trim() : ''
  if (!MODEL_IDS.has(model)) throw new Error('Choose one of the supported coaching models.')
  return model as CoachingModel
}

export function normalizeEnvironmentModel(value: unknown): string | null {
  const model = typeof value === 'string' ? value.trim() : ''
  return /^[a-z0-9][a-z0-9._:-]{0,99}$/i.test(model) ? model : null
}

const PROVIDER_MODEL_FORBIDDEN = /[\s\u0000-\u001f\u007f<>"'\\]/

export function normalizeProviderModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : ''
  if (!model) throw new Error('Enter a model identifier.')
  if (model.length > LIMITS.providerModelChars) {
    throw new Error(`The model identifier must be ${LIMITS.providerModelChars} characters or fewer.`)
  }
  if (PROVIDER_MODEL_FORBIDDEN.test(model)) {
    throw new Error('The model identifier contains unsupported characters.')
  }
  return model
}

export function normalizeProviderBaseUrl(value: unknown, allowPlainHttp: boolean): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.length > LIMITS.providerBaseUrlChars) {
    throw new Error(`Enter a base URL of up to ${LIMITS.providerBaseUrlChars} characters.`)
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Enter a valid base URL, for example https://nano-gpt.com/api/v1.')
  }
  if (parsed.protocol !== 'https:' && !(allowPlainHttp && parsed.protocol === 'http:')) {
    throw new Error(allowPlainHttp ? 'Use an http:// URL for a local server or an https:// URL for a hosted API.' : 'Use an https:// base URL.')
  }
  if (parsed.username || parsed.password) throw new Error('Do not include credentials in the base URL.')
  if (!parsed.hostname) throw new Error('Enter a valid base URL host.')
  const path = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${path}`
}

export function normalizeProviderApiKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!key) throw new Error('Enter an API key.')
  if (key.length > LIMITS.providerKeyChars) throw new Error('The API key is too long.')
  if (AUTH_CONTROL.test(key)) throw new Error('The API key contains unsupported control characters.')
  return key
}

function normalizeMode(value: unknown): ProxyMode {
  if (value === 'system' || value === 'direct' || value === 'http' || value === 'socks5') return value
  throw new Error('Choose System, Direct, HTTP, or SOCKS5 proxy mode.')
}

export function normalizeProxyHost(value: unknown): string {
  const host = typeof value === 'string' ? value.trim() : ''
  if (!host) throw new Error('Enter a proxy host.')
  if (host.length > LIMITS.proxyHostChars) throw new Error('The proxy host is too long.')
  if (HOST_FORBIDDEN.test(host) || host.includes('://')) {
    throw new Error('Enter only a proxy hostname or IP address, without a scheme, path, or credentials.')
  }

  if (host.startsWith('[') || host.endsWith(']')) {
    if (!/^\[[0-9a-f:.]+\]$/i.test(host) || !host.includes(':')) {
      throw new Error('Enter IPv6 proxy addresses in brackets, for example [::1].')
    }
    try {
      const parsed = new URL(`http://${host}:80`)
      if (parsed.hostname.toLowerCase() !== host.toLowerCase()) throw new Error('mismatch')
    } catch {
      throw new Error('Enter a valid bracketed IPv6 proxy address.')
    }
    return host.toLowerCase()
  }

  if (host.includes(':')) throw new Error('Enter IPv6 proxy addresses in brackets, for example [::1].')
  if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    throw new Error('Enter a valid proxy hostname or IP address.')
  }
  const labels = host.split('.')
  if (labels.some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('Enter a valid proxy hostname or IP address.')
  }
  return host.toLowerCase()
}

export function normalizeProxyPort(value: unknown): number {
  if (typeof value === 'string' && !/^[0-9]{1,5}$/.test(value.trim())) {
    throw new Error('Enter a proxy port from 1 to 65535.')
  }
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Enter a proxy port from 1 to 65535.')
  }
  return port
}

function normalizeUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim() : ''
  if (username.length > LIMITS.proxyUsernameChars) throw new Error('The proxy username is too long.')
  if (AUTH_CONTROL.test(username)) throw new Error('The proxy username contains unsupported control characters.')
  return username
}

function normalizePassword(value: unknown): string {
  const password = typeof value === 'string' ? value : ''
  if (password.length > LIMITS.proxyPasswordChars) throw new Error('The proxy password is too long.')
  if (AUTH_CONTROL.test(password)) throw new Error('The proxy password contains unsupported control characters.')
  return password
}

export function normalizeProxySettings(value: unknown): NormalizedProxySettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid proxy settings.')
  const input = value as SetProxyRequest
  const mode = normalizeMode(input.mode)
  const clearPassword = input.clearPassword === true
  if (mode === 'system' || mode === 'direct') {
    return { mode, host: '', username: '', password: '', clearPassword }
  }

  const host = normalizeProxyHost(input.host)
  const port = normalizeProxyPort(input.port)
  const username = normalizeUsername(input.username)
  const password = normalizePassword(input.password)
  if (mode === 'socks5' && (username || password)) {
    throw new Error('SOCKS5 authentication is not supported by Chromium. Remove the username and password.')
  }
  return { mode, host, port, username, password, clearPassword }
}

export function proxyRulesFor(config: NormalizedProxySettings): string | null {
  if (config.mode === 'system' || config.mode === 'direct') return null
  return `${config.mode}://${config.host}:${config.port}`
}

export function sameProxyIdentity(
  left: Pick<NormalizedProxySettings, 'mode' | 'host' | 'port' | 'username'>,
  right: Pick<NormalizedProxySettings, 'mode' | 'host' | 'port' | 'username'>
): boolean {
  return left.mode === right.mode && left.host === right.host && left.port === right.port && left.username === right.username
}

export function proxyAuthMatches(
  config: NormalizedProxySettings,
  authInfo: { isProxy: boolean; host: string; port: number }
): boolean {
  if (config.mode !== 'http' || !authInfo.isProxy || authInfo.port !== config.port) return false
  const authHost = authInfo.host.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const configHost = config.host.replace(/^\[|\]$/g, '').toLowerCase()
  return authHost === configHost
}
