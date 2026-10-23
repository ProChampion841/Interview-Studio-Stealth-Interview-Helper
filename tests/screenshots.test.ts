import { describe, expect, it } from 'vitest'
import { LIMITS } from '../shared/contracts'
import { areaToPixels, parseScreenshotAttachments, screenshotContent } from '../shared/screenshots'
import { streamChatCompletions } from '../electron/main/chat-completions'

const images = ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB', 'data:image/webp;base64,CCCC']

describe('screenshot request validation', () => {
  it('preserves multiple attachments and their order, and accepts old single-image requests', () => {
    expect(parseScreenshotAttachments({ imageDataUrls: images })).toEqual(images)
    expect(parseScreenshotAttachments({ imageDataUrl: images[0] })).toEqual([images[0]])
    expect(parseScreenshotAttachments({})).toEqual([])
  })
  it('rejects malformed lists, unsupported content, and images over the per-image limit', () => {
    for (const value of ['not-a-list', [null], ['https://example.com/image.png'], ['data:image/svg+xml;base64,AAAA'], ['data:image/png;base64,AAAA<script>']]) {
      expect(() => parseScreenshotAttachments({ imageDataUrls: value })).toThrow()
    }
    expect(() => parseScreenshotAttachments({ imageDataUrls: ['data:image/png;base64,' + 'A'.repeat(LIMITS.imageDataUrlChars)] })).toThrow()
  })
  it('accepts large attachment lists without truncating or imposing a count limit', () => {
    const attachments = Array.from({ length: 1000 }, (_, i) => images[i % images.length])
    expect(parseScreenshotAttachments({ imageDataUrls: attachments })).toEqual(attachments)
  })
  it('accepts combined payloads above the old limit while validating each image', () => {
    const attachments = Array(5).fill('data:image/png;base64,' + 'A'.repeat(4_000_000))
    expect(parseScreenshotAttachments({ imageDataUrls: attachments })).toEqual(attachments)
    expect(() => parseScreenshotAttachments({ imageDataUrls: [...Array(20).fill(images[0]), 'invalid'] })).toThrow(/invalid/)
  })
})

describe('area selection on display snapshots', () => {
  it('maps normalized coordinates to actual screenshot pixels on a scaled display', () => {
    expect(areaToPixels({ x: .25, y: .1, width: .5, height: .4 }, 3840, 2160)).toEqual({ x: 960, y: 216, width: 1920, height: 864 })
  })
  it('includes the whole selected rectangle when coordinates fall between pixels', () => {
    expect(areaToPixels({ x: .001, y: .001, width: .501, height: .501 }, 100, 100)).toEqual({ x: 0, y: 0, width: 51, height: 51 })
  })
  it('accepts full display bounds and rejects invalid or outside-display selections', () => {
    expect(areaToPixels({ x: 0, y: 0, width: 1, height: 1 }, 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    for (const area of [null, {}, { x: -1, y: 0, width: 1, height: 1 }, { x: .9, y: 0, width: .2, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) {
      expect(() => areaToPixels(area, 1920, 1080)).toThrow()
    }
  })
})

describe('provider screenshot payloads', () => {
  it('includes every attachment in OpenAI Responses content in order', () => {
    const attachments = Array.from({ length: 24 }, (_, i) => images[i % images.length])
    expect(screenshotContent(attachments).map(part => part.image_url)).toEqual(attachments)
  })
  it('includes all attachments in compatible chat provider requests', async () => {
    const attachments = Array.from({ length: 24 }, (_, i) => images[i % images.length])
    let sentBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      sentBody = JSON.parse(init!.body as string)
      return new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n', { status: 200 })
    }
    await streamChatCompletions({ baseUrl: 'http://localhost:1234/v1', apiKey: null, model: 'local', fetchImpl, systemPrompt: 'Coach', userPayload: { text: 'Compare these screenshots.', imageDataUrls: attachments }, signal: new AbortController().signal, onDelta: () => {} })
    const messages = sentBody!.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>
    expect(messages[1].content.filter(part => part.type === 'image_url').map(part => part.image_url!.url)).toEqual(attachments)
  })
})
