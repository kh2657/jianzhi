// WP-3：文献库检索的分页（「加载更多」可完整浏览 >200 条）与「命中理由」（哪个字段、上下文）。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atomicWriteJson } from '../src/main/storage/fsutil'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

const iso = (d: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + d * 1000).toISOString()

async function seedEntries(t: TestRepo, n: number): Promise<void> {
  for (let d = 0; d < n; d++) {
    const dir = join(t.root, '文献库', '待整理', `P${String(d).padStart(3, '0')}`)
    mkdirSync(dir, { recursive: true })
    const sha = createHash('sha256').update(String(d)).digest('hex')
    await atomicWriteJson(join(dir, 'entry.json'), {
      schema: 2, id: `00000000-0000-4000-8000-${String(d).padStart(12, '0')}`, docType: 'paper',
      title: `标题 ${d}`, authors: [`作者${d % 3}`], year: null, venue: null, doi: null, arxivId: null,
      abstract: d === 7 ? '这篇讨论正则化方法的稳定性。' : null,
      tags: [`标签${d % 2}`], spaceId: null, status: 'ok', note: '',
      files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: iso(d) }],
      readingState: null, createdAt: iso(d), updatedAt: iso(d)
    })
    if (d === 9) {
      const derived = join(dir, 'derived')
      mkdirSync(derived, { recursive: true })
      writeFileSync(join(derived, 'fulltext.txt'), '正文里出现 unique-bodied-term 一次')
    }
  }
}

describe('文献库检索：分页与命中理由', () => {
  it('260 条库可完整浏览：第一页 200、偏移续读 60、页间不重叠且顺序连续', async () => {
    const t: TestRepo = await makeTestRepo('wp3-page-')
    try {
      await seedEntries(t, 260)
      const repo = await t.reopen()
      const first = await repo.librarySearch({ q: '' })
      expect(first.hits).toHaveLength(200)
      expect(first.total).toBe(260)

      const second = await repo.librarySearch({ q: '', offset: 200 })
      expect(second.hits).toHaveLength(60)
      expect(second.total).toBe(260)
      // 不重叠
      const firstIds = new Set(first.hits.map((h) => h.entry.id))
      expect(second.hits.every((h) => !firstIds.has(h.entry.id))).toBe(true)
      // 顺序连续（排序在分页之前：第二页首条应紧接第一页末条）
      const allSorted = [...first.hits, ...second.hits].map((h) => h.entry.updatedAt)
      expect(allSorted).toEqual([...allSorted].sort((a, b) => b.localeCompare(a)))
      // 越界偏移返回空页（不报错）
      expect((await repo.librarySearch({ q: '', offset: 999 })).hits).toHaveLength(0)
    } finally { t.dispose() }
  }, 120000)

  it('命中理由：自由词只描述标题/标签；摘要与正文不在范围（仅其含词不命中）', async () => {
    const t: TestRepo = await makeTestRepo('wp3-match-')
    try {
      await seedEntries(t, 12)
      const repo = await t.reopen()

      // 摘要含「正则化」但标题/标签不含 → 不命中（范围限制，不是漏检）
      const byAbstract = await repo.librarySearch({ q: '正则化' })
      expect(byAbstract.hits).toHaveLength(0)

      // 正文含 unique-bodied-term → 不命中（全文已退出普通检索）
      const byFulltext = await repo.librarySearch({ q: 'unique-bodied-term' })
      expect(byFulltext.hits).toHaveLength(0)

      // 标签命中给「标签」标签与上下文
      const byTag = await repo.librarySearch({ q: '标签1' })
      expect(byTag.hits.length).toBeGreaterThan(0)
      expect(byTag.hits.every((h) => h.match?.field === '标签')).toBe(true)
      expect(byTag.hits[0].match?.term).toBe('标签1')
    } finally { t.dispose() }
  }, 120000)

  it('标题命中优先于其它字段；显式字段检索也给出命中理由（哪个字段命中）', async () => {
    const t: TestRepo = await makeTestRepo('wp3-match2-')
    try {
      await seedEntries(t, 12)
      const repo = await t.reopen()
      const byTitle = await repo.librarySearch({ q: '标题 7' })
      expect(byTitle.hits).toHaveLength(1)
      expect(byTitle.hits[0].match?.field).toBe('标题')

      const fieldOnly = await repo.librarySearch({ q: '作者:作者0' })
      expect(fieldOnly.hits.length).toBeGreaterThan(0)
      expect(fieldOnly.hits[0].match?.field).toBe('作者')
      expect(fieldOnly.hits[0].match?.term).toBe('作者0')

      // 无检索词（浏览列表）不产生命中理由
      const browse = await repo.librarySearch({ q: '' })
      expect(browse.hits.every((h) => h.match === null)).toBe(true)
    } finally { t.dispose() }
  }, 120000)

  // 2026-10-09 排序分层：完整查询精确匹配标题 > 全部自由词在标题 > 标题+标签混合 > 仅标签；
  // 同档按所选排序器（默认 updatedAt 倒序），最后以 ID 保持稳定。
  it('自由词排序分层：完整标题 > 全在标题 > 标题+标签混合 > 仅标签', async () => {
    const t: TestRepo = await makeTestRepo('wp3-tier-')
    try {
      const mk = async (key: string, title: string, tags: string[], updated: string): Promise<void> => {
        const dir = join(t.root, '文献库', '待整理', key)
        mkdirSync(dir, { recursive: true })
        const sha = createHash('sha256').update(key).digest('hex')
        await atomicWriteJson(join(dir, 'entry.json'), {
          schema: 2, id: `00000000-0000-4000-8000-${key.charCodeAt(0).toString().padStart(12, '0')}`,
          docType: 'paper', title, authors: [], year: null, venue: null, doi: null, arxivId: null,
          abstract: null, tags, spaceId: null, status: 'ok', note: '',
          files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: updated }],
          readingState: null, createdAt: updated, updatedAt: updated
        })
      }
      await mk('a', 'Heston 校准', ['随机'], iso(3)) // 完整查询精确等于标题 → 第 0 档
      await mk('b', '弱辨识与 Heston 校准研究', ['标签x'], iso(2)) // 全部词在标题 → 第 1 档
      await mk('c', '校准方法综述', ['Heston'], iso(1)) // 标题+标签混合 → 第 2 档
      await mk('d', '无关题目', ['Heston 校准'], iso(0)) // 仅标签 → 第 3 档
      const repo = await t.reopen()
      const res = await repo.librarySearch({ q: 'heston 校准' })
      expect(res.hits.map((h) => h.entry.title)).toEqual([
        'Heston 校准',
        '弱辨识与 Heston 校准研究',
        '校准方法综述',
        '无关题目'
      ])
    } finally { t.dispose() }
  }, 60000)
})