// WP-2.1：条目元数据 / 收件箱侧车 / 论文库的写盘顺序统一为「先写盘、成功后才提交内存」。
//
// 修复前：这些方法先改内存对象再 await 写盘（或直接 fire-and-forget）——写失败时界面已经显示新值，
// 重启/重扫后却还原，用户以为「设置没保存」。本文件锁定新契约：
//   **写盘失败 → 方法 reject，内存索引与磁盘都保持旧值；恢复后可重试成功。**
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { readonly, writable } from './helpers/readonly-dir'

describe('条目元数据：写盘失败不留幻影', () => {
  it('updateEntryMeta：失败 reject，标题/标签/收藏都保持旧值；恢复后重试成功', async () => {
    const t: TestRepo = await makeTestRepo('wp2-entry-')
    let dirAbs = ''
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const id = imp.documentId!
      dirAbs = t.library.index.entries.get(id)!.dirAbs
      readonly(dirAbs)
      await expect(t.repo.updateEntryMeta(id, { tags: ['新标签'], starred: true, venue: 'Annals' })).rejects.toThrow()
      writable(dirAbs)
      const entry = t.repo.libraryEntryGet(id)!.entry
      expect(entry.tags).toEqual([])
      expect(entry.starred).toBeUndefined()
      expect(entry.venue).toBe(null)
      // 磁盘同样未变
      expect(readFileSync(join(dirAbs, 'entry.json'), 'utf8')).not.toContain('新标签')

      await t.repo.updateEntryMeta(id, { tags: ['新标签'], starred: true })
      expect(t.repo.libraryEntryGet(id)!.entry.tags).toEqual(['新标签'])
      expect(t.repo.libraryEntryGet(id)!.entry.starred).toBe(true)
    } finally {
      if (dirAbs) writable(dirAbs)
      t.dispose()
    }
  }, 60000)

  it('updateDocument（改名）：失败 reject，标题与文件夹名都不变', async () => {
    const t: TestRepo = await makeTestRepo('wp2-doc-')
    let dirAbs = ''
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const id = imp.documentId!
      dirAbs = t.library.index.entries.get(id)!.dirAbs
      readonly(dirAbs)
      await expect(t.repo.updateDocument(id, { title: '改名后' })).rejects.toThrow()
      writable(dirAbs)
      expect(t.repo.libraryEntryGet(id)!.entry.title).toBe('text-basic')
      expect(existsSync(join(dirAbs, 'entry.json'))).toBe(true)
    } finally {
      if (dirAbs) writable(dirAbs)
      t.dispose()
    }
  }, 60000)

  it('setEntryNeedsReview：失败 reject，状态保持旧值', async () => {
    const t: TestRepo = await makeTestRepo('wp2-review-')
    let dirAbs = ''
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const id = imp.documentId!
      // 导入的 PDF 默认 needs-review；先置 ok 再测失败路径
      await t.repo.setEntryNeedsReview(id, false)
      expect(t.repo.libraryEntryGet(id)!.entry.status).toBe('ok')
      dirAbs = t.library.index.entries.get(id)!.dirAbs
      readonly(dirAbs)
      await expect(t.repo.setEntryNeedsReview(id, true)).rejects.toThrow()
      writable(dirAbs)
      expect(t.repo.libraryEntryGet(id)!.entry.status).toBe('ok')
    } finally {
      if (dirAbs) writable(dirAbs)
      t.dispose()
    }
  }, 60000)
})

describe('收件箱侧车：写盘失败不留幻影', () => {
  it('saveCapture：失败 reject，备注与归档状态保持旧值；重启后确认落盘', async () => {
    const t: TestRepo = await makeTestRepo('wp2-capture-')
    const capsDir = join(t.root, '收件箱')
    try {
      const [cap] = await t.repo.importCaptures(['fixtures/photo.png'], '原始备注')
      readonly(capsDir)
      await expect(t.repo.saveCapture(cap.captureId!, { context: '改后备注', inboxStatus: 'filed' })).rejects.toThrow()
      writable(capsDir)
      const rec = t.repo.listCaptures().find((c) => c.id === cap.captureId)!
      expect(rec.context).toBe('原始备注')
      expect(rec.inboxStatus).toBe('inbox')

      await t.repo.saveCapture(cap.captureId!, { context: '改后备注', inboxStatus: 'filed' })
      const after = t.repo.listCaptures().find((c) => c.id === cap.captureId)!
      expect(after.context).toBe('改后备注')
      expect(after.inboxStatus).toBe('filed')
      const repo2 = await t.reopen()
      expect(repo2.listCaptures().find((c) => c.id === cap.captureId)!.context).toBe('改后备注')
    } finally {
      writable(capsDir)
      t.dispose()
    }
  }, 60000)
})

describe('论文库：写盘失败不留幻影', () => {
  it('paperSetStatus / paperFeedUpdate / paperMarkDailyFile：失败 reject，内存与磁盘都保持旧值', async () => {
    const t: TestRepo = await makeTestRepo('wp2-papers-')
    try {
      const feed = await t.repo.paperFeedCreate({ name: '订阅', categories: 'math.AG', keywords: '' })
      await t.repo.paperItemsUpsert(feed.id, [{
        arxivId: '2510.1v1', title: '论文一', authors: ['A'], abstract: '', primaryCategory: 'math.AG',
        categories: [], publishedAt: new Date().toISOString(), pdfUrl: 'https://arxiv.org/pdf/2510.1', absUrl: 'https://arxiv.org/abs/2510.1'
      }])
      readonly(t.root)
      await expect(t.repo.paperSetStatus('2510.1v1', 'skipped')).rejects.toThrow()
      await expect(t.repo.paperFeedUpdate(feed.id, { name: '改名' })).rejects.toThrow()
      await expect(t.repo.paperMarkDailyFile('day.json', 'digest-1')).rejects.toThrow()
      writable(t.root)
      expect(t.repo.paperGetByArxivId('2510.1v1')!.status).toBe('new')
      expect(t.repo.paperFeedList()[0].name).toBe('订阅')
      expect(t.library.index.papers.dailyFiles).toHaveLength(0)

      // 恢复后重试成功
      await t.repo.paperSetStatus('2510.1v1', 'skipped')
      await t.repo.paperMarkDailyFile('day.json', 'digest-1')
      expect(t.repo.paperGetByArxivId('2510.1v1')!.status).toBe('skipped')
      expect(t.library.index.papers.dailyFiles).toHaveLength(1)
    } finally {
      writable(t.root)
      t.dispose()
    }
  }, 60000)
})