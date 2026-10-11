import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo
let repo: TestRepo['repo']

beforeAll(async () => {
  t = await makeTestRepo('mathwb-material-')
  repo = t.repo
  const src = join(t.root, 'book.pdf')
  copyFileSync(join('fixtures', 'text-basic.pdf'), src)
  const r = await repo.importDocuments([src])
  await repo.setVersionMeta(r[0].versionId!, { pageCount: 3 })
})

afterAll(() => {
  t?.dispose()
})

describe('createAnchorWithNote：锚点+笔记组合', () => {
  const anchorInput = {
    documentVersionId: '',
    pageIndex: 0,
    pageLabel: '13',
    rects: [[72, 310, 520, 440]] as [[number, number, number, number]],
    quote: 'THEOREM A.1'
  }

  it('成功路径：锚点、笔记、来源关联一次建立', async () => {
    const doc = repo.listDocuments()[0]
    const opened = repo.openDocument(doc.id)
    const { anchor, note } = await repo.createAnchorWithNote({
      anchor: { ...anchorInput, documentVersionId: opened.versionId },
      note: { title: '第 13 页疑问', noteType: 'problem', bodyMd: '这里不懂：边界条件？' }
    })
    expect(anchor.pageIndex).toBe(0)
    expect(note.title).toBe('第 13 页疑问')
    const full = repo.getNoteFull(note.id)
    expect(full.anchors).toHaveLength(1)
    expect(full.anchors[0].id).toBe(anchor.id)
    expect(full.anchors[0].rects[0]).toEqual([72, 310, 520, 440])
  })

  it('失败补偿：笔记输入非法时锚点不残留', async () => {
    const doc = repo.listDocuments()[0]
    const opened = repo.openDocument(doc.id)
    const totalAnchors = () => [...t.library.index.entries.values()].reduce((acc, e) => acc + e.anchors.length, 0)
    const before = totalAnchors()
    await expect(
      repo.createAnchorWithNote({
        anchor: { ...anchorInput, documentVersionId: opened.versionId },
        note: { title: '   ' } // 空标题 → 笔记校验失败
      })
    ).rejects.toThrow()
    expect(totalAnchors()).toBe(before) // 补偿删除，无孤立锚点
  })
})

describe('listNotesForDocument：材料的笔记面板数据', () => {
  it('合并锚点来源与整份材料来源、去重、带定位信息', async () => {
    const doc = repo.listDocuments()[0]
    const opened = repo.openDocument(doc.id)
    // 经锚点挂的笔记（用既有 API 模拟旧数据）
    const a1 = await repo.createAnchor({ documentVersionId: opened.versionId, pageIndex: 0, rects: [[10, 10, 60, 30]] })
    const n1 = await repo.createNote({ title: '锚点笔记', anchorId: a1.id })
    // 同笔记第二个锚点（另一页）
    const a2 = await repo.createAnchor({ documentVersionId: opened.versionId, pageIndex: 2, rects: [[20, 20, 80, 40]] })
    await repo.attachAnchor(n1.id, a2.id)
    // 材料级关联笔记（模拟 HTML/手动来源）
    const n2 = await repo.createNote({ title: '材料级笔记', bodyMd: '关于整份材料。', documentId: doc.id })

    const all = repo.listNotesForDocument(doc.id)
    const byId = new Map(all.map((n) => [n.id, n]))
    expect(all).toHaveLength(3) // 第一个用例的「第 13 页疑问」+ 以下 2 篇，均去重
    const withAnchor = byId.get(n1.id)!
    expect(withAnchor.anchors.map((a) => a.pageIndex).sort()).toEqual([0, 2])
    expect(withAnchor.viaDocumentSource).toBe(false)
    const materialLevel = byId.get(n2.id)!
    expect(materialLevel.anchors).toHaveLength(0)
    expect(materialLevel.viaDocumentSource).toBe(true)
    expect(materialLevel.bodyMd).toContain('整份材料')

    // 本页过滤：第 0 页命中锚点笔记；第 1 页无锚点笔记（材料级仍显示）
    const page0 = repo.listNotesForDocument(doc.id, { pageIndex: 0 }).map((n) => n.id)
    expect(page0).toContain(n1.id)
    const page1 = repo.listNotesForDocument(doc.id, { pageIndex: 1 }).map((n) => n.id)
    expect(page1).not.toContain(n1.id)
    expect(page1).toContain(n2.id)
  })

  it('重启（重新扫描）后面板数据持久', async () => {
    const repo2 = await t.reopen()
    const doc = repo2.listDocuments()[0]
    const all = repo2.listNotesForDocument(doc.id)
    expect(all).toHaveLength(3)
    expect(all.find((n) => n.title === '锚点笔记')!.anchors).toHaveLength(2)
  })
})
