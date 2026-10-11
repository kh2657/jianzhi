import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let root: string
let t: TestRepo

beforeAll(async () => {
  t = await makeTestRepo('mathwb-storage-')
  root = t.root
})

afterAll(() => {
  t?.dispose()
})

function fixturePath(name: string): string {
  return join('fixtures', name)
}

/** 把夹具复制到独立目录，模拟「用户手里的原文件」（后续可改名/移动，不影响托管副本） */
function stageUserFile(name: string, renameTo?: string): string {
  const userDir = join(root, 'user-files')
  mkdirSync(userDir, { recursive: true })
  const dst = join(userDir, renameTo ?? name)
  copyFileSync(fixturePath(name), dst)
  return dst
}

describe('资产导入与托管', () => {
  // 独立仓库：本组测试自己建文档，不影响下一组的「首次导入」语义
  let t1: TestRepo
  beforeAll(async () => {
    t1 = await makeTestRepo('mathwb-storage2-')
  })
  afterAll(() => t1?.dispose())

  it('导入后原件字节一致，同内容重复导入返回已有条目', async () => {
    const user1 = stageUserFile('text-basic.pdf')
    const r1 = await t1.repo.importDocuments([user1])
    expect(r1[0].ok).toBe(true)
    const served = await t1.repo.resolveServingFile(r1[0].versionId!, 'original')
    expect(readFileSync(served.absPath).equals(readFileSync(user1))).toBe(true)
    const r2 = await t1.repo.importDocuments([stageUserFile('text-basic.pdf', '重命名后的书.pdf')])
    expect(r2[0].duplicate).toBe(true)
    expect(r2[0].documentId).toBe(r1[0].documentId)
  })

  it('非 PDF 字节在文档导入时被拒绝（头校验）', async () => {
    const fake = join(root, 'fake.pdf')
    copyFileSync(fixturePath('photo.png'), fake)
    const r = await t1.repo.importDocuments([fake])
    expect(r[0].ok).toBe(false)
    expect(r[0].error).toContain('不是 PDF')
  })

  it('未知/非法资产 ID 解析被拒绝（不可枚举、不可穿越）', async () => {
    await expect(t1.repo.resolveServingFile('f'.repeat(64), 'original')).rejects.toThrow('未知资产')
    await expect(t1.repo.resolveServingFile('../../etc/passwd', 'original')).rejects.toThrow('未知资产')
  })
})

describe('文档 / 锚点 / 笔记 / 修订', () => {
  const RECT: [[number, number, number, number]] = [[72, 310, 520, 440]]
  let documentId = ''
  let versionId = ''
  let anchorId = ''
  let noteId = ''

  it('文档导入与重复导入', async () => {
    const r = await t.repo.importDocuments([stageUserFile('text-basic.pdf')])
    expect(r[0].ok).toBe(true)
    expect(r[0].duplicate).toBe(false)
    documentId = r[0].documentId!
    versionId = r[0].versionId!
    const r2 = await t.repo.importDocuments([stageUserFile('text-basic.pdf', '另一份副本.pdf')])
    expect(r2[0].duplicate).toBe(true)
    expect(r2[0].documentId).toBe(documentId)
    expect(t.repo.listDocuments()).toHaveLength(1)
  })

  it('用户原文件移动/重命名/删除后托管资料仍可解析', async () => {
    const userFile = stageUserFile('scanned.pdf', '会被移动的扫描件.pdf')
    const r = await t.repo.importDocuments([userFile])
    expect(r[0].ok).toBe(true)
    const opened = t.repo.openDocument(r[0].documentId!)
    rmSync(userFile) // 用户手里的原件被移走/删除
    const served = await t.repo.resolveServingFile(opened.assetId, 'original')
    expect(existsSync(served.absPath)).toBe(true)
    expect(served.mediaType).toBe('application/pdf')
  })

  it('打开文档与元信息回填', async () => {
    const opened = t.repo.openDocument(documentId)
    expect(opened.versionId).toBe(versionId)
    expect(opened.url).toBe(`/api/asset/${opened.assetId}?variant=original`)
    await t.repo.setVersionMeta(versionId, { pageCount: 3, fingerprint: 'abc123' })
    const reopened = t.repo.openDocument(documentId)
    expect(reopened.pageCount).toBe(3)
    expect(reopened.fingerprint).toBe('abc123')
    // 二次回填不覆盖
    await t.repo.setVersionMeta(versionId, { pageCount: 999 })
    expect(t.repo.openDocument(documentId).pageCount).toBe(3)
  })

  it('锚点：创建 / 查询 / 带文档上下文', async () => {
    const a = await t.repo.createAnchor({
      documentVersionId: versionId,
      pageIndex: 0,
      pageLabel: '13',
      rects: RECT,
      quote: 'THEOREM A.1 (fixture) Let f be continuous…'
    })
    anchorId = a.id
    expect(a.rects).toEqual(RECT)
    const ctx = t.repo.getAnchorWithContext(anchorId)
    expect(ctx.documentId).toBe(documentId)
    expect(ctx.pageLabel).toBe('13')
    expect(t.repo.listPageAnchors(versionId, 0)).toHaveLength(1)
    expect(t.repo.listPageAnchors(versionId, 1)).toHaveLength(0)
  })

  it('笔记：创建（挂锚点）/ 保存 / 修订语义', async () => {
    const n = await t.repo.createNote({ title: '中值定理', noteType: 'theorem', bodyMd: '推导草稿', anchorId })
    noteId = n.id
    expect(n.revisionNo).toBe(1)
    const full = t.repo.getNoteFull(noteId)
    expect(full.anchors[0].id).toBe(anchorId)
    expect(full.anchors[0].rects).toEqual(RECT)

    const s1 = await t.repo.saveNote({
      id: noteId,
      title: '中值定理',
      noteType: 'theorem',
      bodyMd: '第一版完整推导',
      aliases: ['Lagrange MVT'],
      verifiedStatus: 'unchecked'
    })
    expect(s1.revisionNo).toBe(2)
    // 相同正文再保存：不产生新修订
    const s2 = await t.repo.saveNote({
      id: noteId,
      title: '中值定理（改标题）',
      noteType: 'theorem',
      bodyMd: '第一版完整推导',
      aliases: ['Lagrange MVT'],
      verifiedStatus: 'unchecked'
    })
    expect(s2.revisionNo).toBe(2)
    const s3 = await t.repo.saveNote({
      id: noteId,
      title: '中值定理（改标题）',
      noteType: 'theorem',
      bodyMd: '第二版：补充几何解释',
      aliases: ['Lagrange MVT'],
      verifiedStatus: 'checked'
    })
    expect(s3.revisionNo).toBe(3)
  })

  it('来源关联去重', async () => {
    const r1 = await t.repo.attachAnchor(noteId, anchorId)
    expect(r1.already).toBe(true) // 创建时已关联
    const r2 = await t.repo.attachAnchor(noteId, anchorId)
    expect(r2.already).toBe(true)
    const full = t.repo.getNoteFull(noteId)
    expect(full.anchors).toHaveLength(1)
  })

  it('阅读位置：保存并随 openDocument 返回', async () => {
    await t.repo.saveReadingState({ documentId, pageIndex: 2, scale: 1.4, rotation: 90 })
    const opened = t.repo.openDocument(documentId)
    expect(opened.readingState).toEqual({ pageIndex: 2, scale: 1.4, rotation: 90 })
  })

  it('收件箱：照片导入 / 幂等 / 关联 / 归档', async () => {
    const photo = 'fixtures/photo.png'
    const r = await t.repo.importCaptures([stageUserFile('photo.png')])
    expect(r[0].ok).toBe(true)
    const r2 = await t.repo.importCaptures([stageUserFile('photo.png', 'dup.png')])
    expect(r2[0].duplicate).toBe(true)
    const list = t.repo.listCaptures()
    expect(list).toHaveLength(1)
    const captureId = list[0].id
    const attach = await t.repo.attachCapture(noteId, captureId)
    expect(attach.already).toBe(false)
    expect((await t.repo.attachCapture(noteId, captureId)).already).toBe(true)
    await t.repo.saveCapture(captureId, { context: '演草', inboxStatus: 'filed' })
    const full = t.repo.getNoteFull(noteId)
    expect(full.captures[0].context).toBe('演草')
    expect(full.note.title).toContain('中值定理')
    expect(existsSync(photo)).toBe(true)
  })

  it('图片服务解析：PNG 原生可显示 → original', async () => {
    const pngAssetId = t.repo.listCaptures().find((c) => c.originalName.endsWith('.png'))!.assetId
    const display = await t.repo.resolveServingFile(pngAssetId, 'display')
    expect(display.mediaType).toBe('image/png') // 原生可显示 → 原件
    const original = await t.repo.resolveServingFile(pngAssetId, 'original')
    expect(original.mediaType).toBe('image/png')
  })

  it('重启（重新扫描磁盘）后全部数据仍在', async () => {
    const repo2 = await t.reopen()
    const docs = repo2.listDocuments()
    expect(docs).toHaveLength(2) // text-basic + scanned
    const main = docs.find((d) => d.id === documentId)!
    expect(main.pageCount).toBe(3)
    const full = repo2.getNoteFull(noteId)
    expect(full.note.revisionNo).toBe(3)
    expect(full.anchors[0].rects).toEqual(RECT)
    expect(full.captures).toHaveLength(1)
    expect(repo2.listCaptures()).toHaveLength(1)
    expect(repo2.openDocument(documentId).readingState!.pageIndex).toBe(2)
    expect(repo2.listPageAnchors(versionId, 0)).toHaveLength(1)
  })

  it('删除条目文件夹（模拟外部删除）后来源标记缺失而非崩溃', async () => {
    const entryDir = t.library.index.entries.get(documentId)!.dirAbs
    rmSync(entryDir, { recursive: true, force: true })
    const repo2 = await t.reopen()
    expect(repo2.listDocuments()).toHaveLength(1) // 只剩 scanned
    // 引用它的笔记来源解析为空（不崩溃、不静默改正文）
    const full = repo2.getNoteFull(noteId)
    expect(full.anchors).toHaveLength(0)
    expect(full.note.bodyMd).toContain('第二版')
  })
})
