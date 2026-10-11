import { expect, test } from '@playwright/test'
import { navigateTo, fixture, launchApp, rmTempDir } from './helpers/launch'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 阅读器目录面板：读论文时「跳到第 N 节」是高频动作。
// links.pdf 夹具带两级大纲（第一节→第 1 页、第二节→第 2 页）；没有大纲的文档按钮应不可用。
test('阅读器：目录面板展开、跳页与当前页高亮', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-outline-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('links.pdf')
    )
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'links' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    const outlineBtn = page.getByRole('button', { name: '目录' })
    await expect(outlineBtn).toBeEnabled()
    await outlineBtn.click()

    const nav = page.getByRole('navigation', { name: '文档目录' })
    await expect(nav).toBeVisible()
    const first = nav.getByRole('button', { name: '第一节 引言' })
    const second = nav.getByRole('button', { name: '第二节 方法' })
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()

    // 当前在第 1 页 → 第一节高亮
    await expect(first).toHaveAttribute('aria-current', 'true')

    // 点第二节 → 跳到第 2 页，高亮跟着走
    await second.click()
    await expect(page.getByLabel('页码')).toHaveValue('2')
    await expect(second).toHaveAttribute('aria-current', 'true')
    await expect(first).not.toHaveAttribute('aria-current', 'true')

    // 再点第一节 → 回到第 1 页
    await first.click()
    await expect(page.getByLabel('页码')).toHaveValue('1')
    await expect(first).toHaveAttribute('aria-current', 'true')

    // 收起面板
    await nav.getByRole('button', { name: '收起目录' }).click()
    await expect(page.getByRole('navigation', { name: '文档目录' })).toHaveCount(0)
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('阅读器：没有大纲的文档，目录按钮不可用', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-nooutline-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('text-basic.pdf')
    )
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    const outlineBtn = page.getByRole('button', { name: '目录' })
    await expect(outlineBtn).toBeDisabled()
    await expect(outlineBtn).toHaveAttribute('title', '这份文档没有目录')
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
