// WP-1 / L1：条目按稳定 id 直取（绕开检索的返回上限）。
//
// 修复前的缺陷：条目信息弹窗用 librarySearch({q:''}) 后按 id 查找，库 >200 条时
// 目标条目不在返回集里 → 弹窗报「条目不存在」（误导用户以为数据丢失）。
// 本文件锁定契约：直取接口返回与检索命中同形的条目（含文件 missing 标记），不存在返回 null。
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

describe('条目直取 libraryEntryGet', () => {
  it('按 id 取回完整条目（含 missing 标记与分区），不存在返回 null', async () => {
    const t: TestRepo = await makeTestRepo('wp1-get-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const id = imp.documentId!
      const hit = t.repo.libraryEntryGet(id)
      expect(hit?.entry.id).toBe(id)
      expect(hit?.entry.title).toBe('text-basic')
      expect(hit?.section).toBe('待整理')
      expect(hit?.entry.files[0].missing).toBe(false)

      expect(t.repo.libraryEntryGet('00000000-0000-4000-8000-000000000000')).toBeNull()

      // 原件被移走 → missing=true（UI 显示「无原件」而不是空白）
      const entry = t.library.index.entries.get(id)!
      rmSync(join(entry.dirAbs, entry.meta.files[0].name))
      expect(t.repo.libraryEntryGet(id)?.entry.files[0].missing).toBe(true)
    } finally { t.dispose() }
  }, 60000)
})