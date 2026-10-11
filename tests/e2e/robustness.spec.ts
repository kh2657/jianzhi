import { expect, test } from '@playwright/test'
import { navigateTo, fixture, launchApp, layoutAudit, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 每个用例独立 userData 与应用实例：单实例锁按 userData 生效，
// 串行失败不应级联到后续用例（Playwright 单 worker 顺序执行）。

test('重复导入提示且不重复建目', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-dup-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const r1 = await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('scanned.pdf')
    )
    expect(r1[0].duplicate).toBe(false)
    const r2 = await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('scanned.pdf')
    )
    expect(r2[0].duplicate).toBe(true)
    expect(r2[0].documentId).toBe(r1[0].documentId)
    const docs = await page.evaluate(() => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docList())
    expect(docs).toHaveLength(1)
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})

test('损坏 PDF：导入成功（头合法）但打开时明确报错不崩溃', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-corrupt-'))
  const app = await launchApp(userData)
  app.setPhase('corrupt')
  try {
    const { page } = app
    const r = await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('corrupt.pdf')
    )
    expect(r[0].ok).toBe(true)

    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'corrupt' }).click()
    await expect(page.locator('.empty-title', { hasText: '文档无法打开' })).toBeVisible({ timeout: 20000 })
    // 应用仍可用：返回文献（错误视图的按钮是「← 返回」）
    await page.getByRole('button', { name: '← 返回' }).click()
    await expect(page.locator('.view-head h1', { hasText: '文献' })).toBeVisible()
    // 正常文档仍可打开
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('scanned.pdf')
    )
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'scanned' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)
  } finally {
    app.setPhase('normal')
    await app.app.close()
    rmTempDir(userData)
  }
})

test('阅读位置在重启后恢复', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-readpos-'))
  const app = await launchApp(userData)
  const page = app.page
  await page.evaluate(
    (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
    fixture('scanned.pdf')
  )
  await page.reload()
  await navigateTo(page, '文献')
  await page.locator('.doc-item', { hasText: 'scanned' }).click()
  await expect
    .poll(() => page.evaluate(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
    .toBeGreaterThanOrEqual(1)
  await page.locator('.page-input').fill('2')
  await page.locator('.page-input').press('Enter')
  await expect(page.getByLabel('页码')).toHaveValue('2')
  await page.waitForTimeout(1500) // 阅读位置防抖落库
  await app.app.close()

  const app2 = await launchApp(userData)
  const page2 = app2.page
  await expect(page2.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
  await expect(page2.getByLabel('页码')).toHaveValue('2')
  await app2.app.close()
  rmTempDir(userData)
})

test('布局门禁：1366×768 / 1512×982 无横向溢出、无零尺寸控件', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-layout-'))
  const app = await launchApp(userData)
  const { page } = app
  try {
    for (const size of [
      { width: 1366, height: 768 },
      { width: 1512, height: 982 }
    ]) {
      await page.setViewportSize(size)
      await navigateTo(page, '文献')
      const issues1 = await layoutAudit(page, `文献 ${size.width}x${size.height}`)
      await navigateTo(page, '笔记')
      const issues2 = await layoutAudit(page, `笔记 ${size.width}x${size.height}`)
      expect([...issues1, ...issues2]).toEqual([])
    }
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})

test('控制台门禁：常规浏览零错误', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-console-'))
  const app = await launchApp(userData)
  const { page, consoleErrors } = app
  try {
    await navigateTo(page, '待办')
    await navigateTo(page, '文献')
    await navigateTo(page, '笔记')
    await page.waitForTimeout(800)
    expect(consoleErrors).toEqual([])
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})
