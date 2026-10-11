import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

const colorFile = (root: string): string => join(root, '分区.json')
const readColors = (root: string): Record<string, string> => JSON.parse(readFileSync(colorFile(root), 'utf8')).colors
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

let t: TestRepo

beforeAll(async () => {
  t = await makeTestRepo('mathwb-seccolor-')
})

afterAll(() => t?.dispose())

describe('分区颜色标签（库根 分区.json）', () => {
  it('未设色时 librarySections 返回 color:null；设色后落盘并写入 schema', async () => {
    await t.repo.sectionCreate('正则化理论')
    let sections = t.repo.librarySections()
    expect(sections.find((s) => s.name === '正则化理论')).toMatchObject({ count: 0, color: null })

    t.repo.sectionColorSet('正则化理论', 'blue')
    await flush()
    expect(sections.find((s) => s.name === '正则化理论')!.color).toBeNull() // 旧数组是快照，不回溯
    sections = t.repo.librarySections()
    expect(sections.find((s) => s.name === '正则化理论')!.color).toBe('blue')

    expect(existsSync(colorFile(t.root))).toBe(true)
    expect(readColors(t.root)).toEqual({ 正则化理论: 'blue' })
    expect(JSON.parse(readFileSync(colorFile(t.root), 'utf8')).schema).toBe(1)
  })

  it('清除颜色：内存立即生效，键从文件消失', async () => {
    t.repo.sectionColorSet('正则化理论', null)
    await flush()
    expect(t.repo.librarySections().find((s) => s.name === '正则化理论')!.color).toBeNull()
    expect(readColors(t.root)).toEqual({})
  })

  it('分区不存在时拒绝设色（避免写出永不显示的颜色）', async () => {
    expect(() => t.repo.sectionColorSet('不存在的分区', 'red')).toThrow(/不存在/)
    expect(readColors(t.root)).toEqual({})
  })

  it('重命名分区：颜色随目录一起迁移，旧键不残留', async () => {
    t.repo.sectionColorSet('正则化理论', 'purple')
    await flush()
    await t.repo.sectionRename('正则化理论', '正则化与稳定性')
    await flush()
    expect(readColors(t.root)).toEqual({ 正则化与稳定性: 'purple' })
    const names = t.repo.librarySections().map((s) => s.name)
    expect(names).toContain('正则化与稳定性')
    expect(names).not.toContain('正则化理论')
  })

  it('删除分区：颜色键一并清理（同名分区重建后不会复活旧颜色）', async () => {
    await t.repo.sectionDelete('正则化与稳定性')
    await flush()
    expect(readColors(t.root)).toEqual({})
    await t.repo.sectionCreate('正则化与稳定性')
    expect(t.repo.librarySections().find((s) => s.name === '正则化与稳定性')!.color).toBeNull()
  })

  it('重启（重开库）后颜色仍在：读盘而非内存', async () => {
    t.repo.sectionColorSet('待整理', 'gray')
    await flush()
    const repo2 = await t.reopen()
    expect(repo2.librarySections().find((s) => s.name === '待整理')!.color).toBe('gray')
  })

  it('文件损坏 → 备份为 .broken 并重建空表，不抛出', async () => {
    const repo2 = await t.reopen()
    writeFileSync(colorFile(t.root), '{ not json')
    const repo3 = await t.reopen()
    expect(repo3.librarySections().find((s) => s.name === '待整理')!.color).toBeNull()
    expect(existsSync(`${colorFile(t.root)}.broken`)).toBe(true)
    expect(readColors(t.root)).toEqual({})
    void repo2
  })

  it('非法颜色 id（手改文件 / 未来版本降级）按未设色处理，其余键保留', async () => {
    writeFileSync(colorFile(t.root), JSON.stringify({ schema: 1, colors: { 待整理: 'neon-pink', 高维反问题: 'green' } }))
    const repo = await t.reopen()
    await repo.sectionCreate('高维反问题')
    const sections = repo.librarySections()
    expect(sections.find((s) => s.name === '待整理')!.color).toBeNull()
    expect(sections.find((s) => s.name === '高维反问题')!.color).toBe('green')
  })

  it('并发设色不互相覆盖（串行写链）', async () => {
    const names = ['A', 'B', 'C', 'D']
    for (const n of names) t.repo.sectionCreate(n)
    t.repo.sectionColorSet('A', 'red')
    t.repo.sectionColorSet('B', 'orange')
    t.repo.sectionColorSet('C', 'yellow')
    t.repo.sectionColorSet('D', 'green')
    await flush()
    const colors = readColors(t.root)
    // 同一 Repo 实例的存储是长期存活的，前序用例留下的键仍在（这里只校验本用例的四个键未被互相覆盖）
    expect(colors).toMatchObject({ A: 'red', B: 'orange', C: 'yellow', D: 'green' })
  })
})
