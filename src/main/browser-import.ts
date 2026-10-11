// 浏览器扩展导入：扩展抓到的书目元数据 + PDF 字节（base64）或本机文件路径 → 复用既有导入管线进「待整理」。
// 与 Zotero 导入同一套落库路径（importDocuments → updateDocument → updateEntryMeta），
// 元数据齐全置 ok，仅有标题则保持 needs-review 交给识别队列回填。
// 本模块不 import electron（repo 注入），HTTP 层见 server.ts，传输契约见 docs/浏览器导入.md。
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from './storage/repo'
import { SECTION_INBOX } from './storage/folder-index'
import type { EntryMeta } from '../shared/types'

const PDF_MAGIC = '%PDF-'
/** PDF 解码后上限：远超常规论文体积，只为拦住异常请求 */
const PDF_MAX_BYTES = 128 * 1024 * 1024

export interface BrowserImportPayload {
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  arxivId: string | null
  abstract: string | null
  tags: string[]
  sourceUrl: string | null
  /** PDF 原始字节（base64 与 localPath 二选一；都没有则建无文件条目） */
  pdf: Buffer | null
  suggestedName: string
}

export interface BrowserImportResult {
  ok: boolean
  documentId?: string
  title?: string
  duplicate?: boolean
  /** 条目保持「待补全」：调用方可挂识别队列即时回填 */
  needsReview?: boolean
  error?: string
}

const ARXIV_ID_RE = /^[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?$/

function asText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function asAuthors(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;，；]/) : []
  return list
    .map((a) => asText(a, 300))
    .filter(Boolean)
    .slice(0, 200)
}

function asTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，]/) : []
  return list.map((t) => asText(t, 60)).filter(Boolean).slice(0, 30)
}

function asYear(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1400 && n <= 2100 ? n : null
}

function asDoi(v: unknown): string | null {
  const doi = asText(v, 200).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/[.,;]+$/, '')
  return doi || null
}

function asArxivId(v: unknown, sourceUrl: string | null): string | null {
  const direct = asText(v, 40)
  if (direct && ARXIV_ID_RE.test(direct)) return direct
  // 兜底：来源页是 arXiv 时从 URL 提取（扩展只传 PDF 直链的场景）
  if (sourceUrl) {
    const m = /arxiv\.org\/(?:abs|pdf|format)\/([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?/i.exec(sourceUrl)
    if (m) return m[1]
  }
  return null
}

function asSourceUrl(v: unknown): string | null {
  const s = asText(v, 2000)
  if (!s) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null
  } catch {
    return null
  }
}

/** 扩展 payload → 标准载荷（宽容输入、严格输出；返回 error 为用户可读中文） */
export function parseBrowserImportPayload(raw: unknown): { payload: BrowserImportPayload } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: '请求体必须是 JSON 对象' }
  const r = raw as Record<string, unknown>

  let pdf: Buffer | null = null
  if (typeof r.pdfBase64 === 'string' && r.pdfBase64.length > 0) {
    try {
      pdf = Buffer.from(r.pdfBase64, 'base64')
    } catch {
      return { error: 'PDF 数据（pdfBase64）不是合法的 base64' }
    }
    if (pdf.length > PDF_MAX_BYTES) return { error: `PDF 超过大小上限（${Math.floor(PDF_MAX_BYTES / 1024 / 1024)} MB）` }
    if (pdf.subarray(0, 5).toString('latin1') !== PDF_MAGIC) return { error: 'PDF 数据不是有效的 PDF 文件' }
  } else if (typeof r.localPath === 'string' && r.localPath.trim()) {
    // 扩展 downloads 兜底路径：付费墙等浏览器内抓不到的 PDF 先落盘再报路径，这里复制入库
    const p = r.localPath.trim()
    if (!existsSync(p) || !statSync(p).isFile()) return { error: `本地文件不存在：${p}` }
    if (statSync(p).size > PDF_MAX_BYTES) return { error: `PDF 超过大小上限（${Math.floor(PDF_MAX_BYTES / 1024 / 1024)} MB）` }
    pdf = readFileSync(p)
    if (pdf.subarray(0, 5).toString('latin1') !== PDF_MAGIC) return { error: '本地文件不是有效的 PDF 文件' }
  }

  const sourceUrl = asSourceUrl(r.sourceUrl)
  const filename = asText(r.filename, 200).replace(/[\\/:*?"<>|]/g, '_')
  const title = asText(r.title, 500) || filename.replace(/\.pdf$/i, '') || '浏览器导入'
  const payload: BrowserImportPayload = {
    title,
    authors: asAuthors(r.authors),
    year: asYear(r.year),
    venue: asText(r.venue, 400) || null,
    doi: asDoi(r.doi),
    arxivId: asArxivId(r.arxivId, sourceUrl),
    abstract: asText(r.abstract, 8000) || null,
    tags: asTags(r.tags),
    sourceUrl,
    pdf,
    suggestedName: /\.pdf$/i.test(filename) ? filename : `${filename || title}.pdf`
  }
  return { payload }
}

/** 有真实书目信息（作者/DOI/arXiv/年份+期刊）才算补全；仅标题让识别队列继续回填 */
function hasRichMeta(p: BrowserImportPayload): boolean {
  return Boolean(p.authors.length || p.doi || p.arxivId || (p.year && p.venue))
}

function noteFor(p: BrowserImportPayload): string {
  return p.sourceUrl ? `浏览器导入：${p.sourceUrl}` : '浏览器导入'
}

/** 查重：DOI / arXiv 已在库则直接报重复（与 Zotero 导入同一策略；同字节文件由 importDocuments 兜底） */
async function findDuplicate(repo: Repo, p: BrowserImportPayload): Promise<string | null> {
  const q = p.doi ? `doi:${p.doi}` : p.arxivId ? `arxiv:${p.arxivId.split('v')[0]}` : null
  if (!q) return null
  const res = await repo.librarySearch({ q })
  return res.hits[0]?.entry.id ?? null
}

export async function importFromBrowser(
  repo: Repo,
  raw: unknown,
  options: { spaceId?: string | null; recognize?: (entryId: string) => void } = {}
): Promise<BrowserImportResult> {
  const parsed = parseBrowserImportPayload(raw)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const p = parsed.payload
  const rich = hasRichMeta(p)

  try {
    const dupId = await findDuplicate(repo, p)
    if (dupId) return { ok: true, documentId: dupId, title: p.title, duplicate: true }

    if (!p.pdf) {
      // 无文件条目（纯书目）：正文 PDF 之后可拖入
      const meta: EntryMeta = {
        schema: 2,
        id: randomUUID(),
        docType: p.doi || p.arxivId || p.venue ? 'paper' : 'other',
        title: p.title,
        authors: p.authors,
        year: p.year,
        venue: p.venue,
        doi: p.doi,
        arxivId: p.arxivId,
        abstract: p.abstract,
        tags: p.tags,
        spaceId: options.spaceId ?? null,
        status: rich ? 'ok' : 'needs-review',
        note: noteFor(p),
        files: [],
        readingState: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await repo.libraryCreateEntry(meta)
      if (!rich) options.recognize?.(meta.id)
      return { ok: true, documentId: meta.id, title: p.title, duplicate: false, needsReview: !rich }
    }

    // 有 PDF：临时文件 → 既有托管/去重管道（与 每日论文导入/Zotero 导入 同一条路）
    const tmpDir = mkdtempSync(join(tmpdir(), 'mathwb-web-'))
    try {
      const pdfPath = join(tmpDir, safeName(p.suggestedName))
      writeFileSync(pdfPath, p.pdf)
      const imp = await repo.importDocuments([pdfPath], { spaceId: options.spaceId ?? null, docType: 'paper', section: SECTION_INBOX })
      if (!imp[0].ok || !imp[0].documentId) throw new Error(imp[0].error ?? '导入失败')
      const documentId = imp[0].documentId
      if (!imp[0].duplicate) {
        await repo.updateDocument(documentId, { title: p.title, note: noteFor(p) })
        await repo.updateEntryMeta(documentId, {
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          doi: p.doi,
          arxivId: p.arxivId,
          abstract: p.abstract,
          tags: p.tags,
          status: rich ? 'ok' : 'needs-review'
        })
        if (!rich) options.recognize?.(documentId)
      }
      return { ok: true, documentId, title: p.title, duplicate: Boolean(imp[0].duplicate), needsReview: !imp[0].duplicate && !rich }
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结果 */
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'import.pdf'
}
