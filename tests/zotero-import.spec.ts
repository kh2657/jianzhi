import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { findAttachmentPdf, importZoteroLibrary, parseZoteroItem, zoteroKeyOf } from '../src/main/metadata/zotero-import'

const CSL_ITEM = {
  id: 'https://www.zotero.org/users/local/abc/items/ABCD1234',
  type: 'journal-article',
  title: '弱辨识性研究',
  author: [{ given: 'San', family: 'Zhang' }, { name: '王五' }],
  issued: { 'date-parts': [[2024]] },
  'container-title': 'Annals of Statistics',
  DOI: '10.1234/weak-id',
  abstract: '关于 Heston 模型。',
  keyword: '弱辨识, Heston'
}

describe('CSL-JSON 解析', () => {
  it('字段映射：作者（given+family 与纯 name）、年份、期刊、DOI、标签、类型', () => {
    const item = parseZoteroItem(CSL_ITEM)!
    expect(item).toMatchObject({
      id: 'https://www.zotero.org/users/local/abc/items/ABCD1234',
      type: 'paper',
      title: '弱辨识性研究',
      authors: ['San Zhang', '王五'],
      year: 2024,
      venue: 'Annals of Statistics',
      doi: '10.1234/weak-id',
      tags: ['弱辨识', 'Heston']
    })
  })

  it('book 类型映射；缺标题/缺 id 跳过', () => {
    expect(parseZoteroItem({ ...CSL_ITEM, type: 'book' })!.type).toBe('book')
    expect(parseZoteroItem({ ...CSL_ITEM, title: '' })).toBeNull()
    expect(parseZoteroItem({ ...CSL_ITEM, id: undefined })).toBeNull()
  })
})

describe('Zotero 键与附件匹配', () => {
  it('id 取末段为条目键；按 KEY 文件夹与文件名两种方式命中 PDF', () => {
    expect(zoteroKeyOf('https://www.zotero.org/users/local/abc/items/ABCD1234')).toBe('ABCD1234')
    expect(zoteroKeyOf('ABCD1234')).toBe('ABCD1234')

    const dir = mkdtempSync(join(tmpdir(), 'mathwb-zot-'))
    try {
      const keyDir = join(dir, 'ABCD1234')
      mkdirSync(keyDir, { recursive: true })
      copyFileSync('fixtures/text-basic.pdf', join(keyDir, 'paper.pdf'))
      expect(findAttachmentPdf(dir, 'ABCD1234')).toBe(join(keyDir, 'paper.pdf'))

      const flatDir = mkdtempSync(join(tmpdir(), 'mathwb-zot2-'))
      copyFileSync('fixtures/text-basic.pdf', join(flatDir, 'ABCD1234-paper.pdf'))
      expect(findAttachmentPdf(flatDir, 'ABCD1234')).toBe(join(flatDir, 'ABCD1234-paper.pdf'))
      expect(findAttachmentPdf(dir, 'NOPE9999')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


describe('Zotero 导入集成（真实存储）', () => {
  it('有附件：条目落库并复制 PDF；同 DOI 重复跳过；坏条目安全降级', async () => {
    const { makeTestRepo } = await import('./helpers/folder-repo')
    const t = await makeTestRepo('mathwb-zotero-')
    try {
      const jsonPath = join(t.root, 'library.json')
      writeFileSync(jsonPath, JSON.stringify([
        CSL_ITEM,
        { type: 'journal-article', title: '' },
        { ...CSL_ITEM, id: 'EFGH5678', DOI: '10.9999/other', title: '另一篇', author: [{ name: '赵六' }] }
      ]))
      const storage = join(t.root, 'storage')
      mkdirSync(join(storage, 'ABCD1234'), { recursive: true })
      copyFileSync('fixtures/text-basic.pdf', join(storage, 'ABCD1234', '论文.pdf'))

      const r = await importZoteroLibrary(t.repo, jsonPath, storage)
      expect(r).toMatchObject({ total: 2, skipped: 1, created: 2, duplicated: 0, failed: 0 })

      const hits = await t.repo.librarySearch({ q: '作者:Zhang' })
      expect(hits.total).toBe(1)
      const entry = hits.hits[0].entry
      expect(entry).toMatchObject({ title: '弱辨识性研究', doi: '10.1234/weak-id', year: 2024, authors: ['San Zhang', '王五'] })
      expect(entry.files).toHaveLength(1)
      expect(existsSync(join(t.library.index.entries.get(entry.id)!.dirAbs, entry.files[0].name))).toBe(true)

      // 重复导入（同 DOI）→ 全部跳过
      const r2 = await importZoteroLibrary(t.repo, jsonPath, storage)
      expect(r2).toMatchObject({ created: 0, duplicated: 2 })
    } finally {
      t.dispose()
    }
  })

  it('无附件目录：纯书目条目（files 空，状态 ok）', async () => {
    const { makeTestRepo } = await import('./helpers/folder-repo')
    const t = await makeTestRepo('mathwb-zotero2-')
    try {
      const jsonPath = join(t.root, 'lib.json')
      writeFileSync(jsonPath, JSON.stringify([{ ...CSL_ITEM, id: 'ZZZZ9999', DOI: null }]))
      const r = await importZoteroLibrary(t.repo, jsonPath, null)
      expect(r).toMatchObject({ total: 1, created: 1 })
      const hit = (await t.repo.librarySearch({ q: '弱辨识性研究' })).hits[0]
      expect(hit.entry.files).toHaveLength(0)
      expect(hit.entry.status).toBe('ok')
      expect(hit.entry.note).toContain('Zotero:ZZZZ9999')
    } finally {
      t.dispose()
    }
  })

  it('全部条目无法识别：skipped 计数可见、库里零条目（选错文件时不再假装成功）', async () => {
    const { makeTestRepo } = await import('./helpers/folder-repo')
    const t = await makeTestRepo('mathwb-zotero3-')
    try {
      const jsonPath = join(t.root, 'wrong-format.json')
      // 模拟选错导出格式：既缺 id 也缺 title 的对象 / 乱结构
      writeFileSync(jsonPath, JSON.stringify([{ type: 'journal-article' }, { foo: 'bar' }, '文本行']))
      const r = await importZoteroLibrary(t.repo, jsonPath, null)
      expect(r).toMatchObject({ total: 0, skipped: 3, created: 0, duplicated: 0, failed: 0 })
      expect((await t.repo.librarySearch({ q: '' })).total).toBe(0)
    } finally {
      t.dispose()
    }
  })
})
