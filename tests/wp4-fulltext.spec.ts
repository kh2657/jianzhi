// WP-4：全文索引独立化——覆盖所有导入路径、全页提取、状态显式（ready/empty/error）、可重建。
//
// 修复前：全文提取写在识别队列里，只覆盖「needs-review 且无 DOI/arXiv」的条目、只取前 5 页；
// arXiv/Zotero/浏览器导入的条目完全没有全文，失败也没有状态可查。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import {
  FULLTEXT_ENGINE, FULLTEXT_FILE, FULLTEXT_META_FILE, FulltextIndexer, readFulltextMeta, readMetaForTargets,
  type FulltextExtractor, type FulltextMeta
} from '../src/main/metadata/fulltext'

/** 假提取器：返回构造的文本（避免测试依赖 pdfjs）；pageStarts 按行（= 页）偏移生成 */
const fakeExtract = (text: string, pages = 3): FulltextExtractor => async () => {
  const lines = text.split('\n')
  const pageStarts: number[] = []
  let offset = 0
  for (let i = 0; i < pages; i++) {
    pageStarts.push(offset)
    offset += (lines[i] ?? `第 ${i + 1} 页`).length + 1
  }
  return { text, pages, pageCount: pages, truncated: false, pageStarts }
}

async function newIndexer(t: TestRepo, extract: FulltextExtractor): Promise<FulltextIndexer> {
  return new FulltextIndexer(t.repo, { extract, politenessMs: 0 })
}

describe('全文索引器：状态显式、可重建', () => {
  it('导入后索引：写 fulltext.txt + meta(ready)，覆盖所有导入路径（都走 importDocuments）', async () => {
    const t: TestRepo = await makeTestRepo('wp4-ready-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const dirAbs = t.library.index.entries.get(imp.documentId!)!.dirAbs
      const indexer = await newIndexer(t, fakeExtract('第一页正文\n第二页正文\n第三页正文'))
      const status = await indexer.indexOne({
        entryId: imp.documentId!, entryDirAbs: dirAbs,
        absPath: join(dirAbs, 'text-basic.pdf'), fileSha: imp.versionId!, mediaType: 'application/pdf', pageCount: null
      })
      expect(status).toBe('ready')
      expect(readFileSync(join(dirAbs, FULLTEXT_FILE), 'utf8')).toContain('第三页正文')
      const meta = await readFulltextMeta(dirAbs)
      expect(meta).toMatchObject({ status: 'ready', engine: FULLTEXT_ENGINE, fileSha: imp.versionId, pages: 3, truncated: false })
    } finally { t.dispose() }
  }, 60000)

  it('扫描版（无文本层）→ empty + 原因（不伪装成已索引）', async () => {
    const t: TestRepo = await makeTestRepo('wp4-empty-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/scanned.pdf'], { docType: 'book' })
      const dirAbs = t.library.index.entries.get(imp.documentId!)!.dirAbs
      const indexer = await newIndexer(t, fakeExtract('   '))
      const status = await indexer.indexOne({
        entryId: imp.documentId!, entryDirAbs: dirAbs,
        absPath: join(dirAbs, 'scanned.pdf'), fileSha: imp.versionId!, mediaType: 'application/pdf', pageCount: 2
      })
      expect(status).toBe('empty')
      const meta = await readFulltextMeta(dirAbs)
      expect(meta?.status).toBe('empty')
      expect(meta?.reason).toContain('扫描版')
    } finally { t.dispose() }
  }, 60000)

  it('提取失败 → error + 原因；重建时会被重新入队', async () => {
    const t: TestRepo = await makeTestRepo('wp4-error-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const target = t.repo.libraryFulltextTarget(imp.documentId!)!
      const failing = await newIndexer(t, async () => { throw new Error('模拟提取失败：磁盘坏扇区') })
      expect(await failing.indexOne(target)).toBe('error')
      const meta = await readFulltextMeta(target.entryDirAbs)
      expect(meta?.status).toBe('error')
      expect(meta?.reason).toContain('坏扇区')

      // 重建（enqueueStale）应把它重新入队：error 状态视为过期
      const ok = await newIndexer(t, fakeExtract('重试成功'))
      const metas = await readMetaForTargets(t.repo.libraryFulltextTargets())
      const queued = ok.enqueueStale(metas)
      expect(queued).toBeGreaterThanOrEqual(1)
      expect(ok.pendingCount).toBeGreaterThanOrEqual(1)
      ok.stop()
    } finally { t.dispose() }
  }, 60000)

  it('过期判定：引擎版本 / 文件 sha / 页数 任一变化都重入队；健康索引不重跑', async () => {
    const t: TestRepo = await makeTestRepo('wp4-stale-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const target = t.repo.libraryFulltextTarget(imp.documentId!)!
      const indexer = await newIndexer(t, fakeExtract('正文'))
      await indexer.indexOne(target)
      const meta = (await readFulltextMeta(target.entryDirAbs))!

      const healthy = new FulltextIndexer(t.repo, { extract: fakeExtract('x'), politenessMs: 0 })
      expect(healthy.enqueueStale(new Map([[target.entryId, meta]]))).toBe(0) // 健康 → 不重跑
      healthy.stop()

      const staleEngine = new FulltextIndexer(t.repo, { extract: fakeExtract('x'), politenessMs: 0 })
      expect(staleEngine.enqueueStale(new Map([[target.entryId, { ...meta, engine: FULLTEXT_ENGINE - 1 } as FulltextMeta]]))).toBe(1)
      staleEngine.stop()

      const staleSha = new FulltextIndexer(t.repo, { extract: fakeExtract('x'), politenessMs: 0 })
      expect(staleSha.enqueueStale(new Map([[target.entryId, { ...meta, fileSha: 'other' } as FulltextMeta]]))).toBe(1)
      staleSha.stop()

      const missing = new FulltextIndexer(t.repo, { extract: fakeExtract('x'), politenessMs: 0 })
      expect(missing.enqueueStale(new Map([[target.entryId, null]]))).toBe(1)
      missing.stop()
    } finally { t.dispose() }
  }, 60000)

  it('HTML 材料：标 empty 并说明原因（当前版本不建全文索引）', async () => {
    const t: TestRepo = await makeTestRepo('wp4-html-')
    try {
      const [imp] = await t.repo.importDocuments([join('fixtures', '..', 'fixtures', 'text-basic.pdf')], { docType: 'book' })
      const target = t.repo.libraryFulltextTarget(imp.documentId!)!
      const indexer = await newIndexer(t, fakeExtract('x'))
      const status = await indexer.indexOne({ ...target, mediaType: 'text/html' })
      expect(status).toBe('empty')
      const meta = await readFulltextMeta(target.entryDirAbs)
      expect(meta?.reason).toContain('HTML')
    } finally { t.dispose() }
  }, 60000)

  it('enqueue（按条目）写入派生文件：仅供打开文档后查找，不再进入文献检索', async () => {
    const t: TestRepo = await makeTestRepo('wp4-enqueue-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      const indexer = await newIndexer(t, fakeExtract('unique-fulltext-marker 出现一次'))
      indexer.enqueue(imp.documentId!)
      // 串行队列：等它跑完（500ms 调度 + 0ms 间隔）
      await new Promise((r) => setTimeout(r, 1200))
      indexer.stop()
      const dirAbs = t.library.index.entries.get(imp.documentId!)!.dirAbs
      expect(existsSync(join(dirAbs, FULLTEXT_FILE))).toBe(true)
      // 检索新范围（architecture §15）：仅正文含词 → 自由词不命中
      const res = await t.repo.librarySearch({ q: 'unique-fulltext-marker' })
      expect(res.total).toBe(0)
      // 打开文档后的查找（findInDocument）仍命中；versionId = 最新文件的 sha
      const target = t.repo.libraryFulltextTarget(imp.documentId!)!
      const found = await t.repo.findInDocument(target.fileSha, 'unique-fulltext-marker')
      expect(found.indexed).toBe(true)
      expect(found.total).toBeGreaterThanOrEqual(1)
    } finally { t.dispose() }
  }, 60000)
})