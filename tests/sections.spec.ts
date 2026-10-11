import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo

beforeAll(async () => {
  t = await makeTestRepo('mathwb-sections-')
  t.repo.ensureActivity()
  const dir = join(t.root, 'user-files')
  mkdirSync(dir, { recursive: true })
  for (const n of ['甲.pdf', '乙.pdf']) writeFileSync(join(dir, n), Buffer.from(`%PDF-1.4\n%${n}\n`))
  await t.repo.importDocuments([join(dir, '甲.pdf'), join(dir, '乙.pdf')])
})

afterAll(() => t?.dispose())

const sectionNames = async (): Promise<string[]> => (await t.repo.librarySections()).map((s) => s.name)

describe('分区管理', () => {
  it('新建分区；空分区也出现在清单；重名报错', async () => {
    t.repo.sectionCreate('模型校准')
    expect(await sectionNames()).toContain('模型校准')
    const s = (await t.repo.librarySections()).find((x) => x.name === '模型校准')
    expect(s).toMatchObject({ count: 0, needsReview: 0 })
    expect(() => t.repo.sectionCreate('模型校准')).toThrow('已存在')
  })

  it('重命名分区：目录改名、条目随行、检索分区口径同步', async () => {
    const [a] = await t.repo.importDocuments([join(t.root, 'user-files', '甲.pdf')])
    await t.repo.moveEntryToSection(a.documentId!, '模型校准')
    await t.repo.sectionRename('模型校准', '校准专题')
    const names = await sectionNames()
    expect(names).toContain('校准专题')
    expect(names).not.toContain('模型校准')
    const res = await t.repo.librarySearch({ q: '' })
    const hit = res.hits.find((h) => h.entry.id === a.documentId)
    expect(hit?.section).toBe('校准专题')
  })

  it('删除分区：条目移回「待整理」，目录移除；重命名/删除待整理被拒', async () => {
    await t.repo.sectionDelete('校准专题')
    const names = await sectionNames()
    expect(names).not.toContain('校准专题')
    const inbox = (await t.repo.librarySections()).find((s) => s.name === '待整理')
    expect(inbox?.count).toBe(2)
    await expect(t.repo.sectionRename('待整理', '别的')).rejects.toThrow('不能重命名')
    await expect(t.repo.sectionDelete('待整理')).rejects.toThrow('不能删除')
  })
})

describe('收藏标记（entry.json starred）', () => {
  it('starred 往返：写入 entry.json；检索可按收藏过滤；取消后键移除', async () => {
    const res = await t.repo.librarySearch({ q: '' })
    const starred1 = res.hits.find((h) => h.entry.title.includes('甲'))!
    const other = res.hits.find((h) => h.entry.title.includes('乙'))!
    await t.repo.libraryEntryUpdate(starred1.entry.id, { starred: true })

    // 落盘检查：starred 键存在
    const { readdirSync, readFileSync } = await import('node:fs')
    const entriesDir = join(t.root, '文献库', '待整理')
    const entryDir = readdirSync(entriesDir).find((d) => {
      try { return JSON.parse(readFileSync(join(entriesDir, d, 'entry.json'), 'utf8')).id === starred1.entry.id } catch { return false }
    })!
    const onDisk = JSON.parse(readFileSync(join(entriesDir, entryDir, 'entry.json'), 'utf8'))
    expect(onDisk.starred).toBe(true)

    // 检索过滤
    expect((await t.repo.librarySearch({ q: '', starred: true })).hits).toHaveLength(1)
    expect((await t.repo.librarySearch({ q: '', starred: false })).hits.map((h) => h.entry.id)).toEqual([other.entry.id])

    // 取消收藏：entry.json 里 starred 键应消失（不给未收藏条目留 false）
    await t.repo.libraryEntryUpdate(starred1.entry.id, { starred: false })
    const onDisk2 = JSON.parse(readFileSync(join(entriesDir, entryDir, 'entry.json'), 'utf8'))
    expect('starred' in onDisk2).toBe(false)
    expect((await t.repo.librarySearch({ q: '', starred: true })).hits).toHaveLength(0)
  })
})
