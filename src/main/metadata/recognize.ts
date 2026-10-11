// 导入自动识别：PDF 文本提取 → DOI / arXiv ID 提取 → Crossref / arXiv API 元数据回填。
// 原则（出处：2026-10-07 文献库与存储重构计划 §四，文档已归档进 git 历史）：识别永远安全降级——
// 提取/网络任何一步失败，条目保持「待补全」（needs-review），绝不阻塞导入、绝不丢原件。
// 职责边界（WP-4 解耦）：本模块只做**书目识别**；全文提取与检索索引在 metadata/fulltext.ts。
import { net } from 'electron'
import type { Repo } from '../storage/repo'
import { warn as logWarn } from '../logger'
import type { EntryMeta } from '../../shared/types'

const UA = 'math-workbench/0.2 (personal local reference manager)'
const RECOGNIZE_TIMEOUT = 30_000
const POLITENESS_MS = 1_500

// ---------- 识别器（纯函数，单测覆盖） ----------

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>()\[\]{}]+/i
const ARXIV_RE = /arxiv[:\s]*([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?/i
/** 无 arxiv 前缀时的兜底：出现「arXiv」字样的**就近窗口**内的 ID 形态（防误伤普通数字/参考文献编号） */
const ARXIV_BARE_RE = /([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?/
/** 兜底窗口：以「arXiv」出现位置为中心，向前 80 / 向后 120 字符 */
const ARXIV_WINDOW_BEFORE = 80
const ARXIV_WINDOW_AFTER = 120

export function detectDoi(text: string): string | null {
  const m = DOI_RE.exec(text)
  if (!m) return null
  // 去掉常见尾随标点（引用格式里的句号/逗号/右括号）
  return m[0].replace(/[.,;:)\]]+$/g, '')
}

export function detectArxivId(text: string): string | null {
  const m = ARXIV_RE.exec(text)
  if (m) return m[1]
  const at = text.toLowerCase().indexOf('arxiv')
  if (at === -1) return null
  // 只在「arXiv」字样附近的窗口里找裸 ID：整篇文本里任意一个 4 位.4-5 位数字都当 arXiv ID
  // 会把参考文献编号、年份、页码误判成论文身份（见 WP-2.2 的识别测试）
  const window = text.slice(Math.max(0, at - ARXIV_WINDOW_BEFORE), at + ARXIV_WINDOW_AFTER)
  const bare = ARXIV_BARE_RE.exec(window)
  return bare ? bare[1] : null
}

/** 标题规范化：小写、去 LaTeX 命令与标点（保留中日韩文字）、折叠空白 */
export function normalizeTitleForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\\[a-z]+/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 候选标题（Crossref/arXiv 返回）与 PDF 正文的一致性判定（纯函数，WP-2.2）。
 *
 * 为什么需要它：`detectDoi` 取的是**首个** DOI——首页脚注里的参考文献 DOI、致谢里的
 * 合作论文 DOI 都可能被选中，此时 Crossref 返回的是**另一篇论文**的书目。修复前这条
 * 链路无条件覆盖条目的标题/作者/年份，等于把错误身份写进文献库（检索、去重、BibTeX 全被污染）。
 *
 * 判定规则（宁可保守）：
 *   1) 规范化后候选标题整串出现在正文里 → 高置信；
 *   2) 否则按词覆盖率（≥ minOverlap，默认 70%，词长 ≥3 才算）判定；
 *   3) 词覆盖率不足 → 低置信：调用方**不得**自动覆盖书目字段。
 */
export function titleMatchesPageText(
  candidateTitle: string,
  pageText: string,
  minOverlap = 0.7
): { confident: boolean; overlap: number; reason: string } {
  const cand = normalizeTitleForMatch(candidateTitle)
  const page = normalizeTitleForMatch(pageText)
  if (!cand) return { confident: false, overlap: 0, reason: '候选标题为空' }
  if (!page) return { confident: false, overlap: 0, reason: 'PDF 无可比对文本' }
  if (cand.length >= 8 && page.includes(cand)) return { confident: true, overlap: 1, reason: '标题出现在正文中' }
  const tokens = cand.split(' ').filter((t) => t.length >= 3)
  if (tokens.length === 0) {
    // 极短标题（含中文标题整串被当作单个词元）退回「原文包含」判定
    return { confident: page.includes(cand), overlap: 0, reason: '标题过短，按原文包含判定' }
  }
  const hits = tokens.filter((t) => page.includes(t)).length
  const overlap = hits / tokens.length
  return { confident: overlap >= minOverlap, overlap, reason: `词覆盖率 ${Math.round(overlap * 100)}%` }
}

export interface RecognizedMeta {
  title?: string
  authors?: string[]
  year?: number | null
  venue?: string | null
  doi?: string | null
  arxivId?: string | null
  abstract?: string | null
  tags?: string[]
}

/** Crossref 条目 → 标准元数据（字段缺失安全跳过） */
export function mapCrossref(body: unknown): RecognizedMeta {
  const message = (body as { message?: Record<string, unknown> })?.message
  if (!message || typeof message !== 'object') return {}
  const out: RecognizedMeta = {}
  const title = firstOf(message.title)
  if (title) out.title = title
  const authors = Array.isArray(message.author)
    ? (message.author as Array<Record<string, unknown>>)
        .map((a) => [a.given, a.family].filter((x) => typeof x === 'string').join(' ').trim())
        .filter(Boolean)
    : []
  if (authors.length) out.authors = authors
  const issued = message.issued as { 'date-parts'?: number[][] } | undefined
  const year = issued?.['date-parts']?.[0]?.[0]
  if (typeof year === 'number') out.year = year
  const venue = firstOf(message['container-title'])
  if (venue) out.venue = venue
  const abstract = typeof message.abstract === 'string' ? message.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (abstract) out.abstract = abstract
  const subjects = Array.isArray(message.subject) ? (message.subject as unknown[]).filter((s): s is string => typeof s === 'string') : []
  if (subjects.length) out.tags = subjects.slice(0, 6)
  return out
}

function firstOf(v: unknown): string | null {
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim()
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/** DOI / arXiv ID → 元数据请求描述（测试可注入 fetcher） */
export interface MetaFetcher {
  (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>
}

export async function fetchMetadataByIdentifier(
  ids: { doi: string | null; arxivId: string | null },
  fetcher: MetaFetcher = defaultFetcher,
  arxivApi: string = 'https://export.arxiv.org/api/query'
): Promise<RecognizedMeta> {
  if (ids.doi) {
    const res = await fetcher(`https://api.crossref.org/works/${encodeURIComponent(ids.doi)}`)
    if (res.ok) return mapCrossref(JSON.parse(await res.text()))
    if (res.status === 404) return {}
    throw new Error(`Crossref 响应 ${res.status}`)
  }
  if (ids.arxivId) {
    const base = ids.arxivId
    const res = await fetcher(`${arxivApi}?id_list=${encodeURIComponent(base)}`)
    if (!res.ok) throw new Error(`arXiv 响应 ${res.status}`)
    const { parseArxivAtom } = await import('../papers')
    const entries = parseArxivAtom(await res.text())
    const e = entries[0]
    if (!e) return {}
    const year = Number.isFinite(Date.parse(e.publishedAt)) ? new Date(e.publishedAt).getUTCFullYear() : null
    return {
      title: e.title || undefined,
      authors: e.authors.length ? e.authors : undefined,
      year,
      venue: 'arXiv',
      abstract: e.abstract || undefined,
      tags: e.primaryCategory ? [e.primaryCategory] : undefined
    }
  }
  return {}
}

async function defaultFetcher(url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(RECOGNIZE_TIMEOUT) })
  return { ok: res.ok, status: res.status, text: () => res.text() }
}

/** 建议条目名：《标题-第一作者姓-年份》（净化后用于文件夹名） */
export function suggestEntryTitle(meta: Pick<EntryMeta, 'title' | 'authors' | 'year'>): string {
  const first = meta.authors[0]?.trim().split(/\s+/)[0] ?? ''
  const parts = [meta.title, first, meta.year ? String(meta.year) : ''].filter(Boolean)
  return parts.join('-')
}

// ---------- PDF 文本提取（主进程 pdfjs legacy；fixtures 单测有真实样本） ----------

export async function extractPdfText(absPath: string, maxPages = 5): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const data = new Uint8Array(readFileSync(absPath))
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false })
  const doc = await task.promise
  try {
    const parts: string[] = []
    const pages = Math.min(maxPages, doc.numPages)
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
      page.cleanup()
    }
    return parts.join('\n')
  } finally {
    void task.destroy()
  }
}

// ---------- 后台识别队列 ----------

interface QueueTask {
  entryId: string
}

export class RecognitionQueue {
  private pending: QueueTask[] = []
  private running = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly repo: Repo,
    private readonly deps: {
      extract?: typeof extractPdfText
      fetcher?: MetaFetcher
      arxivApi?: string
    } = {}
  ) {}

  /** 入队（去重）；条目随后被异步补全，UI 经 library:changed 感知 */
  enqueue(entryId: string): void {
    if (this.stopped || this.pending.some((t) => t.entryId === entryId)) return
    this.pending.push({ entryId })
    this.schedule()
  }

  /** 应用启动：把遗留的待补全条目排入队列（直接读索引，不检索——检索有条数上限会漏条目） */
  enqueueAllPending(): void {
    try {
      for (const id of this.repo.libraryNeedsReviewIds()) this.enqueue(id)
    } catch (err) {
      logWarn('recognize', `待补全条目扫描失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
  }

  private schedule(): void {
    if (this.running || this.stopped || this.pending.length === 0) return
    this.timer = setTimeout(() => void this.drain(), 800)
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    this.running = true
    try {
      while (this.pending.length && !this.stopped) {
        const task = this.pending.shift()!
        try {
          await this.processOne(task.entryId)
        } catch (err) {
          logWarn('recognize', `条目识别失败（保持待补全）: ${err instanceof Error ? err.message : String(err)}`)
          console.error('[mathwb] recognition failed:', err instanceof Error ? err.message : err)
        }
        if (this.pending.length) await new Promise((r) => setTimeout(r, POLITENESS_MS))
      }
    } finally {
      this.running = false
      this.schedule()
    }
  }

  /** 单条识别：任何一步失败都保持 needs-review（安全降级） */
  async processOne(entryId: string): Promise<void> {
    // 按 id 直取：库超过检索上限（200 条）时，librarySearch 的返回集里可能根本没有这条，
    // 旧实现会直接 return，条目永远停在待补全
    const hit = this.repo.libraryEntryById(entryId)
    if (!hit) return
    const meta = hit.entry
    if (meta.status !== 'needs-review' || meta.doi || meta.arxivId) return
    const file = meta.files[meta.files.length - 1]
    if (!file || file.mediaType !== 'application/pdf') return
    const loc = this.repo.libraryEntryFile(entryId, file.sha256)
    if (!loc) return

    const extract = this.deps.extract ?? extractPdfText
    const head = await extract(loc.absPath, 5).catch(() => '')
    const ids = { doi: detectDoi(head), arxivId: detectArxivId(head) }
    const fetched: RecognizedMeta =
      ids.doi || ids.arxivId
        ? await fetchMetadataByIdentifier(ids, this.deps.fetcher, this.deps.arxivApi).catch(() => ({} as RecognizedMeta))
        : {}

    // 全文提取已拆到独立索引器（WP-4：src/main/metadata/fulltext.ts）：
    // 识别队列只负责 DOI/arXiv → 书目元数据；全文由 FulltextIndexer 覆盖全部导入路径、全页提取。
    // 这里保留的 head（前 5 页）只服务于标识符探测。

    const hasAny = Boolean(fetched.title || fetched.authors?.length || fetched.year || fetched.venue || fetched.abstract)
    // 标题一致性门（WP-2.2）：首个 DOI 可能来自首页脚注/致谢里的**参考文献**，Crossref 返回的
    // 就是另一篇论文。低置信时绝不覆盖书目字段——只写「从 PDF 本体提取、可人工复核」的标识符，
    // 并保持待补全，避免把错误身份写进文献库（检索、去重、BibTeX 都会被污染）。
    const titleCheck = fetched.title ? titleMatchesPageText(fetched.title, head) : null
    const confident = Boolean(titleCheck?.confident)
    if (titleCheck && !confident) {
      logWarn('recognize', `候选标题与 PDF 正文不一致（${titleCheck.reason}），不自动覆盖：候选《${fetched.title?.slice(0, 60) ?? ''}》`)
    }
    // 标题走文档更新（会同步重命名条目文件夹）；其余走元数据补全
    if (fetched.title && confident) await this.repo.updateDocument(entryId, { title: fetched.title })
    await this.repo.updateEntryMeta(entryId, {
      ...(confident && fetched.authors?.length ? { authors: fetched.authors } : {}),
      ...(confident && fetched.year ? { year: fetched.year } : {}),
      ...(confident && fetched.venue ? { venue: fetched.venue } : {}),
      ...(confident && fetched.abstract ? { abstract: fetched.abstract } : {}),
      ...(confident && fetched.tags?.length ? { tags: Array.from(new Set([...(meta.tags ?? []), ...fetched.tags])) } : {}),
      ...(ids.doi && !meta.doi ? { doi: ids.doi } : {}),
      ...(ids.arxivId && !meta.arxivId ? { arxivId: ids.arxivId } : {}),
      // 只有「拿到真实书目元数据且与正文一致」才算补全；仅标识符（网络失败/404/低置信）保持待补全
      status: hasAny && confident ? 'ok' : 'needs-review'
    })
  }
}
