import { describe, expect, it } from 'vitest'
import {
  normalizeCoachingModel,
  normalizeEnvironmentModel,
  normalizeProxyHost,
  normalizeProxyPort,
  normalizeProxySettings,
  proxyAuthMatches,
  proxyRulesFor,
  sameProxyIdentity,
  type NormalizedProxySettings
} from '../shared/connection-settings'
import { COACHING_MODELS, LIMITS } from '../shared/contracts'

describe('coaching model settings', () => {
  it('accepts every model offered by the settings panel', () => {
    for (const model of COACHING_MODELS) {
      expect(normalizeCoachingModel(model.id)).toBe(model.id)
      expect(normalizeCoachingModel(`  ${model.id}  `)).toBe(model.id)
    }
  })

  it.each([
    '',
    'gpt-unknown',
    'gpt-6-astra\nignore-previous-instructions',
    'https://api.openai.com/v1/models',
    42,
    null,
    undefined,
    { id: COACHING_MODELS[0].id }
  ])('rejects a model outside the UI allowlist: %p', (value) => {
    expect(() => normalizeCoachingModel(value)).toThrow(/supported coaching models/i)
  })

  it('normalizes a syntactically safe environment override without treating it as a UI choice', () => {
    expect(normalizeEnvironmentModel('  deployment:model_1.2  ')).toBe('deployment:model_1.2')
    expect(normalizeEnvironmentModel('bad model')).toBeNull()
    expect(normalizeEnvironmentModel('model\nsecond')).toBeNull()
    expect(normalizeEnvironmentModel(`m${'x'.repeat(100)}`)).toBeNull()
    expect(normalizeEnvironmentModel({ toString: () => COACHING_MODELS[0].id })).toBeNull()
  })
})

describe('proxy settings normalization', () => {
  it.each([
    ['HTTP hostname', { mode: 'http', host: 'Proxy.Example.COM', port: '8080' }, {
      mode: 'http', host: 'proxy.example.com', port: 8080, username: '', password: '', clearPassword: false
    }],
    ['HTTP IPv4', { mode: 'http', host: '127.0.0.1', port: 3128 }, {
      mode: 'http', host: '127.0.0.1', port: 3128, username: '', password: '', clearPassword: false
    }],
    ['SOCKS5 hostname', { mode: 'socks5', host: 'socks.example', port: '1080' }, {
      mode: 'socks5', host: 'socks.example', port: 1080, username: '', password: '', clearPassword: false
    }],
    ['SOCKS5 bracketed IPv6', { mode: 'socks5', host: '[2001:DB8::1]', port: 1080 }, {
      mode: 'socks5', host: '[2001:db8::1]', port: 1080, username: '', password: '', clearPassword: false
    }]
  ])('accepts and canonicalizes a valid %s proxy', (_label, input, expected) => {
    expect(normalizeProxySettings(input)).toEqual(expected)
  })

  it('accepts HTTP proxy credentials without placing them in the generated rule', () => {
    const normalized = normalizeProxySettings({
      mode: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'interview-user',
      password: 'correct horse battery staple',
      clearPassword: true
    })

    expect(normalized).toMatchObject({
      mode: 'http',
      username: 'interview-user',
      password: 'correct horse battery staple',
      clearPassword: true
    })
    expect(proxyRulesFor(normalized)).toBe('http://proxy.example:8080')
    expect(proxyRulesFor(normalized)).not.toMatch(/interview-user|correct horse/i)
  })

  it.each(['system', 'direct'] as const)('clears endpoint and credential fields in %s mode', (mode) => {
    const normalized = normalizeProxySettings({
      mode,
      host: 'attacker.example',
      port: 4444,
      username: 'should-not-survive',
      password: 'should-not-survive',
      clearPassword: true
    })

    expect(normalized).toEqual({
      mode,
      host: '',
      username: '',
      password: '',
      clearPassword: true
    })
    expect(proxyRulesFor(normalized)).toBeNull()
  })

  it.each([
    'http://proxy.example',
    'socks5://proxy.example',
    'user@proxy.example',
    'proxy.example/path',
    'proxy.example?target=other',
    'proxy.example#fragment',
    'proxy.example;https=attacker.example:443',
    'proxy.example,direct://',
    'proxy.example=attacker',
    'proxy.\nexample',
    'proxy.\u0000example',
    '2001:db8::1'
  ])('rejects a host containing a scheme, path, credentials, injection delimiter, control, or unbracketed IPv6: %p', (host) => {
    expect(() => normalizeProxyHost(host)).toThrow()
  })

  it.each([
    '[not-ipv6]',
    '[127.0.0.1]',
    '[2001:db8::1',
    '2001:db8::1]',
    '.proxy.example',
    'proxy.example.',
    'proxy..example',
    '-proxy.example',
    'proxy-.example',
    `${'a'.repeat(64)}.example`,
    'a'.repeat(LIMITS.proxyHostChars + 1)
  ])('rejects a malformed or overlong host: %p', (host) => {
    expect(() => normalizeProxyHost(host)).toThrow()
  })

  it.each([
    undefined,
    null,
    '',
    0,
    -1,
    65_536,
    80.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    'not-a-port',
    '8080/path',
    '1e3',
    '0x50',
    '+8080',
    '8080.0'
  ])('rejects an invalid port: %p', (port) => {
    expect(() => normalizeProxyPort(port)).toThrow(/1 to 65535/i)
  })

  it('accepts the complete valid port range', () => {
    expect(normalizeProxyPort(1)).toBe(1)
    expect(normalizeProxyPort('65535')).toBe(65_535)
  })

  it.each(['https', 'socks4', 'file', 'pac', '', undefined, null])('rejects unsupported proxy mode %p', (mode) => {
    expect(() => normalizeProxySettings({ mode, host: 'proxy.example', port: 8080 })).toThrow(/System, Direct, HTTP, or SOCKS5/i)
  })

  it('rejects paths and query strings supplied through proxy fields', () => {
    expect(() => normalizeProxySettings({ mode: 'http', host: 'proxy.example/api', port: 8080 })).toThrow()
    expect(() => normalizeProxySettings({ mode: 'http', host: 'proxy.example?x=1', port: 8080 })).toThrow()
  })

  it('rejects control characters and overlong HTTP credentials', () => {
    expect(() => normalizeProxySettings({
      mode: 'http', host: 'proxy.example', port: 8080, username: 'user\nname'
    })).toThrow(/control characters/i)
    expect(() => normalizeProxySettings({
      mode: 'http', host: 'proxy.example', port: 8080, password: 'pass\u0000word'
    })).toThrow(/control characters/i)
    expect(() => normalizeProxySettings({
      mode: 'http', host: 'proxy.example', port: 8080, username: 'u'.repeat(LIMITS.proxyUsernameChars + 1)
    })).toThrow(/too long/i)
    expect(() => normalizeProxySettings({
      mode: 'http', host: 'proxy.example', port: 8080, password: 'p'.repeat(LIMITS.proxyPasswordChars + 1)
    })).toThrow(/too long/i)
  })

  it.each([
    { username: 'user', password: '' },
    { username: '', password: 'secret' },
    { username: 'user', password: 'secret' }
  ])('rejects SOCKS5 credentials because Chromium does not support them: %o', (credentials) => {
    expect(() => normalizeProxySettings({
      mode: 'socks5', host: '127.0.0.1', port: 1080, ...credentials
    })).toThrow(/SOCKS5 authentication is not supported/i)
  })

  it('rejects missing endpoint fields for a fixed proxy', () => {
    expect(() => normalizeProxySettings({ mode: 'http', port: 8080 })).toThrow(/proxy host/i)
    expect(() => normalizeProxySettings({ mode: 'http', host: 'proxy.example' })).toThrow(/proxy port/i)
  })

  it('generates fixed proxy rules for HTTP, SOCKS5, and IPv6 without raw-input delimiters', () => {
    expect(proxyRulesFor(normalizeProxySettings({ mode: 'http', host: 'proxy.example', port: 3128 })))
      .toBe('http://proxy.example:3128')
    expect(proxyRulesFor(normalizeProxySettings({ mode: 'socks5', host: '127.0.0.1', port: 1080 })))
      .toBe('socks5://127.0.0.1:1080')
    expect(proxyRulesFor(normalizeProxySettings({ mode: 'socks5', host: '[::1]', port: 1080 })))
      .toBe('socks5://[::1]:1080')
  })
})

describe('proxy identity and authentication scoping', () => {
  const authenticatedHttp = normalizeProxySettings({
    mode: 'http',
    host: 'Proxy.Example',
    port: 8080,
    username: 'user',
    password: 'secret'
  })

  it('supplies HTTP credentials only to the exact proxy challenge', () => {
    expect(proxyAuthMatches(authenticatedHttp, {
      isProxy: true,
      host: 'PROXY.EXAMPLE',
      port: 8080
    })).toBe(true)
    expect(proxyAuthMatches(authenticatedHttp, {
      isProxy: false,
      host: 'proxy.example',
      port: 8080
    })).toBe(false)
    expect(proxyAuthMatches(authenticatedHttp, {
      isProxy: true,
      host: 'attacker.example',
      port: 8080
    })).toBe(false)
    expect(proxyAuthMatches(authenticatedHttp, {
      isProxy: true,
      host: 'proxy.example',
      port: 8081
    })).toBe(false)
  })

  it('normalizes IPv6 brackets when matching an HTTP proxy challenge', () => {
    const ipv6 = normalizeProxySettings({ mode: 'http', host: '[::1]', port: 8080 })
    expect(proxyAuthMatches(ipv6, { isProxy: true, host: '::1', port: 8080 })).toBe(true)
    expect(proxyAuthMatches(ipv6, { isProxy: true, host: '[::1]', port: 8080 })).toBe(true)
  })

  it('never matches authentication for SOCKS5, System, or Direct modes', () => {
    const challenge = { isProxy: true, host: 'proxy.example', port: 1080 }
    const configs: NormalizedProxySettings[] = [
      normalizeProxySettings({ mode: 'socks5', host: 'proxy.example', port: 1080 }),
      normalizeProxySettings({ mode: 'system' }),
      normalizeProxySettings({ mode: 'direct' })
    ]
    for (const config of configs) expect(proxyAuthMatches(config, challenge)).toBe(false)
  })

  it('compares normalized endpoint identities without including passwords', () => {
    const sameEndpointNewPassword = normalizeProxySettings({
      mode: 'http', host: 'proxy.example', port: 8080, username: 'user', password: 'new-secret'
    })
    const differentUser = normalizeProxySettings({
      mode: 'http', host: 'proxy.example', port: 8080, username: 'other', password: 'secret'
    })

    expect(sameProxyIdentity(authenticatedHttp, sameEndpointNewPassword)).toBe(true)
    expect(sameProxyIdentity(authenticatedHttp, differentUser)).toBe(false)
  })
})
