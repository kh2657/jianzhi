import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrateSqliteLibrary } from '../src/main/storage/migrate-from-sqlite'
import { FolderStore } from '../src/main/storage/folder-store'
import { Repo } from '../src/main/storage/repo'
import { ImageVariants } from '../src/main/assets/images'
import { FILE_ENTRY, SECTION_INBOX, parseNoteMarkdown } from '../src/main/storage/folder-index'

let root: string
let dbPath: string

const SHA = 'ab'.repeat(32)
const SHA_PHOTO = 'cd'.repeat(32)

/** 手工建 v1 最小 schema 并填充典型数据（文档+锚点+墨迹+阅读位置+精读卡、笔记、照片、订阅） */
function buildOldLibrary(dir: string): void {
  mkdirSync(join(dir, 'assets', 'ab', 'cd'), { recursive: true })
  copyFileSync('fixtures/text-basic.pdf', join(dir, 'assets', 'ab', 'cd', `${SHA}.pdf`))
  mkdirSync(join(dir, 'assets', 'cd', 'ef'), { recursive: true })
  copyFileSync('fixtures/photo.png', join(dir, 'assets', 'cd', 'ef', `${SHA_PHOTO}.png`))

  const db = new Database(join(dir, 'library.db'))
  db.exec(`
    CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, created_at TEXT);
    CREATE TABLE assets (id TEXT PRIMARY KEY, sha256 TEXT, media_type TEXT, byte_size INTEGER, rel_path TEXT, original_name TEXT, created_at TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, doc_type TEXT, title TEXT, authors TEXT, note TEXT, created_at TEXT, updated_at TEXT, space_id TEXT);
    CREATE TABLE document_versions (id TEXT PRIMARY KEY, document_id TEXT, asset_id TEXT, fingerprint TEXT, page_count INTEGER, imported_at TEXT);
    CREATE TABLE anchors (id TEXT PRIMARY KEY, document_version_id TEXT, page_index INTEGER, page_label TEXT, rects_json TEXT, quote TEXT, created_at TEXT);
    CREATE TABLE page_annotations (id TEXT PRIMARY KEY, document_version_id TEXT, page_index INTEGER, strokes_json TEXT, updated_at TEXT);
    CREATE TABLE reading_state (document_id TEXT PRIMARY KEY, page_index INTEGER, scale REAL, rotation INTEGER, updated_at TEXT);
    CREATE TABLE reading_workspaces (document_id TEXT PRIMARY KEY, payload_json TEXT, updated_at TEXT);
    CREATE TABLE notes (id TEXT PRIMARY KEY, note_type TEXT, title TEXT, aliases_json TEXT, body_md TEXT, verified_status TEXT, revision_no INTEGER, created_at TEXT, updated_at TEXT, space_id TEXT);
    CREATE TABLE note_sources (id TEXT PRIMARY KEY, note_id TEXT, anchor_id TEXT, capture_id TEXT, created_at TEXT);
    CREATE TABLE note_document_sources (note_id TEXT, document_id TEXT, created_at TEXT);
    CREATE TABLE captures (id TEXT PRIMARY KEY, asset_id TEXT, context TEXT, inbox_status TEXT, created_at TEXT, space_id TEXT);
    CREATE TABLE paper_feeds (id TEXT PRIMARY KEY, name TEXT, categories TEXT, keywords TEXT, max_results INTEGER, sort_key INTEGER, created_at TEXT);
    CREATE TABLE paper_items (id TEXT PRIMARY KEY, base_id TEXT, version TEXT, arxiv_id TEXT, title TEXT, authors_json TEXT, abstract TEXT, primary_category TEXT, published_at TEXT, pdf_url TEXT, abs_url TEXT, status TEXT, document_id TEXT, fetched_at TEXT, updated_at TEXT);
    CREATE TABLE paper_feed_matches (item_id TEXT, feed_id TEXT);
    CREATE TABLE paper_daily_files (file_name TEXT, digest TEXT, imported_at TEXT);
  `)
  db.prepare("INSERT INTO spaces VALUES ('sp1', '概率论', 'course', 't')").run()
  db.prepare("INSERT INTO assets VALUES ('a1', ?, 'application/pdf', ?, 'ab/cd/" + `${SHA}.pdf` + "', '教材.pdf', 't')").run(SHA, readFileSync('fixtures/text-basic.pdf').length)
  db.prepare("INSERT INTO assets VALUES ('a2', ?, 'image/png', ?, 'cd/ef/" + `${SHA_PHOTO}.png` + "', 'photo.png', 't')").run(SHA_PHOTO, readFileSync('fixtures/photo.png').length)
  db.prepare("INSERT INTO documents VALUES ('d1', 'book', '原教材', '张三, 李四', '备注', 't1', 't2', 'sp1')").run()
  db.prepare("INSERT INTO document_versions VALUES ('v1', 'd1', 'a1', 'fp123', 3, 't')").run()
  db.prepare("INSERT INTO anchors VALUES ('an1', 'v1', 2, '14', '[[10,20,30,40]]', '原摘录', 't')").run()
  db.prepare("INSERT INTO page_annotations VALUES ('ink1', 'v1', 0, '[{\"k\":\"pen\",\"c\":\"#111111\",\"w\":2,\"pts\":[[1,1],[2,2]]}]', 't')").run()
  db.prepare("INSERT INTO reading_state VALUES ('d1', 2, 1.5, 90, '2026-10-05T00:00:00.000Z')").run()
  db.prepare("INSERT INTO reading_workspaces VALUES ('d1', '{\"documentId\":\"d1\",\"coreQuestion\":\"？\",\"phase\":\"reading\",\"activeTab\":\"notes\",\"notesScope\":\"page\",\"expandedNoteId\":null,\"quickDraft\":\"\",\"resolvedNoteIds\":[],\"sections\":[],\"updatedAt\":null}', 't')").run()
  db.prepare("INSERT INTO notes VALUES ('n1', 'concept', '弱收敛', '[\"weak convergence\"]', '正文', 'checked', 4, 't1', 't2', NULL)").run()
  db.prepare("INSERT INTO note_sources VALUES ('s1', 'n1', 'an1', NULL, 't')").run()
  db.prepare("INSERT INTO note_document_sources VALUES ('n1', 'd1', 't')").run()
  db.prepare("INSERT INTO captures VALUES ('c1', 'a2', '第三章演草', 'inbox', 't', NULL)").run()
  db.prepare("INSERT INTO paper_feeds VALUES ('f1', '泛函分析', 'math.FA', '', 50, 1, 't')").run()
  db.prepare("INSERT INTO paper_items VALUES ('p1', '2601.00001', 'v1', '2601.00001v1', '论文', '[\"A\"]', '摘要', 'math.FA', '2026-10-01T00:00:00Z', 'https://arxiv.org/pdf/2601.00001v1', 'https://arxiv.org/abs/2601.00001v1', 'new', NULL, 't', 't')").run()
  db.prepare("INSERT INTO paper_feed_matches VALUES ('p1', 'f1')").run()
  db.prepare("INSERT INTO paper_daily_files VALUES ('day1.json', 'digest1', 't')").run()
  db.close()
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mathwb-migrate-'))
  dbPath = join(root, 'library.db')
  buildOldLibrary(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('v1 SQLite → v2 文件夹迁移', () => {
  let entriesBefore: number

  it('迁移生成新结构并统计', async () => {
    const r = await migrateSqliteLibrary(root)
    expect(r.entries).toBe(1)
    expect(r.anchors).toBe(1)
    expect(r.notes).toBe(1)
    expect(r.captures).toBe(1)
    expect(r.spaces).toBe(1)
    expect(r.feeds).toBe(1)
    expect(r.items).toBe(1)
    expect(r.warnings).toEqual([])
    entriesBefore = r.entries
  })

  it('条目：entry.json 字段完整、原件字节一致、锚点/墨迹/精读卡就位', async () => {
    const library = new FolderStore(root)
    await library.scan()
    const entry = [...library.index.entries.values()][0]
    expect(entry).toBeDefined()
    expect(entry!.section).toBe(SECTION_INBOX)
    expect(entry!.meta).toMatchObject({ title: '原教材', docType: 'book', spaceId: 'sp1', authors: ['张三', '李四'], note: '备注' })
    expect(entry!.meta.files[0].sha256).toBe(SHA)
    expect(entry!.meta.readingState).toMatchObject({ pageIndex: 2, scale: 1.5, rotation: 90, lastReadAt: '2026-10-05T00:00:00.000Z' })
    expect(readFileSync(join(entry!.dirAbs, entry!.meta.files[0].name)).length).toBe(readFileSync('fixtures/text-basic.pdf').length)
    expect(entry!.anchors).toHaveLength(1)
    expect(entry!.anchors[0]).toMatchObject({ fileSha: SHA, pageIndex: 2, rects: [[10, 20, 30, 40]], quote: '原摘录' })
    expect(JSON.parse(readFileSync(join(entry!.dirAbs, FILE_ENTRY), 'utf8')).schema).toBe(2)
    // 墨迹：不仅要落文件，还必须与运行时 Repo.inkGet 的读取契约一致
    //（旧实现把 v1 的 strokes_json 原样写入，inkGet 读到 undefined → 全部手写批注静默丢失）
    const inkFile = join(entry!.dirAbs, 'ink', SHA.slice(0, 8), 'p0.json')
    expect(existsSync(inkFile)).toBe(true)
    const ink = JSON.parse(readFileSync(inkFile, 'utf8')) as { versionId?: string; pageIndex?: number; strokes?: unknown[] }
    expect(ink.versionId).toBe(SHA)
    expect(ink.pageIndex).toBe(0)
    expect(Array.isArray(ink.strokes)).toBe(true)
    expect(ink.strokes).toHaveLength(1)
    // 端到端读回：用真实 Repo 接口取一次，确保不是「写对了但读不到」
    const repo = new Repo(library, new ImageVariants(join(root, '.cache', 'variants')))
    expect(repo.inkGet(SHA, 0)).toHaveLength(1)
    expect(existsSync(join(entry!.dirAbs, '精读.json'))).toBe(true)
  })

  it('笔记 front-matter 带来源；照片带侧车；papers.json 与学习区迁移', async () => {
    const library = new FolderStore(root)
    await library.scan()
    const note = [...library.index.notes.values()][0]
    expect(note.fm).toMatchObject({ id: 'n1', title: '弱收敛', revision: 4, verifiedStatus: 'checked', aliases: ['weak convergence'] })
    expect(note.fm.sources).toEqual([
      { kind: 'anchor', id: 'an1', documentId: expect.any(String) },
      { kind: 'document', id: 'd1' }
    ])
    const cap = [...library.index.captures.values()][0]
    expect(cap?.rec).toMatchObject({ id: 'c1', context: '第三章演草', sha256: SHA_PHOTO, inboxStatus: 'inbox' })
    expect(library.index.spaces[0]).toMatchObject({ id: 'sp1', name: '概率论', kind: 'course' })
    expect(library.index.papers.feeds).toHaveLength(1)
    expect(library.index.papers.items[0]).toMatchObject({ baseId: '2601.00001', feedIds: ['f1'], feedNames: ['泛函分析'] })
    expect(library.index.papers.dailyFiles).toHaveLength(1)
  })

  it('旧产物移入备份目录，新库可直接使用', async () => {
    expect(existsSync(dbPath)).toBe(false)
    const backup = readdirOne(root, '_v1备份')
    expect(backup).toBeTruthy()
    expect(existsSync(join(root, backup!, 'library.db'))).toBe(true)
    expect(existsSync(join(root, backup!, 'assets'))).toBe(true)
    // 迁移产物可被正常扫描使用
    const library = new FolderStore(root)
    await library.scan()
    expect(library.index.entries.size).toBe(entriesBefore)
    // 笔记 md 可被主实现解析
    const mdName = readdirSync(join(root, '笔记'))[0]
    const parsed = parseNoteMarkdown(readFileSync(join(root, '笔记', mdName), 'utf8'))
    expect(parsed?.fm.id).toBe('n1')
  })
})

function readdirOne(dir: string, prefix: string): string | null {
  const hit = readdirSync(dir).find((n) => n.startsWith(prefix))
  return hit ?? null
}
