// 研究问题聚合（#29）：以 problem 笔记为枢纽，从双链 / sources / learning 实时推导。
// 关注点：link 方向（in/out/both）、hub 不出现在 notes、文献去重与摘录数合计、知识块合计。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo
let repo: TestRepo['repo']
let hubId = ''
let inNoteId = ''
let outNoteId = ''
let bothNoteId = ''
let documentId = ''
let anchorId = ''

beforeAll(async () => {
  t = await makeTestRepo('mathwb-question-')
  repo = t.repo

  // 文献 + 摘录（作为 sources 里 kind=anchor 的来源）
  const [imp] = await repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
  documentId = imp.documentId!
  const doc = repo.openDocument(documentId)
  const anchor = await repo.createAnchor({ documentVersionId: doc.versionId, pageIndex: 0, rects: [[10, 10, 40, 30]], quote: '定理 1' })
  anchorId = anchor.id

  // 枢纽：problem 类型，正文链出到 outNote
  const hub = await repo.createNote({ title: '收敛速率有多快', noteType: 'problem', bodyMd: '先看 [[误差估计]] 的结论。' })
  hubId = hub.id

  // 链入：对方正文 [[链接]] 指向枢纽
  const inNote = await repo.createNote({ title: '链入笔记', bodyMd: '结论依赖 [[收敛速率有多快]]。' })
  inNoteId = inNote.id

  // 链出目标：同时挂上文献级来源（document）
  const outNote = await repo.createNote({ title: '误差估计', bodyMd: '正文。', documentId })
  outNoteId = outNote.id

  // 双向：对方链入，枢纽也链出去
  const bothNote = await repo.createNote({ title: '双向笔记', bodyMd: '参见 [[收敛速率有多快]]。' })
  bothNoteId = bothNote.id
  const hubFull = repo.getNoteFull(hubId)
  await repo.saveNote({
    id: hubId,
    title: hubFull.note.title,
    noteType: hubFull.note.noteType,
    bodyMd: '先看 [[误差估计]] 的结论；另见 [[双向笔记]]。',
    aliases: hubFull.note.aliases,
    verifiedStatus: hubFull.note.verifiedStatus,
    baseHash: hubFull.baseHash
  })

  // 摘录来源挂到枢纽 + 相关笔记（同一文献，聚合应去重并合计摘录数）
  await repo.attachAnchor(hubId, anchorId)
  await repo.attachAnchor(inNoteId, anchorId)

  // 自评：枢纽 1 疑问，inNote 1 理解 + 1 疑问
  const setLearning = async (id: string, records: Record<string, { status: 'understood' | 'question'; fingerprint: string }>): Promise<void> => {
    const full = repo.getNoteFull(id)
    await repo.saveNote({
      id,
      title: full.note.title,
      noteType: full.note.noteType,
      bodyMd: full.note.bodyMd,
      aliases: full.note.aliases,
      verifiedStatus: full.note.verifiedStatus,
      baseHash: full.baseHash,
      learning: { records }
    })
  }
  await setLearning(hubId, { h1: { status: 'question', fingerprint: 'fp-h' } })
  await setLearning(inNoteId, { i1: { status: 'understood', fingerprint: 'fp-i1' }, i2: { status: 'question', fingerprint: 'fp-i2' } })
})

afterAll(() => {
  t?.dispose()
})

describe('研究问题聚合', () => {
  it('hub 与三个方向：链入 / 链出 / 双向都识别，hub 不出现在 notes', () => {
    const agg = repo.questionAggregate(hubId)
    expect(agg.hub).toEqual({ id: hubId, title: '收敛速率有多快' })
    const byId = new Map(agg.notes.map((n) => [n.id, n]))
    expect(byId.has(hubId)).toBe(false)
    expect(byId.get(inNoteId)?.link).toBe('in')
    expect(byId.get(outNoteId)?.link).toBe('out')
    expect(byId.get(bothNoteId)?.link).toBe('both')
    expect(agg.notes).toHaveLength(3)
  })

  it('知识块状态：枢纽 + 相关笔记的自评合计', () => {
    const agg = repo.questionAggregate(hubId)
    expect(agg.blocks).toEqual({ total: 3, understood: 1, question: 2 })
    const inNote = agg.notes.find((n) => n.id === inNoteId)!
    expect(inNote.understoodCount).toBe(1)
    expect(inNote.questionCount).toBe(1)
  })

  it('相关文献：document 来源与 anchor 来源按文献去重，摘录数合计', () => {
    const agg = repo.questionAggregate(hubId)
    expect(agg.documents).toHaveLength(1)
    const doc = agg.documents[0]
    expect(doc.id).toBe(documentId)
    // 枢纽 1 条 + inNote 1 条 = 2（outNote 的 document 级来源不重复计摘录）
    expect(doc.anchorCount).toBe(2)
    expect(doc.title).toBe(repo.openDocument(documentId).title)
  })

  it('只挂 document 级来源的笔记不产生摘录数（anchorCount 可为 0）', async () => {
    const solo = await repo.createNote({ title: '仅文献级关联', bodyMd: 'x', documentId })
    const link = await repo.createNote({ title: '指向枢纽的孤立链', bodyMd: '见 [[收敛速率有多快]]。' })
    const agg = repo.questionAggregate(hubId)
    const soloRow = agg.notes.find((n) => n.id === solo.id)
    expect(soloRow).toBeUndefined() // 没有链接关系就不进 notes（sources 不构成笔记关系）
    expect(link.id).toBeTruthy()
    expect(agg.documents).toHaveLength(1)
    expect(agg.documents[0].anchorCount).toBe(2)
    // 清理，避免影响后续断言
    expect(agg.notes.some((n) => n.id === link.id)).toBe(true)
  })

  it('移除链接后聚合立即跟着变（无冗余边）', async () => {
    const full = repo.getNoteFull(inNoteId)
    await repo.saveNote({
      id: inNoteId,
      title: full.note.title,
      noteType: full.note.noteType,
      bodyMd: '不再链接了。',
      aliases: full.note.aliases,
      verifiedStatus: full.note.verifiedStatus,
      baseHash: full.baseHash
    })
    const agg = repo.questionAggregate(hubId)
    expect(agg.notes.some((n) => n.id === inNoteId)).toBe(false)
    // 摘录来源还在：文献与摘录数不受双链影响
    expect(agg.documents[0].anchorCount).toBe(1)
    // 恢复（后续用例与整体聚合口径依赖它）
    await repo.saveNote({
      id: inNoteId,
      title: full.note.title,
      noteType: full.note.noteType,
      bodyMd: '结论依赖 [[收敛速率有多快]]。',
      aliases: full.note.aliases,
      verifiedStatus: full.note.verifiedStatus,
      baseHash: (await Promise.resolve(repo.getNoteFull(inNoteId))).baseHash,
      learning: { records: { i1: { status: 'understood', fingerprint: 'fp-i1' }, i2: { status: 'question', fingerprint: 'fp-i2' } } }
    })
    expect(repo.questionAggregate(hubId).notes.some((n) => n.id === inNoteId)).toBe(true)
  })

  it('枢纽不存在时如实抛错（IPC 层据此报错而不是返回空对象）', () => {
    expect(() => repo.questionAggregate('11111111-1111-4111-8111-111111111111')).toThrow('笔记不存在')
  })

  it('重启（重新扫描）后聚合一致', async () => {
    const repo2 = await t.reopen()
    const agg = repo2.questionAggregate(hubId)
    // 4 条 = in + out + both + 「指向枢纽的孤立链」（前面用例新建，同样链入枢纽）
    expect(agg.notes).toHaveLength(4)
    expect(agg.notes.map((n) => n.id)).toEqual(expect.arrayContaining([inNoteId, outNoteId, bothNoteId]))
    expect(agg.blocks).toEqual({ total: 3, understood: 1, question: 2 })
    expect(agg.documents).toHaveLength(1)
    expect(agg.documents[0].anchorCount).toBe(2)
  })
})
