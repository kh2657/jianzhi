/**
 * 检索词语义（笔记检索与文献库自由词共用；WP-3 定为**声明式**规则）：
 *   - 空白分隔的多个词 → AND（每个词都要出现，顺序无关、不必相邻）；
 *   - 双引号包裹 → 精确短语（可含空格，按原文连续匹配）；
 *   - 引号未闭合 → 去掉引号字符，按普通词处理（不把用户卡在语法里）；
 *   - 大小写不敏感（调用方把 haystack 也小写化后传入 matchAllTerms）。
 *
 * 为什么需要它：修复前笔记检索把整句当单一子串（「正则化 参数辨识」要求正文里
 * 恰好出现这个带空格的字符串 → 必然 0 命中），与文献库的逐词 AND 语义相反。
 */

export interface SearchTerm {
  text: string
  /** 来自引号：精确短语（仅影响解析语义与 UI 提示，匹配本身仍是子串匹配） */
  exact: boolean
}

export function parseSearchTerms(raw: string): SearchTerm[] {
  const out: SearchTerm[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    if (m[1] !== undefined) {
      const text = m[1].trim()
      if (text) out.push({ text, exact: true })
      continue
    }
    const text = m[2].replace(/^"+|"+$/g, '').trim()
    if (text) out.push({ text, exact: false })
  }
  return out
}

/** 全部词命中才算（AND）；haystack 需已小写化 */
export function matchAllTerms(haystackLower: string, terms: SearchTerm[]): boolean {
  return terms.every((t) => haystackLower.includes(t.text.toLowerCase()))
}

export interface FieldHit {
  /** 字段名（用于「命中来源」标记，如 标题/摘要/全文） */
  field: string
  term: string
  index: number
  /** 命中的原文（调用方据此截取上下文片段） */
  text: string
}

/** 按字段顺序找第一个命中的词（用于生成「为什么命中」的来源标记与片段） */
export function firstTermHit(
  fields: Array<{ field: string; text: string | null | undefined }>,
  terms: SearchTerm[]
): FieldHit | null {
  for (const { field, text } of fields) {
    if (!text) continue
    const lower = text.toLowerCase()
    for (const t of terms) {
      const idx = lower.indexOf(t.text.toLowerCase())
      if (idx !== -1) return { field, term: t.text, index: idx, text }
    }
  }
  return null
}

/** 命中上下文片段（± radius 字符，折叠空白；用于结果行展示「为什么命中」） */
export function contextSnippet(text: string, index: number, length: number, radius = 40): string {
  const start = Math.max(0, index - radius)
  const end = Math.min(text.length, index + length + radius)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** pageStarts（每页起始字符偏移，升序）里 <= offset 的最后一页；找不到返回 0 */
export function pageIndexAtOffset(pageStarts: number[], offset: number): number {
  let lo = 0
  let hi = pageStarts.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pageStarts[mid] <= offset) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// ---------- 笔记知识块切分（检索分组与渲染层定位共用同一规则） ----------

export interface NoteBlock {
  /** 「## 二级标题」文本；首个 h2 之前的引言 / 全文无 h2 时为 null */
  heading: string | null
  /** 块内 Markdown（含标题行） */
  text: string
}

/**
 * 按「## 二级标题」把笔记正文切成知识块——与渲染层 knowledge-blocks（marked h2 分节）
 * 的切分规则一致：`## x` 行开启新块，其余行归入当前块；引言（首块）与无 h2 的全文
 * heading 为 null。只做行级扫描，不引入 Markdown 解析依赖。
 */
export function splitNoteBlocks(bodyMd: string): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let cur: NoteBlock = { heading: null, text: '' }
  const push = (): void => {
    if (cur.text.trim()) blocks.push(cur)
  }
  for (const line of bodyMd.split('\n')) {
    if (/^##\s+/.test(line)) {
      push()
      cur = { heading: line.replace(/^##\s+/, '').trim() || null, text: `${line}\n` }
    } else {
      cur.text += `${line}\n`
    }
  }
  push()
  return blocks
}

/**
 * 按页统计命中（大小写不敏感子串；用于「在打开的文献里查找」与全文命中的页码定位）。
 * fulltext 为全页抽取文本，pageStarts 为每页起始字符偏移（见存储格式 §4.5）。
 */
export function findInPages(fulltext: string, pageStarts: number[], query: string): Array<{ pageIndex: number; count: number }> {
  const needle = query.trim().toLowerCase()
  if (!needle || !fulltext) return []
  const lower = fulltext.toLowerCase()
  const out: Array<{ pageIndex: number; count: number }> = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(needle, from)
    if (at === -1) break
    const pageIndex = pageStarts.length ? pageIndexAtOffset(pageStarts, at) : 0
    const last = out[out.length - 1]
    if (last && last.pageIndex === pageIndex) last.count++
    else out.push({ pageIndex, count: 1 })
    from = at + needle.length
  }
  return out
}