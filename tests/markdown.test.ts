import { describe, expect, it } from 'vitest'
import { renderCoachMarkdown } from '../shared/markdown'

describe('renderCoachMarkdown', () => {
  it('escapes all HTML before any tag is generated', () => {
    const html = renderCoachMarkdown('<script>alert(1)</script>\n\n**bold** <img src=x onerror=y>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('<strong>bold</strong> &lt;img src=x onerror=y&gt;')
  })

  it('keeps injected markup inert inside bold and code spans', () => {
    const html = renderCoachMarkdown('**<b>** and `<i>`')
    expect(html).toContain('<strong>&lt;b&gt;</strong>')
    expect(html).toContain('<code>&lt;i&gt;</code>')
  })

  it('renders headings, lists, quotes, and code', () => {
    const html = renderCoachMarkdown(
      '### Start here\n\n- one\n- two\n\n1. first\n2. second\n\n> note\n\nUse `npm test` and **act** now.\n\n```js\nconst a = 1\n```'
    )
    expect(html).toContain('<h4>Start here</h4>')
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>')
    expect(html).toContain('<blockquote>note</blockquote>')
    expect(html).toContain('<code>npm test</code>')
    expect(html).toContain('<pre><code>const a = 1</code></pre>')
  })

  it('keeps paragraph line breaks and closes an unterminated fence', () => {
    expect(renderCoachMarkdown('line one\nline two')).toContain('line one<br />line two')
    expect(renderCoachMarkdown('```\nstill open')).toContain('<pre><code>still open</code></pre>')
  })

  it('returns empty output for empty input and enforces the cap', () => {
    expect(renderCoachMarkdown('   ')).toBe('')
    expect(renderCoachMarkdown('x'.repeat(70_000)).length).toBeLessThan(61_000)
  })
})
