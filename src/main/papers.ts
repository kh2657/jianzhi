// arXiv 每日论文：查询构建、Atom 解析、抓取编排、PDF 下载导入。
// 网络行为说明：只在用户点击「抓取」或「导入」时访问 arXiv（export.arxiv.org / arxiv.org），
// 无后台轮询、无隐式上传；订阅与抓取结果全部存本地库。
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { net, shell } from 'electron'
import type { Repo } from './storage/repo'
import type { PaperFeed, PaperRefreshResult } from '@shared/types'

// 测试/E2E 可用环境变量覆盖 API 端点（本地 mock）；生产固定官方端点。
export const arxivApiBase = (): string =>
  process.env.MATHWB_ARXIV_API ?? 'https://export.arxiv.org/api/query'

/** 允许下载 PDF 的主机（防 SSRF：feed 响应里的链接不直接信任）。测试模式额外允许 127.0.0.1。 */
export function pdfHostAllowed(url: URL): boolean {
  const host = url.hostname
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost'))) {
    return false
  }
  if (host === 'arxiv.org' || host.endsWith('.arxiv.org')) return true
  if (process.env.MATHWB_ARXIV_API && (host === '127.0.0.1' || host === 'localhost')) return true
  return false
}

export interface ArxivEntry {
  arxivId: string
  title: string
  authors: string[]
  abstract: string
  primaryCategory: string | null
  categories: string[]
  publishedAt: string
  pdfUrl: string
  absUrl: string
}

/** 订阅条件 → arXiv API 查询串（纯函数，单测覆盖） */
export function buildSearchQuery(feed: { categories: string; keywords: string }): string {
  const cats = feed.categories
    .split(/[,\s]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `cat:${c}`)
  const kws = feed.keywords
    .split(/[，,]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => `all:"${k.replace(/"/g, '')}"`)
  const parts: string[] = []
  if (cats.length) parts.push(`(${cats.join(' OR ')})`)
  if (kws.length) parts.push(`(${kws.join(' OR ')})`)
  return parts.join(' AND ')
}

export function buildApiUrl(feed: Pick<PaperFeed, 'categories' | 'keywords' | 'maxResults'>): string {
  const q = buildSearchQuery(feed)
  if (!q) throw new Error('订阅条件为空：请至少填写一个分类或关键词')
  const params = new URLSearchParams({
    search_query: q,
    sortBy: 'submittedDate',
    sortOrder: 'descending',
    max_results: String(Math.min(200, Math.max(1, feed.maxResults || 50)))
  })
  return `${arxivApiBase()}?${params.toString()}`
}

function cleanText(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
}

/** 解析 arXiv Atom 响应（纯函数，样本单测覆盖）。容错：缺字段条目跳过。 */
export function parseArxivAtom(xml: string): ArxivEntry[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['entry', 'author', 'category', 'link'].includes(name)
  })
  const doc = parser.parse(xml)
  const raw = doc?.feed?.entry ?? []
  const list = Array.isArray(raw) ? raw : [raw]
  const out: ArxivEntry[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const absLink = cleanText(e.id)
    const arxivId = absLink.includes('/abs/') ? absLink.split('/abs/')[1] : ''
    if (!arxivId) continue
    const authors = (Array.isArray(e.author) ? e.author : [])
      .map((a: { name?: unknown }) => cleanText(a?.name))
      .filter(Boolean)
    const categories = (Array.isArray(e.category) ? e.category : [])
      .map((c: { '@_term'?: unknown }) => cleanText(c?.['@_term']))
      .filter(Boolean)
    const primary = cleanText(e['arxiv:primary_category']?.['@_term']) || categories[0] || null
    const pdfLink = (Array.isArray(e.link) ? e.link : []).find(
      (l: { '@_title'?: unknown; '@_type'?: unknown }) => l?.['@_title'] === 'pdf' || l?.['@_type'] === 'application/pdf'
    )
    const pdfUrl = cleanText(pdfLink?.['@_href']) || `https://arxiv.org/pdf/${arxivId}`
    out.push({
      arxivId,
      title: cleanText(e.title),
      authors,
      abstract: cleanText(e.summary),
      primaryCategory: primary,
      categories,
      publishedAt: cleanText(e.published),
      pdfUrl,
      absUrl: `https://arxiv.org/abs/${arxivId}`
    })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 抓取失败的用户可读提示：区分超时（多为网络/代理不通）与普通错误。 */
function describeNetworkError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'TimeoutError' || message.includes('aborted due to timeout')) {
    return '连接 arXiv 超时（30 秒）。请检查网络/代理（系统代理需开启，或给 export.arxiv.org 配置分流）后重试。'
  }
  if (message.includes('fetch failed') || message.includes('ERR_INTERNET_DISCONNECTED') || message.includes('ERR_CONNECTION')) {
    return `无法连接 arXiv：${message}。请检查网络或代理后重试。`
  }
  return message
}

/** 抓取一个订阅（或全部）。多订阅间遵守 arXiv 礼貌间隔（3 秒）。 */
export async function refreshFeeds(repo: Repo, feedId?: string): Promise<PaperRefreshResult[]> {
  const feeds = feedId ? repo.paperFeedList().filter((f) => f.id === feedId) : repo.paperFeedList()
  const results: PaperRefreshResult[] = []
  let first = true
  for (const feed of feeds) {
    const result: PaperRefreshResult = { feedId: feed.id, feedName: feed.name, fetched: 0, newItems: 0 }
    try {
      if (!first) await sleep(3000)
      first = false
      const url = buildApiUrl(feed)
      const res = await net.fetch(url, {
        headers: { 'User-Agent': 'math-workbench/0.1 (personal local reader)' },
        signal: AbortSignal.timeout(30_000)
      })
      if (res.status === 429) throw new Error('arXiv 限流（429）：请几分钟后再抓')
      if (!res.ok) throw new Error(`arXiv 响应 ${res.status}`)
      const entries = parseArxivAtom(await res.text())
      result.fetched = entries.length
      result.newItems = await repo.paperItemsUpsert(feed.id, entries)
    } catch (err) {
      result.error = describeNetworkError(err)
    }
    results.push(result)
  }
  return results
}

/** 导入一篇论文：下载 PDF（受限主机）→ 现有托管/去重管道 → 预填书目 → 关联状态。 */
export async function importPaper(
  repo: Repo,
  arxivId: string,
  spaceId: string | null
): Promise<{ ok: boolean; documentId?: string; duplicate?: boolean; error?: string }> {
  const item = repo.paperGetByArxivId(arxivId)
  if (!item) return { ok: false, error: '本地没有这篇论文的记录，请先抓取' }
  if (item.status === 'imported' && item.documentId) return { ok: true, documentId: item.documentId, duplicate: true }

  let url: URL
  try {
    url = new URL(item.pdfUrl)
  } catch {
    return { ok: false, error: `PDF 链接无效：${item.pdfUrl}` }
  }
  if (!pdfHostAllowed(url)) return { ok: false, error: `不允许的下载地址：${url.host}` }

  const tmpDir = mkdtempSync(join(tmpdir(), 'mathwb-paper-'))
  const pdfPath = join(tmpDir, `${safeName(arxivId)}.pdf`)
  try {
    const res = await net.fetch(url.href, {
      headers: { 'User-Agent': 'math-workbench/0.1 (personal local reader)' },
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('下载内容不是 PDF（可能被网络拦截）')
    writeFileSync(pdfPath, buf)

    const imp = await repo.importDocuments([pdfPath], { spaceId, docType: 'paper' })
    if (!imp[0].ok) throw new Error(imp[0].error ?? '导入失败')
    const documentId = imp[0].documentId!
    if (!imp[0].duplicate) {
      // 预填书目信息（arXiv 条目本身就有真实元数据，无需识别队列）
      await repo.updateDocument(documentId, { title: item.title, note: `arXiv:${item.arxivId}` })
      const year = Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).getUTCFullYear() : null
      await repo.updateEntryMeta(documentId, {
        authors: item.authors,
        arxivId: item.baseId,
        venue: 'arXiv',
        ...(year ? { year } : {}),
        abstract: item.abstract || null,
        status: 'ok'
      })
    }
    await repo.paperMarkImported(arxivId, documentId)
    return { ok: true, documentId, duplicate: Boolean(imp[0].duplicate) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 在系统浏览器打开 arXiv 摘要页（白名单仅 arxiv.org，防任意外链）。 */
export async function openAbsExternal(arxivId: string): Promise<void> {
  const url = new URL(`https://arxiv.org/abs/${encodeURIComponent(arxivId)}`)
  if (url.hostname !== 'arxiv.org') throw new Error('非 arxiv.org 链接被拒绝')
  await shell.openExternal(url.toString())
}
