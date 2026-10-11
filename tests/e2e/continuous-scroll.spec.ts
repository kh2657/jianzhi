import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

// 连续滚动模式（默认）：滚轮/滚动翻阅文档、页码跟随、跳页=滚动定位、单页切换保留

async function openDoc(app: Awaited<ReturnType<typeof launchApp>>, name: string): Promise<void> {
  await app.page.evaluate(async (p) => {
    await window.api.docImport([p], { docType: 'book' })
  }, join(process.cwd(), 'fixtures', name))
  await app.page.reload()
  await navigateTo(app.page, '文献')
  await app.page.locator('.doc-item', { hasText: name.replace('.pdf', '') }).click()
  await expect(app.page.locator('.page-wrap[data-page-index="0"]').locator('.page-canvas')).toBeVisible()
}

test('连续滚动：滚动跟随页码、跳页滚动定位、阅读位置重启恢复', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-scroll-'))
  const app = await launchApp(userData)
  let app2: Awaited<ReturnType<typeof launchApp>> | null = null
  try {
    const { page } = app
    await openDoc(app, 'text-basic.pdf')
    await expect(page.getByLabel('查看方式 连续')).toHaveAttribute('aria-selected', 'true')

    // 滚动到文档底部：当前页跟随为最后一页（第 3 页）
    await page.locator('.page-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(page.getByLabel('页码')).toHaveValue('3')
    await expect(page.locator('.page-wrap[data-page-index="2"]').locator('.page-canvas')).toBeVisible()

    // 页码输入跳回第 1 页 = 滚动定位回顶部
    await page.locator('.page-input').fill('1')
    await page.locator('.page-input').press('Enter')
    await expect(page.locator('.page-scroll')).toHaveJSProperty('scrollTop', 0)
    await expect(page.getByLabel('页码')).toHaveValue('1')

    // 空格翻页语义保留：滚到第 2 页（先让页码输入框失焦，键盘事件才归阅读器）
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press(' ')
    await expect(page.getByLabel('页码')).toHaveValue('2')

    // 阅读位置落库后重启 → 恢复到第 2 页
    await page.waitForTimeout(1200)
    await app.app.close()
    app2 = await launchApp(userData)
    await expect(app2.page.locator('.page-wrap[data-page-index="0"]').locator('.page-canvas')).toBeVisible()
    await expect(app2.page.getByLabel('页码')).toHaveValue('2')
    expect(app2.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    await app2?.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('单页模式：滚轮到底自动翻页，切换选择被记住', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-single-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await openDoc(app, 'text-basic.pdf')
    await page.getByLabel('查看方式 单页').click()
    await expect(page.getByLabel('查看方式 单页')).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.page-wrap')).toHaveCount(1)

    // 滚轮：页内滚到底再继续 → 翻到第 2 页
    await page.locator('.page-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await page.mouse.move(600, 400)
    await page.mouse.wheel(0, 600)
    await expect(page.getByLabel('页码')).toHaveValue('2')

    // 重启后单页选择被记住
    await page.waitForTimeout(1200)
    await app.app.close()
    const app2 = await launchApp(userData)
    await expect(app2.page.locator('.page-canvas')).toBeVisible() // 单页模式恰好一个画布
    await expect(app2.page.getByLabel('查看方式 单页')).toHaveAttribute('aria-selected', 'true')
    await app2.app.close()
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
