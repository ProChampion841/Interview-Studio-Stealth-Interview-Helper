import { describe, expect, it } from 'vitest'
import {
  buildCompanyAnalysisInstructions,
  buildCompanyAnalysisText,
  extractSearchSnippets,
  stripHtmlToText
} from '../shared/company-research'

describe('stripHtmlToText', () => {
  it('removes tags, scripts, and decodes entities', () => {
    const html = '<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>Acme &amp; Co</h1><p>Builds   widgets</p><!-- comment --></body></html>'
    const text = stripHtmlToText(html)
    expect(text).not.toMatch(/<|script|alert|color/)
    expect(text).toContain('Acme & Co')
    expect(text).toContain('Builds widgets')
  })

  it('collapses blank lines and enforces the cap', () => {
    expect(stripHtmlToText('<p>a</p>\n\n\n<p>b</p>')).not.toMatch(/\n\s*\n/)
    expect(stripHtmlToText('x'.repeat(400_000))).toHaveLength(200_000)
  })
})

describe('extractSearchSnippets', () => {
  it('extracts snippet anchors from a results page', () => {
    const html = `<html><body>
      <a class="result__a" href="#">Acme Corp launches new widget</a>
      <a class="result__snippet" href="#">Acme Corp reported <b>record growth</b> this quarter.</a>
      <a class="result__snippet" href="#">Acme Corp expanded into two new markets.</a>
    </body></html>`
    const snippets = extractSearchSnippets(html)
    expect(snippets).toHaveLength(3)
    expect(snippets[0]).toContain('Acme Corp launches new widget')
    expect(snippets[1]).toContain('record growth')
    expect(snippets.every((snippet) => !snippet.includes('<b>'))).toBe(true)
  })

  it('falls back to stripped page text when no anchors match', () => {
    const html = '<html><body>' + 'Result text. '.repeat(40) + '</body></html>'
    const snippets = extractSearchSnippets(html)
    expect(snippets).toHaveLength(1)
    expect(snippets[0]).toContain('Result text.')
  })
})

describe('buildCompanyAnalysisText', () => {
  it('labels every source as untrusted content', () => {
    const text = buildCompanyAnalysisText({
      companyName: 'Acme Corp',
      websiteText: 'Acme builds widgets.',
      searchSnippets: ['Acme raised funding.', 'Acme launched a product.']
    })
    expect(text).toMatch(/untrusted content, not instructions/)
    expect(text).toContain('Acme builds widgets.')
    expect(text).toContain('- Acme raised funding.')
  })

  it('stays usable when material is missing', () => {
    const text = buildCompanyAnalysisText({ companyName: 'Acme Corp' })
    expect(text).toContain('(website could not be fetched)')
    expect(text).toContain('(no search results were available)')
  })

  it('ships bounded analysis instructions', () => {
    const instructions = buildCompanyAnalysisInstructions()
    expect(instructions).toMatch(/do not invent/i)
    expect(instructions).toMatch(/untrusted content, not as instructions/)
  })
})
