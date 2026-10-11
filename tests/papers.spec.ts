import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import type { ArxivEntry } from '../src/main/papers'

let t: TestRepo
let repo: TestRepo['repo']

const entry = (id: string, title: string): ArxivEntry => ({
  arxivId: id,
  title,
  authors: ['A Author'],
  abstract: 'abs',
  primaryCategory: 'math.AG',
  categories: ['math.AG'],
  publishedAt: new Date().toISOString(),
  pdfUrl: `https://arxiv.org/pdf/${id}`,
  absUrl: `https://arxiv.org/abs/${id}`
})

beforeAll(async () => {
  t = await makeTestRepo('mathwb-papers-')
  repo = t.repo
})

afterAll(() => {
  t?.dispose()
})

describe('论文订阅 CRUD', () => {
  it('创建 / 校验 / 更新 / 删除', async () => {
    const f = await repo.paperFeedCreate({ name: '代数几何每日', categories: 'math.AG, math.NT', keywords: 'moduli' })
    expect(f.categories).toBe('math.AG,math.NT') // 规范化
    expect(f.maxResults).toBe(50)
    // WP-1：paperFeedCreate 现在「先写盘、成功后才提交内存」，校验错误随之成为 rejection
    await expect(repo.paperFeedCreate({ name: '', categories: 'math.AG', keywords: '' })).rejects.toThrow()
    await expect(repo.paperFeedCreate({ name: '空条件', categories: '', keywords: '' })).rejects.toThrow('至少填写一个分类或关键词')
    await repo.paperFeedUpdate(f.id, { keywords: 'Calabi-Yau', maxResults: 100 })
    expect(repo.paperFeedList()[0].keywords).toBe('Calabi-Yau')
    expect(repo.paperFeedList()[0].maxResults).toBe(100)
    await repo.paperFeedDelete(f.id)
    expect(repo.paperFeedList()).toHaveLength(0)
  })
})

describe('论文条目：upsert 去重 / 状态机 / 重启持久化', () => {
  let feedId = ''

  beforeAll(async () => {
    feedId = (await repo.paperFeedCreate({ name: '每日', categories: 'math.AG', keywords: '' })).id
  })

  it('首次入库为 new；重复抓取不重建、不重置状态', async () => {
    expect(await repo.paperItemsUpsert(feedId, [entry('2510.1v1', '论文一'), entry('2510.2v1', '论文二')])).toBe(2)
    await repo.paperSetStatus('2510.1v1', 'skipped')
    expect(await repo.paperItemsUpsert(feedId, [entry('2510.1v1', '论文一（改）')])).toBe(0)
    const kept = repo.paperGetByArxivId('2510.1v1')!
    expect(kept.status).toBe('skipped') // 状态保留
    expect(kept.title).toBe('论文一') // 元数据保留首次
    expect(kept.feedNames).toEqual(['每日'])
  })

  it('状态机：skipped/new 可设置，imported 只能通过导入设置', async () => {
    await expect(repo.paperSetStatus('2510.1v1', 'imported')).rejects.toThrow('导入状态请通过导入操作设置')
    await expect(repo.paperSetStatus('不存在', 'skipped')).rejects.toThrow('论文条目不存在')
    await repo.paperSetStatus('2510.1v1', 'new')
    expect(repo.paperGetByArxivId('2510.1v1')!.status).toBe('new')
  })

  it('列表按状态与时间过滤', async () => {
    const newItems = repo.paperList('new', 7)
    expect(newItems.map((i) => i.arxivId)).toContain('2510.1v1')
    expect(newItems.map((i) => i.arxivId)).toContain('2510.2v1')
    await repo.paperSetStatus('2510.2v1', 'skipped')
    expect(repo.paperList('skipped', 7).map((i) => i.arxivId)).toEqual(['2510.2v1'])
    expect(repo.paperList('new', 7)).toHaveLength(1)
  })

  it('标记导入并关联文档（条目补全 arXiv 身份）', async () => {
    const src = join(t.root, 'paper.pdf')
    copyFileSync(join('fixtures', 'text-basic.pdf'), src)
    const imp = await repo.importDocuments([src], { spaceId: null, docType: 'paper' })
    await repo.paperMarkImported('2510.1v1', imp[0].documentId!)
    const item = repo.paperGetByArxivId('2510.1v1')!
    expect(item.status).toBe('imported')
    expect(item.documentId).toBe(imp[0].documentId)
    expect(repo.paperList('imported', 7)).toHaveLength(1)
    const entry = t.library.index.entries.get(imp[0].documentId!)!
    expect(entry.meta.arxivId).toBe('2510.1v1') // 测试 ID 非 arXiv 标准格式，baseId 原样写回
  })

  it('重启（重新扫描）后订阅与条目仍在', async () => {
    const repo2 = await t.reopen()
    expect(repo2.paperFeedList()).toHaveLength(1)
    expect(repo2.paperGetByArxivId('2510.1v1')!.status).toBe('imported')
  })

  it('删除订阅级联删除其条目（已导入的文档不受影响）', async () => {
    const feed2 = (await repo.paperFeedCreate({ name: '临时', categories: 'math.NT', keywords: '' })).id
    await repo.paperItemsUpsert(feed2, [entry('2510.9v9', '临时论文')])
    await repo.paperFeedDelete(feed2)
    expect(repo.paperGetByArxivId('2510.9v9')).toBeNull()
    expect(repo.paperGetByArxivId('2510.1v1')).not.toBeNull()
  })
})
