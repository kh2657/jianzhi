import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'

const pad2 = (n: number): string => String(n).padStart(2, '0')

// 学习日历（DESIGN.md v8）：月历主视图、统一「有记录」标记、当日记录按对象归并并可跳转、
// 月度小结（anchor 口径）收进次级详情、未来日期禁用、面板展开状态在会话内恢复、重启保持
test('学习日历：新建计数、月历标记、当日跳转、月度小结、未来禁用、重启保持', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-footprint-'))
  let app: LaunchedApp | null = await launchApp(userData)
  try {
    const { page } = app
    // 空白占位：先建一篇空笔记（不应计数），再写入正文（首次非空=新建）
    await page.evaluate(async () => {
      const api = (window as unknown as { api: import('../../src/shared/api').MathApi }).api
      await api.noteCreate({ title: '足迹笔记' })
    })
    await page.reload()
    await navigateTo(page, '笔记')

    // 列表日期标签：今天更新
    await expect(page.locator('.note-item .note-time', { hasText: '今天更新' })).toBeVisible()

    // 编辑页：日期行合并为「今天新建」，保存后仍一致
    await page.locator('.note-item', { hasText: '足迹笔记' }).click()
    await page.getByLabel('笔记正文').fill('学习足迹的第一段正文')
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.note-date-line')).toHaveText('今天新建')
    await expect(page.locator('.note-date-line')).toHaveAttribute('title', /创建：.*最近更新：.*修订 2 次/)

    // 学习日历：当前月标签 + 今天格子有统一标记 + 当日记录按对象归并
    await navigateTo(page, '笔记')
    await page.getByRole('button', { name: '学习足迹' }).click()
    const panel = page.locator('.footprint')
    await expect(panel).toBeVisible()
    const now = new Date()
    await expect(panel.locator('.cal-month')).toHaveText(`${now.getFullYear()} 年 ${now.getMonth() + 1} 月`)
    const todayCell = panel.locator('.cal-day.is-today')
    await expect(todayCell).toBeVisible()
    await expect(todayCell).toBeEnabled()
    await expect(todayCell.locator('.cal-mark')).toBeVisible() // 当天新建 → 有记录

    const journal = panel.locator('.footprint-journal')
    await expect(journal.locator('.footprint-entry', { hasText: '足迹笔记' })).toBeVisible()
    await expect(journal.locator('.footprint-entry-action', { hasText: '新建了这篇笔记' })).toBeVisible()

    // 未来日期不可选（若明天仍在本月）
    const tomorrowKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate() + 1)}`
    const tomorrowCell = panel.locator(`button.cal-day[aria-label^="${tomorrowKey}"]`)
    if (await tomorrowCell.count()) await expect(tomorrowCell).toBeDisabled()

    // 月度小结：收进次级详情，口径为当月
    await journal.locator('.footprint-monthfoot summary').click()
    await expect(journal.locator('.footprint-monthstats')).toContainText('1 篇新建')
    await expect(journal.locator('.footprint-monthstats')).toContainText('0 篇修改')

    // 点击当日条目 → 跳回笔记编辑页
    await journal.locator('.footprint-entry', { hasText: '足迹笔记' }).click()
    await expect(page.getByLabel('笔记标题')).toHaveValue('足迹笔记')

    // 返回笔记视图：面板保持展开（会话内恢复），不再需要手动点开
    await navigateTo(page, '笔记')
    await expect(panel).toBeVisible()

    // 重启：会话态不落盘（面板默认收起）；再展开后小结仍正确；同一天再修改仍被「新建」吸收
    await app.app.close()
    app = await launchApp(userData)
    const page2 = app.page
    await navigateTo(page2, '笔记')
    await page2.getByRole('button', { name: '学习足迹' }).click()
    const journal2 = page2.locator('.footprint-journal')
    await expect(journal2.locator('.footprint-entry', { hasText: '足迹笔记' })).toBeVisible()
    await journal2.locator('.footprint-monthfoot summary').click()
    await expect(journal2.locator('.footprint-monthstats')).toContainText('1 篇新建')
    await journal2.locator('.footprint-entry', { hasText: '足迹笔记' }).click()
    await page2.getByLabel('笔记正文').fill('学习足迹的第一段正文，再加一句')
    await expect(page2.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    await navigateTo(page2, '笔记')
    // 面板已由会话状态恢复展开（返回不重来），直接展开月度小结
    await expect(page2.locator('.footprint')).toBeVisible()
    await page2.locator('.footprint-monthfoot summary').click()
    await expect(page2.locator('.footprint-monthstats')).toContainText('0 篇修改')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app?.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
