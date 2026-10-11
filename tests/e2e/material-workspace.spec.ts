import { expect, test } from '@playwright/test'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 计划 §3.2 验收：标记与右栏笔记双向联动，全程不离开材料。
// PDF：框选 → 就地写笔记 → 翻页 → 整份视图 → 回到标记 → 重启仍互相定位。
// HTML：右栏材料级笔记就地创建与编辑。

test('PDF：就地笔记 + 双向定位 + 重启持久', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-p0-material-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      join(process.cwd(), 'fixtures/text-basic.pdf')
    )
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await page
      .waitForFunction(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0) >= 1, null, { timeout: 20000 })

    // 框选 → 浮层只写内容（标题类型可选，默认自动）→「记在这里」
    await page.locator('.seg-btn', { hasText: '摘录' }).click()
    const canvas = (await page.locator('.page-wrap[data-page-index="0"] .page-canvas').boundingBox())!
    const s = canvas.width / 612
    await page.mouse.move(canvas.x + 72 * s, canvas.y + (792 - 440) * s)
    await page.mouse.down()
    await page.mouse.move(canvas.x + 520 * s, canvas.y + (792 - 310) * s, { steps: 5 })
    await page.mouse.up()
    await expect(page.locator('.sel-popover')).toBeVisible()
    await page.locator('.sel-body').fill('这里不懂：边界条件为什么是开区间？')
    await page.getByRole('button', { name: '记在这里' }).click()
    await expect(page.locator('.toast', { hasText: '已记在这里' })).toBeVisible()

    // 全程未离开材料：页面仍在、页码不变、右栏出现笔记且处于展开编辑态
    await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
    await expect(page.locator('.page-input')).toHaveValue('1')
    const item = page.locator('.mnp-item', { hasText: '这里不懂' })
    await expect(item).toBeVisible()
    await expect(item.locator('.mnp-textarea')).toHaveValue(/边界条件/)

    // 就地编辑 → 自动保存
    await item.locator('.mnp-textarea').fill('这里不懂：边界条件为什么是开区间？后来明白了，用 Rolle 可以证。')
    await expect(item.locator('.status-saved')).toBeVisible({ timeout: 15000 })

    // 翻到第 2 页：本页空 → 切「整份」可见 → 回到标记跳回第 1 页
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await expect(page.locator('.page-input')).toHaveValue('2')
    await expect(page.locator('.mnp-empty', { hasText: '这一页还没有笔记' })).toBeVisible()
    await page.locator('.mnp-scope').getByRole('tab', { name: '整份' }).click()
    const again = page.locator('.mnp-item', { hasText: '这里不懂' })
    await expect(again).toBeVisible()
    await again.getByRole('button', { name: /回原文 · 第/ }).click()
    await expect(page.locator('.page-input')).toHaveValue('1')
    await expect(page.locator('.anchor-rect-flash').first()).toBeVisible()
    // 回跳后右栏展开的是这条笔记
    await expect(page.locator('.mnp-item', { hasText: '这里不懂' }).locator('.mnp-textarea')).toBeVisible()

    // 重启：互相定位仍有效
    await app.app.close()
    const app2 = await launchApp(userData)
    const page2 = app2.page
    // 启动直接恢复上次材料。
    await expect(page2.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
    await page2
      .waitForFunction(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0) >= 1, null, { timeout: 20000 })
    await page2.locator('.mnp-scope').getByRole('tab', { name: '整份' }).click()
    const item2 = page2.locator('.mnp-item', { hasText: '第 1 页摘录' })
    await expect(item2).toBeVisible()
    // 重启恢复右栏原先展开的笔记。
    await expect(item2.locator('.mnp-textarea')).toHaveValue(/Rolle/)
    await item2.getByRole('button', { name: /回原文 · 第/ }).click()
    await expect(page2.locator('.page-input')).toHaveValue('1')
    await expect(page2.locator('.anchor-rect-flash').first()).toBeVisible()
    expect(app2.consoleErrors).toEqual([])
    await app2.app.close()
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('HTML：右栏材料级笔记就地创建与编辑，不离开材料', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-p0-html-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const htmlPath = join(userData, 'lecture.html')
    writeFileSync(
      htmlPath,
      '<!doctype html><html><meta charset="utf-8"><body><h1>泛函讲义</h1><p>弱收敛不依价格收敛……</p></body></html>'
    )
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      htmlPath
    )
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'lecture' }).click()
    await expect(page.locator('.html-frame')).toBeVisible()

    // 右栏常驻 + 创建材料级笔记（保存后留在材料上）
    await page.getByRole('button', { name: '＋ 为这份材料写笔记' }).click()
    await page.locator('#html-note-title').fill('弱收敛要点')
    await page.locator('#html-note-body').fill('先记住定义，再回来看例子。')
    await page.getByRole('button', { name: '创建笔记' }).click()
    await expect(page.locator('.toast', { hasText: '已创建材料笔记' })).toBeVisible()
    await expect(page.locator('.html-frame')).toBeVisible()
    const item = page.locator('.mnp-item', { hasText: '弱收敛要点' })
    await expect(item).toBeVisible()
    await expect(item.locator('.mnp-textarea')).toHaveValue(/先记住定义/)

    // 就地编辑保存
    await item.locator('.mnp-textarea').fill('先记住定义，再回来看例子。补充：与强收敛的对照表。')
    await expect(item.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
