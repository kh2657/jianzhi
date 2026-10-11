// WP-1 / D1+D3：保存成功语义——先写盘、成功后提交内存。
//
// 修复前的缺陷（复现见 WP-0 报告 A4/A10）：
//   1) saveNote 先改内存对象再写盘，写盘失败后索引已超前于磁盘（getNote 返回未落盘内容）；
//   2) createSpace/updateSpace/paperFeedCreate 用 void 触发写盘，失败仍向用户返回成功，
//      错误成为 unhandledRejection（主进程无全局处理器）。
// 本文件锁定修复后的契约：**方法 resolve == 已原子落盘；失败则内存索引不变**。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { readonly, writable } from './helpers/readonly-dir'

describe('笔记保存：写盘成功才提交内存', () => {
  it('写盘失败：保存 reject，内存与磁盘都保持旧内容；恢复后重试成功', async () => {
    const t: TestRepo = await makeTestRepo('wp1-save-')
    const notesDir = join(t.root, '笔记')
    try {
      const note = await t.repo.createNote({ title: '一致性', bodyMd: '初始' })
      readonly(notesDir)
      let failed = false
      try {
        await t.repo.saveNote({ id: note.id, title: '一致性', noteType: 'note', bodyMd: '新内容', aliases: [], verifiedStatus: 'unchecked' })
      } catch { failed = true }
      writable(notesDir)
      expect(failed).toBe(true)
      // 关键契约：内存索引不得超前于磁盘
      expect(t.repo.getNoteFull(note.id).note.bodyMd).toBe('初始')
      expect(t.repo.getNote(note.id).bodyMd).toBe('初始')

      // 恢复后重试：正常保存并返回最新指纹
      const r = await t.repo.saveNote({ id: note.id, title: '一致性', noteType: 'note', bodyMd: '新内容', aliases: [], verifiedStatus: 'unchecked' })
      expect(r.conflict).toBe(false)
      expect(r.revisionNo).toBeGreaterThan(1)
      expect(t.repo.getNote(note.id).bodyMd).toBe('新内容')
      expect(r.baseHash).toBe(t.repo.getNoteFull(note.id).baseHash)
    } finally {
      try { writable(notesDir) } catch { /* ignore */ }
      t.dispose()
    }
  }, 60000)

  it('assignSpace（笔记）：写盘失败时内存归属不变', async () => {
    const t: TestRepo = await makeTestRepo('wp1-space-')
    const notesDir = join(t.root, '笔记')
    try {
      const space = await t.repo.createSpace({ name: '区A', kind: 'course' })
      const note = await t.repo.createNote({ title: '归属', bodyMd: '正文' })
      readonly(notesDir)
      await expect(t.repo.assignSpace('note', note.id, space.id)).rejects.toThrow()
      writable(notesDir)
      expect(t.repo.getNote(note.id).spaceId).toBe(null)
      await t.repo.assignSpace('note', note.id, space.id)
      expect(t.repo.getNote(note.id).spaceId).toBe(space.id)
    } finally {
      try { writable(notesDir) } catch { /* ignore */ }
      t.dispose()
    }
  }, 60000)

  it('insertNoteSource（挂来源）：写盘失败时内存来源不变', async () => {
    const t: TestRepo = await makeTestRepo('wp1-src-')
    const notesDir = join(t.root, '笔记')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const note = await t.repo.createNote({ title: '来源', bodyMd: '正文' })
      const doc = t.repo.openDocument(imp.documentId!)
      const anchor = await t.repo.createAnchor({ documentVersionId: doc.versionId, pageIndex: 0, rects: [[10, 10, 40, 30]] })
      readonly(notesDir)
      await expect(t.repo.attachAnchor(note.id, anchor.id)).rejects.toThrow()
      writable(notesDir)
      // 内存里不得出现「未落盘但已生效」的来源
      expect(t.repo.getNoteFull(note.id).anchors).toHaveLength(0)
      const ok = await t.repo.attachAnchor(note.id, anchor.id)
      expect(ok.ok).toBe(true)
      expect(t.repo.getNoteFull(note.id).anchors).toHaveLength(1)
    } finally {
      try { writable(notesDir) } catch { /* ignore */ }
      t.dispose()
    }
  }, 60000)
})

describe('设置级持久化：失败必须 reject、内存不超前', () => {
  it('createSpace：写盘失败 reject，内存不留幻影；恢复后可重试成功', async () => {
    const t: TestRepo = await makeTestRepo('wp1-cs-')
    try {
      readonly(t.root)
      await expect(t.repo.createSpace({ name: '写不进去', kind: 'course' })).rejects.toThrow()
      writable(t.root)
      expect(existsSync(join(t.root, '学习区.json'))).toBe(false)
      expect(t.repo.listSpaces()).toHaveLength(0)

      const ok = await t.repo.createSpace({ name: '写不进去', kind: 'course' })
      expect(existsSync(join(t.root, '学习区.json'))).toBe(true)
      expect(t.repo.listSpaces().some((s) => s.id === ok.id)).toBe(true)
    } finally {
      try { writable(t.root) } catch { /* ignore */ }
      t.dispose()
    }
  }, 60000)

  it('updateSpace：写盘失败 reject，名称保持旧值', async () => {
    const t: TestRepo = await makeTestRepo('wp1-us-')
    try {
      const space = await t.repo.createSpace({ name: '原名', kind: 'course' })
      readonly(t.root)
      await expect(t.repo.updateSpace(space.id, { name: '新名', kind: 'course' })).rejects.toThrow()
      writable(t.root)
      expect(t.repo.listSpaces()[0].name).toBe('原名')
      await t.repo.updateSpace(space.id, { name: '新名', kind: 'course' })
      expect(t.repo.listSpaces()[0].name).toBe('新名')
    } finally {
      try { writable(t.root) } catch { /* ignore */ }
      t.dispose()
    }
  }, 60000)

  it('paperFeedCreate：写盘失败 reject，内存不留幻影', async () => {
    const t: TestRepo = await makeTestRepo('wp1-feed-')
    try {
      readonly(t.root)
      await expect(t.repo.paperFeedCreate({ name: '订阅', categories: 'math.AG', keywords: '' })).rejects.toThrow()
      writable(t.root)
      expect(existsSync(join(t.root, 'papers.json'))).toBe(false)
      expect(t.repo.paperFeedList()).toHaveLength(0)

      const feed = await t.repo.paperFeedCreate({ name: '订阅', categories: 'math.AG', keywords: '' })
      expect(existsSync(join(t.root, 'papers.json'))).toBe(true)
      expect(t.repo.paperFeedList()[0].id).toBe(feed.id)
    } finally {
      try { writable(t.root) } catch { /* ignore */ }
      t.dispose()
    }
  }, 60000)
})