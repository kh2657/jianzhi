import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import type { EntryFile, EntryMeta, PaperFeed, PaperItem, StudySpace } from '../../shared/types'
import {
  DIR_CAPTURES,
  DIR_ENTRIES,
  DIR_NOTES,
  FILE_ANCHORS,
  FILE_ENTRY,
  FILE_SPACES,
  FILE_WORKSPACE,
  SECTION_INBOX,
  type CaptureSidecar,
  type NoteFrontMatter,
  type NoteSourceRef,
  type StoredAnchor
} from './folder-index'
import { atomicWriteFile, atomicWriteJson, sanitizeName, slugFor } from './fsutil'
import { splitAuthors } from './repo'

/**
 * v1（SQLite）→ v2（纯文件夹）一次性迁移。规范见 docs/存储格式.md。
 * 只读旧库、只写新结构；旧产物（library.db / assets/ / derived/ / *.bak）原样移入备份目录。
 * 运行环境：Node ≥23（scripts 直跑 TS）；better-sqlite3 仅在本模块使用（devDependency）。
 *
 * 有意简化（出处：2026-10-07 文献库与存储重构计划 §九，文档已归档进 git 历史）：
 * - 笔记修订历史（note_revisions）不迁移，revision 计数保留；
 * - relations（wiki mentions 边）不迁移——v2 由扫描即时解析；
 * - 条目统一落入「待整理」分区，由用户拖入目标分区。
 */

export interface MigrateResult {
  entries: number
  notes: number
  captures: number
  anchors: number
  spaces: number
  feeds: number
  items: number
  /** 迁移成功的手写批注页数（文件格式与运行时 inkGet 契约一致） */
  inkFiles: number
  /** 无法解析而跳过的手写批注页数（会计入 warnings） */
  inkSkipped: number
  warnings: string[]
}

const now = () => new Date().toISOString()

/** v1 `ink_strokes.strokes_json` → 笔画数组；解析失败或不是数组时返回 null（调用方跳过并记警告） */
function parseStrokesJson(raw: unknown): unknown[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

interface Row {
  [key: string]: unknown
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null
  if (v == null) return null
  return String(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function migrateSqliteLibrary(libraryDir: string): Promise<MigrateResult> {
  const result: MigrateResult = { entries: 0, notes: 0, captures: 0, anchors: 0, spaces: 0, feeds: 0, items: 0, inkFiles: 0, inkSkipped: 0, warnings: [] }
  const warn = (msg: string) => result.warnings.push(msg)

  const dbPath = join(libraryDir, 'library.db')
  if (!existsSync(dbPath)) throw new Error(`未找到旧库：${dbPath}`)
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })

  const all = (sql: string): Row[] => db.prepare(sql).all() as Row[]
  const assetsDir = join(libraryDir, 'assets')

  // ---------- 学习区 ----------
  const spaces: StudySpace[] = all('SELECT id, name, kind, created_at AS createdAt FROM spaces ORDER BY created_at').map((r) => ({
    id: str(r.id)!,
    name: sanitizeName(str(r.name) ?? '未命名'),
    kind: r.kind === 'course' ? 'course' : 'research',
    createdAt: str(r.createdAt) ?? now()
  }))
  result.spaces = spaces.length
  await atomicWriteJson(join(libraryDir, FILE_SPACES), { schema: 2, spaces })

  // ---------- 论文订阅 ----------
  const feeds: PaperFeed[] = all('SELECT id, name, categories, keywords, max_results AS maxResults, created_at AS createdAt FROM paper_feeds ORDER BY sort_key, created_at').map((r) => ({
    id: str(r.id)!,
    name: str(r.name) ?? '未命名',
    categories: str(r.categories) ?? '',
    keywords: str(r.keywords) ?? '',
    maxResults: num(r.maxResults) ?? 50,
    createdAt: str(r.createdAt) ?? now()
  }))
  const matchesByItem = new Map<string, { feedId: string; feedName: string }[]>()
  for (const m of all('SELECT m.item_id AS itemId, f.id AS feedId, f.name AS feedName FROM paper_feed_matches m JOIN paper_feeds f ON f.id = m.feed_id')) {
    const itemId = str(m.itemId)!
    const list = matchesByItem.get(itemId) ?? []
    list.push({ feedId: str(m.feedId)!, feedName: str(m.feedName) ?? '' })
    matchesByItem.set(itemId, list)
  }
  const items: PaperItem[] = all('SELECT * FROM paper_items ORDER BY published_at DESC').map((r) => {
    const matches = matchesByItem.get(str(r.id)!) ?? []
    let authors: string[] = []
    try {
      const parsed = JSON.parse(str(r.authors_json) ?? '[]')
      if (Array.isArray(parsed)) authors = parsed.filter((x) => typeof x === 'string')
    } catch { /* 保持空 */ }
    return {
      id: str(r.id)!,
      baseId: str(r.base_id) ?? '',
      version: str(r.version),
      arxivId: str(r.arxiv_id) ?? '',
      title: str(r.title) ?? '',
      authors,
      abstract: str(r.abstract) ?? '',
      primaryCategory: str(r.primary_category),
      publishedAt: str(r.published_at) ?? now(),
      pdfUrl: str(r.pdf_url) ?? '',
      absUrl: str(r.abs_url) ?? '',
      status: (r.status === 'imported' || r.status === 'skipped' ? r.status : 'new') as PaperItem['status'],
      documentId: str(r.document_id),
      fetchedAt: str(r.fetched_at) ?? now(),
      feedNames: matches.map((m) => m.feedName),
      feedIds: matches.map((m) => m.feedId)
    }
  })
  result.feeds = feeds.length
  result.items = items.length
  const dailyFiles = all('SELECT file_name AS fileName, digest, imported_at AS importedAt FROM paper_daily_files').map((r) => ({
    fileName: str(r.fileName) ?? '',
    digest: str(r.digest) ?? '',
    importedAt: str(r.importedAt) ?? now()
  }))
  await atomicWriteJson(join(libraryDir, 'papers.json'), { schema: 2, feeds, items, dailyFiles })

  // ---------- 资产行索引（sha → 磁盘路径） ----------
  interface AssetRow {
    sha256: string
    mediaType: string
    absPath: string | null
    originalName: string
    byteSize: number
  }
  const assetById = new Map<string, AssetRow>()
  for (const r of all('SELECT * FROM assets')) {
    const rel = str(r.rel_path)
    const abs = rel ? join(assetsDir, rel) : null
    assetById.set(str(r.id)!, {
      sha256: str(r.sha256) ?? '',
      mediaType: str(r.media_type) ?? 'application/octet-stream',
      absPath: abs && existsSync(abs) ? abs : null,
      originalName: str(r.original_name) ?? '原件',
      byteSize: num(r.byte_size) ?? 0
    })
  }

  // ---------- 文档条目 ----------
  const versionsByDoc = new Map<string, Row[]>()
  for (const v of all('SELECT * FROM document_versions ORDER BY imported_at, id')) {
    const docId = str(v.document_id)!
    const list = versionsByDoc.get(docId) ?? []
    list.push(v)
    versionsByDoc.set(docId, list)
  }
  const anchorsByVersion = new Map<string, Row[]>()
  for (const a of all('SELECT * FROM anchors ORDER BY created_at, id')) {
    const vid = str(a.document_version_id)!
    const list = anchorsByVersion.get(vid) ?? []
    list.push(a)
    anchorsByVersion.set(vid, list)
  }
  const inkByVersion = new Map<string, Row[]>()
  for (const p of all('SELECT * FROM page_annotations')) {
    const vid = str(p.document_version_id)!
    const list = inkByVersion.get(vid) ?? []
    list.push(p)
    inkByVersion.set(vid, list)
  }
  const readingStateByDoc = new Map(all('SELECT * FROM reading_state').map((r) => [str(r.document_id)!, r]))
  const workspaceByDoc = new Map(all('SELECT * FROM reading_workspaces').map((r) => [str(r.document_id)!, r]))

  const entryIdByAnchor = new Map<string, string>()
  const usedDirNames = new Set<string>()

  for (const doc of all('SELECT * FROM documents ORDER BY created_at, id')) {
    const docId = str(doc.id)!
    const title = str(doc.title) ?? '未命名'
    const versions = versionsByDoc.get(docId) ?? []
    const files: EntryFile[] = []
    const anchors: StoredAnchor[] = []
    let dirAbs = ''

    for (const v of versions) {
      const versionId = str(v.id)!
      const asset = assetById.get(str(v.asset_id) ?? '')
      if (!asset || !asset.absPath) {
        warn(`文档「${title}」的版本 ${versionId.slice(0, 8)} 原件缺失，已跳过（含其锚点/墨迹）`)
        continue
      }
      const sha = asset.sha256
      const fileName = uniqueFileName(asset.originalName, sha, files)

      // 首个可用版本：建立条目目录并复制原件
      if (!dirAbs) {
        const parent = join(libraryDir, DIR_ENTRIES, SECTION_INBOX)
        const base = sanitizeName(title)
        let dirName = base
        let suffix = 2
        while (usedDirNames.has(dirName) || existsSync(join(parent, dirName))) {
          dirName = suffix === 2 ? `${base}-${docId.slice(0, 8)}` : `${base}-${docId.slice(0, 8)}-${suffix}`
          suffix++
        }
        usedDirNames.add(dirName)
        dirAbs = join(parent, dirName)
        mkdirSync(dirAbs, { recursive: true })
        const tmpCopy = join(dirAbs, `.${sha.slice(0, 8)}.part`)
        copyWithVerify(asset.absPath, tmpCopy, asset.byteSize)
        renameSync(tmpCopy, join(dirAbs, fileName))
      }
      files.push({
        sha256: sha,
        name: fileName,
        mediaType: asset.mediaType,
        byteSize: asset.byteSize,
        pageCount: num(v.page_count),
        fingerprint: str(v.fingerprint),
        importedAt: str(v.imported_at) ?? now()
      })

      for (const a of anchorsByVersion.get(versionId) ?? []) {
        let rects: unknown
        try {
          rects = JSON.parse(str(a.rects_json) ?? '[]')
        } catch {
          rects = []
        }
        anchors.push({
          id: str(a.id)!,
          fileSha: sha,
          pageIndex: num(a.page_index) ?? 0,
          pageLabel: str(a.page_label),
          rects: Array.isArray(rects) ? (rects as StoredAnchor['rects']) : [],
          quote: str(a.quote),
          createdAt: str(a.created_at) ?? now()
        })
        entryIdByAnchor.set(str(a.id)!, docId)
        result.anchors++
      }

      for (const p of inkByVersion.get(versionId) ?? []) {
        const inkDir = join(dirAbs, 'ink', sha.slice(0, 8))
        mkdirSync(inkDir, { recursive: true })
        const strokes = parseStrokesJson(p.strokes_json)
        if (!strokes) {
          // 解析不了就跳过并计入警告：写坏格式的「有内容」文件比留下缺口更难排查
          warn(`文档「${title}」第 ${num(p.page_index) ?? 0} 页手写批注无法解析，已跳过`)
          result.inkSkipped += 1
          continue
        }
        // 必须与运行时契约一致：Repo.inkGet 读的是 { strokes: InkStroke[] }，
        // 且 v2 里 versionId 就是原件 sha256（v1 的 document_version_id 已不存在）
        // 旧实现直接把 v1 的 strokes_json 原样写入 → 迁移后 inkGet 拿到 undefined，
        // 全部手写批注静默消失（见 docs/存储格式.md §4 与 tests/migrate.spec.ts 的读回断言）
        await atomicWriteJson(join(inkDir, `p${num(p.page_index) ?? 0}.json`), {
          versionId: sha,
          pageIndex: num(p.page_index) ?? 0,
          strokes,
          updatedAt: str(p.updated_at) ?? now()
        })
        result.inkFiles += 1
      }
    }

    if (!dirAbs) {
      warn(`文档「${title}」没有任何可用原件，未迁移`)
      continue
    }

    const rs = readingStateByDoc.get(docId)
    const meta: EntryMeta = {
      schema: 2,
      id: docId,
      docType: (doc.doc_type === 'paper' || doc.doc_type === 'book' ? doc.doc_type : 'other') as EntryMeta['docType'],
      title: sanitizeName(title),
      authors: splitAuthors(str(doc.authors) ?? ''),
      year: null,
      venue: null,
      doi: null,
      arxivId: null,
      abstract: null,
      tags: [],
      spaceId: str(doc.space_id),
      status: 'ok',
      note: str(doc.note),
      files,
      readingState: rs
        ? {
            pageIndex: num(rs.page_index) ?? 0,
            scale: num(rs.scale) ?? 1,
            rotation: num(rs.rotation) ?? 0,
            lastReadAt: str(rs.updated_at) ?? undefined
          }
        : null,
      createdAt: str(doc.created_at) ?? now(),
      updatedAt: str(doc.updated_at) ?? now()
    }
    await atomicWriteJson(join(dirAbs, FILE_ENTRY), meta)
    if (anchors.length) await atomicWriteJson(join(dirAbs, FILE_ANCHORS), anchors)
    const ws = workspaceByDoc.get(docId)
    if (ws) {
      try {
        const payload = JSON.parse(str(ws.payload_json) ?? 'null')
        if (payload && typeof payload === 'object') await atomicWriteJson(join(dirAbs, FILE_WORKSPACE), payload)
      } catch {
        warn(`文档「${title}」的精读现场损坏，未迁移`)
      }
    }
    result.entries++
  }

  // ---------- 笔记 ----------
  const noteSourceRows = all('SELECT * FROM note_sources')
  const docSourceRows = all('SELECT * FROM note_document_sources')
  const usedNoteFiles = new Set<string>()
  for (const n of all('SELECT * FROM notes ORDER BY created_at, id')) {
    const id = str(n.id)!
    const title = str(n.title) ?? '未命名'
    const sources: NoteSourceRef[] = []
    for (const s of noteSourceRows.filter((x) => str(x.note_id) === id)) {
      if (str(s.anchor_id)) sources.push({ kind: 'anchor', id: str(s.anchor_id)!, documentId: entryIdByAnchor.get(str(s.anchor_id)!) ?? null })
      else if (str(s.capture_id)) sources.push({ kind: 'capture', id: str(s.capture_id)! })
    }
    for (const s of docSourceRows.filter((x) => str(x.note_id) === id)) {
      sources.push({ kind: 'document', id: str(s.document_id)! })
    }
    let aliases: string[] = []
    try {
      const parsed = JSON.parse(str(n.aliases_json) ?? '[]')
      if (Array.isArray(parsed)) aliases = parsed.filter((x) => typeof x === 'string')
    } catch { /* 保持空 */ }
    const fm: NoteFrontMatter = {
      schema: 2,
      id,
      noteType: (typeof n.note_type === 'string' && NOTE_TYPES.has(n.note_type) ? n.note_type : 'note') as NoteFrontMatter['noteType'],
      title: sanitizeName(title),
      aliases,
      verifiedStatus: n.verified_status === 'checked' ? 'checked' : 'unchecked',
      spaceId: str(n.space_id),
      revision: num(n.revision_no) ?? 1,
      sources,
      createdAt: str(n.created_at) ?? now(),
      updatedAt: str(n.updated_at) ?? now()
    }
    const body = str(n.body_md) ?? ''
    const md = `---\n${yamlStringify(fm, { lineWidth: 0 })}---\n\n${body}`
    const base = `${slugFor(fm.title)}-${id.slice(0, 8)}`
    let fileName = `${base}.md`
    let k = 2
    while (usedNoteFiles.has(fileName)) fileName = `${base}-${k++}.md`
    usedNoteFiles.add(fileName)
    await atomicWriteFile(join(libraryDir, DIR_NOTES, fileName), md)
    result.notes++
  }

  // ---------- 收件箱 ----------
  mkdirSync(join(libraryDir, DIR_CAPTURES), { recursive: true })
  for (const c of all('SELECT * FROM captures ORDER BY created_at, id')) {
    const asset = assetById.get(str(c.asset_id) ?? '')
    if (!asset || !asset.absPath) {
      warn(`收件箱照片 ${str(c.id)?.slice(0, 8) ?? '?'} 原件缺失，已跳过`)
      continue
    }
    const sha = asset.sha256
    const fileName = uniqueFileName(asset.originalName, sha, [])
    const fileAbs = join(libraryDir, DIR_CAPTURES, fileName)
    const tmpCopy = join(libraryDir, DIR_CAPTURES, `.${sha.slice(0, 8)}.part`)
    copyWithVerify(asset.absPath, tmpCopy, asset.byteSize)
    renameSync(tmpCopy, fileAbs)
    const rec: CaptureSidecar = {
      schema: 2,
      id: str(c.id)!,
      mediaType: asset.mediaType,
      byteSize: asset.byteSize,
      sha256: sha,
      context: str(c.context),
      inboxStatus: c.inbox_status === 'filed' ? 'filed' : 'inbox',
      spaceId: str(c.space_id),
      createdAt: str(c.created_at) ?? now()
    }
    await atomicWriteJson(`${fileAbs}.json`, rec)
    result.captures++
  }

  // ---------- 备份旧产物（先关库再移动，Windows 下连接未关闭会锁文件） ----------
  db.close()
  const backupDir = join(libraryDir, `_v1备份-${stamp()}`)
  mkdirSync(backupDir, { recursive: true })
  const legacyNames = ['library.db', 'assets', 'derived', ...readdirSync(libraryDir).filter((n) => n.includes('.before-v'))]
  for (const name of legacyNames) {
    const p = join(libraryDir, name)
    if (existsSync(p)) renameSync(p, join(backupDir, name))
  }

  return result
}

const NOTE_TYPES = new Set(['concept', 'theorem', 'proof', 'example', 'counterexample', 'problem', 'note'])

function uniqueFileName(originalName: string, sha: string, existing: Array<{ name: string }>): string {
  let name = sanitizeName(basename(originalName) || '原件')
  if (existing.some((f) => f.name === name)) {
    const ext = extname(name)
    name = `${stripExt(name)}-${sha.slice(0, 8)}${ext}`
  }
  return name
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

function copyWithVerify(src: string, dst: string, expectedSize: number): void {
  copyFileSync(src, dst)
  const size = statSync(dst).size
  if (expectedSize > 0 && size !== expectedSize) {
    throw new Error(`复制后大小不一致（${src}）：预期 ${expectedSize}，实际 ${size}`)
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}
