// WP-2.2 / R1+R2：识别正确性。
//
// 修复前：`detectDoi` 取首个匹配（可能是首页脚注里的**参考文献** DOI），拿到 Crossref 元数据后
// **无条件覆盖**标题/作者/年份并把状态置 ok —— 错误身份从此写进文献库（检索、去重、BibTeX 全被污染）。
// 修复后：候选标题必须与 PDF 正文一致（标题一致性门）才自动回填；否则只保留「从 PDF 本体提取、
// 可人工复核」的标识符并保持待补全。
// 另外收紧 arxiv 裸 ID 兜底：只在「arXiv」字样就近窗口内识别，避免把参考文献编号/页码当成论文 ID。
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { RecognitionQueue, detectArxivId, detectDoi, titleMatchesPageText, type MetaFetcher } from '../src/main/metadata/recognize'

describe('标题一致性判定（纯函数）', () => {
  it('标题出现在正文中 → 高置信；不相干标题 → 低置信', () => {
    const page = 'Weak Identifiability of the Heston Model\nSan Zhang\nAbstract. We study...'
    expect(titleMatchesPageText('Weak Identifiability of the Heston Model', page).confident).toBe(true)
    expect(titleMatchesPageText('A Study of Something Else Entirely', page).confident).toBe(false)
    // 词覆盖率 3/5 = 60% → 低置信；全覆盖 → 高置信
    const partial = titleMatchesPageText('Weak Identifiability of the Heston Model', 'weak identifiability of some model')
    expect(partial.confident).toBe(false)
    expect(partial.reason).toContain('60%')
    expect(titleMatchesPageText('Weak Identifiability of the Heston Model', 'weak identifiability of the heston model via moments').confident).toBe(true)
  })

  it('PDF 无可比对文本（扫描版/空文本）→ 低置信，绝不自动覆盖', () => {
    expect(titleMatchesPageText('Some Title Here', '').confident).toBe(false)
    expect(titleMatchesPageText('', 'anything').confident).toBe(false)
  })

  it('中文标题按原文包含判定', () => {
    expect(titleMatchesPageText('随机分析引论', '随机分析引论 第一章 引言').confident).toBe(true)
    expect(titleMatchesPageText('随机分析引论', '泛函分析讲义 第一章').confident).toBe(false)
  })
})

describe('arxiv 裸 ID 收紧（R2）', () => {
  it('「arXiv」就近的 ID 命中；远处同形态数字不再误取', () => {
    expect(detectArxivId('arXiv:2401.12345v2 [math.PR] 12 Jan 2026')).toBe('2401.12345')
    expect(detectArxivId('Preprint available on arXiv 2502.99999')).toBe('2502.99999')
    const far = 'References to arXiv and related preprint indexes. ' + 'x'.repeat(300) + ' 2024.12345'
    expect(detectArxivId(far)).toBe(null)
    expect(detectDoi('no identifiers here')).toBe(null)
  })
})

const crossrefResponse = (title: string, year = 2024): MetaFetcher => async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      message: {
        title: [title],
        author: [{ given: 'San', family: 'Zhang' }],
        issued: { 'date-parts': [[year]] },
        'container-title': ['Annals of Statistics'],
        abstract: 'We study weak identifiability.'
      }
    })
})

async function runQueue(t: TestRepo, entryId: string, pageText: string, fetcher: MetaFetcher): Promise<void> {
  const queue = new RecognitionQueue(t.repo, { extract: async () => pageText, fetcher })
  await queue.processOne(entryId)
}

describe('识别链路：低置信书目候选不覆盖身份', () => {
  it('标题一致 → 自动回填标题/作者/年份并置 ok', async () => {
    const t: TestRepo = await makeTestRepo('wp22-conf-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const id = imp.documentId!
      await runQueue(
        t, id,
        'Weak Identifiability of the Heston Model\nSan Zhang\ndoi: 10.1234/found-it',
        crossrefResponse('Weak Identifiability of the Heston Model')
      )
      const meta = t.library.index.entries.get(id)!.meta
      expect(meta.title).toBe('Weak Identifiability of the Heston Model')
      expect(meta.authors).toEqual(['San Zhang'])
      expect(meta.year).toBe(2024)
      expect(meta.doi).toBe('10.1234/found-it')
      expect(meta.venue).toBe('Annals of Statistics')
      expect(meta.status).toBe('ok')
    } finally { t.dispose() }
  }, 60000)

  it('仅参考文献 DOI（标题不一致）→ 不覆盖书目；写 DOI 但保持待补全，且不会反复识别', async () => {
    const t: TestRepo = await makeTestRepo('wp22-ref-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const id = imp.documentId!
      await runQueue(
        t, id,
        'Lecture notes on spectral theory.\nReferences:\n[1] Some paper, doi:10.9999/reference-only.',
        crossrefResponse('完全不同的另一篇论文', 2001)
      )
      const meta = t.library.index.entries.get(id)!.meta
      expect(meta.doi).toBe('10.9999/reference-only') // 标识符本身提取自 PDF，可复核
      expect(meta.title).toBe('text-basic')           // ← 原标题保持（修复前会被覆盖）
      expect(meta.authors).toEqual([])                // ← 作者不被污染
      expect(meta.year).toBe(null)
      expect(meta.abstract).toBe(null)
      expect(meta.venue).toBe(null)
      expect(meta.status).toBe('needs-review')        // ← 仍待补全，等人工核对

      // 已有 doi → 再次入队直接跳过（不会反复覆盖）
      const queue2 = new RecognitionQueue(t.repo, { extract: async () => { throw new Error('不应再提取') } })
      await queue2.processOne(id)
      expect(t.library.index.entries.get(id)!.meta.title).toBe('text-basic')
    } finally { t.dispose() }
  }, 60000)

  it('网络失败：只写提取到的 DOI，其余字段不动，保持待补全', async () => {
    const t: TestRepo = await makeTestRepo('wp22-net-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/scanned.pdf'], { docType: 'paper' })
      const id = imp.documentId!
      await runQueue(t, id, 'Notes with doi:10.1234/x inside.', async () => { throw new Error('network down') })
      const meta = t.library.index.entries.get(id)!.meta
      expect(meta.doi).toBe('10.1234/x')
      expect(meta.title).toBe('scanned')
      expect(meta.authors).toEqual([])
      expect(meta.status).toBe('needs-review')
    } finally { t.dispose() }
  }, 60000)

  it('无标识符的讲义：不写任何字段，保持待补全（现状回归）', async () => {
    const t: TestRepo = await makeTestRepo('wp22-plain-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/scanned.pdf'], { docType: 'paper' })
      const id = imp.documentId!
      await runQueue(t, id, '第一章 引言。本讲义没有 DOI。', async () => { throw new Error('不应请求网络') })
      const meta = t.library.index.entries.get(id)!.meta
      expect(meta.title).toBe('scanned')
      expect(meta.status).toBe('needs-review')
      expect(meta.doi).toBe(null)
    } finally { t.dispose() }
  }, 60000)
})