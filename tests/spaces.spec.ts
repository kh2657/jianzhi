import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo
let repo: TestRepo['repo']
beforeEach(async () => {
  t = await makeTestRepo('mathwb-spaces-')
  repo = t.repo
})
afterEach(() => t.dispose())

describe('学习区', () => {
  it('创建、重命名与类型更新；拒绝空名、重名和未知学习区', async () => {
    const a = await repo.createSpace({ name: ' 概率论 ', kind: 'course' })
    expect(a.name).toBe('概率论')
    // WP-1：createSpace 现在「先写盘、成功后才提交内存」（失败必须 reject），校验错误随之成为 rejection
    await expect(repo.createSpace({ name: '概率论', kind: 'course' })).rejects.toThrow('已存在')
    await expect(repo.createSpace({ name: ' ', kind: 'course' })).rejects.toThrow('名称')
    expect(() => repo.listDocuments('unknown')).toThrow('不存在')
    await expect(repo.createNote({ title: '笔记', spaceId: 'unknown' })).rejects.toThrow('不存在')
    expect(await repo.updateSpace(a.id, { name: '概率论文', kind: 'research' })).toMatchObject({ id: a.id, kind: 'research' })
    expect(repo.listSpaces()).toHaveLength(1)
  })

  it('文档、笔记、照片按 all / unfiled / space 过滤，移动不改变来源', async () => {
    const a = await repo.createSpace({ name: '概率论', kind: 'course' })
    const b = await repo.createSpace({ name: '泛函', kind: 'course' })
    const [doc] = await repo.importDocuments(['fixtures/text-basic.pdf'], { spaceId: a.id, docType: 'paper' })
    await repo.importDocuments(['fixtures/scanned.pdf'])
    const [cap] = await repo.importCaptures(['fixtures/photo.png'], '草稿', a.id)
    // 第二张照片：同夹具换名（内容不同路径无关，sha 相同会判重，故换一张不存在的组合不可行——直接再导入一张 PNG 副本加不同内容）
    const secondPhoto = join(t.root, 'photo2.png')
    copyWithFlip('fixtures/photo.png', secondPhoto)
    await repo.importCaptures([secondPhoto])
    const note = await repo.createNote({ title: '概率极限', spaceId: a.id })
    await repo.createNote({ title: '随手记' })
    expect(repo.listDocuments()).toHaveLength(2)
    expect(repo.listDocuments(a.id)).toHaveLength(1)
    expect(repo.listDocuments(null)).toHaveLength(1)
    expect(repo.listNotes(undefined, a.id).map((n) => n.id)).toEqual([note.id])
    expect(repo.listNotes(undefined, null)).toHaveLength(1)
    expect(repo.listCaptures(a.id).map((c) => c.id)).toEqual([cap.captureId])
    expect(repo.listCaptures(null)).toHaveLength(1)
    expect(repo.listCaptures()).toHaveLength(2)
    await repo.assignSpace('document', doc.documentId!, b.id)
    await repo.assignSpace('note', note.id, b.id)
    await repo.assignSpace('capture', cap.captureId!, null)
    expect(repo.listDocuments(a.id)).toHaveLength(0)
    expect(repo.listDocuments(b.id)[0]).toMatchObject({ id: doc.documentId, docType: 'paper' })
    expect(repo.listNotes(undefined, b.id)[0].id).toBe(note.id)
    expect(repo.listCaptures(null)).toHaveLength(2)
    await repo.updateDocument(doc.documentId!, { title: '新的标题', docType: 'book' })
    expect(repo.openDocument(doc.documentId!)).toMatchObject({ title: '新的标题', docType: 'book', spaceId: b.id })
    await expect(repo.assignSpace('note', 'missing', a.id)).rejects.toThrow('不存在')
  })

  it('笔记从 PDF 锚点继承学习区；显式 null 保持未归类；重复导入不移动', async () => {
    const a = await repo.createSpace({ name: '概率', kind: 'course' })
    const b = await repo.createSpace({ name: '论文', kind: 'research' })
    const [doc] = await repo.importDocuments(['fixtures/text-basic.pdf'], { spaceId: a.id })
    const anchor = await repo.createAnchor({ documentVersionId: doc.versionId!, pageIndex: 0, rects: [[1, 2, 3, 4]], quote: '概率定理 common' })
    expect((await repo.createNote({ title: '继承', anchorId: anchor.id })).spaceId).toBe(a.id)
    expect((await repo.createNote({ title: '显式', anchorId: anchor.id, spaceId: null })).spaceId).toBe(null)
    const [duplicate] = await repo.importDocuments(['fixtures/text-basic.pdf'], { spaceId: b.id })
    expect(duplicate.duplicate).toBe(true)
    expect(repo.openDocument(doc.documentId!).spaceId).toBe(a.id)
    const [cap] = await repo.importCaptures(['fixtures/photo.png'], undefined, a.id)
    const [capDuplicate] = await repo.importCaptures(['fixtures/photo.png'], undefined, b.id)
    expect(capDuplicate).toMatchObject({ duplicate: true, captureId: cap.captureId })
    expect(repo.listCaptures(a.id)).toHaveLength(1)
  })

  it('搜索先按学习区过滤，再限制结果；锚点使用文档归属', async () => {
    const a = await repo.createSpace({ name: 'A', kind: 'course' })
    const b = await repo.createSpace({ name: 'B', kind: 'research' })
    for (let i = 0; i < 55; i++) await repo.createNote({ title: '定理 common ' + i, spaceId: b.id })
    const n = await repo.createNote({ title: '定理 common 正确', spaceId: a.id })
    const unfiled = await repo.createNote({ title: '定理 common 未归类' })
    const [doc] = await repo.importDocuments(['fixtures/text-basic.pdf'], { spaceId: a.id })
    await repo.createAnchor({ documentVersionId: doc.versionId!, pageIndex: 0, rects: [[1, 2, 3, 4]], quote: '定理 common' })
    for (const q of ['定理', 'common']) {
      expect(repo.search(q, a.id).notes.map((x) => x.id)).toEqual([n.id])
      expect(repo.search(q, null).notes.map((x) => x.id)).toEqual([unfiled.id])
      expect(repo.search(q, b.id).notes).toHaveLength(50)
      expect(repo.search(q, a.id).anchors).toHaveLength(1)
      expect(repo.search(q, b.id).anchors).toHaveLength(0)
      expect(repo.search(q, null).anchors).toHaveLength(0)
      expect(repo.listNotes(q, a.id)[0]).toMatchObject({ id: n.id, spaceId: a.id })
    }
  })
})

/** 生成一张与 photo.png 内容不同的 PNG（末字节翻转，测试只关心 sha 不同、不渲染它） */
function copyWithFlip(src: string, dst: string): void {
  const buf = readFileSync(src)
  buf[buf.length - 1] = (buf[buf.length - 1] + 1) % 256
  writeFileSync(dst, buf)
}
