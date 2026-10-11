// WP-3：笔记与摘录检索的声明式语义——多词 AND、引号精确短语、命中总数（不再静默截断）。
//
// 修复前：笔记检索把整句当单一子串（「正则化 参数辨识」要求正文里恰好出现这个带空格的字符串），
// 与文献库的逐词 AND 语义相反；50 条上限无任何提示。
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

describe('笔记检索：多词 AND 与引号短语', () => {
  it('两词不相邻也命中；缺一个词不命中；顺序无关', async () => {
    const t: TestRepo = await makeTestRepo('wp3-notes-')
    try {
      const a = await t.repo.createNote({ title: '参数辨识笔记', bodyMd: '本文讨论正则化方法；附录给出参数辨识性的证明。' })
      await t.repo.createNote({ title: '只有正则化', bodyMd: '这篇只谈正则化。' })

      const hit = t.repo.search('正则化 参数辨识')
      expect(hit.notes.map((n) => n.id)).toEqual([a.id])
      expect(hit.notesTotal).toBe(1)
      // 顺序无关
      expect(t.repo.search('参数辨识 正则化').notes.map((n) => n.id)).toEqual([a.id])
      // 缺一个词 → 不命中
      expect(t.repo.search('正则化 不存在的词').notes).toHaveLength(0)
    } finally { t.dispose() }
  }, 60000)

  it('引号内按原文连续匹配（短语被拆开则不命中）', async () => {
    const t: TestRepo = await makeTestRepo('wp3-phrase-')
    try {
      await t.repo.createNote({ title: 'Heston 笔记', bodyMd: '我们研究 weak identifiability of the model 的判别条件。' })
      expect(t.repo.search('"weak identifiability"').notes).toHaveLength(1)
      // 拆开的词序（identifiability weak）不算短语命中
      expect(t.repo.search('"identifiability weak"').notes).toHaveLength(0)
    } finally { t.dispose() }
  }, 60000)

  it('命中片段来自真正命中的字段（标题命中给标题片段，正文命中给上下文）', async () => {
    const t: TestRepo = await makeTestRepo('wp3-snippet-')
    try {
      const byTitle = await t.repo.createNote({ title: '极值定理综述', bodyMd: '正文与标题无关。' })
      const byBody = await t.repo.createNote({ title: '无关标题', bodyMd: '这里提到极值定理的推广。' })
      const titleHit = t.repo.search('极值定理').notes.find((n) => n.id === byTitle.id)!
      expect(titleHit.snippet).toContain('极值定理综述')
      const bodyHit = t.repo.search('极值定理').notes.find((n) => n.id === byBody.id)!
      expect(bodyHit.snippet).toContain('这里提到极值定理的推广')
    } finally { t.dispose() }
  }, 60000)

  it('超过返回上限时给出真实总数（50 条上限不再静默截断）', async () => {
    const t: TestRepo = await makeTestRepo('wp3-total-')
    try {
      for (let i = 0; i < 60; i++) await t.repo.createNote({ title: `批量笔记 ${i}`, bodyMd: `共同关键词 泛函分析 第 ${i} 篇` })
      const r = t.repo.search('泛函分析')
      expect(r.notes).toHaveLength(50)   // 返回上限（传输量保护）
      expect(r.notesTotal).toBe(60)      // 真实命中数（UI 据此提示）
    } finally { t.dispose() }
  }, 120000)

  it('摘录检索同样多词 AND，并给出总数', async () => {
    const t: TestRepo = await makeTestRepo('wp3-anchors-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const doc = t.repo.openDocument(imp.documentId!)
      await t.repo.createAnchor({ documentVersionId: doc.versionId, pageIndex: 0, rects: [[1, 2, 3, 4]], quote: '拉格朗日中值定理的证明' })
      await t.repo.createAnchor({ documentVersionId: doc.versionId, pageIndex: 1, rects: [[1, 2, 3, 4]], quote: '只提到拉格朗日' })

      const both = t.repo.search('拉格朗日 证明')
      expect(both.anchors).toHaveLength(1)
      expect(both.anchorsTotal).toBe(1)
      const one = t.repo.search('拉格朗日')
      expect(one.anchors).toHaveLength(2)
      expect(one.anchorsTotal).toBe(2)
    } finally { t.dispose() }
  }, 60000)
})

// 2026-10-09（architecture §15）：同一笔记归为一条结果，命中按知识块分组并带定位信息
describe('笔记检索：按知识块分组与定位', () => {
  it('跨块 AND 命中同一笔记：命中位置按块展示（含任一词的块），块数给真实总数', async () => {
    const t: TestRepo = await makeTestRepo('wp3-blocks-')
    try {
      const n = await t.repo.createNote({
        title: '紧性笔记',
        bodyMd: '引言：先回忆紧性的动机。\n\n## 紧性条件\n利用紧性条件提取收敛子列。\n\n## 参数敏感方向\n弱辨识方向可能导致参数不稳定。'
      })
      const r = t.repo.search('紧性 弱辨识')
      expect(r.notes.map((x) => x.id)).toEqual([n.id]) // 两词分属不同块/标题，同一笔记一条结果
      const hit = r.notes[0]
      // 命中位置：引言（紧性）+ 紧性条件块（紧性）+ 参数敏感方向块（弱辨识）——不伪造单一摘要
      expect(hit.blockHitCount).toBe(3)
      expect(hit.blockHits).toHaveLength(3)
      expect(hit.blockHits![0]).toMatchObject({ heading: null, blockIndex: 0 })
      expect(hit.blockHits![1]).toMatchObject({ heading: '紧性条件', blockIndex: 1 })
      expect(hit.blockHits![2]).toMatchObject({ heading: '参数敏感方向', blockIndex: 2 })
      expect(hit.blockHits![1].snippet).toContain('紧性')
      expect(hit.blockHits![2].snippet).toContain('弱辨识')
      expect(hit.updatedAt).toBeTruthy()
    } finally { t.dispose() }
  }, 60000)

  it('无标题块定位到正文开头（heading null / blockIndex 0）；引言命中也算块命中', async () => {
    const t: TestRepo = await makeTestRepo('wp3-intro-')
    try {
      await t.repo.createNote({ title: '无块笔记', bodyMd: '开头就提到紧性。\n\n## 后续\n其他内容。' })
      const r = t.repo.search('紧性')
      expect(r.notes).toHaveLength(1)
      expect(r.notes[0].blockHits![0]).toMatchObject({ heading: null, blockIndex: 0 })
    } finally { t.dispose() }
  }, 60000)

  it('块命中最多给 3 条摘要，其余计数保留', async () => {
    const t: TestRepo = await makeTestRepo('wp3-cap-')
    try {
      await t.repo.createNote({
        title: '多块笔记',
        bodyMd: ['## A', '紧性讨论。', '', '## B', '紧性再讨论。', '', '## C', '紧性第三段。', '', '## D', '紧性第四段。'].join('\n')
      })
      const r = t.repo.search('紧性')
      expect(r.notes[0].blockHitCount).toBe(4)
      expect(r.notes[0].blockHits).toHaveLength(3)
      expect(r.notes[0].blockHits!.map((b) => b.heading)).toEqual(['A', 'B', 'C'])
    } finally { t.dispose() }
  }, 60000)

  it('排序分层：标题精确 > 全部词在标题 > 别名部分命中 > 仅正文', async () => {
    const t: TestRepo = await makeTestRepo('wp3-tier-')
    try {
      await t.repo.createNote({ title: '紧性', bodyMd: '无关内容。' })                                   // 0 档：精确
      await t.repo.createNote({ title: '紧性条件研究', bodyMd: '无关内容。' })                            // 1 档：全词在标题
      const aliased = await t.repo.createNote({ title: '条件与假设', bodyMd: '无关内容。' })
      await t.repo.saveNote({ id: aliased.id, title: '条件与假设', noteType: 'note', bodyMd: '无关内容。', aliases: ['紧性'], verifiedStatus: 'unchecked' }) // 2 档：别名部分命中
      await t.repo.createNote({ title: '无关标题', bodyMd: '这里讨论紧性。' })                            // 3 档：仅正文
      const r = t.repo.search('紧性')
      expect(r.notes.map((x) => x.title)).toEqual(['紧性', '紧性条件研究', '条件与假设', '无关标题'])
    } finally { t.dispose() }
  }, 60000)
})