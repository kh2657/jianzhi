// WP-2.3 / D5 后段：来源被删除后不再「无声消失」——getNoteFull 显式列出失效来源。
//
// 背景（docs/存储格式.md 自认未实现）：解析不到锚点/照片/材料的来源此前被静默跳过，
// 笔记的「来源与关联」会无声减少，用户看不出发生了什么。
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

describe('笔记来源失效可见', () => {
  it('锚点来源随材料删除而失效 → 出现在 missingSources，已解析来源不受影响', async () => {
    const t: TestRepo = await makeTestRepo('wp23-missing-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const doc = t.repo.openDocument(imp.documentId!)
      const anchor = await t.repo.createAnchor({ documentVersionId: doc.versionId, pageIndex: 0, rects: [[10, 10, 40, 30]], quote: '定理' })
      const note = await t.repo.createNote({ title: '带来源', bodyMd: '正文', anchorId: anchor.id })
      const before = t.repo.getNoteFull(note.id)
      expect(before.anchors).toHaveLength(1)
      expect(before.missingSources).toEqual([])

      // 材料被整体删除（条目文件夹移除 = 用户删除文献）
      const dirAbs = t.library.index.entries.get(imp.documentId!)!.dirAbs
      rmSync(dirAbs, { recursive: true, force: true })
      const repo2 = await t.reopen()
      const after = repo2.getNoteFull(note.id)
      expect(after.anchors).toHaveLength(0)
      expect(after.missingSources).toEqual([{ kind: 'anchor', id: anchor.id }])
      // 笔记本体与其它来源不受影响
      expect(after.note.bodyMd).toBe('正文')
    } finally { t.dispose() }
  }, 60000)

  it('材料级来源（document）失效同样可见', async () => {
    const t: TestRepo = await makeTestRepo('wp23-missing-doc-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const note = await t.repo.createNote({ title: '材料笔记', bodyMd: '正文', documentId: imp.documentId! })
      expect(t.repo.getNoteFull(note.id).documents).toHaveLength(1)

      rmSync(t.library.index.entries.get(imp.documentId!)!.dirAbs, { recursive: true, force: true })
      const repo2 = await t.reopen()
      const after = repo2.getNoteFull(note.id)
      expect(after.documents).toHaveLength(0)
      expect(after.missingSources).toEqual([{ kind: 'document', id: imp.documentId }])
    } finally { t.dispose() }
  }, 60000)

  it('照片来源失效同样可见', async () => {
    const t: TestRepo = await makeTestRepo('wp23-missing-cap-')
    try {
      const [cap] = await t.repo.importCaptures(['fixtures/photo.png'], '演草')
      const note = await t.repo.createNote({ title: '照片笔记', bodyMd: '正文' })
      const attached = await t.repo.attachCapture(note.id, cap.captureId!)
      expect(attached.ok).toBe(true)
      expect(t.repo.getNoteFull(note.id).captures).toHaveLength(1)

      // 删除收件箱文件与侧车（用户在文件夹里清理）
      const fileAbs = t.library.index.captures.get(cap.captureId!)!.fileAbs
      rmSync(fileAbs, { force: true })
      rmSync(`${fileAbs}.json`, { force: true })
      const repo2 = await t.reopen()
      const after = repo2.getNoteFull(note.id)
      expect(after.captures).toHaveLength(0)
      expect(after.missingSources).toEqual([{ kind: 'capture', id: cap.captureId }])
    } finally { t.dispose() }
  }, 60000)

  it('来源全部有效时 missingSources 为空（避免常驻噪声）', async () => {
    const t: TestRepo = await makeTestRepo('wp23-ok-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const doc = t.repo.openDocument(imp.documentId!)
      const anchor = await t.repo.createAnchor({ documentVersionId: doc.versionId, pageIndex: 0, rects: [[1, 2, 3, 4]] })
      const note = await t.repo.createNote({ title: '正常', bodyMd: '正文', anchorId: anchor.id, documentId: imp.documentId! })
      expect(t.repo.getNoteFull(note.id).missingSources).toEqual([])
    } finally { t.dispose() }
  }, 60000)
})