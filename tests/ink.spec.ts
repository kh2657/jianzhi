import { copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo
let repo: TestRepo['repo']
let versionId = ''

beforeAll(async () => {
  t = await makeTestRepo('mathwb-ink-')
  repo = t.repo
  const src = join(t.root, 'book.pdf')
  copyFileSync(join('fixtures', 'text-basic.pdf'), src)
  const r = await repo.importDocuments([src])
  versionId = r[0].versionId!
})

afterAll(() => {
  t?.dispose()
})

describe('批注墨迹：存取与契约', () => {
  it('空页面返回空数组', () => {
    expect(repo.inkGet(versionId, 0)).toEqual([])
  })

  it('保存后按 PDF 用户空间原样读回', async () => {
    const strokes = [
      { k: 'pen', c: '#d54941', w: 2.5, pts: [[72, 310], [100, 320], [140, 305]] },
      { k: 'highlight', c: '#ffd400', w: 12, pts: [[72, 350], [520, 350]] }
    ]
    await repo.saveInk(versionId, 0, strokes)
    expect(repo.inkGet(versionId, 0)).toEqual(strokes)
  })

  it('重复保存同页为替换（upsert，不追加）', async () => {
    await repo.saveInk(versionId, 0, [{ k: 'pen', c: '#111111', w: 2, pts: [[0, 0], [10, 10]] }])
    const got = repo.inkGet(versionId, 0)
    expect(got).toHaveLength(1)
    expect(got[0].c).toBe('#111111')
  })

  it('不同页面互不影响', async () => {
    await repo.saveInk(versionId, 1, [{ k: 'pen', c: '#2f6fed', w: 3, pts: [[5, 5], [50, 50]] }])
    expect(repo.inkGet(versionId, 0)).toHaveLength(1)
    expect(repo.inkGet(versionId, 1)).toHaveLength(1)
    expect(repo.inkGet(versionId, 2)).toHaveLength(0)
  })

  it('净化：坏颜色/线宽/点/超大输入被纠正或丢弃', async () => {
    const dirty = [
      { k: 'pen', c: 'javascript:alert(1)', w: 9999, pts: [[1, 1], [2, 2]] },        // 颜色/线宽纠正
      { k: 'x', c: '#ABCDEF', w: 2, pts: [[0, 0], [1, 1]] },                          // 未知种类 → pen
      { k: 'pen', c: '#111111', w: 2, pts: 'not-array' },                             // 丢弃
      { k: 'pen', c: '#111111', w: 2, pts: [[1]] },                                   // 点不完整 → 丢弃
      { k: 'pen', c: '#111111', w: 2, pts: [[1e9, 1e9], [2, 2]] },                    // 越界点 → 丢弃
      'garbage',                                                                      // 丢弃
      { k: 'pen', c: '#22AA88', w: 1.5, pts: [[3, 3], [4, 4], [5, 5]] }               // 合法
    ]
    await repo.saveInk(versionId, 0, dirty)
    const strokes = repo.inkGet(versionId, 0)
    expect(strokes).toHaveLength(3)
    expect(strokes[0]).toMatchObject({ k: 'pen', c: '#111111', w: 60 }) // 颜色纠正 + 线宽钳制
    expect(strokes[1]).toMatchObject({ k: 'pen', c: '#abcdef' })
    expect(strokes[2]).toMatchObject({ c: '#22aa88' })
    expect(strokes.every((s) => s.pts.length >= 2)).toBe(true)
  })

  it('非法输入不抛异常地返回空（损坏 JSON 容错）', async () => {
    const entry = t.library.index.entries.get(t.repo.listDocuments()[0].id)!
    const inkFile = join(entry.dirAbs, 'ink', versionId.slice(0, 8), 'p0.json')
    writeFileSync(inkFile, '{broken')
    expect(repo.inkGet(versionId, 0)).toEqual([])
    await repo.saveInk(versionId, 0, [])
  })

  it('参数校验：坏页码/坏版本被拒绝', async () => {
    await expect(repo.saveInk(versionId, -1, [])).rejects.toThrow()
    await expect(repo.saveInk(versionId, 1.5, [])).rejects.toThrow()
    await expect(repo.saveInk('f'.repeat(64), 0, [])).rejects.toThrow('文档版本不存在')
  })

  it('重启（重新扫描）后墨迹仍在', async () => {
    await repo.saveInk(versionId, 2, [{ k: 'pen', c: '#123456', w: 4, pts: [[10, 20], [30, 40], [50, 60]] }])
    const repo2 = await t.reopen()
    const strokes = repo2.inkGet(versionId, 2)
    expect(strokes).toHaveLength(1)
    expect(strokes[0].pts).toEqual([[10, 20], [30, 40], [50, 60]])
  })

  it('删除条目文件夹后其墨迹消失，其他条目墨迹不受影响', async () => {
    const src2 = join(t.root, 'book2.pdf')
    copyFileSync(join('fixtures', 'scanned.pdf'), src2)
    const r = await t.repo.importDocuments([src2])
    const v2 = r[0].versionId!
    await t.repo.saveInk(v2, 0, [{ k: 'pen', c: '#000000', w: 2, pts: [[1, 1], [2, 2]] }])
    const docId = t.repo.listDocuments().find((d) => d.id === r[0].documentId)!.id
    const entryDir = t.library.index.entries.get(docId)!.dirAbs
    rmSync(entryDir, { recursive: true, force: true })
    const repo2 = await t.reopen()
    expect(repo2.inkGet(v2, 0)).toEqual([])
    // 原条目墨迹不受影响（page1/2 各 1 笔；page0 已被容错测试清空）
    expect(repo2.inkGet(versionId, 1)).toHaveLength(1)
    expect(repo2.inkGet(versionId, 2)).toHaveLength(1)
  })
})
