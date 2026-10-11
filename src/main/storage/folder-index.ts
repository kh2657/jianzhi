import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import type { EntryFile, EntryMeta, LibraryConflict, NoteLearningRecord, NoteLearningState, PaperFeed, PaperItem, StudySpace } from '../../shared/types'

/**
 * 存储格式 v2 的编解码层（格式规范：docs/存储格式.md）。
 * 解析一律防御式：缺省字段补默认值、未知字段丢弃、非法文件收集为 malformed，绝不让单个坏文件拖垮整库扫描。
 */

export const DIR_ENTRIES = '文献库'
export const DIR_NOTES = '笔记'
/** 笔记正文引用的图片附件：笔记/附件/<sha256>.<ext>（内容寻址，全局去重） */
export const DIR_NOTE_ASSETS = '附件'
export const DIR_CAPTURES = '收件箱'
/** 速记（纯文本捕获）：收件箱/速记/<时间戳>-<id8>.md */
export const DIR_MEMOS = '速记'
export const DIR_CACHE = '.cache'
export const SECTION_INBOX = '待整理'
export const FILE_ENTRY = 'entry.json'
export const FILE_ANCHORS = 'anchors.json'
export const FILE_WORKSPACE = '精读.json'
export const FILE_SPACES = '学习区.json'
export const FILE_PAPERS = 'papers.json'

/** 扫描时跳过的目录（.cache 为可丢弃缓存；derived 为条目内派生物；.tmp 临时目录） */
export const SKIP_DIRS = new Set([DIR_CACHE, 'derived', '.tmp', 'node_modules'])

/** 与 AtomicWriteFile 的临时文件命名约定一致；扫描器必须忽略 */
export function isTempName(name: string): boolean {
  return name.startsWith('.') && name.endsWith('.tmp')
}

// ---------- 冲突副本检测（仅高置信模式，避免误伤以 conflict 为题的学术文献） ----------

const CONFLICT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /冲突/, label: '冲突' },
  { re: /conflicted copy/i, label: 'conflicted copy' },
  { re: /conflict copy/i, label: 'conflict copy' },
  { re: /\(from .+ device\)/i, label: 'from other device' }
]

export function detectConflictName(name: string): string | null {
  for (const p of CONFLICT_PATTERNS) {
    if (p.re.test(name)) return p.label
  }
  return null
}

// ---------- entry.json ----------

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null
  if (v == null) return null
  return String(v)
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

const DOC_TYPES = new Set(['book', 'paper', 'other'])

/** entry.json 已知顶层键；其余键提取进 extra 原样保留（前向兼容：新旧版本混跑不丢字段） */
const KNOWN_ENTRY_KEYS = new Set([
  'schema', 'id', 'docType', 'title', 'authors', 'year', 'venue', 'doi', 'arxivId', 'abstract',
  'tags', 'spaceId', 'status', 'note', 'files', 'readingState', 'createdAt', 'updatedAt', 'starred'
])

export function extractUnknownKeys(raw: Record<string, unknown>, known: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) out[k] = raw[k]
  }
  return out
}

export interface NormalizedEntry {
  meta: EntryMeta
  /** 未知顶层键（本版本不识别，但必须在下次写回时原样保留） */
  extra: Record<string, unknown>
}

export function normalizeEntryMeta(raw: unknown): NormalizedEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = asString(r.id)
  if (!id) return null
  const files: EntryFile[] = Array.isArray(r.files)
    ? r.files
        .filter(
            (f): f is Record<string, unknown> =>
              typeof f === 'object' && f !== null && typeof (f as Record<string, unknown>).sha256 === 'string' && ((f as Record<string, unknown>).sha256 as string).length === 64
        )
        .map((f) => ({
          sha256: f.sha256 as string,
          name: sanitize(asString(f.name) ?? '未命名'),
          mediaType: asString(f.mediaType) ?? 'application/octet-stream',
          byteSize: typeof f.byteSize === 'number' && Number.isFinite(f.byteSize) ? f.byteSize : 0,
          pageCount: asNumberOrNull(f.pageCount),
          fingerprint: asString(f.fingerprint),
          importedAt: asString(f.importedAt) ?? new Date(0).toISOString()
        }))
    : []
  const readingStateRaw = (typeof r.readingState === 'object' && r.readingState !== null ? r.readingState : null) as Record<string, unknown> | null
  const now = new Date().toISOString()
  const docType = typeof r.docType === 'string' && DOC_TYPES.has(r.docType) ? (r.docType as EntryMeta['docType']) : 'other'
  const status = r.status === 'needs-review' ? 'needs-review' : 'ok'
  const meta: EntryMeta = {
    schema: 2,
    id,
    docType,
    title: sanitize(asString(r.title) ?? '未命名'),
    authors: asStringArray(r.authors),
    year: asNumberOrNull(r.year),
    venue: asString(r.venue),
    doi: asString(r.doi),
    arxivId: asString(r.arxivId),
    abstract: asString(r.abstract),
    tags: asStringArray(r.tags),
    spaceId: asString(r.spaceId),
    status,
    note: asString(r.note),
    // 收藏标记：仅 true 时存在，不给未收藏条目的 entry.json 凭空加键（往返无损）
    starred: r.starred === true ? true : undefined,
    files,
    readingState:
      readingStateRaw && typeof readingStateRaw.pageIndex === 'number'
        ? {
            pageIndex: readingStateRaw.pageIndex,
            scale: typeof readingStateRaw.scale === 'number' ? readingStateRaw.scale : 1,
            rotation: typeof readingStateRaw.rotation === 'number' ? readingStateRaw.rotation : 0,
            lastReadAt: asString(readingStateRaw.lastReadAt) ?? undefined
          }
        : null,
    createdAt: asString(r.createdAt) ?? now,
    updatedAt: asString(r.updatedAt) ?? now
  }
  return { meta, extra: extractUnknownKeys(r, KNOWN_ENTRY_KEYS) }
}

function sanitize(input: string): string {
  return input.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim()
}

// ---------- 笔记 markdown（front-matter） ----------

/** 笔记 front-matter 的来源引用（存储格式.md §4） */
export type NoteSourceRef =
  | { kind: 'anchor'; id: string; documentId?: string | null }
  | { kind: 'capture'; id: string }
  | { kind: 'document'; id: string }

export interface NoteFrontMatter {
  schema: 2
  id: string
  noteType: string
  title: string
  aliases: string[]
  verifiedStatus: 'unchecked' | 'checked'
  spaceId: string | null
  revision: number
  sources: NoteSourceRef[]
  createdAt: string
  updatedAt: string
  /** 学习足迹：已计过「新建」（首次非空正文）；防止清空正文再写被重复计为新建 */
  counted?: boolean
  /** 知识块自评（WP-8：随笔记文件保存，跨设备同步）；无标记时不存在 */
  learning?: NoteLearningState
}

/** front-matter 里的学习自评：宽容解析（非法形状按无标记处理） */
function normalizeLearning(v: unknown): NoteLearningState | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const raw = v as Record<string, unknown>
  const records: Record<string, NoteLearningRecord> = {}
  if (typeof raw.records === 'object' && raw.records !== null && !Array.isArray(raw.records)) {
    for (const [id, rec] of Object.entries(raw.records as Record<string, unknown>)) {
      if (!id || typeof rec !== 'object' || rec === null) continue
      const r = rec as Record<string, unknown>
      if ((r.status === 'understood' || r.status === 'question') && typeof r.fingerprint === 'string') {
        records[id] = { status: r.status, fingerprint: r.fingerprint }
      }
    }
  }
  const activeId = typeof raw.activeId === 'string' && raw.activeId ? raw.activeId : undefined
  if (!activeId && Object.keys(records).length === 0) return undefined
  return { ...(activeId ? { activeId } : {}), records }
}

export interface ParsedNote {
  fm: NoteFrontMatter
  bodyMd: string
  /** 未知 front-matter 键（本版本不识别，写回时原样保留——前向兼容） */
  extra: Record<string, unknown>
}

const KNOWN_NOTE_KEYS = new Set([
  'schema', 'id', 'noteType', 'title', 'aliases', 'verifiedStatus', 'spaceId', 'revision', 'sources', 'createdAt', 'updatedAt', 'counted',
  'learning'
])

export function serializeNoteMarkdown(fm: NoteFrontMatter, bodyMd: string, extra: Record<string, unknown> = {}): string {
  // 已知键优先；extra 的未知键原样并列写入（防旧 extra 覆盖演化后的已知键）
  return `---\n${yamlStringify({ ...extra, ...fm }, { lineWidth: 0 })}---\n\n${bodyMd}`
}

const NOTE_TYPES = new Set(['concept', 'theorem', 'proof', 'example', 'counterexample', 'problem', 'note'])
const VERIFIED = new Set(['unchecked', 'checked'])

export function parseNoteMarkdown(text: string): ParsedNote | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return null
  let raw: unknown
  try {
    raw = yamlParse(m[1])
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = asString(r.id)
  if (!id) return null
  const sources: NoteSourceRef[] = Array.isArray(r.sources)
    ? r.sources
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).id === 'string')
        .map((s) => {
          const kind = s.kind === 'capture' || s.kind === 'document' ? s.kind : 'anchor'
          return kind === 'anchor'
            ? { kind: 'anchor' as const, id: s.id as string, documentId: asString(s.documentId) }
            : { kind, id: s.id as string }        })
    : []
  let bodyMd = text.slice(m[0].length)
  if (bodyMd.startsWith('\r\n')) bodyMd = bodyMd.slice(2)
  else if (bodyMd.startsWith('\n')) bodyMd = bodyMd.slice(1)
  const now = new Date().toISOString()
  return {
    fm: {
      schema: 2,
      id,
      noteType: typeof r.noteType === 'string' && NOTE_TYPES.has(r.noteType) ? r.noteType : 'note',
      title: sanitize(asString(r.title) ?? '未命名'),
      aliases: asStringArray(r.aliases),
      verifiedStatus: typeof r.verifiedStatus === 'string' && VERIFIED.has(r.verifiedStatus) ? (r.verifiedStatus as NoteFrontMatter['verifiedStatus']) : 'unchecked',
      spaceId: asString(r.spaceId),
      revision: typeof r.revision === 'number' && Number.isInteger(r.revision) ? r.revision : 1,
      sources,
      createdAt: asString(r.createdAt) ?? now,
      updatedAt: asString(r.updatedAt) ?? now,
      // 仅在已计数时存在：不给旧笔记的 front-matter 凭空加 false 键（往返无损）
      counted: r.counted === true ? true : undefined,
      // 学习自评：无标记时不落键（往返无损）
      learning: normalizeLearning(r.learning)
    },
    bodyMd,
    extra: extractUnknownKeys(r, KNOWN_NOTE_KEYS)
  }
}

// ---------- 收件箱侧车 ----------

export interface CaptureSidecar {
  schema: 2
  id: string
  mediaType: string
  byteSize: number
  sha256: string
  context: string | null
  inboxStatus: 'inbox' | 'filed'
  spaceId: string | null
  createdAt: string
}

export function normalizeCaptureSidecar(raw: unknown): { rec: CaptureSidecar; extra: Record<string, unknown> } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const id = asString(r.id)
  if (!id) return null
  const rec: CaptureSidecar = {
    schema: 2,
    id,
    mediaType: asString(r.mediaType) ?? 'image/jpeg',
    byteSize: typeof r.byteSize === 'number' && Number.isFinite(r.byteSize) ? r.byteSize : 0,
    sha256: typeof r.sha256 === 'string' && r.sha256.length === 64 ? r.sha256 : '',
    context: asString(r.context),
    inboxStatus: r.inboxStatus === 'filed' ? 'filed' : 'inbox',
    spaceId: asString(r.spaceId),
    createdAt: asString(r.createdAt) ?? new Date(0).toISOString()
  }
  return {
    rec,
    extra: extractUnknownKeys(r, new Set(['schema', 'id', 'mediaType', 'byteSize', 'sha256', 'context', 'inboxStatus', 'spaceId', 'createdAt']))
  }
}

// ---------- 收件箱速记（纯文本捕获） ----------

export interface MemoFrontMatter {
  schema: 1
  id: string
  inboxStatus: 'inbox' | 'filed'
  spaceId: string | null
  /** 待办标记：以 `!` 开头捕获或事后标记；不为真时不落键（往返无损） */
  todo?: boolean
  createdAt: string
  updatedAt: string
}

export interface ParsedMemo {
  fm: MemoFrontMatter
  /** front-matter 之后的全部文本即捕获内容 */
  text: string
  /** 未知 front-matter 键（写回原样保留——前向兼容） */
  extra: Record<string, unknown>
}

const KNOWN_MEMO_KEYS = new Set(['schema', 'id', 'inboxStatus', 'spaceId', 'todo', 'createdAt', 'updatedAt'])

export function serializeMemoMarkdown(fm: MemoFrontMatter, text: string, extra: Record<string, unknown> = {}): string {
  return `---\n${yamlStringify({ ...extra, ...fm }, { lineWidth: 0 })}---\n\n${text}`
}

export function parseMemoMarkdown(raw: string): ParsedMemo | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!m) return null
  let parsed: unknown
  try {
    parsed = yamlParse(m[1])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  const id = asString(r.id)
  if (!id) return null
  let text = raw.slice(m[0].length)
  if (text.startsWith('\r\n')) text = text.slice(2)
  else if (text.startsWith('\n')) text = text.slice(1)
  const fallback = new Date().toISOString()
  return {
    fm: {
      schema: 1,
      id,
      inboxStatus: r.inboxStatus === 'filed' ? 'filed' : 'inbox',
      spaceId: asString(r.spaceId),
      todo: r.todo === true ? true : undefined,
      createdAt: asString(r.createdAt) ?? fallback,
      updatedAt: asString(r.updatedAt) ?? fallback
    },
    text,
    extra: extractUnknownKeys(r, KNOWN_MEMO_KEYS)
  }
}

// ---------- 学习区.json / papers.json ----------

export interface SpacesDoc {
  schema: 2
  spaces: StudySpace[]
}

export function normalizeSpacesDoc(raw: unknown): SpacesDoc {
  if (typeof raw !== 'object' || raw === null) return { schema: 2, spaces: [] }
  const r = raw as Record<string, unknown>
  const spaces = Array.isArray(r.spaces)
    ? r.spaces
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).id === 'string')
        .map((s) => ({
          id: s.id as string,
          name: sanitize(asString(s.name) ?? '未命名'),
          kind: s.kind === 'course' ? ('course' as const) : ('research' as const),
          createdAt: asString(s.createdAt) ?? new Date(0).toISOString()
        }))
    : []
  return { schema: 2, spaces }
}

export interface DailyFileRecord {
  fileName: string
  digest: string
  importedAt: string
}

export interface PapersDoc {
  schema: 2
  feeds: PaperFeed[]
  items: PaperItem[]
  dailyFiles: DailyFileRecord[]
}

export function normalizePapersDoc(raw: unknown): PapersDoc {
  if (typeof raw !== 'object' || raw === null) return { schema: 2, feeds: [], items: [], dailyFiles: [] }
  const r = raw as Record<string, unknown>
  return {
    schema: 2,
    feeds: Array.isArray(r.feeds) ? (r.feeds as PaperFeed[]) : [],
    items: Array.isArray(r.items) ? (r.items as PaperItem[]) : [],
    dailyFiles: Array.isArray(r.dailyFiles) ? (r.dailyFiles as DailyFileRecord[]) : []
  }
}

// ---------- 锚点 ----------

export interface StoredAnchor {
  id: string
  fileSha: string
  pageIndex: number
  pageLabel: string | null
  /** PDF 用户空间矩形（coords.ts 契约）；空数组 = 页级锚点 */
  rects: Array<[number, number, number, number]>
  quote: string | null
  createdAt: string
}

export function normalizeAnchors(raw: unknown): StoredAnchor[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null && typeof (a as Record<string, unknown>).id === 'string')
    .map((a) => ({
      id: a.id as string,
      fileSha: typeof a.fileSha === 'string' ? a.fileSha : '',
      pageIndex: typeof a.pageIndex === 'number' ? a.pageIndex : 0,
      pageLabel: asString(a.pageLabel),
      rects: Array.isArray(a.rects)
        ? (a.rects.filter(
            (rect): rect is [number, number, number, number] =>
              Array.isArray(rect) && rect.length === 4 && rect.every((n) => typeof n === 'number' && Number.isFinite(n))
          ) as Array<[number, number, number, number]>)
        : [],
      quote: asString(a.quote),
      createdAt: asString(a.createdAt) ?? new Date(0).toISOString()
    }))
}

// ---------- 冲突 ----------

export function toConflict(relPath: string, kind: 'file' | 'folder', pattern: string): LibraryConflict {
  return { path: relPath, kind, pattern, detectedAt: new Date().toISOString() }
}
