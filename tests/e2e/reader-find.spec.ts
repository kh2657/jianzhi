// WP-5 端到端：文档内查找（⌘F）与「检索结果直达命中页」。
// 依赖 WP-4 的全文索引（含每页字符偏移）：主进程按页统计，渲染层用 CSS Highlight 高亮。
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, fixture, launchApp, rmTempDir } from './helpers/launch'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test('文档内查找：⌘F 打开、命中计数、高亮、Enter 跳转、Esc 关闭', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-find-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 导入文本型 PDF（全文索引随后台任务建立）并打开阅读器
    await page.evaluate(async (path) => {
      await window.api.docImport([path], { docType: 'book' })
    }, fixture('text-basic.pdf'))
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await expect(page.getByLabel('随手记内容')).toBeVisible({ timeout: 20000 })
    // 等文本层就绪：高亮注册只在 findResult 变化后的 80/250/600ms 三个窗口重试，
    // 文本层晚于窗口就绪会让断言空等（与首屏改动无关的既有竞态，加等待收敛）
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('.textLayer span').length), { timeout: 20000 }).toBeGreaterThan(0)

    // ⌘F 打开查找条
    await page.keyboard.press(`${MOD}+f`)
    const findBar = page.locator('.reader-find')
    await expect(findBar).toBeVisible()
    await findBar.getByLabel('在文档内查找').fill('THEOREM')
    // 命中统计（等全文索引就绪）
    await expect(findBar.locator('.find-count')).toContainText('个匹配', { timeout: 30000 })
    await expect(findBar.locator('.find-count')).toContainText('第 1 页')

    // 命中高亮已注册（CSS Custom Highlight，不改文字层 DOM）
    await expect.poll(() => page.evaluate(() => Boolean(window.CSS?.highlights?.has('mathwb-find'))), { timeout: 15000 }).toBe(true)

    // Enter 跳到下一个命中（页内或下一页）
    const before = await findBar.locator('.find-count').textContent()
    await findBar.getByLabel('在文档内查找').press('Enter')
    await expect(findBar.locator('.find-count')).not.toHaveText(before ?? '')

    // Esc 关闭并清理高亮
    await findBar.getByLabel('在文档内查找').press('Escape')
    await expect(findBar).toHaveCount(0)
    expect(await page.evaluate(() => Boolean(window.CSS?.highlights?.has('mathwb-find')))).toBe(false)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('扫描版 PDF：查找给出「没有可搜索的文本层」而不是静默无结果', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-find2-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(async (path) => {
      await window.api.docImport([path], { docType: 'book' })
    }, fixture('scanned.pdf'))
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'scanned' }).click()
    await expect(page.getByLabel('随手记内容')).toBeVisible({ timeout: 20000 })

    await page.keyboard.press(`${MOD}+f`)
    const findBar = page.locator('.reader-find')
    await findBar.getByLabel('在文档内查找').fill('theorem')
    await expect(findBar.locator('.find-count')).toContainText('没有可搜索的文本层', { timeout: 30000 })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('检索范围与文档内查找：正文词不进文献检索，打开后 ⌘F 直达命中页', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-find3-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(async (path) => {
      await window.api.docImport([path], { docType: 'book' })
    }, fixture('text-basic.pdf'))
    await page.reload()
    await navigateTo(page, '文献')

    // 2026-10-09 范围（architecture §15）：正文不参与文献检索——「chapter 2」只在正文 → 不命中；
    // 标题命中打开文档后，用文档内查找到达第 2 页（原文在打开后查）
    const libSearch = page.getByLabel('检索文献')
    await libSearch.fill('全文:"chapter 2"')
    await expect(page.getByText('标题和关键词搜索', { exact: false })).toBeVisible({ timeout: 15000 })
    await libSearch.fill('text-basic')
    const row = page.locator('.material-row', { hasText: 'text-basic' })
    await expect(row).toBeVisible({ timeout: 30000 })

    // 打开文档 → ⌘F 文档内查找 → Enter 跳到唯一命中的第 2 页
    await row.locator('.doc-item').click()
    await expect(page.getByLabel('随手记内容')).toBeVisible({ timeout: 20000 })
    await page.keyboard.press(`${MOD}+f`)
    const findBar = page.locator('.reader-find')
    await expect(findBar).toBeVisible({ timeout: 15000 })
    await findBar.locator('input').fill('chapter 2')
    await expect(findBar.locator('.find-count')).toContainText('个匹配', { timeout: 15000 })
    await page.keyboard.press('Enter')
    await expect(page.locator('.page-input')).toHaveValue('2', { timeout: 15000 })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})