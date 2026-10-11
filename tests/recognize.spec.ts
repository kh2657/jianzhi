import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import {
  detectArxivId,
  detectDoi,
  extractPdfText,
  fetchMetadataByIdentifier,
  mapCrossref,
  suggestEntryTitle,
  RecognitionQueue
} from '../src/main/metadata/recognize'

describe('标识符提取', () => {
  it('DOI：正文/引用格式/尾随标点', () => {
    expect(detectDoi('Available at https://doi.org/10.1000/xyz123.')).toBe('10.1000/xyz123')
    expect(detectDoi('doi: 10.1234/weak-id-2024; see also')).toBe('10.1234/weak-id-2024')
    expect(detectDoi('DOI 10.1038/s41586-024-08234-3')).toBe('10.1038/s41586-024-08234-3')
    expect(detectDoi('没有标识符的文本')).toBeNull()
  })

  it('arXiv ID：标准前缀/无版本/裸 ID 上下文', () => {
    expect(detectArxivId('arXiv:2401.12345v2 [math.AG]')).toBe('2401.12345')
    expect(detectArxivId('arXiv 2601.00567 preprint')).toBe('2601.00567')
    expect(detectArxivId('This preprint (arXiv) has id 2401.99999 in it')).toBe('2401.99999')
    expect(detectArxivId('random numbers 1234.567 without context')).toBeNull()
  })
})

describe('Crossref 映射', () => {
  it('字段映射：标题/作者/年份/期刊/摘要去标签/主题', () => {
    const meta = mapCrossref({
      message: {
        title: ['Weak Identifiability'],
        author: [{ given: 'San', family: 'Zhang' }, { family: 'Wang' }],
        issued: { 'date-parts': [[2024, 3]] },
        'container-title': ['Annals of Statistics'],
        abstract: '<jats:p>关于 <jats:italic>Heston</jats:italic> 模型。</jats:p>',
        subject: ['Statistics', 'Mathematics']
      }
    })
    expect(meta).toMatchObject({
      title: 'Weak Identifiability',
      authors: ['San Zhang', 'Wang'],
      year: 2024,
      venue: 'Annals of Statistics',
      abstract: '关于 Heston 模型。',
      tags: ['Statistics', 'Mathematics']
    })
  })

  it('空/坏响应安全返回空', () => {
    expect(mapCrossref(null)).toEqual({})
    expect(mapCrossref({})).toEqual({})
  })
})

describe('fetchMetadataByIdentifier', () => {
  it('DOI 走 Crossref；arXiv 走 Atom API', async () => {
    const calls: string[] = []
    const fetcher = async (url: string) => {
      calls.push(url)
      if (url.includes('api.crossref.org')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { title: ['From Crossref'], author: [{ given: 'A', family: 'B' }], issued: { 'date-parts': [[2023]] } } }) }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>From arXiv</title><author><name>C D</name></author><published>2024-05-01T00:00:00Z</published><summary>摘要内容</summary></entry></feed>'
      }
    }
    const byDoi = await fetchMetadataByIdentifier({ doi: '10.1/x', arxivId: null }, fetcher)
    expect(byDoi.title).toBe('From Crossref')
    expect(calls[0]).toContain('api.crossref.org/works/10.1%2Fx')
    const byArxiv = await fetchMetadataByIdentifier({ doi: null, arxivId: '2401.12345' }, fetcher, 'https://export.arxiv.org/api/query')
    expect(byArxiv).toMatchObject({ title: 'From arXiv', year: 2024, venue: 'arXiv' })
    expect(calls[1]).toContain('id_list=2401.12345')
  })
})

describe('PDF 文本提取（真实夹具）', () => {
  it('text-basic.pdf 前 5 页含 THEOREM 文本；scanned.pdf 无文本', async () => {
    const text = await extractPdfText(join('fixtures', 'text-basic.pdf'), 5)
    expect(text).toContain('THEOREM')
    const empty = await extractPdfText(join('fixtures', 'scanned.pdf'), 5)
    expect(empty.trim()).toBe('')
  })
})

describe('建议条目名', () => {
  it('标题-第一作者姓-年份；缺省安全', () => {
    expect(suggestEntryTitle({ title: '弱辨识性研究', authors: ['Zhang San', 'Li Si'], year: 2024 })).toBe('弱辨识性研究-Zhang-2024')
    expect(suggestEntryTitle({ title: '无作者文献', authors: [], year: null })).toBe('无作者文献')
  })
})

describe('识别队列（注入依赖，离线）', () => {
  let t: TestRepo

  it('导入→队列→提取→Crossref 回填→状态 ok→文件夹改名（全文索引已拆到 WP-4 索引器，不在本链路）', async () => {
    t = await makeTestRepo('mathwb-recognize-')
    const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
    const entryId = imp.documentId!
    expect(t.library.index.entries.get(entryId)!.meta.status).toBe('needs-review')

    const queue = new RecognitionQueue(t.repo, {
      // 首页文本同时含标题与 DOI：标题一致性门（WP-2.2）通过 → 走自动回填路径
      extract: async () => 'Weak Identifiability of the Heston Model\nSan Zhang\nAbstract. We study weak identifiability.\ndoi: 10.1234/found-it',
      fetcher: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            message: {
              title: ['Weak Identifiability of the Heston Model'],
              author: [{ given: 'San', family: 'Zhang' }],
              issued: { 'date-parts': [[2024]] },
              'container-title': ['Annals of Statistics'],
              abstract: 'We study weak identifiability.'
            }
          })
      })
    })
    await queue.processOne(entryId)

    const entry = t.library.index.entries.get(entryId)!.meta
    expect(entry.status).toBe('ok')
    expect(entry.title).toBe('Weak Identifiability of the Heston Model')
    expect(entry.doi).toBe('10.1234/found-it')
    expect(entry.authors).toEqual(['San Zhang'])
    expect(entry.year).toBe(2024)
    expect(entry.venue).toBe('Annals of Statistics')
    // 全文提取/索引不在此链路（WP-4：FulltextIndexer 覆盖所有导入路径，见 tests/wp4-fulltext.spec.ts）
    const dirAbs = t.library.index.entries.get(entryId)!.dirAbs
    expect(existsSync(join(dirAbs, 'derived', 'fulltext.txt'))).toBe(false)
  })

  it('无标识符 → 保持待补全；已识别条目不重复处理', async () => {
    // 换用不同内容夹具（text-basic 已在上一用例导入过，同 sha 会判重）
    const [imp] = await t.repo.importDocuments(['fixtures/scanned.pdf'], { docType: 'paper' })
    const entryId = imp.documentId!
    const queue = new RecognitionQueue(t.repo, { extract: async () => 'plain text without identifiers' })
    await queue.processOne(entryId)
    expect(t.library.index.entries.get(entryId)!.meta.status).toBe('needs-review')

    // 已有 arxivId 的条目直接跳过（每日论文导入路径已自带元数据）
    await t.repo.updateEntryMeta(entryId, { arxivId: '2401.00001', status: 'ok' })
    let extractCalled = 0
    const q2 = new RecognitionQueue(t.repo, { extract: async () => { extractCalled++; return 'arXiv:9999.99999' } })
    await q2.processOne(entryId)
    expect(extractCalled).toBe(0)
  })
})
