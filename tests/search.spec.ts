import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo
let repo: TestRepo['repo']

beforeAll(async () => {
  t = await makeTestRepo('mathwb-search-')
  repo = t.repo
  // 构造一个有代表性的语料：中英文标题、别名、正文、LaTeX 片段
  const notes: Array<{ title: string; body: string; aliases?: string[] }> = [
    {
      title: '拉格朗日中值定理',
      body: '若 f 在 [a,b] 连续且在 (a,b) 可导，则存在 $\\xi$ 使 $f\'(\\xi) = \\frac{f(b)-f(a)}{b-a}$。',
      aliases: ['Lagrange Mean Value Theorem', 'MVT']
    },
    { title: 'Rolle 定理', body: '端点函数值相等时的特例。', aliases: ['罗尔定理'] },
    { title: 'Taylor 展开与余项', body: '$f(x) = \\sum_{k=0}^{n} \\frac{f^{(k)}(a)}{k!}(x-a)^k + R_n(x)$，余项有 Lagrange 形式。' },
    { title: '一致连续性', body: 'ε-δ 语言：对任意 ε>0 存在 δ>0。uniform continuity。' },
    { title: '紧集上的连续函数', body: '有界且取得最大最小值（极值定理）。' },
    { title: '反例：处处连续处处不可导', body: 'Weierstrass 函数 $W(x)=\\sum a^n \\cos(b^n \\pi x)$。', aliases: ['Weierstrass function'] },
    { title: '笔记：第三章习题 7', body: '用中值定理证明不等式；演草见照片。' },
    { title: 'Topological Vector Spaces 读书笔记', body: 'locally convex, weak topology, Alaoglu theorem.' }
  ]
  for (const n of notes) {
    const created = await repo.createNote({ title: n.title, noteType: 'note', bodyMd: n.body })
    if (n.aliases?.length) {
      await repo.saveNote({
        id: created.id,
        title: n.title,
        noteType: 'note',
        bodyMd: n.body,
        aliases: n.aliases,
        verifiedStatus: 'unchecked'
      })
    }
  }
})

afterAll(() => {
  t?.dispose()
})

describe('中文与混合检索（v2 内存扫描，中文子串天然支持）', () => {
  it('中文 ≥3 字命中', () => {
    const r = repo.search('拉格朗日')
    expect(r.mode).toBe('fts')
    expect(r.notes.some((n) => n.title === '拉格朗日中值定理')).toBe(true)
  })

  it('中文 2 字命中', () => {
    const r = repo.search('定理')
    expect(r.mode).toBe('like')
    expect(r.notes.length).toBeGreaterThanOrEqual(3)
  })

  it('英文别名命中（通过 aliases）', () => {
    expect(repo.search('Lagrange').notes.length).toBeGreaterThanOrEqual(1)
    expect(repo.search('Weierstrass').notes.some((n) => n.title.includes('反例'))).toBe(true)
  })

  it('LaTeX 源码字面检索', () => {
    const r = repo.search('frac{f(b)-f(a)}')
    expect(r.notes.length).toBeGreaterThanOrEqual(1)
  })

  it('特殊字符不会破坏查询（引号、反斜杠）', () => {
    expect(() => repo.search('"定理"')).not.toThrow()
    expect(() => repo.search('\\xi')).not.toThrow()
    expect(repo.search('不存在的词组xyz').notes).toHaveLength(0)
  })

  it('正文命中返回片段', () => {
    const r = repo.search('极值定理')
    const hit = r.notes.find((n) => n.title === '紧集上的连续函数')
    expect(hit).toBeTruthy()
    expect(hit!.snippet).toContain('极值定理')
  })

  it('空锚点查询稳定', () => {
    const r = repo.search('THEOREM')
    expect(r.anchors).toHaveLength(0)
  })

  it('批量写入后的查询耗时（208 条探针，非性能门禁）', async () => {
    for (let i = 0; i < 200; i++) {
      await repo.createNote({ title: `批量笔记 ${i}：泛函分析章节`, bodyMd: `内容 ${i}：Banach 空间上的算子理论，第 ${i} 页推导。` })
    }
    const t0 = performance.now()
    const r = repo.search('泛函分析章节')
    const ms = performance.now() - t0
    expect(r.notes.length).toBe(50) // 结果上限 50，非命中总数
    console.log(`[search] 208 条数据 '泛函分析章节'：${ms.toFixed(2)} ms`)
    const t1 = performance.now()
    const r2 = repo.search('算子')
    const ms2 = performance.now() - t1
    expect(r2.notes.length).toBe(50)
    console.log(`[search] 208 条数据 '算子'：${ms2.toFixed(2)} ms`)
  })
})
