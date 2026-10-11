import { describe, expect, it } from 'vitest'
import { parseLibraryQuery, parseYearRange } from '../src/shared/library-search'
import { citeKey, entryToBibtex } from '../src/shared/bibtex'
import type { EntryMeta } from '../src/shared/types'

describe('检索式解析', () => {
  it('字段与自由词拆分', () => {
    const p = parseLibraryQuery('Heston 作者:张三 标签:弱辨识 标签:Heston 全文:calibration')
    expect(p.fields['作者']).toEqual(['张三'])
    expect(p.fields['标签']).toEqual(['弱辨识', 'heston'])
    // 2026-10-09：全文条件废止——仍被识别（不落入自由词），由调用方明确提示
    expect((p.fields as Record<string, string[] | undefined>)['全文']).toBeUndefined()
    expect(p.fulltextDeprecated).toEqual(['calibration'])
    expect(p.terms).toEqual(['Heston'])
  })

  it('全文条件识别两种写法（中英文别名），不落入自由词', () => {
    expect(parseLibraryQuery('全文:Heston').fulltextDeprecated).toEqual(['Heston'])
    expect(parseLibraryQuery('fulltext:Heston').fulltextDeprecated).toEqual(['Heston'])
    expect(parseLibraryQuery('FULLTEXT:Heston').fulltextDeprecated).toEqual(['Heston'])
    expect(parseLibraryQuery('全文:"weak identifiability"').fulltextDeprecated).toEqual(['weak identifiability'])
    // 废止条件被消费掉，剩余片段照常解析为自由词
    expect(parseLibraryQuery('弱辨识 全文:x').terms).toEqual(['弱辨识'])
  })

  it('年份区间与单年', () => {
    const p = parseLibraryQuery('弱辨识 年份:2020-2023 年份:2025')
    expect(p.years).toEqual([[2020, 2023], [2025, 2025]])
    expect(p.terms).toEqual(['弱辨识'])
  })

  it('英文别名与全角冒号', () => {
    const p = parseLibraryQuery('author:Zhang year:2024 venue:annals')
    expect(p.fields['作者']).toEqual(['zhang'])
    expect(p.years).toEqual([[2024, 2024]])
    expect(p.fields['期刊']).toEqual(['annals'])
  })

  it('未知字段名退化为自由词', () => {
    const p = parseLibraryQuery('标题:某词')
    expect((p.fields as Record<string, string[] | undefined>)['标题']).toBeUndefined()
    expect(p.terms).toEqual(['标题:某词'])
  })

  // WP-3：字段名大小写不敏感（此前 arXiv:/Author:/YEAR: 会静默退化为自由词 → 0 命中）
  it('字段名大小写不敏感', () => {
    expect(parseLibraryQuery('arXiv:2401.12345').fields.arxiv).toEqual(['2401.12345'])
    expect(parseLibraryQuery('ARXIV:2401.12345').fields.arxiv).toEqual(['2401.12345'])
    expect(parseLibraryQuery('Author:Zhang').fields['作者']).toEqual(['zhang'])
    expect(parseLibraryQuery('YEAR:2024').years).toEqual([[2024, 2024]])
    expect(parseLibraryQuery('Tags:Heston').fields['标签']).toEqual(['heston'])
  })

  // WP-3：字段值支持引号精确短语（多词作者、带空格标签）
  it('字段值支持引号短语', () => {
    expect(parseLibraryQuery('作者:"Zhang San"').fields['作者']).toEqual(['zhang san'])
    expect(parseLibraryQuery('标签:"弱 辨识"').fields['标签']).toEqual(['弱 辨识'])
    // 未闭合引号：去掉引号字符，不让用户卡在语法上
    expect(parseLibraryQuery('作者:"Zhang San').fields['作者']).toEqual(['zhang'])
  })

  // WP-3：自由词多词 AND + 引号短语（与笔记检索同一套语义）
  it('自由词支持多词 AND 与引号短语', () => {
    const p = parseLibraryQuery('正则化 "weak identifiability" Heston')
    expect(p.terms).toEqual(['正则化', 'weak identifiability', 'Heston'])
  })

  it('非法年份区间退化为自由词', () => {
    const p = parseLibraryQuery('年份:abcd')
    expect(p.years).toEqual([])
    expect(p.terms).toEqual(['abcd'])
  })
})

describe('年份区间解析', () => {
  it('单年/区间/反向区间/非法', () => {
    expect(parseYearRange('2020')).toEqual([2020, 2020])
    expect(parseYearRange('2020-2025')).toEqual([2020, 2025])
    expect(parseYearRange('2025~2020')).toEqual([2020, 2025])
    expect(parseYearRange('二〇二〇')).toBeNull()
  })
})

function meta(over: Partial<EntryMeta>): EntryMeta {
  return {
    schema: 2, id: 'id-1', docType: 'paper', title: '弱辨识性研究', authors: ['Zhang San', 'Li Si'],
    year: 2024, venue: 'Annals of Statistics', doi: '10.1234/x', arxivId: null, abstract: '关于 Heston 模型的弱辨识性。',
    tags: ['弱辨识', 'Heston'], spaceId: null, status: 'ok', note: null, files: [],
    readingState: null, createdAt: 't', updatedAt: 't', ...over
  }
}

describe('BibTeX 生成', () => {
  it('论文 → @article，含 author/year/journal/doi/keywords', () => {
    const b = entryToBibtex(meta({}))
    expect(b).toContain('@article{zhang2024弱辨识性研究')
    expect(b).toContain('author = {Zhang {S}an and {L}i {S}i}')
    expect(b).toContain('year = {2024}')
    expect(b).toContain('journal = {Annals of {S}tatistics}')
    expect(b).toContain('doi = {10.1234/x}')
    expect(b).toContain('keywords = {弱辨识, {H}eston}')
  })

  it('书 → @book（publisher）；无作者用 id 兜底；空年份 nd', () => {
    const b = entryToBibtex(meta({ docType: 'book', authors: [], year: null, id: 'abcdef12-0000' }))
    expect(b).toContain('@book{')
    expect(b).toContain('publisher = {')
    expect(b).toContain('year = {nd}')
    expect(citeKey(meta({ authors: [], id: 'abcdef12-0000' }))).toContain('abcdef12')
  })
})
