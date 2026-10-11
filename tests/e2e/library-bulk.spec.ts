import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

// 文献库的两项「专业工具该有、此前没有」的能力：
//   1) 多选与批量操作（⌘ 点选 / Shift 区间 / 全选后批量移分区、批量收藏）
//   2) 排序切换（默认最近更新，可切标题/作者/年份/最近导入）
test('文献库：多选批量操作与排序切换', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-bulk-'))
  const app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const { page } = app
    await page.evaluate(async () => {
      const importOne = async (name: string, title: string, authors: string[], year: number | null) => {
        const [r] = await window.api.docImport([`fixtures/${name}`], { docType: 'paper' })
        if (!r.documentId) throw new Error(r.error ?? '导入失败')
        await window.api.libraryEntryUpdate(r.documentId, { title, authors, year })
      }
      await importOne('text-basic.pdf', 'Alpha', ['Chen'], 2019)
      await importOne('scanned.pdf', 'Beta', ['An'], 2023)
      await importOne('cropped.pdf', 'Gamma', ['Bo'], null)
    })
    await page.reload()
    await navigateTo(page, '文献')
    await expect(page.locator('.doc-item')).toHaveCount(3)

    // 「待补全」是行内状态标签，与标题同在一个 .doc-title 里，断言前剥掉
    const titles = async (): Promise<string[]> =>
      (await page.locator('.doc-item .doc-title').allInnerTexts()).map((t) => t.replace('待补全', '').trim())

    // 默认排序 = 最近更新（后导入的更新）→ Gamma, Beta, Alpha
    expect(await titles()).toEqual(['Gamma', 'Beta', 'Alpha'])

    // 切到标题排序
    await page.getByLabel('文献排序方式').selectOption('title')
    await expect.poll(titles).toEqual(['Alpha', 'Beta', 'Gamma'])

    // 切到年份排序：2023 > 2019 > 缺年份排最后
    await page.getByLabel('文献排序方式').selectOption('year')
    await expect.poll(titles).toEqual(['Beta', 'Alpha', 'Gamma'])

    // 回到标题排序，便于下面的区间选择断言
    await page.getByLabel('文献排序方式').selectOption('title')
    await expect.poll(titles).toEqual(['Alpha', 'Beta', 'Gamma'])

    // 勾选 Alpha，再 Shift 点 Gamma → 区间选中三条
    await page.getByLabel('选择：Alpha').check()
    await expect(page.locator('.bulk-bar')).toContainText('已选 1 条')
    await page.locator('.doc-item', { hasText: 'Gamma' }).click({ modifiers: ['Shift'] })
    await expect(page.locator('.bulk-bar')).toContainText('已选 3 条')

    // 批量收藏
    await page.locator('.bulk-bar').getByRole('button', { name: '收藏', exact: true }).click()
    await expect(page.locator('.bulk-bar')).toHaveCount(0) // 完成后自动清除选择
    const starred = async (): Promise<boolean[]> =>
      page.evaluate(async () => {
        const res = await window.api.librarySearch({ q: '' })
        return res.hits.map((h) => Boolean(h.entry.starred))
      })
    await expect.poll(starred).toEqual([true, true, true])

    // 批量移入分区
    await page.evaluate(() => window.api.librarySectionCreate('批量目标'))
    await page.reload()
    await navigateTo(page, '文献')
    await expect(page.locator('.doc-item')).toHaveCount(3)
    for (const t of ['Alpha', 'Beta', 'Gamma']) await page.getByLabel(`选择：${t}`).check()
    await expect(page.locator('.bulk-bar')).toContainText('已选 3 条')
    await page.getByLabel('批量移入分区').selectOption('批量目标')

    const sections = async (): Promise<string[]> =>
      page.evaluate(async () => {
        const res = await window.api.librarySearch({ q: '' })
        return res.hits.map((h) => h.section)
      })
    await expect.poll(sections).toEqual(['批量目标', '批量目标', '批量目标'])
    // 等 runBulk 真正收尾再交互：它在移动完成后才清空选择，而上面的轮询在最后一条落盘时就通过了——
    // 抢在清空之前勾选，选择会被随后的 setSelected(new Set()) 抹掉（负载越高这个窗口越大）
    await expect(page.locator('.bulk-bar')).toHaveCount(0)

    // ⌘ 点选可取消单条
    await page.getByLabel('选择：Alpha').check()
    await expect(page.locator('.bulk-bar')).toContainText('已选 1 条')
    await page.locator('.doc-item', { hasText: 'Alpha' }).click({ modifiers: ['Meta'] })
    await expect(page.locator('.bulk-bar')).toHaveCount(0)
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})
