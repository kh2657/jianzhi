// 文献库检索：返回上限、排序与 total 口径（regression guards）
//
// 背景：hits 曾按 Map（= readdir 文件系统顺序）直接截断 200，库超过200 条时靠后的条目
// 既不显示也不可检索，而 total 取 hits.length、被截断，与分面计数（全量candidates）口径不一致。
// 修复：先按 updatedAt 倒序再截断，total 取真实命中数。
//
// 本文件规模用例（260 条）故意超出上限，验证「上限只截断传输、不影响命中总数与排序」。
import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import type { Repo } from '../src/main/storage/repo'
import { atomicWriteJson } from '../src/main/storage/fsutil'

/** 造 N 个条目库（updatedAt 递增，便于验证排序） */
async function buildEntries(t: TestRepo, n: number): Promise<void> {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  for (let d = 0; d < n; d++) {
    const dir = join(t.root, '文献库', '待整理', `P${String(d).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    const sha = createHash('sha256').update(String(d)).digest('hex')
    const iso = new Date(base + d * 1000).toISOString() // 序号越大越新
    await atomicWriteJson(join(dir, 'entry.json'), {
      schema: 2,
      id: `00000000-0000-4000-8000-${String(d).padStart(12, '0')}`,
      docType: 'paper',
      title: `标题 ${d}`,
      authors: [`作者${d % 3}`],
      year: null,
      venue: null,
      doi: null,
      arxivId: null,
      abstract: null,
      tags: [`标签${d % 2}`],
      spaceId: null,
      status: 'ok',
      note: '',
      files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: iso }],
      readingState: null,
      createdAt: iso,
      updatedAt: iso
    })
  }
}

/**
 * 260 条的重库：写 260 个 entry.json + 首次全库扫描是本文件最贵的部分
 * （Windows 上单次约 30 秒，占全量单测的主要开销）。两个规模用例都只做只读检索，
 * 因此共用一份建好的库，清理也只做一次。
 */
let big: { t: TestRepo; repo: Repo } | null = null
async function bigLibrary(): Promise<{ t: TestRepo; repo: Repo }> {
  if (big) return big
  const t = await makeTestRepo('mathwb-cap-')
  await buildEntries(t, 260)
  big = { t, repo: await t.reopen() }
  return big
}

afterAll(() => {
  big?.t.dispose()
  big = null
})

describe('librarySearch 返回上限与排序', () => {
  it('超过 200 条时：total 为真实命中数，hits 按 updatedAt 倒序且条数受上限约束', async () => {
    const { repo } = await bigLibrary()
    const res = await repo.librarySearch({ q: '' })

    // 上限只截断传输条数
    expect(res.hits).toHaveLength(200)
    // total 是真实命中数（不受上限影响）——这是修复的核心断言
    expect(res.total).toBe(260)

    // 排序：updatedAt 倒序，最新的在最前（标题 259 = 最后写入 = 最新）
    expect(res.hits[0].entry.title).toBe('标题 259')
    const times = res.hits.map((h) => h.entry.updatedAt)
    expect(times).toEqual([...times].sort((a, b) => b.localeCompare(a)))

    // 命中集包含最早那条（更新排序后它在末尾被截掉，但 total 证明它被算作命中）
    expect(res.total).toBeGreaterThan(res.hits.length)
  }, 120000)

  it('不满上限时 total 与 hits 一致', async () => {
    const t = await makeTestRepo('mathwb-cap2-')
    try {
      await buildEntries(t, 5)
      const repo = await t.reopen()
      const res = await repo.librarySearch({ q: '' })
      expect(res.total).toBe(5)
      expect(res.hits).toHaveLength(5)
    } finally {
      t.dispose()
    }
  }, 60000)

  it('分面计数与 total 口径协调（分面按「去掉该维度」统计，可大于 total）', async () => {
    const { repo } = await bigLibrary()
    const res = await repo.librarySearch({ q: '' })
    // 作者只有 3 个取值，author 分面的计数之和 = 全量命中（不是 hits.length）
    const authorSum = res.facets.author.reduce((a, f) => a + f.count, 0)
    expect(authorSum).toBe(260)
    expect(res.total).toBe(260)
  }, 120000)
})

describe('librarySearch 与全文派生数据解耦（2026-10-09 范围决策）', () => {
  it('空查询/自由词/字段查询全程不触碰全文文件（零读取、零 stat）', async () => {
    const t = await makeTestRepo('mathwb-ft-')
    try {
      const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
      const entryId = imp.documentId!
      const dirAbs = t.library.index.entries.get(entryId)!.dirAbs
      mkdirSync(join(dirAbs, 'derived'), { recursive: true })
      const abs = join(dirAbs, 'derived', 'fulltext.txt')
      const { writeFileSync, utimesSync } = await import('node:fs')
      writeFileSync(abs, 'UNIQUEFULLTEXT alpha beta gamma')
      const future = new Date(Date.now() + 2000)
      utimesSync(abs, future, future)

      const repo = await t.reopen()
      const cache = (repo as unknown as { fulltextCache: Map<string, unknown> }).fulltextCache

      // 空查询：不读全文
      await repo.librarySearch({ q: '' })
      expect(cache.size).toBe(0)

      // 自由词只搜标题/标签：仅正文含词 → 不命中，**也不读全文**（与派生数据彻底解耦）
      const freeWord = await repo.librarySearch({ q: 'UNIQUEFULLTEXT' })
      expect(freeWord.total).toBe(0)
      expect(cache.size).toBe(0)

      // 纯字段检索：同样零读取
      await repo.librarySearch({ q: '作者:Someone' })
      expect(cache.size).toBe(0)

      // 废止的全文条件：明确拒绝（不能静默当自由词，也不能返回未过滤全库）
      await expect(repo.librarySearch({ q: '全文:gamma' })).rejects.toThrow('标题和关键词')
      expect(cache.size).toBe(0)
    } finally {
      t.dispose()
    }
  }, 60000)
})

/**
 * 识别队列曾用 librarySearch({q:''}) 找条目，于是被同一个 200 条上限截断：
 * 库超过上限时目标条目不在返回集里，条目永远停在「待补全」。这里锁定直取接口的契约。
 */
describe('绕开检索上限的直取接口', () => {
  it('libraryEntryById：能取到被 hits 上限截掉的条目', async () => {
    const { repo } = await bigLibrary()
    const capped = await repo.librarySearch({ q: '' })
    const oldestId = '00000000-0000-4000-8000-000000000000' // 「标题 0」= 最早写入 = 排序末位
    expect(capped.hits.some((h) => h.entry.id === oldestId)).toBe(false) // 确实不在返回集里
    const found = repo.libraryEntryById(oldestId)
    expect(found?.entry.title).toBe('标题 0')
    expect(found?.section).toBe('待整理')
    expect(repo.libraryEntryById('nope')).toBeNull()
  })

  it('libraryNeedsReviewIds：直接按索引筛待补全（不经过检索）', async () => {
    const t = await makeTestRepo('mathwb-review-')
    try {
      await buildEntries(t, 3)
      const repo = await t.reopen()
      expect(repo.libraryNeedsReviewIds()).toEqual([])
      const id = repo.libraryEntryById('00000000-0000-4000-8000-000000000001')!.entry.id
      await repo.setEntryNeedsReview(id, true)
      expect(repo.libraryNeedsReviewIds()).toEqual([id])
    } finally {
      t.dispose()
    }
  })
})
// 排序：默认「最近更新」，可切标题 / 第一作者 / 年份 / 最近导入。
// 关键不变量：**排序发生在 200 条截断之前**（否则切换排序也救不回被截掉的条目）。
describe('文献库排序', () => {
  /** 三条字段完全可控的条目：标题/作者用 ASCII 保证断言确定 */
  const SPECS = [
    { key: 'a', title: 'Alpha', author: 'Chen', year: 2019, created: '2026-01-03T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' },
    { key: 'b', title: 'Beta', author: 'An', year: 2023, created: '2026-01-01T00:00:00.000Z', updated: '2026-01-03T00:00:00.000Z' },
    { key: 'c', title: 'Gamma', author: 'Bo', year: null, created: '2026-01-02T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z' }
  ]

  it('五种排序各自给出预期顺序（缺年份排最后）', async () => {
    const t = await makeTestRepo('mathwb-sort-')
    try {
      for (const s of SPECS) {
        const dir = join(t.root, '文献库', '待整理', s.key)
        mkdirSync(dir, { recursive: true })
        const sha = createHash('sha256').update(s.key).digest('hex')
        await atomicWriteJson(join(dir, 'entry.json'), {
          schema: 2,
          id: `00000000-0000-4000-8000-00000000000${s.key.charCodeAt(0) - 97}`,
          docType: 'paper',
          title: s.title,
          authors: [s.author],
          year: s.year,
          venue: null,
          doi: null,
          arxivId: null,
          abstract: null,
          tags: [],
          spaceId: null,
          status: 'ok',
          note: '',
          files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: s.created }],
          readingState: null,
          createdAt: s.created,
          updatedAt: s.updated
        })
      }
      const repo: Repo = await t.reopen()
      const titles = async (sort?: 'updated' | 'created' | 'title' | 'author' | 'year'): Promise<string[]> =>
        (await repo.librarySearch(sort ? { q: '', sort } : { q: '' })).hits.map((h) => h.entry.title)

      expect(await titles()).toEqual(['Beta', 'Gamma', 'Alpha']) // 默认 = 最近更新
      expect(await titles('title')).toEqual(['Alpha', 'Beta', 'Gamma'])
      expect(await titles('author')).toEqual(['Beta', 'Gamma', 'Alpha']) // An < Bo < Chen
      expect(await titles('year')).toEqual(['Beta', 'Alpha', 'Gamma']) // 2023 > 2019 > 缺
      expect(await titles('created')).toEqual(['Alpha', 'Gamma', 'Beta']) // 导入时间新→旧
    } finally {
      t.dispose()
    }
  })
})
