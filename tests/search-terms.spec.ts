// WP-3：检索词语义（多词 AND + 引号精确短语）——笔记与文献库共用的声明式规则。
import { describe, expect, it } from 'vitest'
import { contextSnippet, findInPages, firstTermHit, matchAllTerms, pageIndexAtOffset, parseSearchTerms } from '../src/shared/search-terms'

describe('检索词解析', () => {
  it('空白分隔 → 多词 AND；顺序无关、不必相邻', () => {
    const terms = parseSearchTerms('正则化 参数辨识')
    expect(terms).toEqual([{ text: '正则化', exact: false }, { text: '参数辨识', exact: false }])
    // 两词都在同一段文本里（不相邻）→ 命中
    expect(matchAllTerms('本文讨论正则化方法与参数辨识性的关系', terms)).toBe(true)
    // 缺一个词 → 不命中
    expect(matchAllTerms('本文只讨论正则化方法', terms)).toBe(false)
  })

  it('双引号 → 精确短语（含空格，按原文连续匹配）', () => {
    const terms = parseSearchTerms('"weak identifiability" model')
    expect(terms).toEqual([{ text: 'weak identifiability', exact: true }, { text: 'model', exact: false }])
    expect(matchAllTerms('we study weak identifiability of the model', terms)).toBe(true)
    // 短语被拆开 → 不命中（这正是「精确短语」的意义）
    expect(matchAllTerms('weak results on identifiability of the model', terms)).toBe(false)
  })

  it('引号未闭合 → 去掉引号按普通词处理（不把用户卡在语法里）', () => {
    expect(parseSearchTerms('"未闭合 定理')).toEqual([{ text: '未闭合', exact: false }, { text: '定理', exact: false }])
    expect(parseSearchTerms('""')).toEqual([])
    expect(parseSearchTerms('   ')).toEqual([])
  })

  it('中文与 LaTeX 片段原样保留', () => {
    const terms = parseSearchTerms('中值定理 \\frac{f(b)-f(a)}')
    expect(terms.map((t) => t.text)).toEqual(['中值定理', '\\frac{f(b)-f(a)}'])
    expect(matchAllTerms('中值定理：$\\frac{f(b)-f(a)}{b-a}$', terms)).toBe(true)
  })
})

describe('命中来源与上下文', () => {
  it('按字段顺序返回第一个命中（标题优先于正文）', () => {
    const fields = [
      { field: '标题', text: '随机分析引论' },
      { field: '正文', text: '本文讨论正则化与随机分析。' }
    ]
    const hit = firstTermHit(fields, parseSearchTerms('随机分析'))!
    expect(hit.field).toBe('标题')
    expect(hit.index).toBe(0) // 标题以「随机分析」开头
    expect(hit.text).toBe('随机分析引论') // 带回原文，供调用方截取上下文
    const hit2 = firstTermHit(fields, parseSearchTerms('正则化'))!
    expect(hit2.field).toBe('正文')
  })

  it('片段截取带省略号并折叠空白', () => {
    const text = `${'前'.repeat(100)}目标词${'后'.repeat(100)}`
    const index = text.indexOf('目标词')
    const snippet = contextSnippet(text, index, '目标词'.length, 10)
    expect(snippet).toBe(`…${'前'.repeat(10)}目标词${'后'.repeat(10)}…`)
  })

  it('无命中字段返回 null（空文本安全）', () => {
    expect(firstTermHit([{ field: '正文', text: '' }, { field: '摘要', text: null }], parseSearchTerms('x'))).toBe(null)
  })
})

describe('按页查找（阅读器 ⌘F / 全文命中的页码定位）', () => {
  const page1 = 'first page has THEOREM here'
  const page2 = 'second page mentions theorem twice: theorem'
  const page3 = 'third page nothing useful'
  const text = [page1, page2, page3].join('\n')
  const pageStarts = [0, page1.length + 1, page1.length + 1 + page2.length + 1]

  it('pageIndexAtOffset：偏移落在哪一页（边界与越界）', () => {
    expect(pageIndexAtOffset(pageStarts, 0)).toBe(0)
    expect(pageIndexAtOffset(pageStarts, pageStarts[1] - 1)).toBe(0)
    expect(pageIndexAtOffset(pageStarts, pageStarts[1])).toBe(1)
    expect(pageIndexAtOffset(pageStarts, 99999)).toBe(2)
    expect(pageIndexAtOffset([], 5)).toBe(0)
  })

  it('findInPages：按页统计命中（大小写不敏感），页序升序', () => {
    expect(findInPages(text, pageStarts, 'theorem')).toEqual([
      { pageIndex: 0, count: 1 },
      { pageIndex: 1, count: 2 }
    ])
    expect(findInPages(text, pageStarts, 'THEOREM')).toHaveLength(2)
    expect(findInPages(text, pageStarts, 'nothing useful')).toEqual([{ pageIndex: 2, count: 1 }])
    expect(findInPages(text, pageStarts, 'missing')).toEqual([])
    expect(findInPages(text, pageStarts, '   ')).toEqual([])
    expect(findInPages('', [], 'x')).toEqual([])
  })

  it('同页多次命中合并计数；跨页边界不串页', () => {
    // 'page' 出现在 1/2/3 页各一次（第 2 页两次：second page / page mentions）
    const hits = findInPages(text, pageStarts, 'page')
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 1, 2])
    for (const h of hits) expect(h.count).toBeGreaterThanOrEqual(1)
  })
})