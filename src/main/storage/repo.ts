import { randomUUID, createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, type Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { MAX_HTML_BYTES, mediaTypeFor, extImageKind, sniffImageKind } from '../assets/library'
import type { ImageVariants } from '../assets/images'
import type { FolderStore, IndexedEntry, IndexedMemo, IndexedNote } from './folder-store'
import { atomicWriteFile, atomicWriteJson, readJsonSafeSync, sanitizeName, sanitizeFileName, sha1OfText, sha256Of, slugFor } from './fsutil'
import { warn as logWarn } from '../logger'
import { ActivityStore, localDateKey, weekRangeOf, monthRangeOf, type ActivityEvent } from './activity'
import { SectionColorStore } from './section-colors'
import {
  DIR_CAPTURES,
  DIR_ENTRIES,
  DIR_MEMOS,
  DIR_NOTE_ASSETS,
  DIR_NOTES,
  FILE_ANCHORS,
  FILE_ENTRY,
  FILE_SPACES,
  FILE_WORKSPACE,
  SECTION_INBOX,
  isTempName,
  parseMemoMarkdown,
  parseNoteMarkdown,
  serializeMemoMarkdown,
  serializeNoteMarkdown,
  type CaptureSidecar,
  type MemoFrontMatter,
  type NoteFrontMatter,
  type NoteSourceRef,
  type PapersDoc,
  type StoredAnchor
} from './folder-index'
import {
  DOC_TYPE_LABELS,
  type StudySpace,
  type SpaceScope,
  type ActivityDayItem,
  type ActivityPanelData,
  type ActivityObjectStat,
  type AnchorRecord,
  type CaptureImportResult,
  type CaptureRecord,
  type DocType,
  type DocumentSummary,
  type EntryFile,
  type EntryMeta,
  type ImportResult,
  type InboxStatus,
  type LibraryFacetCount,
  type LibraryFacetKind,
  type LibrarySearchHit,
  type LibrarySearchQuery,
  type LibrarySearchResponse,
  type LibraryMatchInfo,
  type LibrarySort,
  type LibraryDiagnostics,
  type NoteSaveConflictInfo,
  type NoteSaveResponse,
  type NoteAnchorView,
  type NoteCaptureView,
  type NoteFull,
  type NoteLearningState,
  type NoteRecord,
  type NoteSummary,
  type NoteType,
  type OpenDocumentResult,
  type PageAnchorView,
  type PdfRect,
  type ReaderFindResult,
  type SearchResponse,
  type SearchNoteBlockHit,
  type VerifiedStatus,
  type InkStroke,
  type PaperFeed,
  type PaperItem,
  type PaperStatus,
  type BacklinkView,
  type MaterialNoteView,
  type MemoRecord,
  type ReadingWorkspace,
  type NoteLinkIndexEntry,
  type LibrarySection,
  type QuestionAggregate,
  type SectionColor
} from '@shared/types'
import { parseLibraryQuery, parseYearRange, type LibraryField } from '@shared/library-search'
import { contextSnippet, findInPages, firstTermHit, matchAllTerms, parseSearchTerms, pageIndexAtOffset, splitNoteBlocks, type SearchTerm } from '@shared/search-terms'
import { readFulltextMeta, type FulltextMeta, type FulltextTarget } from '../metadata/fulltext'
import type { ArxivEntry } from '../papers'

const now = () => new Date().toISOString()

/** 旧调用降级（无 baseHash）诊断日志的进程内去重标记：只提示一次，避免刷屏 */
let legacySaveWarned = false

/** 全文缓存累计字符上限（约 32MB 文本）：超出按 LRU 淘汰，避免主进程常驻内存只增不减 */
const FULLTEXT_CACHE_MAX_CHARS = 32 * 1024 * 1024

/**
 * 查询返回上限（个人量级下的保护，避免一次 IPC 传回过多数据）。
 * 注意：这些是「返回条数」上限，**命中总数另行统计**（见 librarySearch 的 total）——
 * 上限只截断传回的数据，不影响 total 与分面计数口径。
 */
const QUERY_LIMITS = {
  /** 文献库检索：IPC 序列化开销最大，含完整条目元数据 */
  libraryHits: 200,
  /** 笔记列表（某材料的关联笔记） */
  materialNotes: 500,
  /** 双链索引（编辑器 [[ 补全候选） */
  linkIndex: 5000,
  /** 笔记检索返回条数（命中总数另行统计，UI 据此提示「只显示前 N 条」） */
  noteSearch: 50,
  /** 摘录检索返回条数 */
  anchorSearch: 50,
  /** 速记检索返回条数 */
  memoSearch: 50
} as const

const LIBRARY_HITS_LIMIT = QUERY_LIMITS.libraryHits
const NOTE_SEARCH_LIMIT = QUERY_LIMITS.noteSearch
const ANCHOR_SEARCH_LIMIT = QUERY_LIMITS.anchorSearch
const MEMO_SEARCH_LIMIT = QUERY_LIMITS.memoSearch

/**
 * 文献库排序。缺年份的排最后（用 -1 当哨兵，否则 null 会混在中间）；
 * 文本类排序统一用 zh 比较器，中文标题按拼音序而不是码点序。
 */
const LIBRARY_SORTERS: Record<LibrarySort, (a: IndexedEntry, b: IndexedEntry) => number> = {
  updated: (a, b) => b.meta.updatedAt.localeCompare(a.meta.updatedAt),
  created: (a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt),
  title: (a, b) => a.meta.title.localeCompare(b.meta.title, 'zh'),
  author: (a, b) =>
    (a.meta.authors[0] ?? '').localeCompare(b.meta.authors[0] ?? '', 'zh') ||
    a.meta.title.localeCompare(b.meta.title, 'zh'),
  year: (a, b) => (b.meta.year ?? -1) - (a.meta.year ?? -1)
}

export interface ServingFile {
  absPath: string
  mediaType: string
}

/** 精读卡的空现场（文件缺失或损坏时使用；损坏的那份已由读取原语备份为 .broken） */
function emptyReadingWorkspace(documentId: string): ReadingWorkspace {
  return {
    documentId,
    coreQuestion: '',
    phase: 'reading',
    activeTab: 'notes',
    notesScope: 'page',
    expandedNoteId: null,
    quickDraft: '',
    resolvedNoteIds: [],
    sections: (['question', 'method', 'findings', 'evidence', 'relevance'] as const).map((id) => ({
      id,
      body: '',
      anchorIds: [],
      checked: false
    })),
    updatedAt: null
  }
}

/**
 * FolderRepo：存储格式 v2（docs/存储格式.md）之上的 Repo 实现。
 * 与 v1（SQLite）保持相同的公开方法语义与传输类型；渲染层与 IPC 契约不变。
 *
 * 写入策略：磁盘原子写（fsutil）→ 直接更新内存索引 → notify 广播变更种类。
 * 自身写入触发的 watcher 重扫与索引一致，diff 为空不会产生重复事件。
 * versionId / assetId 在 v2 中统一为文件 sha256。
 */
export class Repo {
  /**
   * 全文检索缓存（跨调用复用，避免每次搜索重读全部 derived/fulltext.txt）。
   * mtime+size 作为有效性判据：外部（iCloud）重写全文后缓存自动失效。
   * 并发同键读取只落一次盘（in-flight 去重），避免连续输入时并发打开同一文件。
   */
  private readonly fulltextCache = new Map<string, { mtimeMs: number; size: number; text: string | null }>()
  private readonly fulltextPending = new Map<string, Promise<string | null>>()
  private fulltextCacheChars = 0
  /** 学习足迹（库根/足迹.json）：只在下方写路径记录，外部同步/索引重建不产生事件 */
  private readonly activities: ActivityStore
  /** 分区颜色标签（库根/分区.json）：纯显示属性，随分区目录改名/删除迁移 */
  private readonly sectionColors: SectionColorStore
  /** 新条目落库回调（全文索引器挂钩；见 onDocumentsImported） */
  private importListener: ((documentId: string) => void) | null = null

  constructor(
    private readonly library: FolderStore,
    private readonly variants: ImageVariants
  ) {
    this.activities = new ActivityStore(library.root)
    this.sectionColors = new SectionColorStore(library.root)
  }

  /** 启动时调用：确保足迹文件存在（无则以当下为启用日，不补造历史） */
  ensureActivity(): void {
    this.activities.ensure()
  }

  private idx() {
    return this.library.index
  }

  /**
   * 分区名 → 绝对目录。sanitizeName 已去掉首尾点（`..` 之类无法再出现），
   * 这里再做一次「落位校验」：解析结果必须严格位于 文献库/ 之内，否则拒绝。
   * 双保险的理由是分区名可能来自 IPC 入参（doc:import 的 options.section、library:move），
   * 一旦穿越，条目会被建/移到分区体系之外（甚至库根），且扫描器再也看不见。
   */
  private sectionDir(name: string): string {
    const entriesRoot = join(this.library.root, DIR_ENTRIES)
    const dir = join(entriesRoot, sanitizeName(name, 60))
    const rel = relative(entriesRoot, dir)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('分区名无效')
    return dir
  }

  /**
 * 条目全文（derived/fulltext.txt）：异步读 + 跨调用缓存；不存在或不可读返回 null。
 *
 * 容量上限 FULLTEXT_CACHE_MAX_CHARS：主进程常驻，全文总量可达数百 MB，
 * 故按累计字符数上限 + LRU 淘汰，避免长期使用后内存只增不减。
 * 已知局限：mtime 精度为毫秒，同毫秒内等长重写理论上命中旧缓存（概率极低，
 * fulltext.txt 由本进程原子写入，实际不会发生）。
 */
  private async fulltextOf(entry: IndexedEntry): Promise<string | null> {
    const abs = join(entry.dirAbs, 'derived', 'fulltext.txt')
    let st: Stats
    try {
      st = await stat(abs)
    } catch {
      this.forgetFulltext(entry.meta.id)
      return null
    }
    const hit = this.fulltextCache.get(entry.meta.id)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      this.fulltextCache.delete(entry.meta.id) // 提升为最新使用
      this.fulltextCache.set(entry.meta.id, hit)
      return hit.text
    }
    const flying = this.fulltextPending.get(entry.meta.id)
    if (flying) return flying
    const task = readFile(abs, 'utf8')
      .then((text) => {
        this.putFulltext(entry.meta.id, { mtimeMs: st.mtimeMs, size: st.size, text })
        return text
      })
      .catch(() => {
        this.putFulltext(entry.meta.id, { mtimeMs: st.mtimeMs, size: st.size, text: null })
        return null
      })
      .finally(() => {
        this.fulltextPending.delete(entry.meta.id)
      })
    this.fulltextPending.set(entry.meta.id, task)
    return task
  }

  /** 写入全文缓存并按累计字符数淘汰最久未用项；覆盖已有键时要先扣掉旧值，否则计数虚高、缓存被过早清空 */
  private putFulltext(key: string, value: { mtimeMs: number; size: number; text: string | null }): void {
    this.forgetFulltext(key)
    this.fulltextCache.set(key, value)
    this.fulltextCacheChars += value.text?.length ?? 0
    while (this.fulltextCacheChars > FULLTEXT_CACHE_MAX_CHARS) {
      const oldest = this.fulltextCache.keys().next()
      if (oldest.done) break
      const evicted = this.fulltextCache.get(oldest.value)
      this.fulltextCache.delete(oldest.value)
      this.fulltextCacheChars -= evicted?.text?.length ?? 0
    }
  }

  /** 删除缓存项并同步扣减累计字符数（只 delete 不扣减会让上限形同虚设） */
  private forgetFulltext(key: string): void {
    const prev = this.fulltextCache.get(key)
    if (prev === undefined) return
    this.fulltextCache.delete(key)
    this.fulltextCacheChars -= prev.text?.length ?? 0
  }

  // ---------- 索引访问助手 ----------

  private entryById(id: string): IndexedEntry | undefined {
    return this.idx().entries.get(id)
  }

  private entryBySha(sha: string): IndexedEntry | undefined {
    const loc = this.idx().shaToEntryFile.get(sha)
    return loc ? this.idx().entries.get(loc.entryId) : undefined
  }

  private fileIndexOf(entry: IndexedEntry, sha: string): number {
    return entry.meta.files.findIndex((f) => f.sha256 === sha)
  }

  private requireEntryBySha(sha: string, label = '文档版本不存在'): IndexedEntry {
    const entry = this.entryBySha(sha)
    if (!entry) throw new Error(label)
    return entry
  }

  /** 最新文件 = files 末位（导入顺序） */
  private primaryFile(entry: IndexedEntry): EntryFile | undefined {
    return entry.meta.files[entry.meta.files.length - 1]
  }

  /**
   * 落盘条目元数据（**先写盘、成功后才提交内存**；失败时索引保持旧值——不产生「界面已改、磁盘没写」的幻影）。
   * opts.touch=false 用于「不改元数据本身」的高频写入（如翻页保存阅读位置）：不刷新 updatedAt
   * （否则阅读行为会把「最近更新」一路顶到最前，列表排序与日期全部失真），也不广播变更。
   */
  private async commitEntryMeta(entry: IndexedEntry, nextMeta: EntryMeta, opts: { touch?: boolean } = {}): Promise<void> {
    const touch = opts.touch !== false
    const meta: EntryMeta = touch ? { ...nextMeta, updatedAt: now() } : nextMeta
    // extra = 历史版本写入的未知键（前向兼容），原样保留；已知键以当前 meta 为准
    await atomicWriteJson(join(entry.dirAbs, FILE_ENTRY), { ...entry.extra, ...meta })
    entry.meta = meta
    if (touch) this.library.notify(['entries'])
  }

  private async persistAnchors(entry: IndexedEntry): Promise<void> {
    await atomicWriteJson(join(entry.dirAbs, FILE_ANCHORS), entry.anchors)
    this.library.notify(['entries'])
  }

  /** 条目文件夹名随标题走：改名时同步重命名目录（身份 id 不变） */
  private async syncEntryDirName(entry: IndexedEntry): Promise<void> {
    const desired = this.desiredEntryDirName(entry)
    if (desired === entry.dirAbs.split(/[\\/]/).pop()) return
    const parent = join(this.library.root, DIR_ENTRIES, entry.section)
    const target = join(parent, desired)
    if (existsSync(target)) return // 目标名被占（同名条目），保留现有目录名
    renameSync(entry.dirAbs, target)
    entry.dirAbs = target
    entry.dirRel = join(DIR_ENTRIES, entry.section, desired)
  }

  private desiredEntryDirName(entry: IndexedEntry): string {
    const base = sanitizeName(entry.meta.title)
    const current = entry.dirAbs.split(/[\\/]/).pop() ?? ''
    if (current === base) return base
    // 同分区下有别的条目占用了基础名 → 加 id 后缀
    for (const [id, e] of this.idx().entries) {
      if (id !== entry.meta.id && e.section === entry.section && (e.dirAbs.split(/[\\/]/).pop() ?? '') === base) {
        return `${base}-${entry.meta.id.slice(0, 8)}`
      }
    }
    return base
  }

  private validateSpace(spaceId: SpaceScope): void {
    if (spaceId !== undefined && spaceId !== null) {
      if (typeof spaceId !== 'string' || !this.idx().spaces.some((s) => s.id === spaceId)) {
        throw new Error('学习区不存在')
      }
    }
  }

  private scopeMatch(spaceId: SpaceScope, entitySpaceId: string | null): boolean {
    if (spaceId === undefined) return true
    if (spaceId === null) return entitySpaceId === null
    return entitySpaceId === spaceId
  }

  // ---------- 学习区 ----------

  listSpaces(): StudySpace[] {
    return [...this.idx().spaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private validateSpaceInput(input: { name: string; kind: StudySpace['kind'] }, exceptId?: string): string {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('请输入学习区名称')
    const name = input.name.trim()
    if (name.length > 100) throw new Error('学习区名称不能超过 100 字')
    if (!['course', 'research'].includes(input.kind)) throw new Error('学习区类型无效')
    const duplicate = this.idx().spaces.find((s) => s.name.toLowerCase() === name.toLowerCase())
    if (duplicate && duplicate.id !== exceptId) throw new Error('学习区名称已存在')
    return name
  }

  private async persistSpaces(spaces: StudySpace[]): Promise<void> {
    await atomicWriteJson(join(this.library.root, FILE_SPACES), { schema: 2, spaces })
    this.library.notify(['spaces'])
  }

  /** 新建学习区：先写盘、成功后才提交内存（写失败必须让调用方看到错误，不留幻影） */
  async createSpace(input: { name: string; kind: StudySpace['kind'] }): Promise<StudySpace> {
    const name = this.validateSpaceInput(input)
    const space = { id: randomUUID(), name, kind: input.kind, createdAt: now() }
    const next = [...this.idx().spaces, space]
    await this.persistSpaces(next)
    this.idx().spaces = next
    return space
  }

  async updateSpace(id: string, input: { name: string; kind: StudySpace['kind'] }): Promise<StudySpace> {
    const cur = this.idx().spaces.find((s) => s.id === id)
    if (!cur) throw new Error('学习区不存在')
    const name = this.validateSpaceInput(input, id)
    const updated = { ...cur, name, kind: input.kind }
    const next = this.idx().spaces.map((s) => (s.id === id ? updated : s))
    await this.persistSpaces(next)
    this.idx().spaces = next
    return { ...updated }
  }

  async assignSpace(entity: 'document' | 'note' | 'capture', id: string, spaceId: string | null): Promise<void> {
    if (spaceId === undefined) throw new Error('归属参数无效')
    this.validateSpace(spaceId)
    if (entity === 'document') {
      const entry = this.entryById(id)
      if (!entry) throw new Error('记录不存在')
      await this.commitEntryMeta(entry, { ...entry.meta, spaceId })
      return
    }
    if (entity === 'note') {
      const note = this.idx().notes.get(id)
      if (!note) throw new Error('记录不存在')
      const nextFm: NoteFrontMatter = { ...note.fm, spaceId, updatedAt: now() }
      await this.writeNote(id, note.extra, nextFm, note.bodyMd, note.fileAbs)
      return
    }
    if (entity === 'capture') {
      const capture = this.idx().captures.get(id)
      if (!capture || capture.orphan) throw new Error('记录不存在')
      const nextRec = { ...capture.rec, spaceId }
      await this.persistCaptureSidecar(capture.fileAbs, nextRec, capture.extra)
      capture.rec = nextRec
      this.library.notify(['captures'])
      return
    }
    throw new Error('归属参数无效')
  }

  // ---------- 文档与版本 ----------

  async importDocuments(
    paths: string[],
    options: { spaceId?: string | null; docType?: DocType; section?: string } = {}
  ): Promise<ImportResult[]> {
    this.validateSpace(options.spaceId)
    if (options.docType !== undefined && !['book', 'paper', 'other'].includes(options.docType)) throw new Error('文档类型无效')
    const results: ImportResult[] = []
    for (const path of paths) {
      try {
        const mediaType = mediaTypeFor(path)
        if (!mediaType || !['application/pdf', 'text/html'].includes(mediaType)) throw new Error('只支持导入 PDF 或 HTML 文档')
        if (mediaType === 'application/pdf') {
          const header = await readHead(path, 5)
          if (!header.startsWith('%PDF-')) throw new Error('文件头不是 PDF（可能已损坏或扩展名错误）')
        }
        results.push(await this.importOneDocument(path, mediaType, options))
      } catch (err) {
        results.push({ ok: false, path, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return results
  }

  private async importOneDocument(
    path: string,
    mediaType: string,
    options: { spaceId?: string | null; docType?: DocType; section?: string }
  ): Promise<ImportResult> {
    const stats = await stat(path)
    if (!stats.isFile()) throw new Error('请选择文件')
    if (mediaType === 'text/html' && stats.size > MAX_HTML_BYTES) throw new Error('HTML 文件不能超过 10 MB')
    const sha = await sha256Of(path)
    // 同一内容已在任何条目下 → 视为重复导入（提示，不建新条目）
    const existing = this.idx().shaToEntryFile.get(sha)
    if (existing) {
      return { ok: true, path, documentId: existing.entryId, versionId: sha, duplicate: true }
    }

    const ts = now()
    const id = randomUUID()
    const title = stripExt(basename(path))
    const section = sanitizeName(options.section?.trim() || SECTION_INBOX, 60)
    const originalName = basename(path)

    const parent = this.sectionDir(section)
    const base = sanitizeName(title)
    let dirName = base
    let dirAbs = join(parent, dirName)
    let suffix = 2
    while (existsSync(dirAbs)) {
      dirName = `${base}-${suffix}`
      dirAbs = join(parent, dirName)
      suffix++
    }
    mkdirSync(dirAbs, { recursive: true })

    // 原件：同目录临时副本 → 原子改名；文件名冲突时加 sha8 前缀区分
    let fileName = sanitizeFileName(originalName)
    if (existsSync(join(dirAbs, fileName))) {
      const ext = extname(fileName)
      fileName = `${stripExt(fileName)}-${sha.slice(0, 8)}${ext}`
    }
    const tmpCopy = join(dirAbs, `.${randomUUID()}.tmp`)
    copyFileSync(path, tmpCopy)
    const target = join(dirAbs, fileName)
    renameSync(tmpCopy, target)
    // 复制后复核（v1 的承诺，v2 丢了）：sha256 是资产的唯一身份（版本 id / 去重键 / /api/asset 寻址），
    // 复制中途损坏（磁盘满、坏扇区）会让身份与字节不一致，此后所有读取都会静默给出错误字节。
    const copiedSha = await sha256Of(target)
    if (copiedSha !== sha) {
      rmSync(target, { force: true })
      try { rmSync(dirAbs, { recursive: false, force: true }) } catch { /* 目录非空则保留 */ }
      throw new Error('原件复制校验失败：写入的字节与源文件不一致（磁盘可能已满或损坏）')
    }

    const meta: EntryMeta = {
      schema: 2,
      id,
      docType: options.docType ?? 'book',
      title: sanitizeName(title),
      authors: [],
      year: null,
      venue: null,
      doi: null,
      arxivId: null,
      abstract: null,
      tags: [],
      spaceId: options.spaceId ?? null,
      // PDF 交由识别队列回填书目（DOI/arXiv → Crossref/arXiv API）；HTML 无书目可识别
      status: mediaType === 'application/pdf' ? 'needs-review' : 'ok',
      note: null,
      files: [
        {
          sha256: sha,
          name: fileName,
          mediaType,
          byteSize: stats.size,
          pageCount: null,
          fingerprint: null,
          importedAt: ts
        }
      ],
      readingState: null,
      createdAt: ts,
      updatedAt: ts
    }
    await atomicWriteJson(join(dirAbs, FILE_ENTRY), meta)

    const indexed: IndexedEntry = {
      meta,
      section,
      dirAbs,
      dirRel: join(DIR_ENTRIES, section, dirName),
      anchors: [],
      hasFulltext: false,
      extra: {}
    }
    this.idx().entries.set(id, indexed)
    this.idx().shaToEntryFile.set(sha, { entryId: id, fileIndex: 0 })
    this.library.notify(['entries'])
    // 新条目交给全文索引器（覆盖所有导入路径；见 onDocumentsImported）
    try { this.importListener?.(id) } catch (err) { logWarn('repo', err instanceof Error ? err.message : String(err)) }
    return { ok: true, path, documentId: id, versionId: sha, duplicate: false }
  }

  listDocuments(spaceId?: SpaceScope): DocumentSummary[] {
    this.validateSpace(spaceId)
    const out: DocumentSummary[] = []
    for (const entry of this.idx().entries.values()) {
      if (!this.scopeMatch(spaceId, entry.meta.spaceId)) continue
      const file = this.primaryFile(entry)
      out.push({
        mediaType: file?.mediaType ?? 'application/octet-stream',
        spaceId: entry.meta.spaceId,
        id: entry.meta.id,
        docType: entry.meta.docType,
        title: entry.meta.title,
        pageCount: file?.pageCount ?? null,
        versionCount: entry.meta.files.length,
        lastReadPageIndex: entry.meta.readingState?.pageIndex ?? null,
        updatedAt: entry.meta.updatedAt
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  openDocument(documentId: string): OpenDocumentResult {
    const entry = this.entryById(documentId)
    if (!entry) throw new Error('文档不存在')
    const file = this.primaryFile(entry)
    if (!file) throw new Error('文档没有可用文件')
    return {
      documentId,
      spaceId: entry.meta.spaceId,
      mediaType: file.mediaType,
      versionId: file.sha256,
      assetId: file.sha256,
      url: `/api/asset/${file.sha256}?variant=original`,
      title: entry.meta.title,
      docType: entry.meta.docType,
      pageCount: file.pageCount,
      fingerprint: file.fingerprint,
      readingState: entry.meta.readingState
        ? { pageIndex: entry.meta.readingState.pageIndex, scale: entry.meta.readingState.scale, rotation: entry.meta.readingState.rotation }
        : null
    }
  }

  async readHtml(documentId: string): Promise<string> {
    const document = this.openDocument(documentId)
    if (document.mediaType !== 'text/html') throw new Error('此文档不是 HTML')
    const file = await this.resolveServingFile(document.assetId, 'original')
    if ((await stat(file.absPath)).size > MAX_HTML_BYTES) throw new Error('HTML 文件不能超过 10 MB')
    return readFile(file.absPath, 'utf8')
  }

  async updateDocument(id: string, patch: { title?: string; docType?: DocType; authors?: string; note?: string }): Promise<void> {
    const entry = this.entryById(id)
    if (!entry) throw new Error('文档不存在')
    const title = patch.title === undefined ? entry.meta.title : patch.title.trim()
    if (!title) throw new Error('请输入文档标题')
    const docType = patch.docType ?? entry.meta.docType
    if (!['book', 'paper', 'other'].includes(docType)) throw new Error('文档类型无效')
    const nextMeta: EntryMeta = {
      ...entry.meta,
      title,
      docType: docType as DocType,
      ...(patch.authors !== undefined ? { authors: splitAuthors(patch.authors) } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {})
    }
    // 先写盘（失败：内存与磁盘都不变），再改名目录（目录名只是展示；失败时元数据已生效、名称下次再同步）
    await this.commitEntryMeta(entry, nextMeta)
    await this.syncEntryDirName(entry)
  }

  /** 渲染进程首次用 PDF.js 打开后回报（只在为空时填充） */
  async setVersionMeta(versionId: string, meta: { pageCount?: number; fingerprint?: string }): Promise<void> {
    const entry = this.entryBySha(versionId)
    if (!entry) return
    const i = this.fileIndexOf(entry, versionId)
    if (i === -1) return
    const file = entry.meta.files[i]
    const fingerprint = file.fingerprint ?? meta.fingerprint ?? null
    const pageCount = file.pageCount ?? meta.pageCount ?? null
    if (fingerprint === file.fingerprint && pageCount === file.pageCount) return
    const nextMeta: EntryMeta = {
      ...entry.meta,
      files: entry.meta.files.map((f, idx) => (idx === i ? { ...f, fingerprint, pageCount } : f))
    }
    await this.commitEntryMeta(entry, nextMeta)
  }

  // ---------- 锚点 ----------

  async createAnchor(input: {
    documentVersionId: string
    pageIndex: number
    pageLabel?: string | null
    rects: PdfRect[]
    quote?: string | null
  }, activity?: { groupId?: string }): Promise<AnchorRecord> {
    if (!Array.isArray(input.rects)) throw new Error('锚点坐标格式无效')
    const entry = this.entryBySha(input.documentVersionId)
    if (!entry) throw new Error('文档版本不存在')
    const file = entry.meta.files[this.fileIndexOf(entry, input.documentVersionId)]
    // 无矩形表示明确的页级来源；仍须是真实 PDF 的有效页码。
    if (!input.rects.length) {
      if (!file || file.mediaType !== 'application/pdf' || !Number.isInteger(input.pageIndex) || input.pageIndex < 0 ||
          (file.pageCount !== null && input.pageIndex >= file.pageCount)) {
        throw new Error('页级来源必须指向 PDF 的有效页面')
      }
    }
    const id = randomUUID()
    const ts = now()
    const anchor: StoredAnchor = {
      id,
      fileSha: input.documentVersionId,
      pageIndex: input.pageIndex,
      pageLabel: input.pageLabel ?? null,
      rects: input.rects,
      quote: input.quote ?? null,
      createdAt: ts
    }
    entry.anchors.push(anchor)
    await this.persistAnchors(entry)
    this.activities.record({
      kind: 'anchor-added',
      documentId: entry.meta.id,
      title: entry.meta.title,
      spaceId: entry.meta.spaceId,
      groupId: activity?.groupId
    })
    return {
      id,
      documentVersionId: input.documentVersionId,
      pageIndex: input.pageIndex,
      pageLabel: input.pageLabel ?? null,
      rects: input.rects,
      quote: input.quote ?? null,
      createdAt: ts
    }
  }

  private findAnchor(anchorId: string): { entry: IndexedEntry; anchor: StoredAnchor } | undefined {
    for (const entry of this.idx().entries.values()) {
      const anchor = entry.anchors.find((a) => a.id === anchorId)
      if (anchor) return { entry, anchor }
    }
    return undefined
  }

  getAnchorWithContext(anchorId: string): AnchorRecord & { documentId: string; documentTitle: string } {
    const found = this.findAnchor(anchorId)
    if (!found) throw new Error('锚点不存在')
    const { entry, anchor } = found
    return {
      id: anchor.id,
      documentVersionId: anchor.fileSha,
      pageIndex: anchor.pageIndex,
      pageLabel: anchor.pageLabel,
      rects: anchor.rects,
      quote: anchor.quote,
      createdAt: anchor.createdAt,
      documentId: entry.meta.id,
      documentTitle: entry.meta.title
    }
  }

  listPageAnchors(versionId: string, pageIndex: number): PageAnchorView[] {
    const entry = this.entryBySha(versionId)
    if (!entry) return []
    const notes = [...this.idx().notes.values()].sort((a, b) => b.fm.updatedAt.localeCompare(a.fm.updatedAt))
    const noteIdsFor = (anchorId: string) => {
      const ids: string[] = []
      const titles: string[] = []
      for (const n of notes) {
        if (n.fm.sources.some((s) => s.kind === 'anchor' && s.id === anchorId)) {
          ids.push(n.fm.id)
          titles.push(n.fm.title)
        }
      }
      return { noteIds: ids, noteTitles: titles }
    }
    return entry.anchors
      .filter((a) => a.fileSha === versionId && a.pageIndex === pageIndex)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => ({
        id: a.id,
        documentVersionId: versionId,
        pageIndex,
        pageLabel: null,
        rects: a.rects,
        quote: a.quote,
        createdAt: a.createdAt,
        ...noteIdsFor(a.id)
      }))
  }

  // ---------- 笔记 ----------

  private noteRecordOf(note: { fm: NoteFrontMatter; bodyMd: string }): NoteRecord {
    return {
      spaceId: note.fm.spaceId,
      id: note.fm.id,
      noteType: note.fm.noteType as NoteType,
      title: note.fm.title,
      aliases: note.fm.aliases,
      bodyMd: note.bodyMd,
      verifiedStatus: note.fm.verifiedStatus as VerifiedStatus,
      revisionNo: note.fm.revision,
      createdAt: note.fm.createdAt,
      updatedAt: note.fm.updatedAt,
      learning: note.fm.learning ?? null
    }
  }

  private noteFilePath(title: string, id: string): string {
    return join(this.library.root, DIR_NOTES, `${slugFor(title)}-${id.slice(0, 8)}.md`)
  }

  /**
   * 笔记落盘（唯一的写入原语）：**先写盘、成功后才提交内存索引** —— 写失败时索引绝不超前于磁盘。
   * 返回提交后的索引节点（调用方以返回值/索引为准，不要持有已被替换的旧对象）。
   * oldFileAbs：改名前的旧路径（写成功后删除，保持「一 id 一文件」）。
   */
  private async writeNote(
    id: string,
    extra: Record<string, unknown>,
    nextFm: NoteFrontMatter,
    nextBody: string,
    oldFileAbs: string | null
  ): Promise<IndexedNote> {
    const fileAbs = this.noteFilePath(nextFm.title, nextFm.id)
    const content = serializeNoteMarkdown(nextFm, nextBody, extra)
    await atomicWriteFile(fileAbs, content)
    if (oldFileAbs && oldFileAbs !== fileAbs && existsSync(oldFileAbs)) rmSync(oldFileAbs, { force: true })
    const node: IndexedNote = {
      fm: nextFm,
      bodyMd: nextBody,
      fileAbs,
      fileRel: join(DIR_NOTES, basename(fileAbs)),
      // 与扫描同算法：sha1(写出的原文)。冲突检测的下一次比对基准
      diskHash: sha1OfText(content),
      extra
    }
    this.idx().notes.set(nextFm.id, node)
    this.library.notify(['notes'])
    return node
  }

  /**
   * 磁盘上该笔记的当前原文：优先索引记录的路径，兜底按「-<id8>.md」后缀在 笔记/ 里找
   * （外部改名 / iCloud 换名 / 索引尚未重扫时也能对上）。
   */
  private async readNoteDisk(noteId: string, existing: IndexedNote | null): Promise<{ fileAbs: string; text: string } | null> {
    // 常见路径：索引记录的路径可直接读到（每次保存只多一次小文件读，不做目录扫描）
    if (existing) {
      try {
        return { fileAbs: existing.fileAbs, text: await readFile(existing.fileAbs, 'utf8') }
      } catch { /* 文件被外部改名/删除 → 走后缀兜底 */ }
    }
    // 兜底：按「-<id8>.md」后缀在 笔记/ 里找（外部改名 / iCloud 换名 / 索引尚未重扫）
    const candidates: string[] = []
    const dir = join(this.library.root, DIR_NOTES)
    const suffix = `-${noteId.slice(0, 8)}.md`
    try {
      for (const name of readdirSync(dir)) {
        if (name.endsWith(suffix)) candidates.push(join(dir, name))
      }
    } catch { /* 目录尚未建立 */ }
    for (const abs of candidates) {
      try {
        return { fileAbs: abs, text: await readFile(abs, 'utf8') }
      } catch { /* 试下一个候选 */ }
    }
    return null
  }

  /** 冲突载荷：把磁盘现状翻译成渲染层可呈现、可落回编辑器的版本（无法解析时用原始文本兜底） */
  private conflictFromDisk(existing: IndexedNote | null, disk: { fileAbs: string; text: string }): NoteSaveConflictInfo {
    const parsed = parseNoteMarkdown(disk.text)
    const fm = parsed?.fm ?? null
    return {
      title: fm?.title ?? existing?.fm.title ?? '未命名',
      noteType: (fm?.noteType ?? existing?.fm.noteType ?? 'note') as NoteType,
      bodyMd: parsed ? parsed.bodyMd : disk.text,
      aliases: fm?.aliases ?? existing?.fm.aliases ?? [],
      verifiedStatus: (fm?.verifiedStatus ?? existing?.fm.verifiedStatus ?? 'unchecked') as VerifiedStatus,
      updatedAt: fm?.updatedAt ?? existing?.fm.updatedAt ?? new Date(0).toISOString(),
      revisionNo: fm?.revision ?? existing?.fm.revision ?? 1,
      baseHash: sha1OfText(disk.text),
      parseFailed: !parsed
    }
  }

  /**
   * 把「磁盘上的外部版本」保留为一条独立笔记（用户明确选择「以本地覆盖」前调用）。
   * 归档笔记是普通 .md：出现在列表、可检索、可打开；不记入学习足迹（系统产物，非用户学习行为）。
   */
  private async archiveNoteVersion(existing: IndexedNote | null, disk: { fileAbs: string; text: string }): Promise<string> {
    const parsed = parseNoteMarkdown(disk.text)
    const fm = parsed?.fm ?? null
    const id = randomUUID()
    const ts = now()
    const baseTitle = fm?.title ?? existing?.fm.title ?? '外部修改'
    const nextFm: NoteFrontMatter = {
      schema: 2,
      id,
      noteType: (fm?.noteType ?? existing?.fm.noteType ?? 'note') as NoteType,
      title: `${baseTitle}（外部修改副本）`.slice(0, 200),
      aliases: fm?.aliases ?? existing?.fm.aliases ?? [],
      verifiedStatus: 'unchecked',
      spaceId: fm?.spaceId ?? existing?.fm.spaceId ?? null,
      revision: 1,
      sources: fm?.sources ?? existing?.fm.sources ?? [],
      createdAt: ts,
      updatedAt: ts
    }
    await this.writeNote(id, existing?.extra ?? {}, nextFm, parsed ? parsed.bodyMd : disk.text, null)
    return id
  }

  async createNote(input: {
    title: string
    noteType?: NoteType
    bodyMd?: string
    anchorId?: string
    documentId?: string
    spaceId?: string | null
  }, activity?: { groupId?: string }): Promise<NoteRecord> {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) throw new Error('请输入笔记标题')
    if (title.length > 200) throw new Error('笔记标题过长')
    input = { ...input, title }
    const id = randomUUID()
    const ts = now()
    const body = input.bodyMd ?? ''
    let spaceId = input.spaceId
    if (input.documentId) {
      const source = this.openDocument(input.documentId)
      if (spaceId === undefined) spaceId = source.spaceId
    }
    if (input.anchorId) {
      const source = this.getAnchorWithContext(input.anchorId)
      if (spaceId === undefined) spaceId = this.openDocument(source.documentId).spaceId
    }
    this.validateSpace(spaceId)
    const sources: NoteSourceRef[] = []
    if (input.anchorId) {
      const found = this.findAnchor(input.anchorId)
      if (!found) throw new Error('锚点不存在')
      sources.push({ kind: 'anchor', id: input.anchorId, documentId: found.entry.meta.id })
    }
    if (input.documentId) sources.push({ kind: 'document', id: input.documentId })
    const fm: NoteFrontMatter = {
      schema: 2,
      id,
      noteType: input.noteType ?? 'note',
      title,
      aliases: [],
      verifiedStatus: 'unchecked',
      spaceId: spaceId ?? null,
      revision: 1,
      sources,
      createdAt: ts,
      updatedAt: ts,
      // 随手记等「带正文直接建笔记」：本次即首次非空正文，直接计新建；空白占位不计数
      counted: body.trim() !== ''
    }
    const node = await this.writeNote(id, {}, fm, body, null)
    if (body.trim() !== '') {
      this.activities.record({ kind: 'note-created', noteId: id, title, spaceId: spaceId ?? null, groupId: activity?.groupId })
    }
    return this.noteRecordOf(node)
  }

  getNote(noteId: string): NoteRecord {
    const note = this.idx().notes.get(noteId)
    if (!note) throw new Error('笔记不存在')
    return this.noteRecordOf(note)
  }

  getNoteFull(noteId: string): NoteFull {
    const note = this.getNote(noteId)
    const idx = this.idx()
    const node = idx.notes.get(noteId)!
    const anchors: NoteAnchorView[] = []
    const captures: NoteCaptureView[] = []
    const documents: NoteFull['documents'] = []
    const missingSources: NoteFull['missingSources'] = []
    for (const src of node.fm.sources) {
      if (src.kind === 'anchor') {
        const found = this.findAnchor(src.id)
        if (found) {
          anchors.push({
            id: found.anchor.id,
            documentVersionId: found.anchor.fileSha,
            pageIndex: found.anchor.pageIndex,
            pageLabel: found.anchor.pageLabel,
            rects: found.anchor.rects,
            quote: found.anchor.quote,
            createdAt: found.anchor.createdAt,
            documentId: found.entry.meta.id,
            documentTitle: found.entry.meta.title
          })
        } else {
          missingSources.push({ kind: 'anchor', id: src.id })
        }
      } else if (src.kind === 'capture') {
        const cap = idx.captures.get(src.id)
        if (cap) {
          captures.push({
            spaceId: cap.rec.spaceId,
            id: cap.rec.id,
            assetId: cap.rec.sha256,
            context: cap.rec.context,
            inboxStatus: cap.rec.inboxStatus,
            createdAt: cap.rec.createdAt,
            originalName: cap.fileName,
            mediaType: cap.rec.mediaType
          })
        } else {
          missingSources.push({ kind: 'capture', id: src.id })
        }
      } else {
        const entry = this.entryById(src.id)
        if (entry) {
          const file = this.primaryFile(entry)
          documents.push({ documentId: entry.meta.id, title: entry.meta.title, mediaType: file?.mediaType ?? 'application/pdf' })
        } else {
          missingSources.push({ kind: 'document', id: src.id })
        }
      }
    }
    return { note, documents, anchors, captures, missingSources, baseHash: node.diskHash }
  }

  /**
   * 保存笔记：磁盘指纹冲突检测 → 先写盘 → 成功后提交内存。
   *
   * 冲突语义（NoteSaveResponse）：
   *   - 调用方携带 baseHash（编辑起点的磁盘指纹）且磁盘已变 → **不写入**，返回磁盘版本；
   *   - 未携带 baseHash（旧调用/跨版本混跑）→ 保持后写覆盖，不阻断；
   *   - force=true（用户在冲突界面明确选择覆盖）→ 先把磁盘版本另存为独立笔记，再写本地内容。
   */
  async saveNote(input: {
    id: string
    title: string
    noteType: NoteType
    bodyMd: string
    aliases: string[]
    verifiedStatus: VerifiedStatus
    baseHash?: string
    force?: boolean
    /** 知识块自评（WP-8）：undefined = 不改动已有标记；null = 清空 */
    learning?: NoteLearningState | null
  }): Promise<NoteSaveResponse> {
    const existing = this.idx().notes.get(input.id) ?? null
    const disk = await this.readNoteDisk(input.id, existing)
    const diskHash = disk ? sha1OfText(disk.text) : null
    const externalChange = Boolean(disk && input.baseHash !== undefined && diskHash !== input.baseHash)
    // 旧客户端（无 baseHash）只能后写覆盖：进程内记一次日志，便于排查「两台机器混跑新旧版本」的场景
    if (input.baseHash === undefined && !legacySaveWarned) {
      legacySaveWarned = true
      logWarn('repo', '保存请求未携带 baseHash（旧版本调用或外部集成）：该笔记按后写覆盖处理，无法检测外部修改')
    }

    if (externalChange && !input.force) {
      const payload = this.conflictFromDisk(existing, disk!)
      // 索引可能还没看到外部改动：重扫让列表/侧栏/其它视图与磁盘一致（冲突路径，代价可接受）
      await this.library.rescanNow().catch(() => undefined)
      const after = this.idx().notes.get(input.id)
      return {
        conflict: true,
        disk: payload,
        revisionNo: after?.fm.revision ?? payload.revisionNo,
        savedAt: after?.fm.updatedAt ?? payload.updatedAt,
        baseHash: after?.diskHash ?? payload.baseHash
      }
    }

    let archivedNoteId: string | undefined
    if (externalChange && input.force && disk) {
      // 覆盖前先把外部版本留成独立笔记：双方内容都不丢
      archivedNoteId = await this.archiveNoteVersion(existing, disk)
    }

    // 索引缺失但磁盘存在（外部写坏 front-matter / 索引滞后）：以磁盘版本为基底重建；都没有才报不存在
    const base = existing
      ? { fm: existing.fm, bodyMd: existing.bodyMd, extra: existing.extra }
      : disk
        ? (() => { const p = parseNoteMarkdown(disk.text); return p ? { fm: p.fm, bodyMd: p.bodyMd, extra: p.extra } : null })()
        : null
    if (!base) throw new Error('笔记不存在')

    const ts = now()
    const bodyChanged = base.bodyMd !== input.bodyMd
    const aliases = input.aliases.filter((a) => typeof a === 'string')
    // 改名时把旧标题并入 aliases：双链与反链按「标题 + aliases」解析（见 noteBacklinks），
    // 不并入的话改一次标题就会让所有 [[旧标题]] 断链——docs/存储格式.md 明确承诺了这条语义。
    const previousTitle = base.fm.title.trim()
    if (previousTitle && previousTitle !== input.title.trim() && !aliases.includes(previousTitle)) {
      aliases.push(previousTitle)
    }
    const anyChanged = bodyChanged || base.fm.title !== input.title || base.fm.noteType !== input.noteType ||
      JSON.stringify(base.fm.aliases) !== JSON.stringify(aliases) || base.fm.verifiedStatus !== input.verifiedStatus
    // 足迹口径：首次写出非空正文=新建（counted 防「清空再写」重复计新建）；其余正文变化=修改。
    // 改名/改分类/核对状态变化是用户编辑但不计为正文学习活动。
    const firstContent = bodyChanged && !base.fm.counted && base.bodyMd.trim() === '' && input.bodyMd.trim() !== ''
    const nextFm: NoteFrontMatter = {
      ...base.fm,
      title: input.title,
      noteType: input.noteType,
      aliases,
      verifiedStatus: input.verifiedStatus,
      revision: bodyChanged ? base.fm.revision + 1 : base.fm.revision,
      // updatedAt 只在真实变化时刷新：零变化的重复合存不得虚增「最近更新」
      updatedAt: anyChanged ? ts : base.fm.updatedAt,
      ...(firstContent ? { counted: true } : {}),
      // 学习自评：显式传入才改；且**不算内容变化**（不动 revision / updatedAt / 足迹）——
      // 自评是学习行为，不是对笔记正文的编辑
      ...(input.learning !== undefined
        ? (input.learning && (input.learning.activeId || Object.keys(input.learning.records).length)
            ? { learning: input.learning }
            : { learning: undefined })
        : {})
    }
    const node = await this.writeNote(input.id, base.extra, nextFm, input.bodyMd, disk?.fileAbs ?? existing?.fileAbs ?? null)
    // 事件在笔记成功保存之后记录；足迹写入失败由 ActivityStore 兜底，不影响本次保存
    if (bodyChanged) {
      this.activities.record({
        kind: firstContent ? 'note-created' : 'note-updated',
        noteId: node.fm.id,
        title: node.fm.title,
        spaceId: node.fm.spaceId
      })
    }
    // 知识块自评的状态变化 = 学习行为：每个状态发生改变的块记一条（「已理解」的复习也计入）
    if (input.learning !== undefined) {
      const before = base.fm.learning?.records ?? {}
      const after = nextFm.learning?.records ?? {}
      for (const [blockId, rec] of Object.entries(after)) {
        if (before[blockId]?.status === rec.status) continue
        this.activities.record({
          kind: 'block-reviewed',
          noteId: node.fm.id,
          title: node.fm.title,
          spaceId: node.fm.spaceId,
          status: rec.status
        })
      }
    }
    // 改名后索引键不变（id 为键），文件路径已在 writeNote 中更新
    return { conflict: false, revisionNo: node.fm.revision, savedAt: node.fm.updatedAt, baseHash: node.diskHash, archivedNoteId }
  }

  /**
   * 冲突处理出口：「把当前编辑内容另存为独立笔记」。
   * 来源引用（锚点/材料）随副本保留；原笔记保持磁盘上的外部版本不动。
   */
  async noteSaveAsCopy(input: {
    sourceId: string
    title: string
    noteType: NoteType
    bodyMd: string
    aliases: string[]
    verifiedStatus: VerifiedStatus
  }): Promise<NoteRecord> {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) throw new Error('请输入笔记标题')
    if (title.length > 200) throw new Error('笔记标题过长')
    const src = this.idx().notes.get(input.sourceId) ?? null
    const id = randomUUID()
    const ts = now()
    const nextFm: NoteFrontMatter = {
      schema: 2,
      id,
      noteType: input.noteType ?? 'note',
      title,
      aliases: [...new Set(input.aliases.filter((a) => typeof a === 'string'))],
      verifiedStatus: input.verifiedStatus ?? 'unchecked',
      spaceId: src?.fm.spaceId ?? null,
      revision: 1,
      sources: src ? src.fm.sources.map((s) => ({ ...s })) : [],
      createdAt: ts,
      updatedAt: ts,
      ...(input.bodyMd.trim() !== '' ? { counted: true } : {})
    }
    const node = await this.writeNote(id, src?.extra ?? {}, nextFm, input.bodyMd, null)
    if (input.bodyMd.trim() !== '') {
      this.activities.record({ kind: 'note-created', noteId: id, title, spaceId: nextFm.spaceId })
    }
    return this.noteRecordOf(node)
  }

  // ---------- 学习足迹查询 ----------

  /**
   * 足迹面板一次取全：摘要（本周/本月，按 noteId 去重、范围内新建不重复计修改）
   * + 月历圆点 + 当日活动列表。标题与存活状态按索引实时解析，活动仅应用内行为。
   */
  /**
   * 阅读会话：ReaderView 在导航冲刷 / 卸载时把「这段时间翻了哪些页」汇总成一条上报。
   * 按会话聚合而不是每页写盘——读一篇 300 页的论文不该产生 300 条事件。
   * 太短的会话（<10 秒且没翻页）不计：打开又关掉不算学习。
   */
  recordReaderSession(input: { documentId: string; pages: number; seconds: number }): void {
    const entry = this.entryById(input.documentId)
    if (!entry) return
    const seconds = Math.max(0, Math.min(86400, Math.round(input.seconds) || 0))
    const pages = Math.max(0, Math.min(100000, Math.round(input.pages) || 0))
    if (seconds < 10 && pages === 0) return
    this.activities.record({
      kind: 'reader-session',
      documentId: entry.meta.id,
      title: entry.meta.title,
      spaceId: entry.meta.spaceId,
      pages,
      seconds
    })
  }

  activityPanel(input: { range: 'week' | 'month'; month?: string; date?: string; anchor?: string; spaceId?: string | null }): ActivityPanelData {
    const events = this.activities.all().filter((e) => input.spaceId === undefined || e.spaceId === input.spaceId)
    const today = localDateKey(new Date())
    // anchor：历史回看的口径锚点（本地日期，缺省=今天，向后兼容）。
    // 摘要范围与对象统计随 anchor 计算；monthDays / heat / items 的语义不变。
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(input.anchor ?? '') ? input.anchor! : today
    const { start, end } = input.range === 'week' ? weekRangeOf(anchor) : monthRangeOf(anchor)
    const inRange = events.filter((e) => e.date >= start && e.date <= end)
    const createdIds = new Set(inRange.filter((e) => e.kind === 'note-created' && e.noteId).map((e) => e.noteId!))
    const updatedIds = new Set(
      inRange.filter((e) => e.kind === 'note-updated' && e.noteId && !createdIds.has(e.noteId)).map((e) => e.noteId!)
    )
    const sessions = inRange.filter((e) => e.kind === 'reader-session')
    const month = /^\d{4}-\d{2}$/.test(input.month ?? '') ? input.month! : today.slice(0, 7)
    const monthDays = [...new Set(events.filter((e) => e.date.startsWith(`${month}-`)).map((e) => e.date))].sort()
    const dayEvents = /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') ? events.filter((e) => e.date === input.date) : []
    return {
      startedAt: this.activities.startedAt(),
      healthy: this.activities.healthy,
      rangeStart: start,
      rangeEnd: end,
      summary: {
        activeDays: new Set(inRange.map((e) => e.date)).size,
        created: createdIds.size,
        updated: updatedIds.size,
        readMinutes: Math.round(sessions.reduce((a, e) => a + (e.seconds ?? 0), 0) / 60),
        readPages: sessions.reduce((a, e) => a + (e.pages ?? 0), 0),
        reviews: inRange.filter((e) => e.kind === 'block-reviewed').length
      },
      month,
      monthDays,
      heat: this.activityHeat(events, today),
      objects: this.activityObjects(inRange),
      items: this.activityDayItems(dayEvents)
    }
  }

  /**
   * 热力图数据：最近 17 周（119 天）每天一个权重，只用于格子深浅。
   * 权重是各类活动的加权和（阅读按时长分档封顶），不是「打卡数」——不做连续天数之类的游戏化指标。
   */
  private activityHeat(events: ActivityEvent[], today: string): Array<{ date: string; weight: number }> {
    const byDay = new Map<string, number>()
    for (const e of events) {
      const w =
        e.kind === 'note-created' ? 3
        : e.kind === 'block-reviewed' ? 2
        : e.kind === 'reader-session' ? Math.min(4, 1 + Math.floor((e.seconds ?? 0) / 600))
        : 1
      byDay.set(e.date, (byDay.get(e.date) ?? 0) + w)
    }
    const [y, m, d] = today.split('-').map(Number)
    const out: Array<{ date: string; weight: number }> = []
    for (let i = 118; i >= 0; i--) {
      const key = localDateKey(new Date(y, m - 1, d - i))
      out.push({ date: key, weight: byDay.get(key) ?? 0 })
    }
    return out
  }

  /** 对象级统计：范围内每个材料 / 笔记「读了几次多久、翻了几页、写了几笔、摘了几条、改了几次、自评几块」 */
  private activityObjects(events: ActivityEvent[]): ActivityObjectStat[] {
    const docs = new Map<string, ActivityObjectStat>()
    const notes = new Map<string, ActivityObjectStat>()
    const blank = (kind: 'document' | 'note', id: string, title: string, deleted: boolean): ActivityObjectStat => ({
      kind, id, title, deleted,
      reads: 0, readMinutes: 0, pages: 0, inkStrokes: 0, anchors: 0, updates: 0, created: false,
      questions: 0, understands: 0, lastAt: ''
    })
    for (const e of events) {
      if (e.documentId && (e.kind === 'reader-session' || e.kind === 'ink-saved' || e.kind === 'anchor-added')) {
        const live = this.entryById(e.documentId)
        const s = docs.get(e.documentId) ?? blank('document', e.documentId, live?.meta.title ?? e.title ?? '已删除的材料', !live)
        if (live) s.mediaType = this.primaryFile(live)?.mediaType
        if (e.at > s.lastAt) s.lastAt = e.at
        if (e.kind === 'reader-session') {
          s.reads++
          s.readMinutes += Math.round((e.seconds ?? 0) / 60)
          s.pages += e.pages ?? 0
        } else if (e.kind === 'ink-saved') {
          s.inkStrokes += e.strokes ?? 0
        } else {
          s.anchors++
        }
        docs.set(e.documentId, s)
        continue
      }
      if (e.noteId && (e.kind === 'note-created' || e.kind === 'note-updated' || e.kind === 'block-reviewed')) {
        const live = this.idx().notes.get(e.noteId)
        const s = notes.get(e.noteId) ?? blank('note', e.noteId, live?.fm.title ?? e.title ?? '已删除的笔记', !live)
        if (e.at > s.lastAt) s.lastAt = e.at
        if (e.kind === 'note-created') s.created = true
        else if (e.kind === 'note-updated') s.updates++
        else if (e.status === 'question') s.questions++
        else if (e.status === 'understood') s.understands++
        notes.set(e.noteId, s)
      }
    }
    const weight = (s: ActivityObjectStat): number =>
      s.reads * 2 + s.readMinutes / 10 + s.anchors + s.inkStrokes / 20 + s.updates + s.questions + s.understands + (s.created ? 2 : 0)
    return [...docs.values(), ...notes.values()]
      .filter((s) => weight(s) > 0)
      .sort((a, b) => weight(b) - weight(a) || b.lastAt.localeCompare(a.lastAt))
      .slice(0, 12)
  }

  /** 当日活动合并：同笔记多条事件→一条（新建优先）；摘录按材料合并；groupId 关联的伴随摘录并入笔记条目 */
  private activityDayItems(events: ActivityEvent[]): ActivityDayItem[] {
    const idx = this.idx()
    interface NoteAgg { at: string; created: boolean; anchorCount: number; fromDoc?: string }
    const notes = new Map<string, NoteAgg>()
    const docs = new Map<string, { at: string; count: number; snapshot: string | undefined }>()
    const reads = new Map<string, { at: string; reads: number; pages: number; seconds: number }>()
    const inks = new Map<string, { at: string; strokes: number }>()
    const reviews = new Map<string, { at: string; questions: number; understands: number }>()
    const groupIdNote = new Map<string, string>()
    for (const e of events) {
      if (e.kind !== 'anchor-added' && e.groupId && e.noteId) groupIdNote.set(e.groupId, e.noteId)
    }
    for (const e of events) {
      if (e.kind === 'anchor-added') {
        const noteId = e.groupId ? groupIdNote.get(e.groupId) : undefined
        if (noteId) {
          const agg = notes.get(noteId) ?? { at: e.at, created: false, anchorCount: 0 }
          agg.anchorCount++
          if (e.at > agg.at) agg.at = e.at
          agg.fromDoc = agg.fromDoc ?? e.title
          notes.set(noteId, agg)
        } else if (e.documentId) {
          const agg = docs.get(e.documentId) ?? { at: e.at, count: 0, snapshot: e.title }
          agg.count++
          if (e.at > agg.at) agg.at = e.at
          docs.set(e.documentId, agg)
        }
        continue
      }
      if (e.kind === 'reader-session' && e.documentId) {
        const agg = reads.get(e.documentId) ?? { at: e.at, reads: 0, pages: 0, seconds: 0 }
        agg.reads++
        agg.pages += e.pages ?? 0
        agg.seconds += e.seconds ?? 0
        if (e.at > agg.at) agg.at = e.at
        reads.set(e.documentId, agg)
        continue
      }
      if (e.kind === 'ink-saved' && e.documentId) {
        const agg = inks.get(e.documentId) ?? { at: e.at, strokes: 0 }
        agg.strokes += e.strokes ?? 0
        if (e.at > agg.at) agg.at = e.at
        inks.set(e.documentId, agg)
        continue
      }
      if (e.kind === 'block-reviewed' && e.noteId) {
        const agg = reviews.get(e.noteId) ?? { at: e.at, questions: 0, understands: 0 }
        if (e.status === 'question') agg.questions++
        else agg.understands++
        if (e.at > agg.at) agg.at = e.at
        reviews.set(e.noteId, agg)
        continue
      }
      if (!e.noteId) continue
      const agg = notes.get(e.noteId) ?? { at: e.at, created: false, anchorCount: 0 }
      if (e.kind === 'note-created') agg.created = true
      if (e.at > agg.at) agg.at = e.at
      notes.set(e.noteId, agg)
    }
    const items: ActivityDayItem[] = []
    for (const [noteId, agg] of notes) {
      const live = idx.notes.get(noteId)
      items.push({
        key: `note-${noteId}`,
        kind: 'note',
        created: agg.created,
        noteId,
        title: live ? live.fm.title : (events.find((e) => e.noteId === noteId)?.title ?? '已删除的笔记'),
        deleted: !live,
        anchorCount: agg.anchorCount,
        fromDocumentTitle: agg.fromDoc,
        at: agg.at
      })
    }
    for (const [documentId, agg] of docs) {
      const live = this.entryById(documentId)
      const file = live ? this.primaryFile(live) : null
      items.push({
        key: `doc-${documentId}`,
        kind: 'anchors',
        created: false,
        documentId,
        title: live ? live.meta.title : (agg.snapshot ?? '已删除的材料'),
        deleted: !live,
        anchorCount: agg.count,
        mediaType: file?.mediaType,
        at: agg.at
      })
    }
    for (const [documentId, agg] of reads) {
      const live = this.entryById(documentId)
      const file = live ? this.primaryFile(live) : null
      items.push({
        key: `read-${documentId}`,
        kind: 'read',
        created: false,
        documentId,
        title: live ? live.meta.title : '已删除的材料',
        deleted: !live,
        anchorCount: 0,
        mediaType: file?.mediaType,
        reads: agg.reads,
        pages: agg.pages,
        seconds: agg.seconds,
        at: agg.at
      })
    }
    for (const [documentId, agg] of inks) {
      const live = this.entryById(documentId)
      const file = live ? this.primaryFile(live) : null
      items.push({
        key: `ink-${documentId}`,
        kind: 'ink',
        created: false,
        documentId,
        title: live ? live.meta.title : '已删除的材料',
        deleted: !live,
        anchorCount: 0,
        mediaType: file?.mediaType,
        strokes: agg.strokes,
        at: agg.at
      })
    }
    for (const [noteId, agg] of reviews) {
      const live = idx.notes.get(noteId)
      items.push({
        key: `review-${noteId}`,
        kind: 'review',
        created: false,
        noteId,
        title: live ? live.fm.title : (events.find((e) => e.noteId === noteId)?.title ?? '已删除的笔记'),
        deleted: !live,
        anchorCount: 0,
        questions: agg.questions,
        understands: agg.understands,
        at: agg.at
      })
    }
    return items.sort((a, b) => b.at.localeCompare(a.at))
  }

  /**
   * 「建锚点 + 建笔记」组合操作：笔记写入失败时回滚刚写入的锚点，避免留下孤立锚点
   * （v1 靠数据库事务；v2 文件语义下用补偿删除达到同等效果）。
   */
  async createAnchorWithNote(input: {
    anchor: {
      documentVersionId: string
      pageIndex: number
      pageLabel?: string | null
      rects: PdfRect[]
      quote?: string | null
    }
    note: { title: string; noteType?: NoteType; bodyMd?: string; spaceId?: string | null }
  }): Promise<{ anchor: AnchorRecord; note: NoteRecord }> {
    // 同一 groupId 的摘录与伴随笔记在足迹里合并为一条叙述
    const groupId = randomUUID()
    const anchor = await this.createAnchor(input.anchor, { groupId })
    try {
      const note = await this.createNote({
        title: input.note.title,
        noteType: input.note.noteType,
        bodyMd: input.note.bodyMd,
        spaceId: input.note.spaceId,
        anchorId: anchor.id
      }, { groupId })
      return { anchor, note }
    } catch (err) {
      try {
        await this.removeAnchor(anchor.id)
      } catch {
        /* 回滚失败保留锚点（无害：仅是页上标记） */
      }
      throw err
    }
  }

  private async removeAnchor(anchorId: string): Promise<void> {
    const found = this.findAnchor(anchorId)
    if (!found) return
    found.entry.anchors = found.entry.anchors.filter((a) => a.id !== anchorId)
    await this.persistAnchors(found.entry)
  }

  /** 一份材料的全部关联笔记：锚点来源 ∪ 材料级关联，合并去重；可选按页过滤。 */
  listNotesForDocument(documentId: string, opts?: { pageIndex?: number }): MaterialNoteView[] {
    const idx = this.idx()
    const entry = this.entryById(documentId)
    if (!entry) return []
    const anchorByNote = new Map<string, Array<{ anchorId: string; pageIndex: number; rects: PdfRect[] }>>()
    const noteAnchorIds = new Map<string, Set<string>>()
    for (const anchor of entry.anchors) {
      for (const note of idx.notes.values()) {
        if (!note.fm.sources.some((s) => s.kind === 'anchor' && s.id === anchor.id)) continue
        const list = anchorByNote.get(note.fm.id) ?? []
        list.push({ anchorId: anchor.id, pageIndex: anchor.pageIndex, rects: anchor.rects })
        anchorByNote.set(note.fm.id, list)
        const set = noteAnchorIds.get(note.fm.id) ?? new Set<string>()
        set.add(anchor.id)
        noteAnchorIds.set(note.fm.id, set)
      }
    }
    const docSourceNotes = new Set<string>()
    for (const note of idx.notes.values()) {
      if (note.fm.sources.some((s) => s.kind === 'document' && s.id === documentId)) docSourceNotes.add(note.fm.id)
    }

    const rows = [...idx.notes.values()]
      .filter((n) => anchorByNote.has(n.fm.id) || docSourceNotes.has(n.fm.id))
      .sort((a, b) => b.fm.updatedAt.localeCompare(a.fm.updatedAt))
      .slice(0, QUERY_LIMITS.materialNotes)

    const out: MaterialNoteView[] = []
    for (const r of rows) {
      const anchors = (anchorByNote.get(r.fm.id) ?? []).slice().sort((a, b) => a.pageIndex - b.pageIndex)
      if (opts?.pageIndex !== undefined && anchors.length && !anchors.some((a) => a.pageIndex === opts.pageIndex)) {
        // 本页模式：完全由材料级关联挂进来的笔记（无任何锚点）也显示，便于 HTML/材料级说明
        if (!docSourceNotes.has(r.fm.id) || anchors.length > 0) continue
      }
      out.push({
        id: r.fm.id,
        title: r.fm.title,
        noteType: r.fm.noteType as NoteType,
        bodyMd: r.bodyMd,
        aliases: r.fm.aliases,
        verifiedStatus: r.fm.verifiedStatus as VerifiedStatus,
        revisionNo: r.fm.revision,
        updatedAt: r.fm.updatedAt,
        anchors,
        viaDocumentSource: docSourceNotes.has(r.fm.id),
        baseHash: r.diskHash
      })
    }
    return out
  }

  // ---------- 双向链接 ----------

  /** 反向链接：扫描其他笔记正文中的 [[链接]]（按标题/别名精确匹配本笔记），返回来源+上下文片段。 */
  noteBacklinks(noteId: string): BacklinkView[] {
    const me = this.getNote(noteId)
    const names = new Set<string>([me.title.trim(), ...me.aliases.map((a) => a.trim())])
    const out: BacklinkView[] = []
    for (const note of this.idx().notes.values()) {
      if (note.fm.id === noteId) continue
      for (const link of parseWikiLinks(note.bodyMd)) {
        if (!names.has(link.target.trim())) continue
        out.push({
          fromNoteId: note.fm.id,
          fromTitle: note.fm.title,
          fromNoteType: note.fm.noteType as NoteType,
          snippet: wikiSnippet(note.bodyMd, link.raw)
        })
        break // 每篇来源笔记只出现一次
      }
    }
    return out
  }

  /** 笔记链接索引（编辑器渲染解析与 [[ 输入辅助用） */
  noteLinkIndex(): NoteLinkIndexEntry[] {
    return [...this.idx().notes.values()]
      .sort((a, b) => b.fm.updatedAt.localeCompare(a.fm.updatedAt))
      .slice(0, QUERY_LIMITS.linkIndex)
      .map((n) => ({ id: n.fm.id, title: n.fm.title, aliases: n.fm.aliases }))
  }

  /**
   * 研究问题聚合（只读）：以一篇问题笔记为枢纽，汇总相关笔记、相关文献与知识块状态。
   *
   * 不新增存储、不改存储格式——全部从已有数据推导：
   *   - 链入 = noteBacklinks（其他笔记正文 [[链接]] 指向枢纽）；
   *   - 链出 = 解析枢纽自身正文的 [[链接]]，经链接索引（标题 + 别名）解析到笔记；
   *   - 文献 = 枢纽与相关笔记 front-matter 的 sources（anchor/document 两类，按文献去重合计摘录数）；
   *   - 知识块 = 枢纽与相关笔记的 learning 自评记录合计。
   * 因此聚合永远与库的当前状态一致，不需要维护任何冗余边。
   */
  questionAggregate(noteId: string): QuestionAggregate {
    const hubNode = this.idx().notes.get(noteId)
    if (!hubNode) throw new Error('笔记不存在')
    const idx = this.idx()
    const hub = { id: hubNode.fm.id, title: hubNode.fm.title }

    // 链入方向：复用反链扫描（按标题/别名匹配、排除自身、每篇来源只算一次）
    const incoming = new Set<string>()
    for (const b of this.noteBacklinks(noteId)) incoming.add(b.fromNoteId)

    // 链出方向：解析枢纽正文的 [[链接]]，经链接索引（标题 + 别名）解析到目标笔记
    const nameToId = new Map<string, string>()
    for (const entry of this.noteLinkIndex()) {
      const title = entry.title.trim()
      if (title && !nameToId.has(title)) nameToId.set(title, entry.id)
      for (const alias of entry.aliases) {
        const a = alias.trim()
        if (a && !nameToId.has(a)) nameToId.set(a, entry.id)
      }
    }
    const outgoing = new Set<string>()
    for (const link of parseWikiLinks(hubNode.bodyMd)) {
      const target = nameToId.get(link.target.trim())
      if (target && target !== noteId) outgoing.add(target)
    }

    const noteIds = [...new Set([...incoming.keys(), ...outgoing])]
    const tally = (note: IndexedNote): { questionCount: number; understoodCount: number } => {
      let questionCount = 0
      let understoodCount = 0
      for (const rec of Object.values(note.fm.learning?.records ?? {})) {
        if (rec.status === 'question') questionCount++
        else understoodCount++
      }
      return { questionCount, understoodCount }
    }

    const notes: QuestionAggregate['notes'] = noteIds
      .map((id) => {
        const node = idx.notes.get(id)
        if (!node) return null
        const counts = tally(node)
        const isIn = incoming.has(id)
        const isOut = outgoing.has(id)
        return {
          id,
          title: node.fm.title,
          questionCount: counts.questionCount,
          understoodCount: counts.understoodCount,
          updatedAt: node.fm.updatedAt,
          link: (isIn && isOut ? 'both' : isOut ? 'out' : 'in') as 'in' | 'out' | 'both'
        }
      })
      .filter((n): n is NonNullable<typeof n> => n !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    // 文献汇总：枢纽 + 相关笔记的 sources，按文献去重、摘录数合计
    const docAgg = new Map<string, { id: string; title: string; anchorCount: number; mediaType?: string }>()
    const addDocument = (documentId: string, anchored: boolean): void => {
      const entry = this.entryById(documentId)
      if (!entry) return // 来源已失效：与 getNoteFull 的 missingSources 不同，这里静默跳过（聚合只呈现存活对象）
      const existing = docAgg.get(documentId)
      if (existing) {
        if (anchored) existing.anchorCount++
        return
      }
      const mediaType = this.primaryFile(entry)?.mediaType
      docAgg.set(documentId, {
        id: documentId,
        title: entry.meta.title,
        anchorCount: anchored ? 1 : 0,
        ...(mediaType ? { mediaType } : {})
      })
    }
    const collectSources = (note: IndexedNote): void => {
      for (const src of note.fm.sources) {
        if (src.kind === 'document') addDocument(src.id, false)
        else if (src.kind === 'anchor') {
          const found = this.findAnchor(src.id)
          if (found) addDocument(found.entry.meta.id, true)
        }
      }
    }
    collectSources(hubNode)
    for (const id of noteIds) {
      const node = idx.notes.get(id)
      if (node) collectSources(node)
    }

    // 知识块合计：枢纽 + 相关笔记的自评记录
    const blocks = { total: 0, understood: 0, question: 0 }
    const addBlocks = (note: IndexedNote): void => {
      for (const rec of Object.values(note.fm.learning?.records ?? {})) {
        blocks.total++
        if (rec.status === 'question') blocks.question++
        else blocks.understood++
      }
    }
    addBlocks(hubNode)
    for (const id of noteIds) {
      const node = idx.notes.get(id)
      if (node) addBlocks(node)
    }

    return {
      hub,
      notes,
      documents: [...docAgg.values()].sort((a, b) => b.anchorCount - a.anchorCount || a.title.localeCompare(b.title, 'zh')),
      blocks
    }
  }

  listNotes(query?: string, spaceId?: SpaceScope): NoteSummary[] {
    this.validateSpace(spaceId)
    if (query && query.trim()) {
      const ids = new Set(this.searchNotesAll(query.trim(), spaceId).notes.map((h) => h.id))
      return this.listNotes(undefined, spaceId).filter((n) => ids.has(n.id))
    }
    const out: NoteSummary[] = []
    for (const note of this.idx().notes.values()) {
      if (!this.scopeMatch(spaceId, note.fm.spaceId)) continue
      let anchorCount = 0
      let captureCount = 0
      let fromDoc = false
      for (const s of note.fm.sources) {
        if (s.kind === 'anchor') { anchorCount++; fromDoc = true }
        else if (s.kind === 'capture') captureCount++
        else if (s.kind === 'document') fromDoc = true
      }
      let questionCount = 0
      if (note.fm.learning) {
        for (const rec of Object.values(note.fm.learning.records)) if (rec.status === 'question') questionCount++
      }
      out.push({
        spaceId: note.fm.spaceId,
        id: note.fm.id,
        noteType: note.fm.noteType as NoteType,
        title: note.fm.title,
        updatedAt: note.fm.updatedAt,
        anchorCount,
        captureCount,
        questionCount,
        fromDoc
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async attachAnchor(noteId: string, anchorId: string): Promise<{ ok: boolean; already: boolean }> {
    return this.insertNoteSource(noteId, { kind: 'anchor', id: anchorId })
  }

  async attachCapture(noteId: string, captureId: string): Promise<{ ok: boolean; already: boolean }> {
    return this.insertNoteSource(noteId, { kind: 'capture', id: captureId })
  }

  private async insertNoteSource(noteId: string, source: NoteSourceRef): Promise<{ ok: boolean; already: boolean }> {
    const note = this.idx().notes.get(noteId)
    if (!note) throw new Error('笔记不存在')
    const dup = note.fm.sources.some((s) => s.kind === source.kind && s.id === source.id)
    if (dup) return { ok: true, already: true }
    if (source.kind === 'anchor') {
      const found = this.findAnchor(source.id)
      source = { kind: 'anchor', id: source.id, documentId: found?.entry.meta.id ?? null }
    }
    const nextFm: NoteFrontMatter = { ...note.fm, sources: [...note.fm.sources, source], updatedAt: now() }
    await this.writeNote(noteId, note.extra, nextFm, note.bodyMd, note.fileAbs)
    return { ok: true, already: false }
  }

  // ---------- 收件箱 ----------

  private async persistCaptureSidecar(fileAbs: string, rec: CaptureSidecar, extra: Record<string, unknown> = {}): Promise<void> {
    await atomicWriteJson(`${fileAbs}.json`, { ...extra, ...rec })
  }

  async importCaptures(paths: string[], context?: string, spaceId?: SpaceScope): Promise<CaptureImportResult[]> {
    this.validateSpace(spaceId)
    const results: CaptureImportResult[] = []
    for (const path of paths) {
      try {
        const mediaType = mediaTypeFor(path)
        if (!mediaType || !mediaType.startsWith('image/')) throw new Error('只支持导入图片')
        const stats = await stat(path)
        const sha = await sha256Of(path)
        const dup = this.idx().shaToCapture.get(sha)
        if (dup) {
          results.push({ ok: true, path, captureId: dup, duplicate: true })
          continue
        }
        const id = randomUUID()
        const ts = now()
        const capsDir = join(this.library.root, DIR_CAPTURES)
        let fileName = sanitizeFileName(basename(path))
        if (existsSync(join(capsDir, fileName))) {
          const ext = extname(fileName)
          fileName = `${stripExt(fileName)}-${sha.slice(0, 8)}${ext}`
        }
        const fileAbs = join(capsDir, fileName)
        const tmpCopy = join(capsDir, `.${randomUUID()}.tmp`)
        copyFileSync(path, tmpCopy)
        renameSync(tmpCopy, fileAbs)
        const rec: CaptureSidecar = {
          schema: 2,
          id,
          mediaType,
          byteSize: stats.size,
          sha256: sha,
          context: context ?? null,
          inboxStatus: 'inbox',
          spaceId: spaceId ?? null,
          createdAt: ts
        }
        await this.persistCaptureSidecar(fileAbs, rec)
        this.idx().captures.set(id, { rec, fileAbs, fileRel: join(DIR_CAPTURES, fileName), fileName, orphan: false, extra: {} })
        this.idx().shaToCapture.set(sha, id)
        this.library.notify(['captures'])
        results.push({ ok: true, path, captureId: id, duplicate: false })
      } catch (err) {
        results.push({ ok: false, path, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return results
  }

  listCaptures(spaceId?: SpaceScope, inboxStatus?: InboxStatus): Array<CaptureRecord & { originalName: string; mediaType: string }> {
    this.validateSpace(spaceId)
    const out: Array<CaptureRecord & { originalName: string; mediaType: string }> = []
    for (const cap of this.idx().captures.values()) {
      if (!this.scopeMatch(spaceId, cap.rec.spaceId)) continue
      if (inboxStatus && cap.rec.inboxStatus !== inboxStatus) continue
      out.push({
        spaceId: cap.rec.spaceId,
        id: cap.rec.id,
        assetId: cap.rec.sha256,
        context: cap.rec.context,
        inboxStatus: cap.rec.inboxStatus,
        createdAt: cap.rec.createdAt,
        originalName: cap.fileName,
        mediaType: cap.rec.mediaType
      })
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async saveCapture(id: string, patch: { context?: string; inboxStatus?: InboxStatus }): Promise<void> {
    const capture = this.idx().captures.get(id)
    if (!capture || capture.orphan) throw new Error('记录不存在')
    const nextRec = { ...capture.rec }
    if (patch.context !== undefined) nextRec.context = patch.context
    if (patch.inboxStatus !== undefined) nextRec.inboxStatus = patch.inboxStatus
    // 先写盘、成功后才提交内存：失败时列表里的备注/状态不会变成「重启就还原」的幻影
    await this.persistCaptureSidecar(capture.fileAbs, nextRec, capture.extra)
    capture.rec = nextRec
    this.library.notify(['captures'])
  }

  // ---------- 收件箱速记（纯文本捕获） ----------

  /** 速记文件名：<yyyyMMdd-HHmmss>-<id8>.md。createdAt 不可变 → 一 id 一文件、永不改名 */
  private memoFilePath(fm: MemoFrontMatter): string {
    const stamp = fm.createdAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    return join(this.library.root, DIR_CAPTURES, DIR_MEMOS, `${stamp}-${fm.id.slice(0, 8)}.md`)
  }

  /**
   * 速记落盘（唯一写入原语）：**先写盘、成功后才提交内存索引**——与笔记同一条铁律。
   * fileAbs 传索引已知路径（用户或同步盘改过名也写回原处）；新建传 null 走规范名。
   */
  private async writeMemo(fm: MemoFrontMatter, text: string, extra: Record<string, unknown>, fileAbs: string | null): Promise<IndexedMemo> {
    const target = fileAbs ?? this.memoFilePath(fm)
    await atomicWriteFile(target, serializeMemoMarkdown(fm, text, extra))
    const node: IndexedMemo = {
      fm,
      text,
      fileAbs: target,
      fileRel: join(DIR_CAPTURES, DIR_MEMOS, basename(target)),
      extra
    }
    this.idx().memos.set(fm.id, node)
    this.library.notify(['memos'])
    return node
  }

  private memoRecordOf(memo: IndexedMemo): MemoRecord {
    return {
      id: memo.fm.id,
      text: memo.text,
      inboxStatus: memo.fm.inboxStatus,
      spaceId: memo.fm.spaceId,
      todo: memo.fm.todo === true,
      createdAt: memo.fm.createdAt,
      updatedAt: memo.fm.updatedAt
    }
  }

  /** 新建速记：零仪式，只要正文。以 `!`（或全角 `！`）开头即成为待办，标记本身不落正文 */
  async createMemo(input: { text: string; spaceId?: SpaceScope }): Promise<MemoRecord> {
    const raw = typeof input.text === 'string' ? input.text.replace(/\r\n/g, '\n').trim() : ''
    const todo = /^[!！]\s*/.test(raw)
    const text = (todo ? raw.replace(/^[!！]\s*/, '') : raw).trim()
    if (!text) throw new Error('速记内容不能为空')
    if (text.length > 20000) throw new Error('速记过长（上限 2 万字），请改用笔记')
    this.validateSpace(input.spaceId)
    const id = randomUUID()
    const ts = now()
    const fm: MemoFrontMatter = {
      schema: 1,
      id,
      inboxStatus: 'inbox',
      spaceId: input.spaceId ?? null,
      todo: todo || undefined,
      createdAt: ts,
      updatedAt: ts
    }
    return this.memoRecordOf(await this.writeMemo(fm, text, {}, null))
  }

  listMemos(spaceId?: SpaceScope, inboxStatus?: InboxStatus): MemoRecord[] {
    this.validateSpace(spaceId)
    const out: MemoRecord[] = []
    for (const memo of this.idx().memos.values()) {
      if (!this.scopeMatch(spaceId, memo.fm.spaceId)) continue
      if (inboxStatus && memo.fm.inboxStatus !== inboxStatus) continue
      out.push(this.memoRecordOf(memo))
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getMemo(id: string): MemoRecord {
    const memo = this.idx().memos.get(id)
    if (!memo) throw new Error('速记不存在')
    return this.memoRecordOf(memo)
  }

  async saveMemo(id: string, patch: { text?: string; inboxStatus?: InboxStatus; spaceId?: SpaceScope; todo?: boolean }): Promise<void> {
    const memo = this.idx().memos.get(id)
    if (!memo) throw new Error('速记不存在')
    if (patch.spaceId !== undefined) this.validateSpace(patch.spaceId)
    const nextFm: MemoFrontMatter = { ...memo.fm }
    let nextText = memo.text
    if (patch.text !== undefined) {
      const text = patch.text.replace(/\r\n/g, '\n').trim()
      if (!text) throw new Error('速记内容不能为空')
      if (text.length > 20000) throw new Error('速记过长（上限 2 万字），请改用笔记')
      nextText = text
    }
    if (patch.inboxStatus !== undefined) nextFm.inboxStatus = patch.inboxStatus
    if (patch.spaceId !== undefined) nextFm.spaceId = patch.spaceId
    if (patch.todo !== undefined) nextFm.todo = patch.todo ? true : undefined
    nextFm.updatedAt = now()
    await this.writeMemo(nextFm, nextText, memo.extra, memo.fileAbs)
  }

  /**
   * 删除速记：文件先交给调用方处置（系统废纸篓，可恢复），成功后才从索引移除——处置失败则速记仍在。
   * trash 由调用方注入（ipc 层用 shell.trashItem）——存储层不依赖 electron，单测可传等价实现；
   * 返回「是否真的进了废纸篓」，无桌面环境时调用方会退回直接删除，界面据此如实提示。
   */
  async deleteMemo(id: string, trash: (fileAbs: string) => Promise<boolean>): Promise<{ trashed: boolean }> {
    const memo = this.idx().memos.get(id)
    if (!memo) throw new Error('速记不存在')
    const trashed = await trash(memo.fileAbs)
    this.idx().memos.delete(id)
    this.library.notify(['memos'])
    return { trashed }
  }

  /** 速记转笔记：正文原样成为笔记正文，标题取首行（可指定）；速记随后标记已归档，保留出处 */
  async memoToNote(id: string, input?: { title?: string; spaceId?: SpaceScope }): Promise<NoteRecord> {
    const memo = this.idx().memos.get(id)
    if (!memo) throw new Error('速记不存在')
    const firstLine = memo.text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
    const title = (input?.title?.trim() || firstLine || '速记').slice(0, 200)
    const note = await this.createNote({
      title,
      bodyMd: memo.text,
      spaceId: input?.spaceId !== undefined ? input.spaceId : memo.fm.spaceId
    })
    await this.saveMemo(id, { inboxStatus: 'filed' })
    return note
  }

  // ---------- 搜索（v2：内存扫描式子串检索，替代 FTS5） ----------

  search(q: string, spaceId?: SpaceScope): SearchResponse {
    this.validateSpace(spaceId)
    const t0 = performance.now()
    const trimmed = q.trim()
    if (!trimmed) return { notes: [], anchors: [], memos: [], notesTotal: 0, anchorsTotal: 0, memosTotal: 0, tookMs: 0, mode: 'fts' }
    const notes = this.searchNotesAll(trimmed, spaceId)
    const anchors = this.searchAnchorsAll(trimmed, spaceId)
    const memos = this.searchMemosAll(trimmed, spaceId)
    return {
      notes: notes.notes,
      anchors: anchors.anchors,
      memos: memos.memos,
      notesTotal: notes.total,
      anchorsTotal: anchors.total,
      memosTotal: memos.total,
      tookMs: Math.round((performance.now() - t0) * 100) / 100,
      mode: trimmed.length >= 3 ? 'fts' : 'like'
    }
  }

  private searchNotesAll(q: string, spaceId?: SpaceScope): { notes: SearchResponse['notes']; total: number } {
    const terms = parseSearchTerms(q)
    if (!terms.length) return { notes: [], total: 0 }
    const raw = q.trim().toLowerCase()
    interface Matched {
      note: IndexedNote
      tier: number
      blockHits: SearchNoteBlockHit[]
    }
    const matched: Matched[] = []
    for (const note of this.idx().notes.values()) {
      if (!this.scopeMatch(spaceId, note.fm.spaceId)) continue
      const titleLower = note.fm.title.toLowerCase()
      const aliasTextLower = note.fm.aliases.join('，').toLowerCase()
      // 多词 AND（空白分隔；引号短语按原文连续匹配）——词可分布在标题/别名/不同块，不要求同块。
      // 块命中 = 该块含**任一**查询词（用于「命中跨块时展示多个位置」，不伪造包含全部词的单一摘要）
      const blocks = splitNoteBlocks(note.bodyMd)
      const blockHits: SearchNoteBlockHit[] = []
      blocks.forEach((b, blockIndex) => {
        const blockText = (b.heading ? `${b.heading}\n` : '') + b.text
        const blockLower = blockText.toLowerCase()
        if (!terms.some((t) => blockLower.includes(t.text.toLowerCase()))) return
        const hit = firstTermHit([{ field: '块', text: blockText }], terms)
        blockHits.push({
          heading: b.heading,
          blockIndex,
          snippet: hit ? contextSnippet(hit.text, hit.index, hit.term.length, 36) : ''
        })
      })
      // 整体匹配：标题 + 别名 + 各块拼接（与既有多词 AND 语义一致）
      const haystack = [note.fm.title, ...note.fm.aliases, ...blocks.map((b) => b.text)].join('\n').toLowerCase()
      if (!matchAllTerms(haystack, terms)) continue
      // 排序分层（2026-10-09）：标题精确 > 全部词在标题 > 标题/别名部分命中 > 仅正文
      const tier =
        raw && titleLower === raw ? 0
        : terms.every((t) => titleLower.includes(t.text.toLowerCase())) ? 1
        : terms.some((t) => titleLower.includes(t.text.toLowerCase()) || aliasTextLower.includes(t.text.toLowerCase())) ? 2
        : 3
      matched.push({ note, tier, blockHits })
    }
    matched.sort((a, b) =>
      a.tier - b.tier ||
      b.note.fm.updatedAt.localeCompare(a.note.fm.updatedAt) ||
      a.note.fm.id.localeCompare(b.note.fm.id)
    )
    const out: SearchResponse['notes'] = matched.slice(0, NOTE_SEARCH_LIMIT).map(({ note, blockHits }) => {
      const hit = firstTermHit(
        [
          { field: '标题', text: note.fm.title },
          { field: '别名', text: note.fm.aliases.join('，') },
          { field: '正文', text: note.bodyMd }
        ],
        terms
      )
      return {
        id: note.fm.id,
        title: note.fm.title,
        noteType: note.fm.noteType as NoteType,
        snippet: hit ? contextSnippet(hit.text, hit.index, hit.term.length) : '',
        updatedAt: note.fm.updatedAt,
        blockHits: blockHits.slice(0, 3),
        blockHitCount: blockHits.length,
        fromDoc: note.fm.sources.some((s) => s.kind === 'anchor' || s.kind === 'document')
      }
    })
    return { notes: out, total: matched.length }
  }

  private searchAnchorsAll(q: string, spaceId?: SpaceScope): { anchors: SearchResponse['anchors']; total: number } {
    const terms = parseSearchTerms(q)
    if (!terms.length) return { anchors: [], total: 0 }
    const out: SearchResponse['anchors'] = []
    let total = 0
    for (const entry of this.idx().entries.values()) {
      if (!this.scopeMatch(spaceId, entry.meta.spaceId)) continue
      for (const a of entry.anchors) {
        if (!a.quote) continue
        if (!matchAllTerms(a.quote.toLowerCase(), terms)) continue
        total++
        if (out.length >= ANCHOR_SEARCH_LIMIT) continue
        out.push({
          anchorId: a.id,
          documentId: entry.meta.id,
          documentTitle: entry.meta.title,
          pageIndex: a.pageIndex,
          quote: a.quote
        })
      }
    }
    return { anchors: out, total }
  }

  private searchMemosAll(q: string, spaceId?: SpaceScope): { memos: SearchResponse['memos']; total: number } {
    const terms = parseSearchTerms(q)
    if (!terms.length) return { memos: [], total: 0 }
    const out: SearchResponse['memos'] = []
    let total = 0
    const sorted = [...this.idx().memos.values()].sort((a, b) => b.fm.createdAt.localeCompare(a.fm.createdAt))
    for (const memo of sorted) {
      if (!this.scopeMatch(spaceId, memo.fm.spaceId)) continue
      if (!matchAllTerms(memo.text.toLowerCase(), terms)) continue
      total++
      if (out.length >= MEMO_SEARCH_LIMIT) continue
      const hit = firstTermHit([{ field: '正文', text: memo.text }], terms)
      out.push({
        id: memo.fm.id,
        snippet: hit ? contextSnippet(hit.text, hit.index, hit.term.length) : memo.text.slice(0, 80),
        todo: memo.fm.todo === true,
        createdAt: memo.fm.createdAt
      })
    }
    return { memos: out, total }
  }

  // ---------- 批注墨迹 ----------

  /**
   * 整页笔画替换式保存：ink/<sha8>/p<page>.json。传入的笔画先净化
   * （形状/颜色/线宽/点数上限），防止异常数据膨胀或破坏渲染。
   */
  async saveInk(versionId: string, pageIndex: number, strokes: unknown): Promise<void> {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 100000) throw new Error('页码无效')
    const entry = this.entryBySha(versionId)
    if (!entry) throw new Error('文档版本不存在')
    const clean = sanitizeStrokes(strokes)
    const path = this.inkPath(entry, versionId, pageIndex)
    await atomicWriteJson(path, { versionId, pageIndex, strokes: clean, updatedAt: now() })
    this.activities.record({
      kind: 'ink-saved',
      documentId: entry.meta.id,
      title: entry.meta.title,
      spaceId: entry.meta.spaceId,
      pageIndex,
      strokes: clean.length
    })
  }

  inkGet(versionId: string, pageIndex: number): InkStroke[] {
    const entry = this.entryBySha(versionId)
    if (!entry) return []
    // 墨迹是「整页替换式」保存：解析失败必须先把坏文件备份为 .broken，
    // 否则界面看起来是空页，用户下一笔就把整页旧批注覆盖掉
    const raw = readJsonSafeSync<{ strokes?: unknown } | null>(
      this.inkPath(entry, versionId, pageIndex),
      null,
      (message) => logWarn('repo', message)
    )
    return raw ? sanitizeStrokes(raw.strokes) : []
  }

  private inkPath(entry: IndexedEntry, versionId: string, pageIndex: number): string {
    return join(entry.dirAbs, 'ink', versionId.slice(0, 8), `p${pageIndex}.json`)
  }

  // ---------- 阅读位置 ----------

  readingWorkspaceGet(documentId: string): ReadingWorkspace {
    const entry = this.entryById(documentId)
    if (!entry) throw new Error('材料不存在')
    // 精读卡同样是整份替换式保存：坏文件先备份为 .broken，避免下一次保存把内容覆盖掉
    const raw = readJsonSafeSync<ReadingWorkspace | null>(join(entry.dirAbs, FILE_WORKSPACE), null, (message) =>
      logWarn('repo', message)
    )
    if (!raw) return emptyReadingWorkspace(documentId)
    return { ...raw, documentId, updatedAt: raw.updatedAt ?? null }
  }

  async readingWorkspaceSave(input: ReadingWorkspace): Promise<void> {
    const string = (value: unknown, max: number, label: string): string => {
      if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式或长度无效`)
      return value
    }
    const ids = (value: unknown, max: number, label: string): string[] => {
      if (!Array.isArray(value) || value.length > max) throw new Error(`${label}格式或数量无效`)
      return [...new Set(value.map((id) => {
        const result = string(id, 100, label)
        if (!result) throw new Error(`${label}不能为空`)
        return result
      }))]
    }
    if (!input || typeof input !== 'object') throw new Error('阅读现场格式无效')
    const documentId = string(input.documentId, 100, '材料 ID')
    const entry = this.entryById(documentId)
    if (!entry) throw new Error('材料不存在')
    if (!['reading', 'paused', 'reviewing', 'complete'].includes(input.phase)) throw new Error('阅读阶段无效')
    if (!['notes', 'card'].includes(input.activeTab)) throw new Error('阅读面板无效')
    if (!['page', 'all'].includes(input.notesScope)) throw new Error('笔记范围无效')
    if (input.updatedAt !== null) string(input.updatedAt, 40, '更新时间')
    const coreQuestion = string(input.coreQuestion, 10000, '核心问题')
    const quickDraft = string(input.quickDraft, 100000, '随手记草稿')
    const resolvedNoteIds = ids(input.resolvedNoteIds, 10000, '已解决疑问')
    const materialNotes = this.listNotesForDocument(documentId)
    const notesById = new Map(materialNotes.map((note) => [note.id, note]))
    if (resolvedNoteIds.some((id) => notesById.get(id)?.noteType !== 'problem')) {
      throw new Error('已解决疑问必须是本材料的问题笔记')
    }
    const expandedNoteId = input.expandedNoteId === null ? null : string(input.expandedNoteId, 100, '展开笔记')
    if (expandedNoteId !== null && !notesById.has(expandedNoteId)) throw new Error('展开笔记不属于本材料')
    const sectionIds = ['question', 'method', 'findings', 'evidence', 'relevance'] as const
    if (!Array.isArray(input.sections) || input.sections.length !== sectionIds.length ||
        new Set(input.sections.map((section) => section?.id)).size !== sectionIds.length) {
      throw new Error('精读卡栏目无效')
    }
    const sections = input.sections.map((section) => {
      if (!section || !sectionIds.includes(section.id) || typeof section.checked !== 'boolean') {
        throw new Error('精读卡栏目格式无效')
      }
      const title = section.title === undefined ? undefined : string(section.title, 120, '精读卡栏目名称')
      const body = string(section.body, 100000, '精读卡内容')
      const anchorIds = ids(section.anchorIds, 500, '来源锚点')
      for (const anchorId of anchorIds) {
        const anchor = entry.anchors.find((a) => a.id === anchorId)
        const file = anchor ? entry.meta.files.find((f) => f.sha256 === anchor.fileSha) : undefined
        if (!anchor || !file || file.mediaType !== 'application/pdf' || !Number.isInteger(anchor.pageIndex) || anchor.pageIndex < 0 ||
            (file.pageCount !== null && anchor.pageIndex >= file.pageCount)) {
          throw new Error('来源锚点必须可定位到本材料的 PDF 原文')
        }
        const rects = anchor.rects
        if (!Array.isArray(rects) || rects.some((rect) => !Array.isArray(rect) || rect.length !== 4 ||
            !rect.every((n) => typeof n === 'number' && Number.isFinite(n)) || rect[0] >= rect[2] || rect[1] >= rect[3])) {
          throw new Error('来源锚点坐标无效')
        }
      }
      if (section.checked && (!body.trim() || !anchorIds.length)) throw new Error('已核对内容必须有正文和可回源的锚点')
      return { id: section.id, ...(title === undefined ? {} : { title }), body, anchorIds, checked: section.checked }
    })
    const updatedAt = now()
    const clean: ReadingWorkspace = {
      documentId, coreQuestion, phase: input.phase, activeTab: input.activeTab, notesScope: input.notesScope,
      expandedNoteId, quickDraft, resolvedNoteIds, sections, updatedAt
    }
    await atomicWriteJson(join(entry.dirAbs, FILE_WORKSPACE), clean)
  }

  readingLastDocument(): string | null {
    let best: { id: string; at: string } | null = null
    for (const entry of this.idx().entries.values()) {
      const at = entry.meta.readingState?.lastReadAt
      if (!at) continue
      if (!best || at > best.at) best = { id: entry.meta.id, at }
    }
    return best?.id ?? null
  }

  async saveReadingState(input: { documentId: string; pageIndex: number; scale: number; rotation: number }): Promise<void> {
    const entry = this.entryById(input.documentId)
    if (!entry) throw new Error('文档不存在')
    const prev = entry.meta.readingState
    // 位置没变就不写盘：连续滚动/往返缩放会高频触发保存，每次写 entry.json 都会引发全库重扫
    if (prev && prev.pageIndex === input.pageIndex && prev.scale === input.scale && prev.rotation === input.rotation) return
    const nextMeta: EntryMeta = {
      ...entry.meta,
      readingState: {
        pageIndex: input.pageIndex,
        scale: input.scale,
        rotation: input.rotation,
        lastReadAt: now()
      }
    }
    // 阅读位置不是元数据编辑：不动 updatedAt、不广播（避免「最近更新」与排序被翻页刷走）
    await this.commitEntryMeta(entry, nextMeta, { touch: false })
  }

  // ---------- arXiv 每日论文（papers.json） ----------

  /** 论文库落盘（**先写盘、成功后才提交内存**）：papers.json 是「每日论文」页的唯一真相 */
  private async writePapersDoc(next: PapersDoc): Promise<void> {
    await atomicWriteJson(join(this.library.root, 'papers.json'), next)
    this.idx().papers = next
    this.library.notify(['papers'])
  }

  paperFeedList(): PaperFeed[] {
    return this.idx().papers.feeds.map((f) => ({ ...f }))
  }

  async paperFeedCreate(input: { name: string; categories: string; keywords: string; maxResults?: number }): Promise<PaperFeed> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new Error('请输入订阅名称')
    if (name.length > 80) throw new Error('订阅名称过长')
    const categories = normalizeCategoryList(input.categories)
    const keywords = typeof input.keywords === 'string' ? input.keywords.trim() : ''
    const maxResults = clampInt(input.maxResults, 1, 200, 50)
    if (!categories && !keywords) throw new Error('请至少填写一个分类或关键词')
    const feed: PaperFeed = { id: randomUUID(), name, categories, keywords, maxResults, createdAt: now() }
    // 先写盘、成功后才提交内存：写失败不能让用户看到「已创建的订阅」
    await this.writePapersDoc({ ...this.idx().papers, feeds: [...this.idx().papers.feeds, feed] })
    return { ...feed }
  }

  async paperFeedUpdate(id: string, patch: { name?: string; categories?: string; keywords?: string; maxResults?: number }): Promise<void> {
    const cur = this.idx().papers.feeds.find((f) => f.id === id)
    if (!cur) throw new Error('订阅不存在')
    const name = patch.name === undefined ? cur.name : String(patch.name).trim()
    if (!name) throw new Error('请输入订阅名称')
    const categories = patch.categories === undefined ? cur.categories : normalizeCategoryList(patch.categories)
    const keywords = patch.keywords === undefined ? cur.keywords : String(patch.keywords).trim()
    const maxResults = patch.maxResults === undefined ? cur.maxResults : clampInt(patch.maxResults, 1, 200, 50)
    if (!categories && !keywords) throw new Error('请至少填写一个分类或关键词')
    const updated: PaperFeed = { ...cur, name, categories, keywords, maxResults }
    await this.writePapersDoc({ ...this.idx().papers, feeds: this.idx().papers.feeds.map((f) => (f.id === id ? updated : f)) })
  }

  async paperFeedDelete(id: string): Promise<void> {
    // 只属于该订阅且未处理的候选一并清理（已导入/已忽略的候选保留——它们是用户决策或文库关联）
    const nextFeeds = this.idx().papers.feeds.filter((f) => f.id !== id)
    const feedNameById = new Map(nextFeeds.map((f) => [f.id, f.name]))
    const nextItems = this.idx().papers.items
      .filter((item) => {
        if (item.status !== 'new' || item.documentId !== null) return true
        const remaining = (item.feedIds ?? []).filter((fid) => fid !== id && feedNameById.has(fid))
        return remaining.length > 0
      })
      .map((item) => {
        const feedIds = (item.feedIds ?? []).filter((fid) => feedNameById.has(fid))
        // feedNames 与 feedIds 同序对应；删除订阅后按 feedIds 重算
        const feedNames = (item.feedNames ?? []).length === feedIds.length
          ? item.feedNames
          : feedIds.map((fid) => feedNameById.get(fid) ?? '').filter(Boolean)
        return feedIds.length === (item.feedIds ?? []).length && feedNames === item.feedNames ? item : { ...item, feedIds, feedNames }
      })
    await this.writePapersDoc({ ...this.idx().papers, feeds: nextFeeds, items: nextItems })
  }

  private feedNameOf(feedId: string): string {
    return this.idx().papers.feeds.find((f) => f.id === feedId)?.name ?? ''
  }

  /** 抓取/清单结果入库：按基础 ID（不带 vN）聚合，一个候选多个来源（订阅/邮件清单）。返回新条目数。 */
  async paperItemsUpsert(feedId: string, entries: ArxivEntry[]): Promise<number> {
    const ts = now()
    const nextItems = [...this.idx().papers.items]
    let created = 0
    for (const e of entries) {
      const { base, version } = splitArxivId(e.arxivId)
      const index = nextItems.findIndex((p) => p.baseId === base)
      if (index === -1) {
        nextItems.push({
          id: randomUUID(),
          baseId: base,
          version,
          arxivId: e.arxivId,
          title: e.title,
          authors: e.authors,
          abstract: e.abstract,
          primaryCategory: e.primaryCategory,
          publishedAt: e.publishedAt || ts,
          pdfUrl: e.pdfUrl,
          absUrl: e.absUrl,
          status: 'new',
          documentId: null,
          fetchedAt: ts,
          feedNames: [this.feedNameOf(feedId)].filter(Boolean),
          feedIds: [feedId]
        })
        created++
        continue
      }
      // 已有候选：补记来源；仅未处理的候选允许跟随新版本（已导入版本不可被后台替换）
      const exists = nextItems[index]
      const feedIds = exists.feedIds ?? []
      const feedNames = exists.feedNames ?? []
      let next = exists
      if (!feedIds.includes(feedId)) {
        next = { ...next, feedIds: [...feedIds, feedId], feedNames: [...feedNames, this.feedNameOf(feedId)].filter(Boolean) }
      }
      if (exists.status === 'new' && version && version !== exists.version) {
        next = { ...next, version, arxivId: e.arxivId, pdfUrl: e.pdfUrl, fetchedAt: ts }
      }
      if (next !== exists) nextItems[index] = next
    }
    await this.writePapersDoc({ ...this.idx().papers, items: nextItems })
    return created
  }

  /** 按基础 ID 取候选（deep link 定位用） */
  paperGetByBaseId(baseId: string): PaperItem | null {
    const item = this.idx().papers.items.find((p) => p.baseId === baseId)
    return item ? { ...item, feedNames: [...(item.feedNames ?? [])] } : null
  }

  paperList(status: PaperStatus | 'all', days = 7): PaperItem[] {
    const cutoff = new Date(Date.now() - Math.max(1, Math.min(90, days)) * 86400_000).toISOString()
    return this.idx().papers.items
      .filter((p) => (p.publishedAt >= cutoff || p.status !== 'new') && (status === 'all' || p.status === status))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 500)
      .map((p) => ({ ...p, feedNames: [...(p.feedNames ?? [])] }))
  }

  paperGetByArxivId(arxivId: string): PaperItem | null {
    return this.paperGetByBaseId(splitArxivId(arxivId).base)
  }

  async paperMarkImported(arxivId: string, documentId: string): Promise<void> {
    const base = splitArxivId(arxivId).base
    const item = this.idx().papers.items.find((p) => p.baseId === base)
    if (!item) throw new Error('论文条目不存在')
    const nextItems = this.idx().papers.items.map((p) => (p.baseId === base ? { ...p, status: 'imported' as PaperStatus, documentId } : p))
    // 条目补全 arXiv 身份（文献库展示/检索用）；已有时不覆盖
    const entry = this.entryById(documentId)
    if (entry && !entry.meta.arxivId) {
      await this.commitEntryMeta(entry, { ...entry.meta, arxivId: base })
    }
    await this.writePapersDoc({ ...this.idx().papers, items: nextItems })
  }

  async paperSetStatus(arxivId: string, status: PaperStatus): Promise<void> {
    if (!['new', 'imported', 'skipped'].includes(status)) throw new Error('状态无效')
    if (status === 'imported') throw new Error('导入状态请通过导入操作设置')
    const base = splitArxivId(arxivId).base
    if (!this.idx().papers.items.some((p) => p.baseId === base)) throw new Error('论文条目不存在')
    await this.writePapersDoc({
      ...this.idx().papers,
      items: this.idx().papers.items.map((p) => (p.baseId === base ? { ...p, status } : p))
    })
  }

  paperDailyFileSeen(fileName: string, digest: string): boolean {
    return this.idx().papers.dailyFiles.some((f) => f.fileName === fileName && f.digest === digest)
  }

  async paperMarkDailyFile(fileName: string, digest: string): Promise<void> {
    if (this.paperDailyFileSeen(fileName, digest)) return
    await this.writePapersDoc({
      ...this.idx().papers,
      dailyFiles: [...this.idx().papers.dailyFiles, { fileName, digest, importedAt: now() }]
    })
  }

  paperFeedCounts(): Array<{ feedId: string; newCount: number }> {
    const counts = new Map<string, number>()
    for (const item of this.idx().papers.items) {
      if (item.status !== 'new') continue
      for (const fid of item.feedIds ?? []) {
        counts.set(fid, (counts.get(fid) ?? 0) + 1)
      }
    }
    return [...counts.entries()].map(([feedId, newCount]) => ({ feedId, newCount }))
  }

  // ---------- 文献库（v2 新增：分区移动 / 待整理 / 冲突） ----------

  /** 移动条目到目标分区（物理移动文件夹；身份不变，锚点/笔记来源不断链） */
  async moveEntryToSection(entryId: string, section: string): Promise<void> {
    const entry = this.entryById(entryId)
    if (!entry) throw new Error('条目不存在')
    const cleanSection = sanitizeName(section, 60)
    if (cleanSection === entry.section) return
    const parent = this.sectionDir(cleanSection)
    const target = join(parent, entry.dirAbs.split(/[\\/]/).pop() ?? '未命名')
    mkdirSync(parent, { recursive: true })
    if (existsSync(target)) throw new Error('目标分区已有同名条目文件夹')
    renameSync(entry.dirAbs, target)
    entry.section = cleanSection
    entry.dirAbs = target
    entry.dirRel = join(DIR_ENTRIES, cleanSection, target.split(/[\\/]/).pop() ?? '')
    // 移动的原子单元是目录改名（不可回滚）：先让内存与磁盘位置一致，再补写元数据；
    // 元数据写失败只影响 updatedAt（下次扫描以磁盘为准），位置本身已经正确
    await this.commitEntryMeta(entry, { ...entry.meta })
  }

  /** 标记/取消待整理状态 */
  async setEntryNeedsReview(entryId: string, needsReview: boolean): Promise<void> {
    const entry = this.entryById(entryId)
    if (!entry) throw new Error('条目不存在')
    await this.commitEntryMeta(entry, { ...entry.meta, status: needsReview ? 'needs-review' : 'ok' })
  }

  /** 文献条目元数据编辑（文献库详情弹窗；title/docType 走 updateDocument，这里补全其余字段） */
  async updateEntryMeta(id: string, patch: Partial<Pick<EntryMeta, 'authors' | 'year' | 'venue' | 'doi' | 'arxivId' | 'abstract' | 'tags' | 'note' | 'status' | 'starred'>>): Promise<void> {
    const entry = this.entryById(id)
    if (!entry) throw new Error('条目不存在')
    const nextMeta: EntryMeta = {
      ...entry.meta,
      ...(patch.authors !== undefined ? { authors: patch.authors.filter((a) => typeof a === 'string') } : {}),
      ...(patch.year !== undefined ? { year: typeof patch.year === 'number' && Number.isFinite(patch.year) ? Math.round(patch.year) : null } : {}),
      ...(patch.venue !== undefined ? { venue: patch.venue } : {}),
      ...(patch.doi !== undefined ? { doi: patch.doi } : {}),
      ...(patch.arxivId !== undefined ? { arxivId: patch.arxivId } : {}),
      ...(patch.abstract !== undefined ? { abstract: patch.abstract } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags.filter((t) => typeof t === 'string') } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.starred !== undefined ? { starred: patch.starred || undefined } : {})
    }
    // 先写盘（失败：内存与磁盘都不变），再同步目录名
    await this.commitEntryMeta(entry, nextMeta)
    await this.syncEntryDirName(entry)
  }

  /**
   * 文献库一站式更新（详情弹窗用）：标题/类型走文档更新（含文件夹改名），
   * 其余字段走元数据补全，学习区走归属；分区移动单独调 moveEntryToSection。
   */
  async libraryEntryUpdate(id: string, patch: {
    title?: string
    docType?: DocType
    authors?: string[]
    year?: number | null
    venue?: string | null
    doi?: string | null
    arxivId?: string | null
    abstract?: string | null
    tags?: string[]
    note?: string | null
    spaceId?: string | null
    status?: EntryMeta['status']
    starred?: boolean
  }): Promise<void> {
    if (patch.title !== undefined || patch.docType !== undefined) {
      await this.updateDocument(id, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.docType !== undefined ? { docType: patch.docType } : {})
      })
    }
    const metaPatch: Parameters<Repo['updateEntryMeta']>[1] = {}
    if (patch.authors !== undefined) metaPatch.authors = patch.authors
    if (patch.year !== undefined) metaPatch.year = patch.year
    if (patch.venue !== undefined) metaPatch.venue = patch.venue
    if (patch.doi !== undefined) metaPatch.doi = patch.doi
    if (patch.arxivId !== undefined) metaPatch.arxivId = patch.arxivId
    if (patch.abstract !== undefined) metaPatch.abstract = patch.abstract
    if (patch.tags !== undefined) metaPatch.tags = patch.tags
    if (patch.note !== undefined) metaPatch.note = patch.note
    if (patch.status !== undefined) metaPatch.status = patch.status
    if (patch.starred !== undefined) metaPatch.starred = patch.starred
    if (Object.keys(metaPatch).length) await this.updateEntryMeta(id, metaPatch)
    if (patch.spaceId !== undefined) await this.assignSpace('document', id, patch.spaceId)
  }

  /** 按 id 取条目（识别队列等内部消费者用）。**不要走 librarySearch**：它有条数上限
   *（LIBRARY_HITS_LIMIT），库超过上限时目标条目可能不在返回集里，队列会静默漏处理。 */
  libraryEntryById(id: string): { entry: EntryMeta; section: string } | null {
    const hit = this.entryById(id)
    return hit ? { entry: { ...hit.meta }, section: hit.section } : null
  }

  /** 待补全条目 id 列表（同样绕开检索上限，用于把遗留条目排进识别队列） */
  libraryNeedsReviewIds(): string[] {
    return [...this.idx().entries.values()]
      .filter((entry) => entry.meta.status === 'needs-review')
      .map((entry) => entry.meta.id)
  }

  /** 分区清单：目录列举（空分区也可见）+ 条目计数聚合 + 颜色标签；待整理置顶，其余按名称排序 */
  librarySections(): LibrarySection[] {
    const entriesDir = join(this.library.root, DIR_ENTRIES)
    const names = new Set<string>([SECTION_INBOX])
    try {
      for (const item of readdirSync(entriesDir, { withFileTypes: true })) {
        if (item.isDirectory() && !item.name.startsWith('.') && !isTempName(item.name)) names.add(item.name)
      }
    } catch {
      /* 文献库目录尚不存在时只返回待整理 */
    }
    const bySection = new Map<string, LibrarySection>()
    for (const n of names) bySection.set(n, { name: n, count: 0, needsReview: 0, color: null })
    for (const entry of this.idx().entries.values()) {
      const s = bySection.get(entry.section)
      if (!s) continue
      s.count++
      if (entry.meta.status === 'needs-review') s.needsReview++
    }
    const colors = this.sectionColors.all()
    for (const s of bySection.values()) s.color = colors[s.name] ?? null
    return [...bySection.values()].sort((a, b) =>
      a.name === SECTION_INBOX ? -1 : b.name === SECTION_INBOX ? 1 : a.name.localeCompare(b.name, 'zh')
    )
  }

  /** 设置/清除分区颜色标签（颜色只是显示属性，不触碰目录） */
  sectionColorSet(name: string, color: SectionColor | null): void {
    const clean = sanitizeName(name, 60)
    if (!clean) throw new Error('分区不存在')
    const exists = this.librarySections().some((s) => s.name === clean)
    if (!exists) throw new Error(`分区「${clean}」不存在`)
    this.sectionColors.set(clean, color)
    this.library.notify(['entries'])
  }

  /** 新建分区（即建目录）；重名报错 */
  sectionCreate(name: string): void {
    const clean = sanitizeName(name, 60)
    if (!clean) throw new Error('请输入分区名称')
    const dir = this.sectionDir(clean)
    if (existsSync(dir)) throw new Error(`分区「${clean}」已存在`)
    mkdirSync(dir, { recursive: true })
    this.library.notify(['entries'])
  }

  /** 重命名分区：直接改名目录（条目随目录走，不断链）；待整理不可改名。重扫后内存索引同步 */
  async sectionRename(oldName: string, newName: string): Promise<void> {
    const from = sanitizeName(oldName, 60)
    const to = sanitizeName(newName, 60)
    if (!to) throw new Error('请输入分区名称')
    if (from === SECTION_INBOX) throw new Error('「待整理」分区不能重命名')
    if (from === to) return
    const fromDir = this.sectionDir(from)
    const toDir = this.sectionDir(to)
    if (!existsSync(fromDir)) throw new Error('分区不存在')
    if (existsSync(toDir)) throw new Error(`分区「${to}」已存在`)
    renameSync(fromDir, toDir)
    this.sectionColors.rename(from, to)
    await this.library.rescanNow()
  }

  /** 删除分区：条目全部移回「待整理」后移除空目录（待整理不可删除；同名冲突时明确报错） */
  async sectionDelete(name: string): Promise<void> {
    const from = sanitizeName(name, 60)
    if (from === SECTION_INBOX) throw new Error('「待整理」分区不能删除')
    const fromDir = this.sectionDir(from)
    if (!existsSync(fromDir)) throw new Error('分区不存在')
    for (const entry of [...this.idx().entries.values()]) {
      if (entry.section === from) await this.moveEntryToSection(entry.meta.id, SECTION_INBOX)
    }
    const rest = existsSync(fromDir) ? readdirSync(fromDir) : []
    if (rest.length > 0) throw new Error('分区里仍有未能移动的条目（目标存在同名条目文件夹），请先手动处理')
    rmSync(fromDir, { recursive: true })
    this.sectionColors.drop(from)
    this.library.notify(['entries'])
  }

  libraryConflicts() {
    return this.idx().conflicts.map((c) => ({ ...c }))
  }

  /** 库诊断（只读）：坏文件、散装文件与全文索引覆盖情况，供文献库横幅提示；不自动修复任何用户文件 */
  libraryDiagnostics(): LibraryDiagnostics {
    const entries = [...this.idx().entries.values()]
    const pdfs = entries.filter((e) => (e.meta.files[e.meta.files.length - 1]?.mediaType ?? '') === 'application/pdf')
    return {
      malformed: [...this.idx().malformed],
      unfiled: this.idx().unfiled.map((u) => ({ ...u })),
      // 全文索引覆盖（来自索引标记，零额外 IO）：ready 与 empty（扫描版）都算「已建立」
      fulltext: { pdfTotal: pdfs.length, indexed: pdfs.filter((e) => e.hasFulltext).length }
    }
  }

  /** 按稳定 id 直取条目（绕开检索返回上限；条目信息弹窗用，避免大库误报「不存在」） */
  libraryEntryGet(id: string): LibrarySearchHit | null {
    const entry = this.entryById(id)
    return entry ? this.toHit(entry, null) : null
  }

  // ---------- 全文索引（WP-4：独立于识别队列；覆盖所有导入路径） ----------

  /**
   * 导入监听：新条目落库后回调（全文索引器据此入队）。
   * **所有导入路径都经 importDocuments**（对话框 / arXiv 每日论文 / Zotero / 浏览器扩展 / 散装导入），
   * 因此这一处挂钩即可覆盖全部来源——修复前只有「识别队列处理过的 needs-review 条目」才有全文。
   */
  onDocumentsImported(cb: (documentId: string) => void): void {
    this.importListener = cb
  }

  /** 全文索引目标（最新文件）；没有文件返回 null */
  libraryFulltextTarget(entryId: string): FulltextTarget | null {
    const entry = this.entryById(entryId)
    if (!entry) return null
    const file = this.primaryFile(entry)
    if (!file) return null
    return {
      entryId: entry.meta.id,
      entryDirAbs: entry.dirAbs,
      absPath: join(entry.dirAbs, file.name),
      fileSha: file.sha256,
      mediaType: file.mediaType,
      pageCount: file.pageCount
    }
  }

  /** 全部可建立全文索引的条目（PDF/HTML），供启动过期检查与手动重建 */
  libraryFulltextTargets(): FulltextTarget[] {
    const out: FulltextTarget[] = []
    for (const entry of this.idx().entries.values()) {
      const file = this.primaryFile(entry)
      if (!file) continue
      if (file.mediaType !== 'application/pdf' && file.mediaType !== 'text/html') continue
      out.push({
        entryId: entry.meta.id,
        entryDirAbs: entry.dirAbs,
        absPath: join(entry.dirAbs, file.name),
        fileSha: file.sha256,
        mediaType: file.mediaType,
        pageCount: file.pageCount
      })
    }
    return out
  }

  /** 索引器完成一批后通知 UI。kind='fulltext' 专属信号：渲染层据此**只刷新诊断**，
   * 不得重新触发标题/标签检索（architecture §15——检索不再依赖全文索引何时建好） */
  notifyFulltextIndexed(): void {
    this.library.notify(['fulltext'])
  }

  /** 单个条目的全文索引状态（读派生 meta；条目信息弹窗用；失败/未建返回 null） */
  async fulltextStatusOf(entryId: string): Promise<FulltextMeta | null> {
    const entry = this.entryById(entryId)
    if (!entry) return null
    return readFulltextMeta(entry.dirAbs)
  }

  /**
   * 在已索引的全文里**按页**查找（阅读器「查找」用）。
   * indexed=false 表示本文档没有可搜索的文本层（扫描版/未建索引）——UI 据此给出诚实说明。
   */
  async findInDocument(versionId: string, query: string): Promise<ReaderFindResult> {
    const entry = this.entryBySha(versionId)
    if (!entry) throw new Error('文档版本不存在')
    const trimmed = query.trim()
    if (!trimmed) return { indexed: true, total: 0, pages: [] }
    const meta = await readFulltextMeta(entry.dirAbs)
    const text = await this.fulltextOf(entry)
    // 空白文本（扫描版提取结果是空行）等同「没有可搜索的文本层」——不能让 UI 显示「无匹配」
    if (!text || !text.trim()) return { indexed: false, total: 0, pages: [] }
    const pages = findInPages(text, meta?.pageStarts ?? [], trimmed)
    return { indexed: true, total: pages.reduce((n, p) => n + p.count, 0), pages }
  }

  /**
   * 导入分区目录里的散装文件（诊断横幅的「导入」按钮）。
   * 只接受**扫描器已收集**的相对路径（白名单式校验，杜绝任意路径导入）；
   * 导入成功后原文件的处置（移废纸篓）由 IPC 层负责——repo 不依赖 electron。
   */
  async importUnfiled(fileRel: string): Promise<{ result: ImportResult; absPath: string }> {
    const hit = this.idx().unfiled.find((u) => u.fileRel === fileRel)
    if (!hit) throw new Error('该文件不在待处理清单里（可能已被移动或删除）')
    const absPath = join(this.library.root, fileRel)
    const results = await this.importDocuments([absPath], { section: SECTION_INBOX })
    return { result: results[0], absPath }
  }

  /** 条目 → 传输层命中。盘上存在性只在传输层标记（不写回 entry.json）：声明了但盘上没有 → UI 显示「无原件」 */
  private toHit(entry: IndexedEntry, match: LibraryMatchInfo | null): LibrarySearchHit {
    return {
      entry: {
        ...entry.meta,
        files: entry.meta.files.map((f) => ({ ...f, missing: !existsSync(join(entry.dirAbs, f.name)) }))
      },
      section: entry.section,
      match
    }
  }

  /** 创建无原件的条目（Zotero 导入的纯书目条目；PDF 之后可单独拖入条目文件夹） */
  async libraryCreateEntry(meta: EntryMeta): Promise<void> {
    const parent = join(this.library.root, DIR_ENTRIES, SECTION_INBOX)
    const base = sanitizeName(meta.title)
    let dirName = base
    let suffix = 2
    while (existsSync(join(parent, dirName))) {
      dirName = `${base}-${meta.id.slice(0, 8)}${suffix > 2 ? `-${suffix}` : ''}`
      suffix++
    }
    const dirAbs = join(parent, dirName)
    mkdirSync(dirAbs, { recursive: true })
    await atomicWriteJson(join(dirAbs, FILE_ENTRY), meta)
    this.idx().entries.set(meta.id, { meta, section: SECTION_INBOX, dirAbs, dirRel: join(DIR_ENTRIES, SECTION_INBOX, dirName), anchors: [], hasFulltext: false, extra: {} })
    this.library.notify(['entries'])
  }

  /** 条目所在文件夹的绝对路径（「在文件夹中显示」用；仅本地 shell 使用，不出 IPC 数据面） */
  libraryEntryDir(id: string): string | null {
    return this.entryById(id)?.dirAbs ?? null
  }

  /** 分区目录绝对路径（分区右键「在文件夹中显示」用；同样只在本地 shell 消费） */
  librarySectionDir(name: string): string | null {
    const clean = sanitizeName(name, 60)
    if (!clean) return null
    const dir = this.sectionDir(clean)
    return existsSync(dir) ? dir : null
  }

  /** 条目内文件定位（识别队列取原件路径用） */
  libraryEntryFile(entryId: string, fileSha: string): { absPath: string; entryDirAbs: string; name: string } | null {
    const entry = this.entryById(entryId)
    if (!entry) return null
    const i = this.fileIndexOf(entry, fileSha)
    if (i === -1) return null
    return { absPath: join(entry.dirAbs, entry.meta.files[i].name), entryDirAbs: entry.dirAbs, name: entry.meta.files[i].name }
  }

  /**
   * 学术检索式搜索：自由词 + 字段语法（作者:/年份:/期刊:/标签:/分区:/doi:/arxiv:）
   * 与结构化分面过滤叠加；同维度 OR、跨维度 AND。分面计数在「去掉本维度约束」的结果上统计。
   *
   * 检索范围决策（2026-10-09，architecture §15）：自由词**只匹配标题与标签**；
   * 摘要、作者、期刊、标识符、文件名与 PDF 全文不参与自由词匹配（字段条件照旧）。
   * 全链路不读取 / stat 任何 derived/fulltext.txt——普通检索与全文派生数据彻底解耦。
   */
  async librarySearch(query: LibrarySearchQuery): Promise<LibrarySearchResponse> {
    const t0 = performance.now()
    const parsed = parseLibraryQuery(query.q ?? '')
    // 废止的「全文:」条件：识别但明确拒绝（不能静默当自由词，也不能返回未过滤的全库）
    if (parsed.fulltextDeprecated.length) {
      throw new Error('文献库已改为标题和关键词搜索，请打开文档后查找正文')
    }
    const filters = query.filters ?? {}
    const terms = [...parsed.terms]

    interface Dim {
      kind: 'author' | 'venue' | 'tag' | 'section' | 'year' | 'doi' | 'arxiv'
      values?: string[]
      years?: Array<[number, number]>
    }
    const dims: Dim[] = []
    const pushValues = (kind: Dim['kind'], values: string[] | undefined) => {
      if (values?.length) dims.push({ kind, values: values.map((v) => v.toLowerCase()) })
    }
    pushValues('author', parsed.fields['作者'])
    pushValues('venue', parsed.fields['期刊'])
    pushValues('tag', parsed.fields['标签'])
    pushValues('section', parsed.fields['分区'])
    pushValues('doi', parsed.fields['doi'])
    pushValues('arxiv', parsed.fields['arxiv'])
    if (parsed.years.length) dims.push({ kind: 'year', years: parsed.years })
    pushValues('author', filters.author)
    pushValues('venue', filters.venue)
    pushValues('tag', filters.tag)
    pushValues('section', filters.section)
    const yearRanges = (filters.year ?? []).map(parseYearRange).filter((r): r is [number, number] => r !== null)
    if (yearRanges.length) dims.push({ kind: 'year', years: yearRanges })

    const facetKindOf = (field: LibraryField): LibraryFacetKind | null =>
      field === '作者' ? 'author' : field === '期刊' ? 'venue' : field === '标签' ? 'tag' : field === '分区' ? 'section' : null
    const fieldOfKind: Partial<Record<LibraryFacetKind, LibraryField>> = {
      author: '作者', venue: '期刊', tag: '标签', section: '分区'
    }

    const matchValue = (entry: IndexedEntry, field: LibraryField, value: string): boolean => {
      const meta = entry.meta
      switch (field) {
        case '作者': return meta.authors.some((a) => a.toLowerCase().includes(value))
        case '期刊': return (meta.venue ?? '').toLowerCase().includes(value)
        case '标签': return meta.tags.some((t) => t.toLowerCase().includes(value))
        case '分区': return entry.section.toLowerCase().includes(value)
        case 'doi': return (meta.doi ?? '').toLowerCase().includes(value)
        case 'arxiv': return (meta.arxivId ?? '').toLowerCase().includes(value)
        default: return true
      }
    }
    const matchYear = (entry: IndexedEntry, ranges: Array<[number, number]>): boolean =>
      entry.meta.year !== null && ranges.some(([a, b]) => entry.meta.year! >= a && entry.meta.year! <= b)
    // 自由词 haystack = 标题 + 标签（join '\n'：引号短语不会跨字段边界拼接）
    const matchTerms = (entry: IndexedEntry): boolean => {
      if (!terms.length) return true
      const meta = entry.meta
      const haystack = `${meta.title}\n${meta.tags.join('\n')}`.toLowerCase()
      return terms.every((t) => haystack.includes(t.toLowerCase()))
    }

    const candidates = [...this.idx().entries.values()].filter((entry) => {
      if (query.status && query.status !== 'all' && entry.meta.status !== query.status) return false
      if (query.starred !== undefined && Boolean(entry.meta.starred) !== query.starred) return false
      if (!this.scopeMatch(query.spaceId, entry.meta.spaceId)) return false
      return matchTerms(entry)
    })

    // 每个维度只对每个候选求值一次；分面（skip 某维度）复用这份结果，不再重复匹配 5 遍
    const dimOk = (entry: IndexedEntry, dim: Dim): boolean => {
      if (dim.kind === 'year') return matchYear(entry, dim.years!)
      if (dim.kind === 'doi') return dim.values!.some((v) => matchValue(entry, 'doi', v))
      if (dim.kind === 'arxiv') return dim.values!.some((v) => matchValue(entry, 'arxiv', v))
      const field = fieldOfKind[dim.kind as LibraryFacetKind]
      if (!field || !dim.values) return true
      return dim.values.some((v) => matchValue(entry, field, v))
    }
    const dimFacetKind = (dim: Dim): LibraryFacetKind | null =>
      dim.kind === 'year' || dim.kind === 'doi' || dim.kind === 'arxiv' ? null : (dim.kind as LibraryFacetKind)
    const okByEntry = candidates.map((entry) => dims.map((d) => dimOk(entry, d)))
    // 命中 = 所有维度都成立；统计某分面时忽略该维度（视为成立）
    const matchesAllExcept = (i: number, skip: LibraryFacetKind | null): boolean =>
      okByEntry[i].every((ok, j) => ok || (skip !== null && dimFacetKind(dims[j]) === skip))

    // 命中集合：先分层再排序，之后才截断。
    // 排序分层（2026-10-09）：有自由词时——完整查询精确等于标题 > 全部自由词都在标题 > 标题+标签混合 > 仅标签；
    // 同档按用户所选排序器排，最后以 ID 保持稳定（同 updatedAt 时不随扫描顺序漂移）。
    // 无自由词时保留原列表排序。
    const titleLower = (e: IndexedEntry): string => e.meta.title.toLowerCase()
    const rawQuery = (query.q ?? '').trim().toLowerCase()
    const tierOf = (entry: IndexedEntry): number => {
      if (!terms.length) return 0
      const inTitle = terms.filter((t) => titleLower(entry).includes(t.toLowerCase())).length
      if (rawQuery && titleLower(entry) === rawQuery) return 0
      if (inTitle === terms.length) return 1
      if (inTitle > 0) return 2
      return 3
    }
    const tiers = candidates.map((entry) => tierOf(entry))
    const matched = candidates
      .map((entry, i) => ({ entry, i }))
      .filter(({ i }) => matchesAllExcept(i, null))
      .sort((a, b) => {
        if (terms.length && tiers[a.i] !== tiers[b.i]) return tiers[a.i] - tiers[b.i]
        const bySorter = LIBRARY_SORTERS[query.sort ?? 'updated'](a.entry, b.entry)
        return bySorter || a.entry.meta.id.localeCompare(b.entry.meta.id)
      })
      .map(({ entry }) => entry)
    const total = matched.length // 真实命中数（不受返回上限与分页影响）
    // 分页：排序发生在分页之前 → 同一查询下页间顺序稳定（「加载更多」直接追加即可）
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const page = matched.slice(offset, offset + LIBRARY_HITS_LIMIT)
    const queryTerms: SearchTerm[] = terms.map((text) => ({ text, exact: false }))

    const hits: LibrarySearchHit[] = []
    for (const entry of page) {
      // 命中理由：哪个字段、哪个词、上下文片段（自由词只描述标题/标签；显式字段检索（作者: 等）也算）
      let match: LibraryMatchInfo | null = null
      const describe = (terms: SearchTerm[], fields: Array<{ field: string; text: string }>): LibraryMatchInfo | null => {
        const hit = firstTermHit(fields, terms)
        return hit ? { field: hit.field, term: hit.term, snippet: contextSnippet(hit.text, hit.index, hit.term.length) } : null
      }
      if (queryTerms.length) {
        match = describe(queryTerms, [
          { field: '标题', text: entry.meta.title },
          { field: '标签', text: entry.meta.tags.join(' ') }
        ])
      }
      if (!match) {
        for (const dim of dims) {
          if (dim.kind === 'year' || !dim.values?.length) continue
          const candidates: Record<string, { field: string; text: string }> = {
            author: { field: '作者', text: entry.meta.authors.join(' ') },
            venue: { field: '期刊', text: entry.meta.venue ?? '' },
            tag: { field: '标签', text: entry.meta.tags.join(' ') },
            doi: { field: 'DOI', text: entry.meta.doi ?? '' },
            arxiv: { field: 'arXiv', text: entry.meta.arxivId ?? '' }
          }
          const candidate = candidates[dim.kind]
          if (!candidate) continue
          match = describe(dim.values.map((text) => ({ text, exact: false })), [candidate])
          if (match) break
        }
      }
      hits.push(this.toHit(entry, match))
    }

    const facetMaps = {
      author: new Map<string, number>(),
      venue: new Map<string, number>(),
      tag: new Map<string, number>(),
      section: new Map<string, number>(),
      year: new Map<string, number>()
    }
    const bump = (map: Map<string, number>, value: string) => map.set(value, (map.get(value) ?? 0) + 1)
    candidates.forEach((entry, i) => {
      if (!matchesAllExcept(i, 'author')) return
      for (const a of entry.meta.authors) bump(facetMaps.author, a)
    })
    candidates.forEach((entry, i) => {
      if (!matchesAllExcept(i, 'venue')) return
      if (entry.meta.venue) bump(facetMaps.venue, entry.meta.venue)
    })
    candidates.forEach((entry, i) => {
      if (!matchesAllExcept(i, 'tag')) return
      for (const t of entry.meta.tags) bump(facetMaps.tag, t)
    })
    candidates.forEach((entry, i) => {
      if (!matchesAllExcept(i, 'section')) return
      bump(facetMaps.section, entry.section)
    })
    candidates.forEach((entry, i) => {
      if (!matchesAllExcept(i, 'year')) return
      if (entry.meta.year !== null) bump(facetMaps.year, String(entry.meta.year))
    })
    const topN = (map: Map<string, number>, n = 30): LibraryFacetCount[] =>
      [...map.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, n)
    const facets: Record<LibraryFacetKind, LibraryFacetCount[]> = {
      author: topN(facetMaps.author),
      venue: topN(facetMaps.venue),
      tag: topN(facetMaps.tag),
      section: topN(facetMaps.section),
      year: topN(facetMaps.year).sort((a, b) => b.value.localeCompare(a.value))
    }

    const starredCount = [...this.idx().entries.values()].filter((e) => e.meta.starred).length
    // unindexed 字段保留仅为接口形状兼容（architecture §15：全文已退出普通检索，不再有「未建全文」提示）
    return { hits, facets, total, starredCount, unindexed: 0, tookMs: Math.round((performance.now() - t0) * 100) / 100 }
  }

  // ---------- 笔记附件（插图） ----------

  /**
   * 保存笔记插图：内容寻址落盘 笔记/附件/<sha256>.<ext>，重复插入同一张图幂等（不重复占空间）。
   * 图片类型先按文件头嗅探，嗅探不出再退回扩展名（HEIC 等浏览器不认的格式靠扩展名保底）。
   */
  async addNoteImage(input: { data: Uint8Array; fileName?: string }): Promise<{ assetId: string; mediaType: string; byteSize: number }> {
    const kind = sniffImageKind(input.data) ?? extImageKind(input.fileName ?? '')
    if (!kind) throw new Error('不支持的图片格式（支持 PNG / JPEG / GIF / WEBP / BMP / HEIC / TIFF）')
    if (input.data.byteLength === 0) throw new Error('图片内容为空')
    if (input.data.byteLength > 50 * 1024 * 1024) throw new Error('图片超过 50MB，请压缩后再插入')
    const sha = createHash('sha256').update(input.data).digest('hex')
    const dir = join(this.library.root, DIR_NOTES, DIR_NOTE_ASSETS)
    mkdirSync(dir, { recursive: true })
    const abs = join(dir, `${sha}${kind.ext}`)
    if (!existsSync(abs)) await atomicWriteFile(abs, input.data)
    // 写入本身会被 watcher 捕获触发重扫；这里定向补索引让 /api/asset 立即可用
    this.idx().shaToNoteAsset.set(sha, { abs, mediaType: kind.mediaType })
    this.library.notify(['notes'])
    return { assetId: sha, mediaType: kind.mediaType, byteSize: input.data.byteLength }
  }

  // ---------- 资产服务（/api 用） ----------

  async resolveServingFile(assetId: string, variant: 'original' | 'display' | 'thumb'): Promise<ServingFile> {
    const idx = this.idx()
    let absOriginal: string | null = null
    let mediaType = 'application/octet-stream'
    const loc = idx.shaToEntryFile.get(assetId)
    if (loc) {
      const entry = idx.entries.get(loc.entryId)!
      const file = entry.meta.files[loc.fileIndex]
      absOriginal = join(entry.dirAbs, file.name)
      mediaType = file.mediaType
    } else {
      const capId = idx.shaToCapture.get(assetId)
      if (capId) {
        const cap = idx.captures.get(capId)!
        absOriginal = cap.fileAbs
        mediaType = cap.rec.mediaType
      } else {
        const noteAsset = idx.shaToNoteAsset.get(assetId)
        if (noteAsset) {
          absOriginal = noteAsset.abs
          mediaType = noteAsset.mediaType
        }
      }
    }
    if (!absOriginal) throw new Error(`未知资产：${assetId}`)
    let absPath = absOriginal
    if (variant === 'display') {
      const v = await this.variants.ensureDisplay({ id: assetId, mediaType, absOriginal })
      if (v === 'display') {
        absPath = this.variants.derivedPath(`${assetId}.display.jpg`)
        mediaType = 'image/jpeg'
      }
    } else if (variant === 'thumb') {
      const thumb = await this.variants.ensureThumb({ id: assetId, mediaType, absOriginal })
      absPath = thumb.absPath
      mediaType = thumb.mediaType
    }
    return { absPath, mediaType }
  }
}

async function readHead(path: string, n: number): Promise<string> {
  const { open } = await import('node:fs/promises')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    await fh.read(buf, 0, n, 0)
    return buf.toString('latin1')
  } finally {
    await fh.close()
  }
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** 逗号分隔作者串 → 数组（transport 兼容：papers 预填与旧数据迁移共用） */
export function splitAuthors(raw: string): string[] {
  return raw
    .split(/[,，;；]/)
    .map((a) => a.trim())
    .filter(Boolean)
}

// ---------- 双链工具 ----------

export interface WikiLink {
  /** 原始文本（含双方括号），用于反链片段定位 */
  raw: string
  /** 链接目标：[[目标]] 或 [[目标|显示文本]] */
  target: string
  display: string
}

/** 提取正文中的 [[链接]]；跳过围栏代码块与行内代码，避免把代码示例当链接。 */
export function parseWikiLinks(bodyMd: string): WikiLink[] {
  const stripped = bodyMd.replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
  const out: WikiLink[] = []
  const re = /\[\[([^\[\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) {
    const inner = m[1]
    const bar = inner.indexOf('|')
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim()
    const display = (bar === -1 ? inner : inner.slice(bar + 1)).trim() || target
    if (target) out.push({ raw: m[0], target, display })
    if (out.length >= 500) break // 上限防御
  }
  return out
}

/** [[链接]] 在正文中的上下文片段（±60 字符） */
function wikiSnippet(body: string, raw: string, radius = 60): string {
  const idx = body.indexOf(raw)
  if (idx === -1) return raw
  const start = Math.max(0, idx - radius)
  const end = Math.min(body.length, idx + raw.length + radius)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`
}

/** arXiv ID → 基础 ID + 版本（2601.12345v2 → { base: '2601.12345', version: 'v2' }） */
export function splitArxivId(arxivId: string): { base: string; version: string | null } {
  const m = /^([0-9]{4}\.[0-9]{4,5})(v\d+)?$/.exec(arxivId.trim())
  if (!m) return { base: arxivId.trim(), version: null }
  return { base: m[1], version: m[2] ?? null }
}

function normalizeCategoryList(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .split(/[,\s，]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .join(',')
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  if (Number.isNaN(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

// ---------- 墨迹净化 ----------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const MAX_STROKES_PER_PAGE = 800
const MAX_POINTS_PER_STROKE = 6000
const round2 = (n: number): number => Math.round(n * 100) / 100

function sanitizeStrokes(raw: unknown): InkStroke[] {
  if (!Array.isArray(raw)) return []
  const out: InkStroke[] = []
  for (const item of raw.slice(0, MAX_STROKES_PER_PAGE)) {
    if (typeof item !== 'object' || item === null) continue
    const s = item as Record<string, unknown>
    const k = s.k === 'highlight' ? 'highlight' : 'pen'
    const c = typeof s.c === 'string' && HEX_COLOR.test(s.c) ? s.c.toLowerCase() : '#111111'
    const w = typeof s.w === 'number' && Number.isFinite(s.w) ? Math.min(60, Math.max(0.5, s.w)) : 2
    if (!Array.isArray(s.pts)) continue
    const pts: Array<[number, number]> = []
    for (const p of s.pts.slice(0, MAX_POINTS_PER_STROKE)) {
      if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' &&
          Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) < 1e6 && Math.abs(p[1]) < 1e6) {
        pts.push([round2(p[0]), round2(p[1])])
      }
    }
    if (pts.length >= 2) out.push({ k, c, w, pts })
  }
  return out
}

export { DOC_TYPE_LABELS }
