import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { EntryMeta, LibraryConflict, StudySpace } from '../../shared/types'
import { warn as logWarn } from '../logger'
import { readJsonSafeAsync } from './fsutil'
import {
  DIR_CAPTURES,
  DIR_ENTRIES,
  DIR_MEMOS,
  DIR_NOTE_ASSETS,
  DIR_NOTES,
  DIR_CACHE,
  FILE_ANCHORS,
  FILE_ENTRY,
  FILE_PAPERS,
  FILE_SPACES,
  PapersDoc,
  SKIP_DIRS,
  SECTION_INBOX,
  StoredAnchor,
  NoteFrontMatter,
  MemoFrontMatter,
  normalizeAnchors,
  normalizeCaptureSidecar,
  normalizeEntryMeta,
  normalizePapersDoc,
  normalizeSpacesDoc,
  parseMemoMarkdown,
  parseNoteMarkdown,
  detectConflictName,
  toConflict,
  CaptureSidecar,
  isTempName
} from './folder-index'

/**
 * FolderStore：库根目录的扫描器与监听器（存储内核）。
 * 职责只有三件事——把磁盘现状扫成内存索引、监听变化（含 iCloud 外部写入）触发增量重扫、
 * 把变更种类广播给消费者。实体读写语义在上层 Repo（见 P2）。
 */

/** 只读文件头 5 字节确认 PDF（对账认领用；不整读大文件） */
function sniffPdfHead(abs: string): boolean {
  try {
    const fd = openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(5)
      const n = readSync(fd, buf, 0, 5, 0)
      return n === 5 && buf.toString('latin1') === '%PDF-'
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

export interface IndexedEntry {
  meta: EntryMeta
  /** 所在分区 = 文献库/<分区>/ 的目录名 */
  section: string
  dirAbs: string
  dirRel: string
  anchors: StoredAnchor[]
  /** derived/fulltext.txt 是否存在（扫描时顺带判断；检索覆盖范围提示与诊断统计用） */
  hasFulltext: boolean
  /** 未知顶层键（本版本不识别但必须写回保留——前向兼容） */
  extra: Record<string, unknown>
}

export interface IndexedNote {
  fm: NoteFrontMatter
  bodyMd: string
  fileAbs: string
  fileRel: string
  /** 磁盘原文的 sha1（扫描时现算；写盘成功后由 Repo 更新）——笔记冲突检测的比对基准 */
  diskHash: string
  /** 未知 front-matter 键（写回保留） */
  extra: Record<string, unknown>
}

export interface IndexedCapture {
  rec: CaptureSidecar
  fileAbs: string
  fileRel: string
  fileName: string
  /** 无侧车的孤儿图片：id 为内存合成，用户操作时才落侧车转正 */
  orphan: boolean
  /** 未知侧车键（写回保留） */
  extra: Record<string, unknown>
}

export interface IndexedMemo {
  fm: MemoFrontMatter
  /** 正文即捕获内容 */
  text: string
  fileAbs: string
  fileRel: string
  /** 未知 front-matter 键（写回保留） */
  extra: Record<string, unknown>
}

export interface UnfiledFile {
  fileRel: string
  fileName: string
  byteSize: number
}

export interface LibraryIndex {
  entries: Map<string, IndexedEntry>
  notes: Map<string, IndexedNote>
  captures: Map<string, IndexedCapture>
  /** 收件箱速记（纯文本捕获）：id → 节点 */
  memos: Map<string, IndexedMemo>
  spaces: StudySpace[]
  papers: PapersDoc
  conflicts: LibraryConflict[]
  /** 分区文件夹里的散装文件（用户手动放进来的 PDF 等），待识别导入 */
  unfiled: UnfiledFile[]
  malformed: string[]
  /** sha256 → 条目内文件位置（由 entry.json 元数据构建，不做全量哈希） */
  shaToEntryFile: Map<string, { entryId: string; fileIndex: number }>
  shaToCapture: Map<string, string>
  /** 笔记附件（笔记/附件/<sha256>.<ext>，文件名即内容哈希） */
  shaToNoteAsset: Map<string, { abs: string; mediaType: string }>
}

/** 'fulltext' 只由 notifyFulltextIndexed 发出：后台全文索引完成的专属信号（检索不得据此重查） */
export type LibraryChangeKind = 'entries' | 'notes' | 'captures' | 'memos' | 'spaces' | 'papers' | 'conflicts' | 'fulltext'

/** 文件戳（mtime + size）：增量扫描的「未变化」判据 */
interface FileStamp {
  mtimeMs: number
  size: number
}

/** 最近一次扫描的统计（诊断/性能用；filesRead 是真正读盘解析的文件数） */
export interface ScanStats {
  durationMs: number
  /** 真正读盘 + 解析的文件数（增量命中时为 0 量级） */
  filesRead: number
  filesStated: number
  entries: number
  notes: number
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.heic', '.heif', '.tif', '.tiff', '.webp', '.gif', '.bmp'])

/** 笔记附件文件名 → MIME（不认识的扩展名返回 null） */
export function noteAssetMediaType(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return null
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff'
  }
  return map[fileName.slice(dot).toLowerCase()] ?? null
}

function emptyIndex(): LibraryIndex {
  return {
    entries: new Map(),
    notes: new Map(),
    captures: new Map(),
    memos: new Map(),
    spaces: [],
    papers: { schema: 2, feeds: [], items: [], dailyFiles: [] },
    conflicts: [],
    unfiled: [],
    malformed: [],
    shaToEntryFile: new Map(),
    shaToCapture: new Map(),
    shaToNoteAsset: new Map()
  }
}

/**
 * 读取并解析 JSON。文件不存在返回 null；**解析失败先把坏文件备份为 `<名>.broken` 再返回 null**。
 *
 * 只回退 null 是不够的：这些文件都按「整份替换」写回，坏文件被当成空内容后，
 * 用户下一次操作就会覆盖它，原内容（条目元数据、锚点、学习区、收件箱侧车）永久消失。
 */
async function readJsonSafe(abs: string): Promise<unknown | null> {
  return readJsonSafeAsync<unknown | null>(abs, null, (message) => logWarn('folder-store', message))
}

async function listDir(abs: string): Promise<Array<{ name: string; isDir: boolean }>> {
  try {
    const dirents = await readdir(abs, { withFileTypes: true })
    return dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  } catch {
    return []
  }
}

function contentHash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex')
}

export class FolderStore {
  readonly root: string
  private idx: LibraryIndex = emptyIndex()
  private listeners = new Set<(kinds: LibraryChangeKind[]) => void>()
  private watcher: ReturnType<typeof watch> | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  private periodTimer: NodeJS.Timeout | null = null
  private scanChain: Promise<void> = Promise.resolve()
  /**
   * 增量扫描缓存：文件绝对路径 → 上次扫描时的戳（mtime+size）。
   * 与「上一次索引里的解析结果」配合，未变的文件不读盘、不解析（每次保存触发的重扫因此降为统计级）。
   * 键只在「本次扫描实际访问过」的路径上重建 → 自动剪枝。
   */
  private statCache = new Map<string, FileStamp>()
  private scanFilesRead = 0
  private scanFilesStated = 0
  lastScanStats: ScanStats = { durationMs: 0, filesRead: 0, filesStated: 0, entries: 0, notes: 0 }

  constructor(root: string) {
    this.root = root
  }

  get index(): LibraryIndex {
    return this.idx
  }

  /** 确保库骨架存在（新用户 / 被同步软件清空的库） */
  ensureSkeleton(): void {
    for (const dir of [DIR_ENTRIES, DIR_NOTES, DIR_CAPTURES, DIR_CACHE]) {
      mkdirSync(join(this.root, dir), { recursive: true })
    }
    mkdirSync(join(this.root, DIR_ENTRIES, SECTION_INBOX), { recursive: true })
    mkdirSync(join(this.root, DIR_CAPTURES, DIR_MEMOS), { recursive: true })
  }

  onChange(cb: (kinds: LibraryChangeKind[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(kinds: LibraryChangeKind[]): void {
    if (kinds.length === 0) return
    for (const cb of this.listeners) {
      try {
        cb(kinds)
      } catch (err) {
        console.error('[mathwb] library change listener failed:', err)
      }
    }
  }

  /** 实体写入方在定向更新索引后手动广播变更种类 */
  notify(kinds: LibraryChangeKind[]): void {
    this.emit(kinds)
  }

  /** 立即全扫（实体写入方在定向更新不可靠时兜底调用） */
  async rescanNow(): Promise<void> {
    await this.scanChain
    await this.scan()
  }

  /** 扫描串行化：并发触发时排队执行，避免索引交错 */
  private enqueueScan(): Promise<void> {
    const run = () => this.scan()
    this.scanChain = this.scanChain.then(run, run)
    return this.scanChain
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      void this.enqueueScan().catch((err) => { logWarn('library-watch', `rescan failed: ${err instanceof Error ? err.message : String(err)}`); console.error('[mathwb] rescan failed:', err) })
    }, 300)
  }

  /** fs.watch 递归监听（Windows/macOS 均支持）；iCloud 外部写入由此进入索引 */
  startWatch(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (filename && (isTempName(filename) || filename.includes(`${sep}.cache${sep}`) || filename.startsWith('.cache'))) return
        this.scheduleRescan()
      })
      this.watcher.on('error', (err) => { logWarn('library-watch', `watcher error: ${err instanceof Error ? err.message : String(err)}`); console.error('[mathwb] library watcher error:', err) })
      // 监听流建立的一瞬间可能丢掉紧接着发生的写入（macOS FSEvents 实测；iCloud 恰在启动时落盘同理）。
      // 就绪后补一次防抖重扫兜住这个窗口——代价是一次后台扫描，不进启动关键路径。
      this.scheduleRescan()
    } catch (err) {
      console.error('[mathwb] library watcher unavailable:', err)
    }
    // 周期全扫兜底：网盘占位文件/监听丢失时保证最终一致
    this.periodTimer = setInterval(
      () => {
        void this.enqueueScan().catch(() => {})
      },
      5 * 60_000
    )
    this.periodTimer.unref?.()
  }

  stopWatch(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = null
    if (this.periodTimer) clearInterval(this.periodTimer)
    this.periodTimer = null
  }

  /** 文件戳（mtime+size）；不存在返回 null。用于增量扫描的「没变就跳过」判据 */
  private async stampOf(abs: string): Promise<FileStamp | null> {
    this.scanFilesStated++
    try {
      const st = await stat(abs)
      return { mtimeMs: st.mtimeMs, size: st.size }
    } catch {
      return null
    }
  }

  /** 两个戳是否代表同一状态（都为 null = 都没这个文件，也算未变） */
  private sameStamp(prev: FileStamp | undefined, current: FileStamp | null): boolean {
    if (!prev || !current) return prev == null && current == null
    return prev.mtimeMs === current.mtimeMs && prev.size === current.size
  }

  async scan(): Promise<void> {
    const t0 = performance.now()
    const prev = this.idx
    const next = emptyIndex()
    const nextStat = new Map<string, FileStamp>()
    this.scanFilesRead = 0
    this.scanFilesStated = 0
    this.ensureSkeleton()

    // 顶层注册文件
    const spacesRaw = await readJsonSafe(join(this.root, FILE_SPACES))
    if (spacesRaw === null && existsSync(join(this.root, FILE_SPACES))) next.malformed.push(FILE_SPACES)
    next.spaces = normalizeSpacesDoc(spacesRaw).spaces

    const papersRaw = await readJsonSafe(join(this.root, FILE_PAPERS))
    if (papersRaw === null && existsSync(join(this.root, FILE_PAPERS))) next.malformed.push(FILE_PAPERS)
    next.papers = normalizePapersDoc(papersRaw)

    // 文献条目：文献库/<分区>/<条目>/entry.json
    const entriesDir = join(this.root, DIR_ENTRIES)
    const prevEntryByDir = new Map<string, IndexedEntry>()
    for (const e of prev.entries.values()) prevEntryByDir.set(e.dirAbs, e)
    for (const sectionItem of await listDir(entriesDir)) {
      if (sectionItem.name.startsWith('.')) continue
      if (!sectionItem.isDir) {
        // 分区根下的散装文件（用户直接拖进来的）
        this.collectUnfiled(next, join(entriesDir, sectionItem.name), join(DIR_ENTRIES, sectionItem.name), sectionItem.name)
        this.noteConflict(next, join(DIR_ENTRIES, sectionItem.name), 'file')
        continue
      }
      const section = sectionItem.name
      const sectionDir = join(entriesDir, section)
      for (const item of await listDir(sectionDir)) {
        if (item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue
        const entryDir = join(sectionDir, item.name)
        const dirRel = join(DIR_ENTRIES, section, item.name)
        this.noteConflict(next, dirRel, 'dir')
        if (!item.isDir) {
          this.collectUnfiled(next, entryDir, dirRel, item.name)
          continue
        }
        const entryJsonPath = join(entryDir, FILE_ENTRY)
        const entryJsonStamp = await this.stampOf(entryJsonPath)
        if (entryJsonStamp === null) {
          next.malformed.push(`${dirRel}（缺 entry.json）`)
          continue
        }
        nextStat.set(entryJsonPath, entryJsonStamp)
        // 条目内部的冲突副本（iCloud/网盘同步产生的「(冲突副本)」文件）：
        // 目录 mtime 未变 = 不可能新增/改名文件 → 跳过 readdir（这是重扫里最大的一笔固定开销）
        const dirStamp = await this.stampOf(entryDir)
        if (dirStamp) nextStat.set(entryDir, dirStamp)
        const dirUnchanged = dirStamp !== null && this.sameStamp(this.statCache.get(entryDir), dirStamp)
        if (!dirUnchanged) {
          for (const inner of await listDir(entryDir)) {
            if (inner.name.startsWith('.') || SKIP_DIRS.has(inner.name)) continue
            const pattern = detectConflictName(inner.name)
            if (pattern) next.conflicts.push(toConflict(join(dirRel, inner.name), 'file', pattern))
          }
        }
        const anchorsPath = join(entryDir, FILE_ANCHORS)
        const anchorsStamp = await this.stampOf(anchorsPath)
        if (anchorsStamp) nextStat.set(anchorsPath, anchorsStamp)
        // 增量：entry.json 与 anchors.json 都没变（且上次已有解析结果）→ 复用，不读盘不解析
        const cached = prevEntryByDir.get(entryDir)
        let meta: EntryMeta
        let anchors: StoredAnchor[]
        let extra: Record<string, unknown>
        if (cached && this.sameStamp(this.statCache.get(entryJsonPath), entryJsonStamp) && this.sameStamp(this.statCache.get(anchorsPath), anchorsStamp)) {
          meta = cached.meta
          anchors = cached.anchors
          extra = cached.extra
        } else {
          this.scanFilesRead++
          const normalized = normalizeEntryMeta(await readJsonSafe(entryJsonPath))
          if (!normalized) {
            next.malformed.push(`${dirRel}（entry.json 无法解析）`)
            continue
          }
          meta = normalized.meta
          extra = normalized.extra
          this.scanFilesRead++
          anchors = normalizeAnchors(await readJsonSafe(anchorsPath))
        }
        // 声明文件 ↔ 盘上对账：iCloud 等同步盘会改写超长文件名（切头/切尾/丢扩展名），
        // entry.json 声明的名字可能对应不上盘上文件，条目因此「打不开、像没有文件」。
        // 按「字节大小 + PDF 头」认领同目录未匹配文件，只在内存修正 f.name——
        // 不回写 entry.json：同步盘还在继续改名，回写会跟它来回打架；每次扫描重新对账。
        // 只在「确实有声明文件缺失」时才做这一步（否则每个条目每轮都要 readdir+stat 一遍）
        if (meta.files.some((f) => f.byteSize > 0 && !existsSync(join(entryDir, f.name)))) {
          try {
            const diskFiles: Array<{ name: string; size: number; claimed: boolean }> = []
            for (const inner of await listDir(entryDir)) {
              if (inner.isDir || inner.name.startsWith('.') || isTempName(inner.name)) continue
              if (inner.name === FILE_ENTRY || inner.name === FILE_ANCHORS || SKIP_DIRS.has(inner.name)) continue
              const st = await stat(join(entryDir, inner.name))
              diskFiles.push({ name: inner.name, size: st.size, claimed: false })
            }
            for (const f of meta.files) {
              if (!f.byteSize || existsSync(join(entryDir, f.name))) continue
              const wantPdf = f.mediaType === 'application/pdf'
              const hit = diskFiles.find((d) => !d.claimed && d.size === f.byteSize && (!wantPdf || sniffPdfHead(join(entryDir, d.name))))
              if (hit) {
                hit.claimed = true
                f.name = hit.name
              }
            }
          } catch (err) {
            logWarn('folder-store', err instanceof Error ? err.message : String(err))
          }
        }
        const indexed: IndexedEntry = {
          meta,
          section,
          dirAbs: entryDir,
          dirRel,
          anchors,
          hasFulltext: existsSync(join(entryDir, 'derived', 'fulltext.txt')),
          extra
        }
        next.entries.set(meta.id, indexed)
        meta.files.forEach((f, i) => {
          if (f.sha256) next.shaToEntryFile.set(f.sha256, { entryId: meta.id, fileIndex: i })
        })
      }
    }

    // 笔记：笔记/*.md
    const notesDir = join(this.root, DIR_NOTES)
    const prevNoteByFile = new Map<string, IndexedNote>()
    for (const n of prev.notes.values()) prevNoteByFile.set(n.fileAbs, n)
    for (const item of await listDir(notesDir)) {
      if (item.isDir || !item.name.endsWith('.md') || item.name.startsWith('.')) continue
      const fileAbs = join(notesDir, item.name)
      const fileRel = join(DIR_NOTES, item.name)
      this.noteConflict(next, fileRel, 'file')
      const stamp = await this.stampOf(fileAbs)
      if (!stamp) continue
      nextStat.set(fileAbs, stamp)
      const cachedNote = prevNoteByFile.get(fileAbs)
      if (cachedNote && this.sameStamp(this.statCache.get(fileAbs), stamp)) {
        // 增量：文件没变 → 复用上次的解析结果（含 diskHash，不重算）
        next.notes.set(cachedNote.fm.id, cachedNote)
        continue
      }
      this.scanFilesRead++
      let text: string
      try {
        text = await readFile(fileAbs, 'utf8')
      } catch {
        continue
      }
      const parsed = parseNoteMarkdown(text)
      if (!parsed) {
        next.malformed.push(`${fileRel}（front-matter 无法解析）`)
        continue
      }
      next.notes.set(parsed.fm.id, {
        fm: parsed.fm,
        bodyMd: parsed.bodyMd,
        fileAbs,
        fileRel,
        // 与 Repo 写盘后的同一算法：sha1(磁盘原文)。扫描已读全文，这里零额外 IO
        diskHash: createHash('sha1').update(text, 'utf8').digest('hex'),
        extra: parsed.extra
      })
    }

    // 笔记附件：笔记/附件/<sha256>.<ext>（文件名即内容哈希，与 entry 文件同策略——不做全量哈希）
    const noteAssetsDir = join(this.root, DIR_NOTES, DIR_NOTE_ASSETS)
    for (const item of await listDir(noteAssetsDir)) {
      if (item.isDir || item.name.startsWith('.') || isTempName(item.name)) continue
      const m = /^([0-9a-f]{64})\.(png|jpe?g|gif|webp|bmp|heic|heif|tiff?)$/i.exec(item.name)
      if (!m) continue
      const mediaType = noteAssetMediaType(item.name)
      if (!mediaType) continue
      next.shaToNoteAsset.set(m[1].toLowerCase(), {
        abs: join(noteAssetsDir, item.name),
        mediaType
      })
    }

    // 收件箱：图片 + 同名 .json 侧车
    const capsDir = join(this.root, DIR_CAPTURES)
    const seenImages = new Set<string>()
    const prevCapByFile = new Map<string, IndexedCapture>()
    for (const c of prev.captures.values()) prevCapByFile.set(c.fileAbs, c)
    for (const item of await listDir(capsDir)) {
      if (item.isDir || item.name.startsWith('.') || isTempName(item.name)) continue
      const fileRel = join(DIR_CAPTURES, item.name)
      this.noteConflict(next, fileRel, 'file')
      const ext = item.name.slice(item.name.lastIndexOf('.')).toLowerCase()
      if (IMAGE_EXTS.has(ext)) {
        seenImages.add(item.name)
        const fileAbs = join(capsDir, item.name)
        const imageStamp = await this.stampOf(fileAbs)
        if (!imageStamp) continue
        nextStat.set(fileAbs, imageStamp)
        const sidecarAbs = join(capsDir, `${item.name}.json`)
        const sidecarStamp = await this.stampOf(sidecarAbs)
        if (sidecarStamp) nextStat.set(sidecarAbs, sidecarStamp)
        // 增量：图片与侧车都没变 → 复用上次解析结果（byteSize 等一并复用）
        const cachedCap = prevCapByFile.get(fileAbs)
        if (cachedCap && this.sameStamp(this.statCache.get(fileAbs), imageStamp) && this.sameStamp(this.statCache.get(sidecarAbs), sidecarStamp)) {
          next.captures.set(cachedCap.rec.id, cachedCap)
          if (cachedCap.rec.sha256) next.shaToCapture.set(cachedCap.rec.sha256, cachedCap.rec.id)
          continue
        }
        const byteSize = imageStamp.size
        const sidecarRaw = sidecarStamp ? await readJsonSafe(sidecarAbs) : null
        if (sidecarRaw === null) {
          // 孤儿图片：合成内存身份，不落盘
          const orphan: CaptureSidecar = {
            schema: 2,
            id: `orphan-${contentHash(fileRel).slice(0, 8)}`,
            mediaType: ext === '.png' ? 'image/png' : 'image/jpeg',
            byteSize,
            sha256: '',
            context: null,
            inboxStatus: 'inbox',
            spaceId: null,
            createdAt: new Date(0).toISOString()
          }
          next.captures.set(orphan.id, { rec: orphan, fileAbs, fileRel, fileName: item.name, orphan: true, extra: {} })
        } else {
          this.scanFilesRead++
          const sidecar = normalizeCaptureSidecar(sidecarRaw)
          if (!sidecar) {
            next.malformed.push(`${fileRel}（侧车无法解析）`)
            continue
          }
          const rec = sidecar.rec
          next.captures.set(rec.id, { rec, fileAbs, fileRel, fileName: item.name, orphan: false, extra: sidecar.extra })
          if (rec.sha256) next.shaToCapture.set(rec.sha256, rec.id)
        }
      } else if (item.name.endsWith('.json')) {
        const imageName = item.name.slice(0, -'.json'.length)
        if (!seenImages.has(imageName)) next.malformed.push(`${fileRel}（侧车无对应图片）`)
      }
    }

    // 收件箱速记：收件箱/速记/*.md（front-matter + 正文；与笔记同一套增量与容错策略）
    const memoDir = join(this.root, DIR_CAPTURES, DIR_MEMOS)
    const prevMemoByFile = new Map<string, IndexedMemo>()
    for (const mo of prev.memos.values()) prevMemoByFile.set(mo.fileAbs, mo)
    for (const item of await listDir(memoDir)) {
      if (item.isDir || !item.name.endsWith('.md') || item.name.startsWith('.') || isTempName(item.name)) continue
      const fileAbs = join(memoDir, item.name)
      const fileRel = join(DIR_CAPTURES, DIR_MEMOS, item.name)
      this.noteConflict(next, fileRel, 'file')
      const stamp = await this.stampOf(fileAbs)
      if (!stamp) continue
      nextStat.set(fileAbs, stamp)
      const cachedMemo = prevMemoByFile.get(fileAbs)
      if (cachedMemo && this.sameStamp(this.statCache.get(fileAbs), stamp)) {
        // 增量：文件没变 → 复用上次解析结果
        next.memos.set(cachedMemo.fm.id, cachedMemo)
        continue
      }
      this.scanFilesRead++
      let raw: string
      try {
        raw = await readFile(fileAbs, 'utf8')
      } catch {
        continue
      }
      const parsedMemo = parseMemoMarkdown(raw)
      if (!parsedMemo) {
        next.malformed.push(`${fileRel}（front-matter 无法解析）`)
        continue
      }
      next.memos.set(parsedMemo.fm.id, {
        fm: parsedMemo.fm,
        text: parsedMemo.text,
        fileAbs,
        fileRel,
        extra: parsedMemo.extra
      })
    }

    // 冲突副本（目录级已逐项检测；去重）
    next.conflicts = dedupeConflicts(next.conflicts)

    // 提交：交换索引与增量缓存（只保留本轮访问过的路径 → 自动剪枝），并记录扫描统计
    this.statCache = nextStat
    this.lastScanStats = {
      durationMs: Math.round(performance.now() - t0),
      filesRead: this.scanFilesRead,
      filesStated: this.scanFilesStated,
      entries: next.entries.size,
      notes: next.notes.size
    }
    this.idx = next
    const kinds = diffKinds(prev, next)
    this.emit(kinds)
  }

  private collectUnfiled(index: LibraryIndex, abs: string, rel: string, name: string): void {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
    if (ext === '.pdf' || ext === '.html' || ext === '.htm') {
      let byteSize = 0
      try {
        byteSize = statSync(abs).size
      } catch {
        return
      }
      index.unfiled.push({ fileRel: rel, fileName: name, byteSize })
    }
  }

  private noteConflict(index: LibraryIndex, relPath: string, kind: 'file' | 'dir'): void {
    const base = relPath.split(sep).pop() ?? relPath
    const pattern = detectConflictName(base)
    if (pattern) index.conflicts.push(toConflict(relPath, kind === 'dir' ? 'folder' : 'file', pattern))
  }
}

function dedupeConflicts(list: LibraryConflict[]): LibraryConflict[] {
  const seen = new Set<string>()
  return list.filter((c) => {
    if (seen.has(c.path)) return false
    seen.add(c.path)
    return true
  })
}

function diffKinds(prev: LibraryIndex, next: LibraryIndex): LibraryChangeKind[] {
  const kinds: LibraryChangeKind[] = []
  const entrySig = (m: LibraryIndex) => {
    let acc = ''
    for (const [id, e] of m.entries) acc += `${id}:${contentHash([e.meta, e.section, e.anchors, e.dirRel])};`
    return acc
  }
  if (entrySig(prev) !== entrySig(next) || contentHash(prev.unfiled) !== contentHash(next.unfiled)) kinds.push('entries')
  const noteSig = (m: LibraryIndex) => {
    let acc = ''
    for (const [id, n] of m.notes) acc += `${id}:${contentHash([n.fm, n.bodyMd, n.fileRel])};`
    return acc
  }
  if (noteSig(prev) !== noteSig(next)) kinds.push('notes')
  const capSig = (m: LibraryIndex) => {
    let acc = ''
    for (const [id, c] of m.captures) acc += `${id}:${contentHash([c.rec, c.fileRel])};`
    return acc
  }
  if (capSig(prev) !== capSig(next)) kinds.push('captures')
  const memoSig = (m: LibraryIndex) => {
    let acc = ''
    for (const [id, mo] of m.memos) acc += `${id}:${contentHash([mo.fm, mo.text, mo.fileRel])};`
    return acc
  }
  if (memoSig(prev) !== memoSig(next)) kinds.push('memos')
  if (JSON.stringify(prev.spaces) !== JSON.stringify(next.spaces)) kinds.push('spaces')
  if (JSON.stringify(prev.papers) !== JSON.stringify(next.papers)) kinds.push('papers')
  if (JSON.stringify(prev.conflicts) !== JSON.stringify(next.conflicts)) kinds.push('conflicts')
  return kinds
}

export type { PapersDoc, StoredAnchor, NoteFrontMatter, MemoFrontMatter }
