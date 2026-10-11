// Zotero 导入：CSL-JSON 条目 → 文献库条目（元数据映射 + 附件 PDF 匹配）。
// 这是「逐步脱离 Zotero」的落地路径：Zotero「导出文库 → CSL JSON」产出条目元数据；
// 若同时提供了附件目录（导出时勾选「导出文件」或手动指定 storage 目录），
// 按「条目键出现在文件夹名/文件名中」匹配 PDF 复制进条目。
// 全程只读 Zotero 数据；识别/查重由既有导入管线完成；失败条目安全降级进待整理。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Repo } from '../storage/repo'
import type { EntryMeta, ZoteroImportResult } from '../../shared/types'

const PDF_EXT = new Set(['.pdf'])

export interface ZoteroItem {
  id: string
  type: string
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  abstract: string | null
  tags: string[]
}

/** CSL-JSON → 标准条目（坏条目跳过，返回 null） */
export function parseZoteroItem(raw: unknown): ZoteroItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  const id = typeof r.id === 'string' ? r.id : ''
  if (!title || !id) return null
  const authors = Array.isArray(r.author)
    ? (r.author as Array<Record<string, unknown>>)
        .map((a) => {
          if (typeof a.name === 'string') return a.name
          return [a.given, a.family].filter((x) => typeof x === 'string').join(' ').trim()
        })
        .filter(Boolean)
    : []
  let year: number | null = null
  const parts = (r.issued as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0]
  if (Array.isArray(parts) && typeof parts[0] === 'number') year = parts[0]
  const venue = firstText(r['container-title']) ?? firstText(r.publisher)
  const doi = typeof r.DOI === 'string' && r.DOI.trim() ? r.DOI.trim() : null
  const abstract = typeof r.abstract === 'string' ? r.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''
  const tags = splitKeywords(r.keyword)
  const type = r.type === 'book' || r.type === 'book-section' ? 'book' : r.type === 'journal-article' || r.type === 'paper-conference' || r.type === 'article' ? 'paper' : 'other'
  return { id, type, title, authors, year, venue, doi, abstract: abstract || null, tags }
}

/** CSL keyword 可能是字符串（逗号分隔）或数组 */
function splitKeywords(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/[，,]/).map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(v)) return v.flatMap((k) => (typeof k === 'string' ? k.split(/[，,]/).map((s) => s.trim()).filter(Boolean) : []))
  return []
}

function firstText(v: unknown): string | null {
  if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim()
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/** 从 CSL id（可能形如 https://www.zotero.org/.../items/ABCD1234 或直接 ABCD1234）提取条目键 */
export function zoteroKeyOf(id: string): string {
  const tail = id.split('/').pop() ?? id
  return tail.trim()
}

/** 在附件目录中找属于该条目的 PDF：文件夹名或文件名包含条目键 */
export function findAttachmentPdf(storageDir: string, key: string): string | null {
  if (!storageDir || !existsSync(storageDir)) return null
  const direct = join(storageDir, key)
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    const pdf = readdirSync(direct).find((n) => PDF_EXT.has(extname(n).toLowerCase()))
    if (pdf) return join(direct, pdf)
  }
  // 兜底：文件名含 key（Zotero「导出文件」的部分布局）
  for (const name of readdirSync(storageDir)) {
    const p = join(storageDir, name)
    try {
      if (statSync(p).isFile() && name.includes(key) && PDF_EXT.has(extname(name).toLowerCase())) return p
    } catch { /* 跳过不可读项 */ }
  }
  return null
}

export async function importZoteroLibrary(
  repo: Repo,
  jsonPath: string,
  storageDir: string | null,
  options: { spaceId?: string | null } = {}
): Promise<ZoteroImportResult> {
  const { readFileSync } = await import('node:fs')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch (err) {
    throw new Error(`无法读取 CSL-JSON：${err instanceof Error ? err.message : err}`)
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const result: ZoteroImportResult = { total: 0, skipped: 0, created: 0, duplicated: 0, failed: 0, errors: [] }

  for (const raw of list) {
    const item = parseZoteroItem(raw)
    // 无法识别的行必须计数并在结果中可见——静默跳过会让用户误以为导入成功
    if (!item) {
      result.skipped++
      continue
    }
    result.total++
    try {
      // 查重：同 DOI 已在库则跳过
      if (item.doi) {
        const dup = await repo.librarySearch({ q: `doi:${item.doi}` })
        if (dup.total > 0) {
          result.duplicated++
          continue
        }
      }
      // 附件（可选）
      const key = zoteroKeyOf(item.id)
      const pdf = storageDir ? findAttachmentPdf(storageDir, key) : null
      if (pdf) {
        const imp = await repo.importDocuments([pdf], { spaceId: options.spaceId ?? null, docType: cslTypeToDocType(item.type), section: SECTION_INBOX })
        if (!imp[0].ok || !imp[0].documentId) throw new Error(imp[0].error ?? 'PDF 导入失败')
        if (!imp[0].duplicate) {
          await repo.updateDocument(imp[0].documentId, { title: item.title })
          await repo.updateEntryMeta(imp[0].documentId, {
            authors: item.authors,
            year: item.year,
            venue: item.venue,
            doi: item.doi,
            abstract: item.abstract,
            tags: item.tags,
            status: 'ok'
          })
        }
        result.created++
      } else {
        // 无附件：直接建条目（占位，正文 PDF 之后可拖入）
        await createEntryWithoutFile(repo, item, options.spaceId ?? null)
        result.created++
      }
    } catch (err) {
      result.failed++
      result.errors.push(`${item.title.slice(0, 40)}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return result
}

const SECTION_INBOX = '待整理'

function cslTypeToDocType(type: string): EntryMeta['docType'] {
  return type === 'book' ? 'book' : type === 'paper' ? 'paper' : 'other'
}

/** 无附件条目：只写 entry.json 的最小条目（files 空，status ok——元数据已来自 Zotero） */
async function createEntryWithoutFile(repo: Repo, item: ZoteroItem, spaceId: string | null): Promise<void> {
  const meta: EntryMeta = {
    schema: 2,
    id: randomUUID(),
    docType: cslTypeToDocType(item.type),
    title: item.title,
    authors: item.authors,
    year: item.year,
    venue: item.venue,
    doi: item.doi,
    arxivId: null,
    abstract: item.abstract,
    tags: item.tags,
    spaceId,
    status: 'ok',
    note: `Zotero:${zoteroKeyOf(item.id)}`,
    files: [],
    readingState: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  await repo.libraryCreateEntry(meta)
}
