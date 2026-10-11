// 全文索引（WP-4）：把「书目识别」「正文提取」「检索索引」三件事解耦。
//
// 背景（修复前的耦合链路）：全文提取写在识别队列里，而识别队列只处理「needs-review 且无 DOI/arXiv」
// 的条目、且只取**前 5 页**（那是为 DOI 探测选的上限）——于是 arXiv 每日论文 / Zotero / 浏览器导入
// 的条目**完全没有全文**，手动导入的书也只有前 5 页可搜，且索引失败没有任何状态可查。
//
// 本模块的契约：
//   - 覆盖**所有导入路径**（都经 Repo.importDocuments → onImported 回调入队）；
//   - 提取**全部可提取页**（页数/字符数上限保护，超限在 meta 里标 truncated）；
//   - 显式状态 ready / empty / error（+ 原因）、绑定文件 sha 与页数（文件变化即过期）；
//   - 可重建、可后台重跑（串行 + 限速），派生文件全部落在 derived/（可随时删除重建）；
//   - 扫描版 PDF 标 empty（无文本层）——**不伪装成已索引**，检索提示据此说明覆盖范围。
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Repo } from '../storage/repo'
import { atomicWriteFile } from '../storage/fsutil'
import { warn as logWarn } from '../logger'
import type { FulltextIndexStatus, FulltextStatus } from '../../shared/types'

export const FULLTEXT_FILE = 'derived/fulltext.txt'
export const FULLTEXT_META_FILE = 'derived/fulltext.meta.json'

/** 提取上限：防超长 PDF 拖垮主进程与索引体积（超限时 meta.truncated = true，UI 可说明） */
export const FULLTEXT_MAX_PAGES = 500
export const FULLTEXT_MAX_CHARS = 8 * 1024 * 1024
/** 提取引擎版本：实现变化时 +1，启动时的过期检查据此触发重建 */
export const FULLTEXT_ENGINE = 1

export type { FulltextStatus }

export interface FulltextMeta extends FulltextIndexStatus {
  schema: 1
}

export interface ExtractResult {
  text: string
  pages: number
  pageCount: number
  truncated: boolean
  /** 每页起始字符偏移（升序）：供「跳转到命中页」与按页命中统计 */
  pageStarts: number[]
}

/** 提取器签名（测试可注入假实现） */
export type FulltextExtractor = (absPath: string, opts?: { maxPages?: number; maxChars?: number }) => Promise<ExtractResult>

/**
 * 提取 PDF 全文（全部可提取页，带页数/字符上限）。识别队列另有自己的「前 5 页」提取，
 * 那是为 DOI 探测服务的选择，与这里的检索索引互不耦合。
 */
export async function extractPdfFullText(
  absPath: string,
  opts: { maxPages?: number; maxChars?: number } = {}
): Promise<ExtractResult> {
  const maxPages = opts.maxPages ?? FULLTEXT_MAX_PAGES
  const maxChars = opts.maxChars ?? FULLTEXT_MAX_CHARS
  const { readFileSync } = await import('node:fs')
  const data = new Uint8Array(readFileSync(absPath))
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false })
  const doc = await task.promise
  try {
    const parts: string[] = []
    const pageStarts: number[] = []
    const limit = Math.min(maxPages, doc.numPages)
    let chars = 0
    let pages = 0
    let truncated = false
    let offset = 0
    for (let p = 1; p <= limit; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      const line = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      pageStarts.push(offset)
      parts.push(line)
      offset += line.length + 1 // +1：与下面的 join('\n') 对齐
      pages++
      chars += line.length
      page.cleanup()
      if (chars >= maxChars) {
        truncated = true
        break
      }
    }
    if (limit < doc.numPages) truncated = true
    return { text: parts.join('\n'), pages, pageCount: doc.numPages, truncated, pageStarts }
  } finally {
    void task.destroy()
  }
}

/** 读派生 meta（可丢弃数据：损坏/缺失一律按 null 处理，不备份、不报错） */
export async function readFulltextMeta(entryDirAbs: string): Promise<FulltextMeta | null> {
  try {
    const raw = await readFile(join(entryDirAbs, FULLTEXT_META_FILE), 'utf8')
    const parsed = JSON.parse(raw) as FulltextMeta
    if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export interface FulltextTarget {
  entryId: string
  entryDirAbs: string
  absPath: string
  fileSha: string
  mediaType: string
  pageCount: number | null
}

/**
 * 后台全文索引器：串行 + 限速，失败不抛出（写 error 状态供 UI 诊断）。
 * 与识别队列同构：入队去重、可 stop、可重建（enqueueStale）。
 */
export class FulltextIndexer {
  private pending: FulltextTarget[] = []
  private queued = new Set<string>()
  private running = false
  private stopped = false
  private timer: NodeJS.Timeout | null = null
  private readonly extract: FulltextExtractor
  private readonly politenessMs: number

  constructor(
    private readonly repo: Repo,
    deps: { extract?: FulltextExtractor; politenessMs?: number } = {}
  ) {
    this.extract = deps.extract ?? extractPdfFullText
    this.politenessMs = deps.politenessMs ?? 250
  }

  /** 入队（去重）；条目随后被异步索引，完成后经一次 library 变更通知 UI */
  enqueue(entryId: string): void {
    if (this.stopped || this.queued.has(entryId)) return
    const target = this.repo.libraryFulltextTarget(entryId)
    if (!target) return
    this.queued.add(entryId)
    this.pending.push(target)
    this.schedule()
  }

  /** 启动 / 手动重建：把所有「缺索引、过期（引擎/文件/页数变化）或上次失败」的 PDF 条目入队，返回入队数 */
  enqueueStale(metas: Map<string, FulltextMeta | null>): number {
    let n = 0
    for (const target of this.repo.libraryFulltextTargets()) {
      if (this.queued.has(target.entryId)) continue
      const meta = metas.get(target.entryId) ?? null
      const stale =
        target.mediaType === 'application/pdf' &&
        (!meta ||
          meta.engine !== FULLTEXT_ENGINE ||
          meta.fileSha !== target.fileSha ||
          (target.pageCount !== null && meta.pageCount !== null && meta.pageCount !== target.pageCount) ||
          meta.status === 'error')
      if (!stale) continue
      this.queued.add(target.entryId)
      this.pending.push(target)
      n++
    }
    if (n) this.schedule()
    return n
  }

  get pendingCount(): number {
    return this.pending.length
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = []
    this.queued.clear()
  }

  private schedule(): void {
    if (this.running || this.stopped || this.pending.length === 0) return
    this.timer = setTimeout(() => void this.drain(), 500)
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    this.running = true
    let indexed = 0
    try {
      while (this.pending.length && !this.stopped) {
        const target = this.pending.shift()!
        this.queued.delete(target.entryId)
        try {
          await this.indexOne(target)
          indexed++
        } catch (err) {
          logWarn('fulltext', `索引失败（已记为 error 状态）：${err instanceof Error ? err.message : String(err)}`)
        }
        if (this.pending.length) await new Promise((r) => setTimeout(r, this.politenessMs))
      }
    } finally {
      this.running = false
      if (indexed > 0) this.repo.notifyFulltextIndexed()
      this.schedule()
    }
  }

  /** 单个条目：提取 → 原子写 fulltext.txt + meta；任何失败都落 error 状态（可重试） */
  async indexOne(target: FulltextTarget): Promise<FulltextStatus> {
    const derived = dirname(join(target.entryDirAbs, FULLTEXT_FILE))
    try {
      mkdirSync(derived, { recursive: true })
      if (target.mediaType !== 'application/pdf') {
        await this.writeMeta(target, { status: 'empty', pages: 0, chars: 0, truncated: false, pageCount: null, reason: 'HTML 材料暂不建立全文索引' })
        return 'empty'
      }
      const { text, pages, pageCount, truncated, pageStarts } = await this.extract(target.absPath)
      const hasText = text.trim().length > 0
      // 写出**原样文本**（不 trim）：pageStarts 是按原文本算的字符偏移，trim 会让页码定位整体偏移
      await atomicWriteFile(join(target.entryDirAbs, FULLTEXT_FILE), text)
      await this.writeMeta(target, {
        status: hasText ? 'ready' : 'empty',
        pages,
        chars: text.trim().length,
        truncated,
        pageCount,
        pageStarts,
        reason: hasText ? null : '没有可提取的文本层（扫描版 PDF 需要 OCR，当前版本不做）'
      })
      return hasText ? 'ready' : 'empty'
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      try {
        await this.writeMeta(target, { status: 'error', pages: 0, chars: 0, truncated: false, pageCount: null, reason })
      } catch { /* 连 meta 都写不动（磁盘满等）：下次重建会重试 */ }
      return 'error'
    }
  }

  private async writeMeta(
    target: FulltextTarget,
    patch: { status: FulltextStatus; pages: number; chars: number; truncated: boolean; pageCount: number | null; reason: string | null; pageStarts?: number[] }
  ): Promise<void> {
    const meta: FulltextMeta = {
      schema: 1,
      engine: FULLTEXT_ENGINE,
      fileSha: target.fileSha,
      indexedAt: new Date().toISOString(),
      ...patch
    }
    await atomicWriteFile(join(target.entryDirAbs, FULLTEXT_META_FILE), `${JSON.stringify(meta, null, 2)}\n`)
  }
}

/** 启动时读取所有待检查条目的 meta（用于 enqueueStale 的过期判定；由调用方注入 IO 结果便于测试） */
export async function readMetaForTargets(targets: FulltextTarget[]): Promise<Map<string, FulltextMeta | null>> {
  const out = new Map<string, FulltextMeta | null>()
  for (const t of targets) out.set(t.entryId, await readFulltextMeta(t.entryDirAbs))
  return out
}

/** 供 UI/诊断判断「该条目是否已有可用全文」（不读盘：只看 fulltext.txt 是否存在） */
export function fulltextFileExists(entryDirAbs: string): boolean {
  return existsSync(join(entryDirAbs, FULLTEXT_FILE))
}