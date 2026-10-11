// 文本节点命中范围收集：阅读器文档内查找与笔记内查找共用（CSS Custom Highlight 标注，不改 DOM）
export function collectTextRanges(root: Element, query: string): Range[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const out: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  while (node) {
    const text = node.data.toLowerCase()
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at === -1) break
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      out.push(range)
      from = at + needle.length
    }
    node = walker.nextNode() as Text | null
  }
  return out
}
