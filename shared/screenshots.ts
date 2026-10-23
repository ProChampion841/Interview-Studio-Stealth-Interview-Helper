import { LIMITS, type CaptureArea } from './contracts'

/** Validate before copying screenshot data across the provider boundary. */
export function parseScreenshotAttachments(input: { imageDataUrl?: unknown; imageDataUrls?: unknown }): string[] {
  if (input.imageDataUrls !== undefined && !Array.isArray(input.imageDataUrls)) throw new Error('Screenshot attachments must be a list.')
  const values = input.imageDataUrls === undefined
    ? (input.imageDataUrl ? [input.imageDataUrl] : [])
    : input.imageDataUrls as unknown[]
  return values.map(value => {
    if (typeof value !== 'string' || value.length > LIMITS.imageDataUrlChars || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)) {
      throw new Error('A screenshot attachment is invalid or too large. Use PNG, JPEG, or WebP.')
    }
    return value
  })
}

/** Normalized overlay coordinates map to the actual screenshot pixels, including HiDPI. */
export function areaToPixels(value: unknown, imageWidth: number, imageHeight: number): CaptureArea {
  if (!value || typeof value !== 'object') throw new Error('Select a screenshot area first.')
  const { x, y, width, height } = value as CaptureArea
  if (![x, y, width, height].every(v => typeof v === 'number' && Number.isFinite(v)) ||
      x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001 ||
      imageWidth < 1 || imageHeight < 1) throw new Error('The selected area is outside the screen.')
  const left = Math.min(imageWidth - 1, Math.floor(x * imageWidth))
  const top = Math.min(imageHeight - 1, Math.floor(y * imageHeight))
  const right = Math.min(imageWidth, Math.ceil((x + width) * imageWidth))
  const bottom = Math.min(imageHeight, Math.ceil((y + height) * imageHeight))
  if (right - left < 2 || bottom - top < 2) throw new Error('Select a larger area.')
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function screenshotContent(images: string[]): Array<{ type: 'input_image'; image_url: string; detail: 'auto' }> {
  return images.map(image_url => ({ type: 'input_image', image_url, detail: 'auto' }))
}
