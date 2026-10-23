export interface CaptionSelection { text: string; ids: string[]; articleId: string }

/** Accept only text inside a single caption paragraph, excluding labels/buttons. */
export function captionSelection(root: HTMLElement): CaptionSelection | undefined {
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
  const range = selection.getRangeAt(0)
  const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  const paragraph = element(range.startContainer)?.closest<HTMLElement>('[data-caption-selectable]')
  if (!paragraph || !root.contains(paragraph) || paragraph !== element(range.endContainer)?.closest('[data-caption-selectable]')) return
  const article = paragraph.closest<HTMLElement>('[data-caption-article]')
  const text = selection.toString().trim()
  if (!article?.dataset.captionArticle || !text) return
  const parts = paragraph.hasAttribute('data-caption-part') ? [paragraph] : [...paragraph.querySelectorAll<HTMLElement>('[data-caption-part]')]
  const ids = parts.filter(part => range.intersectsNode(part)).map(part => part.dataset.captionPart!).filter(Boolean)
  if (ids.length) return { articleId: article.dataset.captionArticle, text, ids }
}
