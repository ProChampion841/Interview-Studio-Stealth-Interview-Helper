import { describe, expect, it, vi } from 'vitest'
import { decodeTranslationEntities, translateWithApi, translationTargetCode } from '../electron/main/translation-api'
import { translationErrorMessage } from '../electron/main/caption-translations'
const input = { apiKey: 'private-key', text: 'Hello & goodbye.', language: 'ko' as const, signal: new AbortController().signal }
describe('dedicated live translation APIs', () => {
  it('uses Azure text-only JSON, region/key headers, and automatic source detection', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ translations: [{ text: '안녕하세요.' }] }]))
    expect(await translateWithApi({ ...input, provider: 'azure', region: 'eastus', fetchImpl })).toBe('안녕하세요.')
    const [url, request] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=ko')
    expect(request?.headers).toMatchObject({ 'Ocp-Apim-Subscription-Key': 'private-key', 'Ocp-Apim-Subscription-Region': 'eastus' })
    expect(JSON.parse(request!.body as string)).toEqual([{ Text: input.text }])
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', signal: input.signal })
  })
  it('supports Azure global keys without a region and maps Norwegian', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ translations: [{ text: 'Hei.' }] }]))
    await translateWithApi({ ...input, language: 'no', provider: 'azure', fetchImpl })
    expect(String(fetchImpl.mock.calls[0][0])).toContain('to=nb')
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Ocp-Apim-Subscription-Region')
  })
  it('uses Google Basic NMT, keeps keys out of URLs, and decodes returned entities once', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { translations: [{ translatedText: 'It&#39;s &lt;fine&gt; &amp; safe.' }] } }))
    const text = await translateWithApi({ ...input, provider: 'google', language: 'zh-Hant', fetchImpl })
    expect(text).toBe("It's <fine> & safe.")
    expect(fetchImpl.mock.calls[0][0]).toBe('https://translation.googleapis.com/language/translate/v2')
    const request = fetchImpl.mock.calls[0][1]!
    expect(request.headers).toHaveProperty('X-goog-api-key', 'private-key')
    expect(JSON.parse(request.body as string)).toEqual({ q: [input.text], target: 'zh-TW', format: 'text', model: 'nmt' })
    expect(translationTargetCode('google', 'zh-Hans')).toBe('zh-CN')
    expect(translationTargetCode('google', 'fil')).toBe('tl')
    expect(decodeTranslationEntities('&#x1f600; &amp;lt; &#99999999;')).toBe('😀 &lt; &#99999999;')
  })
  it.each(['azure', 'google'] as const)('rejects malformed %s responses', async provider => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: 'wrong schema' }))
    await expect(translateWithApi({ ...input, provider, fetchImpl })).rejects.toThrow('Invalid translation response')
  })
  it.each([401, 403, 429, 503])('sanitizes HTTP %i without reading private error bodies', async status => {
    const response = new Response('private-key caption-content', { status })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(translateWithApi({ ...input, provider: 'google', fetchImpl })).rejects.toMatchObject({ status, message: `Translation HTTP ${status}` })
    expect(translationErrorMessage(status)).not.toContain('private-key')
    if (status === 429) expect(translationErrorMessage(status)).toMatch(/quota/)
  })
})
