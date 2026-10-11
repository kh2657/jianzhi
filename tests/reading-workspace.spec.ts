import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWriteJson } from '../src/main/storage/fsutil'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import type { ReadingWorkspace } from '../src/shared/types'

let root: string
let t: TestRepo
let repo: TestRepo['repo']
let documentId: string
let versionId: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mathwb-reading-'))
  t = await makeTestRepo('mathwb-reading-')
  repo = t.repo
  const [doc] = await repo.importDocuments(['fixtures/text-basic.pdf'])
  documentId = doc.documentId!
  versionId = doc.versionId!
  await repo.setVersionMeta(versionId, { pageCount: 3 })
})

afterEach(() => t.dispose())

describe('精读工作流持久化与来源约束', () => {
  it('默认不要求填写；完成阶段也不要求填满模板', async () => {
    const workspace = repo.readingWorkspaceGet(documentId)
    expect(workspace).toMatchObject({ coreQuestion: '', phase: 'reading', activeTab: 'notes', quickDraft: '', updatedAt: null })
    expect(workspace.sections.map((section) => section.id)).toEqual(['question', 'method', 'findings', 'evidence', 'relevance'])
    expect(workspace.sections.every((section) => !section.body && !section.checked && !section.anchorIds.length)).toBe(true)
    await repo.readingWorkspaceSave({ ...workspace, phase: 'complete' })
    expect(repo.readingWorkspaceGet(documentId).phase).toBe('complete')
    expect(() => repo.readingWorkspaceGet('missing')).toThrow('材料不存在')
  })

  it('草稿、疑问、面板与有来源精读卡在重启后恢复', async () => {
    const { anchor, note } = await repo.createAnchorWithNote({
      anchor: { documentVersionId: versionId, pageIndex: 1, rects: [[1, 2, 3, 4]] },
      note: { title: '紧性的作用？', noteType: 'problem' }
    })
    const workspace = repo.readingWorkspaceGet(documentId)
    Object.assign(workspace, { coreQuestion: '证明依赖什么假设？', quickDraft: '继续检查边界', phase: 'paused',
      activeTab: 'card', notesScope: 'all', expandedNoteId: note.id, resolvedNoteIds: [note.id] })
    workspace.sections[0] = { id: 'question', body: '紧性用于抽取收敛子列。', anchorIds: [anchor.id], checked: true }
    await repo.readingWorkspaceSave(workspace)
    const saved = repo.readingWorkspaceGet(documentId)
    expect(saved.updatedAt).toMatch(/^\d{4}-/)
    const repo2 = await t.reopen()
    expect(repo2.readingWorkspaceGet(documentId)).toEqual(saved)
    expect(repo2.getNoteFull(note.id).anchors[0].id).toBe(anchor.id)
  })

  it('栏目自由名称在重启后保留，不改变正文、依据和人工核对', async () => {
    const anchor = await repo.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [] })
    const workspace = repo.readingWorkspaceGet(documentId)
    workspace.sections[2] = { id: 'findings', title: '我的理解', body: '边界条件不能省略。', anchorIds: [anchor.id], checked: true }
    await repo.readingWorkspaceSave(workspace)
    const repo2 = await t.reopen()
    expect(repo2.readingWorkspaceGet(documentId).sections[2]).toEqual(workspace.sections[2])
    expect(repo2.readingWorkspaceGet(documentId).sections[0]).not.toHaveProperty('title')
  })

  it('旧版无名称栏目兼容，空白名称可以回退默认；非法名称不覆盖草稿', async () => {
    const legacy = repo.readingWorkspaceGet(documentId)
    legacy.quickDraft = '原来的草稿'
    await repo.readingWorkspaceSave(legacy)
    expect(repo.readingWorkspaceGet(documentId).sections).toEqual(legacy.sections)
    legacy.sections[2].title = ''
    await repo.readingWorkspaceSave(legacy)
    expect(repo.readingWorkspaceGet(documentId).sections[2].title).toBe('')
    for (const title of [null, 12, {}, 'x'.repeat(121)]) {
      const invalid = { ...legacy, quickDraft: '不能覆盖', sections: legacy.sections.map((section) => section.id === 'findings' ? { ...section, title } : section) }
      await expect(repo.readingWorkspaceSave(invalid as unknown as ReadingWorkspace)).rejects.toThrow('栏目名称')
      expect(repo.readingWorkspaceGet(documentId).quickDraft).toBe('原来的草稿')
    }
    legacy.sections[2].title = 'x'.repeat(120)
    await repo.readingWorkspaceSave(legacy)
    expect(repo.readingWorkspaceGet(documentId).sections[2].title).toHaveLength(120)
  })

  it('拒绝跨材料锚点、无依据核对、空正文核对且不覆盖既有草稿', async () => {
    const [other] = await repo.importDocuments(['fixtures/scanned.pdf'])
    const foreign = await repo.createAnchor({ documentVersionId: other.versionId!, pageIndex: 0, rects: [[1, 2, 3, 4]] })
    const own = await repo.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [[1, 2, 3, 4]] })
    const workspace = repo.readingWorkspaceGet(documentId)
    workspace.quickDraft = '应当保留'
    await repo.readingWorkspaceSave(workspace)
    workspace.sections[0].body = '理解'
    workspace.sections[0].anchorIds = [foreign.id]
    await expect(repo.readingWorkspaceSave(workspace)).rejects.toThrow('本材料')
    workspace.sections[0].anchorIds = []
    workspace.sections[0].checked = true
    await expect(repo.readingWorkspaceSave(workspace)).rejects.toThrow('正文和可回源')
    workspace.sections[0].anchorIds = [own.id]
    workspace.sections[0].body = '  '
    await expect(repo.readingWorkspaceSave(workspace)).rejects.toThrow('正文和可回源')
    expect(repo.readingWorkspaceGet(documentId).quickDraft).toBe('应当保留')
    expect(repo.readingWorkspaceGet(documentId).sections[0].checked).toBe(false)
  })

  it('页级来源保存真实页码和空矩形，并可作为人工核对依据', async () => {
    const { anchor } = await repo.createAnchorWithNote({
      anchor: { documentVersionId: versionId, pageIndex: 2, rects: [] },
      note: { title: '页级疑问', noteType: 'problem' }
    })
    expect(repo.getAnchorWithContext(anchor.id)).toMatchObject({ pageIndex: 2, rects: [] })
    const workspace = repo.readingWorkspaceGet(documentId)
    workspace.sections[0] = { id: 'question', body: '已检查这一页', anchorIds: [anchor.id], checked: true }
    await repo.readingWorkspaceSave(workspace)
    expect(repo.readingWorkspaceGet(documentId).sections[0].checked).toBe(true)
    await expect(repo.createAnchor({ documentVersionId: versionId, pageIndex: 3, rects: [] })).rejects.toThrow('有效页面')
  })

  it('HTML 允许卡片草稿，但不能伪造 PDF 定位和已核对', async () => {
    const htmlPath = join(root, 'lesson.html')
    writeFileSync(htmlPath, '<!doctype html><html><body>教材</body></html>')
    const [html] = await repo.importDocuments([htmlPath])
    const workspace = repo.readingWorkspaceGet(html.documentId!)
    workspace.sections[0].body = '尚不能精确定位'
    await repo.readingWorkspaceSave(workspace)
    await expect(repo.createAnchor({ documentVersionId: html.versionId!, pageIndex: 0, rects: [] })).rejects.toThrow('PDF')
    // 既有锚点接口允许矩形写入 HTML；工作流不能把这样的行当作依据。
    const fake = await repo.createAnchor({ documentVersionId: html.versionId!, pageIndex: 0, rects: [[1, 2, 3, 4]] })
    workspace.sections[0].anchorIds = [fake.id]
    workspace.sections[0].checked = true
    await expect(repo.readingWorkspaceSave(workspace)).rejects.toThrow('PDF 原文')
  })

  it('已解决标记仅接受本材料的问题笔记，输入类型与长度受限', async () => {
    const ordinary = await repo.createNote({ title: '普通笔记', documentId })
    const [other] = await repo.importDocuments(['fixtures/scanned.pdf'])
    const foreign = await repo.createNote({ title: '别的疑问', noteType: 'problem', documentId: other.documentId! })
    for (const id of [ordinary.id, foreign.id, 'missing']) {
      await expect(repo.readingWorkspaceSave({ ...repo.readingWorkspaceGet(documentId), resolvedNoteIds: [id] })).rejects.toThrow('问题笔记')
    }
    const workspace = repo.readingWorkspaceGet(documentId)
    await expect(repo.readingWorkspaceSave({ ...workspace, quickDraft: 'x'.repeat(100001) })).rejects.toThrow('长度')
    await expect(repo.readingWorkspaceSave({ ...workspace, sections: [] })).rejects.toThrow('栏目')
    await expect(repo.readingWorkspaceSave({ ...workspace, phase: 'invalid' } as unknown as ReadingWorkspace)).rejects.toThrow('阶段')
    await expect(repo.readingWorkspaceSave(null as unknown as ReadingWorkspace)).rejects.toThrow('格式')
  })

  it('最近阅读依据 lastReadAt，文档删除后跳过', async () => {
    expect(repo.readingLastDocument()).toBeNull()
    const [other] = await repo.importDocuments(['fixtures/scanned.pdf'])
    await repo.saveReadingState({ documentId, pageIndex: 2, scale: 1.3, rotation: 90 })
    await repo.saveReadingState({ documentId: other.documentId!, pageIndex: 0, scale: 1, rotation: 0 })
    // 把 documentId 的最近阅读时间改旧（模拟「另外那台机器读得更晚」）
    const entry = t.library.index.entries.get(documentId)!
    entry.meta.readingState!.lastReadAt = '2020-01-01T00:00:00.000Z'
    await atomicWriteJson(join(entry.dirAbs, 'entry.json'), entry.meta)
    await t.library.rescanNow()
    expect(repo.readingLastDocument()).toBe(other.documentId)
    const otherDir = t.library.index.entries.get(other.documentId!)!.dirAbs
    rmSync(otherDir, { recursive: true, force: true })
    const repo2 = await t.reopen()
    expect(repo2.readingLastDocument()).toBe(documentId)
  })
})
