import type { TranslationLanguage } from '../../shared/caption-translation'
type TranslationApi = 'azure' | 'google'

export const TRANSLATION_ENDPOINTS = {
  azure: 'https://api.cognitive.microsofttranslator.com/translate',
  google: 'https://translation.googleapis.com/language/translate/v2'
} as const
export function translationTargetCode(provider: TranslationApi, language: TranslationLanguage): string {
  if (provider === 'azure') return language === 'no' ? 'nb' : language
  return ({ 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', fil: 'tl' } as Record<string, string>)[language] ?? language
}
// Google v2 can return HTML entities even for plain-text input. Decode once,
// leaving markup as literal text; the renderer never inserts HTML.
export function decodeTranslationEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}
export async function translateWithApi(options: {
  provider: TranslationApi; apiKey: string; region?: string; text: string; language: TranslationLanguage; signal: AbortSignal; fetchImpl: typeof fetch
}): Promise<string> {
  const { provider, apiKey, text, language, signal, fetchImpl } = options
  const url = new URL(TRANSLATION_ENDPOINTS[provider])
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=UTF-8' }
  const target = translationTargetCode(provider, language)
  let body: string
  if (provider === 'azure') {
    url.searchParams.set('api-version', '3.0'); url.searchParams.set('to', target)
    headers['Ocp-Apim-Subscription-Key'] = apiKey
    if (options.region) headers['Ocp-Apim-Subscription-Region'] = options.region
    body = JSON.stringify([{ Text: text }])
  } else {
    headers['X-goog-api-key'] = apiKey
    body = JSON.stringify({ q: [text], target, format: 'text', model: 'nmt' })
  }
  const response = await fetchImpl(url.href, { method: 'POST', headers, body, signal, redirect: 'error', credentials: 'omit' })
  if (!response.ok) {
    // Never surface upstream bodies, which can contain text or credentials.
    await response.body?.cancel().catch(() => {})
    throw Object.assign(new Error(`Translation HTTP ${response.status}`), { status: response.status })
  }
  const data = await response.json()
  const result: unknown = provider === 'azure' ? data?.[0]?.translations?.[0]?.text : data?.data?.translations?.[0]?.translatedText
  if (typeof result !== 'string' || !result.trim() || result.length > 12_000) throw new Error('Invalid translation response.')
  return provider === 'google' ? decodeTranslationEntities(result) : result
}
