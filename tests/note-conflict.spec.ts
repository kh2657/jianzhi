// WP-1 / D2：笔记保存的冲突保护（基于磁盘内容指纹的乐观并发）。
//
// 修复前的缺陷（复现见 WP-0 报告 A3）：编辑器持有旧快照时，保存会整份覆盖磁盘上由
// 外部（另一台机器 / iCloud / 外部编辑器）写入的新版本，且无任何提示或保留。
// 本文件锁定修复后的契约：
//   - 携带与磁盘不一致的 baseHash → 拒绝写入，返回磁盘版本（供 UI 呈现与三选处理）；
//   - force 覆盖 → 先把磁盘版本保留为独立笔记，再写本地内容（双方内容都不丢）；
//   - saveAsCopy → 本地草稿另存为独立笔记（来源引用随副本保留），原笔记不动；
//   - 未携带 baseHash 的旧调用保持后写覆盖（跨版本兼容，不阻断）。
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

/** 模拟外部（另一台机器 / 同步工具 / 外部编辑器）原地改写笔记文件 */
function externalEdit(t: TestRepo, noteId: string, from: string, to: string): string {
  const fileAbs = t.library.index.notes.get(noteId)!.fileAbs
  writeFileSync(fileAbs, readFileSync(fileAbs, 'utf8').replace(from, to))
  return fileAbs
}

const draft = (over: Partial<Parameters<TestRepo['repo']['saveNote']>[0]> & { id: string }) => ({
  title: '冲突演示', noteType: 'note' as const, bodyMd: '本地内容', aliases: [], verifiedStatus: 'unchecked' as const, ...over
})

describe('笔记冲突保护：磁盘指纹乐观并发', () => {
  it('外部改写后，携带旧 baseHash 的保存被拒绝且不写盘；载荷带回磁盘版本', async () => {
    const t: TestRepo = await makeTestRepo('wp1-conf-')
    try {
      const created = await t.repo.createNote({ title: '冲突演示', bodyMd: '版本A' })
      const baseHash = t.repo.getNoteFull(created.id).baseHash
      const fileAbs = externalEdit(t, created.id, '版本A', '版本B-外部新增')
      const repo2 = await t.reopen() // 等价于 watcher 重扫后索引已识别 B

      const res = await repo2.saveNote(draft({ id: created.id, bodyMd: '版本A+本地追加', baseHash }))
      expect(res.conflict).toBe(true)
      expect(readFileSync(fileAbs, 'utf8')).toContain('版本B-外部新增') // 磁盘未被覆盖
      expect(res.disk?.bodyMd).toContain('版本B-外部新增')
      expect(res.disk?.baseHash).toBeTruthy()
      expect(res.disk?.parseFailed).toBe(false)
    } finally { t.dispose() }
  }, 60000)

  it('无外部变化：携带当前 baseHash 的保存正常写入，并返回新指纹', async () => {
    const t: TestRepo = await makeTestRepo('wp1-ok-')
    try {
      const created = await t.repo.createNote({ title: '冲突演示', bodyMd: '版本A' })
      const baseHash = t.repo.getNoteFull(created.id).baseHash
      const res = await t.repo.saveNote(draft({ id: created.id, bodyMd: '版本A+本地追加', baseHash }))
      expect(res.conflict).toBe(false)
      expect(res.revisionNo).toBe(2)
      expect(res.baseHash).toBeTruthy()
      expect(res.baseHash).not.toBe(baseHash) // 内容变化 → 指纹更新
      expect(t.repo.getNoteFull(created.id).baseHash).toBe(res.baseHash) // 后续加载拿到最新指纹
      expect(t.repo.getNote(created.id).bodyMd).toBe('版本A+本地追加')
    } finally { t.dispose() }
  }, 60000)

  it('跨版本兼容：未携带 baseHash 的旧调用保持后写覆盖（不阻断）', async () => {
    const t: TestRepo = await makeTestRepo('wp1-legacy-')
    try {
      const created = await t.repo.createNote({ title: '冲突演示', bodyMd: '版本A' })
      const fileAbs = externalEdit(t, created.id, '版本A', '版本B-外部新增')
      const repo2 = await t.reopen()
      const res = await repo2.saveNote(draft({ id: created.id, bodyMd: '旧调用覆盖' }))
      expect(res.conflict).toBe(false)
      expect(readFileSync(fileAbs, 'utf8')).toContain('旧调用覆盖')
    } finally { t.dispose() }
  }, 60000)

  it('force 覆盖：先把磁盘版本保留为独立笔记，再写本地内容（双方内容都不丢）', async () => {
    const t: TestRepo = await makeTestRepo('wp1-force-')
    try {
      const created = await t.repo.createNote({ title: '冲突演示', bodyMd: '版本A' })
      const baseHash = t.repo.getNoteFull(created.id).baseHash
      const fileAbs = externalEdit(t, created.id, '版本A', '版本B-外部新增')
      const repo2 = await t.reopen()

      const res = await repo2.saveNote(draft({ id: created.id, bodyMd: '本地内容', baseHash, force: true }))
      expect(res.conflict).toBe(false)
      expect(readFileSync(fileAbs, 'utf8')).toContain('本地内容')
      expect(res.archivedNoteId).toBeTruthy()
      const archived = repo2.getNote(res.archivedNoteId!)
      expect(archived.id).not.toBe(created.id)
      expect(archived.bodyMd).toContain('版本B-外部新增')
      // 归档笔记是普通笔记：出现在列表里，可被检索/打开
      expect(repo2.listNotes().some((n) => n.id === res.archivedNoteId)).toBe(true)
    } finally { t.dispose() }
  }, 60000)

  it('saveAsCopy：本地草稿另存为独立笔记（来源随副本保留），原笔记维持外部版本', async () => {
    const t: TestRepo = await makeTestRepo('wp1-copy-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const created = await t.repo.createNote({ title: '带来源', bodyMd: '版本A', documentId: imp.documentId! })
      expect(t.repo.getNoteFull(created.id).documents).toHaveLength(1)
      const fileAbs = externalEdit(t, created.id, '版本A', '版本B-外部新增')
      const repo2 = await t.reopen()

      const copy = await repo2.noteSaveAsCopy({
        sourceId: created.id, title: '带来源-本地稿', noteType: 'note', bodyMd: '本地草稿内容',
        aliases: ['别名X'], verifiedStatus: 'checked'
      })
      expect(copy.id).not.toBe(created.id)
      expect(repo2.getNote(copy.id).bodyMd).toBe('本地草稿内容')
      expect(repo2.getNote(copy.id).aliases).toContain('别名X')
      expect(repo2.getNoteFull(copy.id).documents).toHaveLength(1) // 来源引用随副本保留
      expect(repo2.getNote(copy.id).verifiedStatus).toBe('checked')
      expect(readFileSync(fileAbs, 'utf8')).toContain('版本B-外部新增') // 原笔记不动
    } finally { t.dispose() }
  }, 60000)

  it('外部版本不可解析时仍识别为冲突，且载荷可以原始文本兜底', async () => {
    const t: TestRepo = await makeTestRepo('wp1-broken-')
    try {
      const created = await t.repo.createNote({ title: '冲突演示', bodyMd: '版本A' })
      const baseHash = t.repo.getNoteFull(created.id).baseHash
      const fileAbs = t.library.index.notes.get(created.id)!.fileAbs
      writeFileSync(fileAbs, '外部工具写坏了 front-matter{')
      const repo2 = await t.reopen() // 坏文件不在索引里 → 保存时按磁盘读回
      const res = await repo2.saveNote(draft({ id: created.id, bodyMd: '本地内容', baseHash }))
      expect(res.conflict).toBe(true)
      expect(res.disk?.parseFailed).toBe(true)
      expect(res.disk?.bodyMd).toContain('外部工具写坏了')
      expect(readFileSync(fileAbs, 'utf8')).toContain('外部工具写坏了') // 仍然不覆盖
    } finally { t.dispose() }
  }, 60000)
})