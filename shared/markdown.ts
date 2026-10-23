/**
 * Renders the small Markdown subset the coach is instructed to emit —
 * headings, bullet and ordered lists, blockquotes, fenced and inline code,
 * and bold — as HTML markup. Every text fragment is HTML-escaped before any
 * tag is generated, so model output can never inject markup.
 */
export function renderCoachMarkdown(source: string, maxChars = 60_000): string {
  const text = (typeof source === 'string' ? source : '').slice(0, maxChars)
  if (!text.trim()) return ''

  const escapeHtml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  const renderInline = (value: string): string =>
    escapeHtml(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let fence: string[] | null = null

  const flushParagraph = (): void => {
    if (paragraph.length) {
      blocks.push(`<p>${paragraph.map(renderInline).join('<br />')}</p>`)
      paragraph = []
    }
  }
  const flushList = (): void => {
    if (list) {
      const tag = list.ordered ? 'ol' : 'ul'
      blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`)
      list = null
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (fence) {
      if (/^```/.test(trimmed)) {
        blocks.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
        fence = null
      } else {
        fence.push(line)
      }
      continue
    }
    if (!trimmed) {
      flushParagraph()
      flushList()
      continue
    }
    if (/^```/.test(trimmed)) {
      flushParagraph()
      flushList()
      fence = []
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(heading[1].length + 1, 4) // "# " -> h2, "## " -> h3, deeper -> h4
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }
    const quote = /^>\s?(.*)$/.exec(trimmed)
    if (quote) {
      flushParagraph()
      flushList()
      blocks.push(`<blockquote>${renderInline(quote[1])}</blockquote>`)
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet) {
      flushParagraph()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1])
      continue
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
    if (ordered) {
      flushParagraph()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[1])
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  flushParagraph()
  flushList()
  if (fence && fence.length) blocks.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`)

  return blocks.join('\n')
}
