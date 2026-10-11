// WP-6：增量扫描——未变化的文件不读盘不解析（每次保存触发的重扫从"全量读盘"降为"统计级"），
// 但外部修改、删除、新增必须照旧被发现（正确性优先于省事）。
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FolderStore } from '../src/main/storage/folder-store'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

/** 改文件内容并推进 mtime（避免同毫秒写入被当作未变） */
function externalWrite(abs: string, content: string): void {
  writeFileSync(abs, content)
  const future = new Date(Date.now() + 2000)
  utimesSync(abs, future, future)
}

async function seed(t: TestRepo): Promise<{ noteAbs: string; entryDir: string; entryJson: string }> {
  const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
  const entryDir = t.library.index.entries.get(imp.documentId!)!.dirAbs
  const note = await t.repo.createNote({ title: '增量笔记', bodyMd: '初始正文' })
  const noteAbs = t.library.index.notes.get(note.id)!.fileAbs
  await t.repo.importCaptures(['fixtures/photo.png'], '演草')
  return { noteAbs, entryDir, entryJson: join(entryDir, 'entry.json') }
}

describe('增量扫描', () => {
  it('无变化的重扫：一次读盘都不做（filesRead = 0）', async () => {
    const t: TestRepo = await makeTestRepo('wp6-warm-')
    try {
      await seed(t)
      await t.library.rescanNow() // 预热：这一轮把内容都读进来
      const warm = t.library.lastScanStats
      expect(warm.filesRead).toBeGreaterThan(0)

      await t.library.rescanNow()
      const second = t.library.lastScanStats
      expect(second.filesRead).toBe(0)
      expect(second.entries).toBe(1)
      expect(second.notes).toBe(1)
    } finally { t.dispose() }
  }, 60000)

  it('外部改笔记：只重读那一个文件，其余复用', async () => {
    const t: TestRepo = await makeTestRepo('wp6-note-')
    try {
      const { noteAbs } = await seed(t)
      await t.library.rescanNow()
      externalWrite(noteAbs, (await import('node:fs')).readFileSync(noteAbs, 'utf8').replace('初始正文', '外部改过的正文'))

      await t.library.rescanNow()
      expect(t.library.lastScanStats.filesRead).toBe(1) // 只有这一篇笔记
      const notes = [...t.library.index.notes.values()]
      expect(notes.some((n) => n.bodyMd.includes('外部改过的正文'))).toBe(true)
    } finally { t.dispose() }
  }, 60000)

  it('外部删笔记：从索引消失（缓存被剪枝）', async () => {
    const t: TestRepo = await makeTestRepo('wp6-del-')
    try {
      const { noteAbs } = await seed(t)
      await t.library.rescanNow()
      expect([...t.library.index.notes.values()]).toHaveLength(1)

      rmSync(noteAbs)
      await t.library.rescanNow()
      expect([...t.library.index.notes.values()]).toHaveLength(0)
      // 再放回来（外部恢复）→ 重新读入
      externalWrite(noteAbs, '---\nschema: 2\nid: 11111111-1111-4111-8111-111111111111\nnoteType: note\ntitle: 恢复的笔记\naliases: []\nverifiedStatus: unchecked\nspaceId: null\nrevision: 1\nsources: []\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n恢复了')
      await t.library.rescanNow()
      expect([...t.library.index.notes.values()]).toHaveLength(1)
      expect(t.library.lastScanStats.filesRead).toBe(1)
    } finally { t.dispose() }
  }, 60000)

  it('外部改 entry.json：该条目重读（entry+anchors 两个文件），其余条目复用', async () => {
    const t: TestRepo = await makeTestRepo('wp6-entry-')
    try {
      const { entryJson } = await seed(t)
      await t.library.rescanNow()
      externalWrite(entryJson, (await import('node:fs')).readFileSync(entryJson, 'utf8').replace('"title": "text-basic"', '"title": "外部改名"'))

      await t.library.rescanNow()
      expect(t.library.lastScanStats.filesRead).toBe(2) // entry.json + anchors.json
      const entry = [...t.library.index.entries.values()][0]
      expect(entry.meta.title).toBe('外部改名')
    } finally { t.dispose() }
  }, 60000)

  it('热索引与冷启动（全新 FolderStore）结果一致：内容等价', async () => {
    const t: TestRepo = await makeTestRepo('wp6-equal-')
    try {
      const { noteAbs } = await seed(t)
      await t.library.rescanNow()
      externalWrite(noteAbs, (await import('node:fs')).readFileSync(noteAbs, 'utf8').replace('初始正文', '等价性校验正文'))
      await t.library.rescanNow()

      const digest = (store: FolderStore): string => JSON.stringify({
        entries: [...store.index.entries.values()].map((e) => [e.meta.id, e.meta.title, e.section, e.anchors.length, e.hasFulltext]),
        notes: [...store.index.notes.values()].map((n) => [n.fm.id, n.fm.title, n.bodyMd, n.diskHash]),
        captures: [...store.index.captures.values()].map((c) => [c.rec.id, c.rec.context]),
        malformed: store.index.malformed
      })
      const warm = digest(t.library)

      const cold = new FolderStore(t.root)
      await cold.scan()
      expect(digest(cold)).toBe(warm)
      cold.stopWatch()
    } finally { t.dispose() }
  }, 60000)

  it('扫描统计字段健全（durationMs / stated / entries / notes）', async () => {
    const t: TestRepo = await makeTestRepo('wp6-stats-')
    try {
      await seed(t)
      await t.library.rescanNow()
      const s = t.library.lastScanStats
      expect(s.durationMs).toBeGreaterThanOrEqual(0)
      expect(s.filesStated).toBeGreaterThan(0)
      expect(s.entries).toBe(1)
      expect(s.notes).toBe(1)
    } finally { t.dispose() }
  }, 60000)
})