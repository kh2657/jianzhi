import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

// 笔记编辑器三态（编辑/分屏/阅读）+ 可拖拽分栏；偏好落 settings.json，重启保持
test('笔记编辑器：三态切换、分栏拖拽、重启保持', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-note-modes-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(async () => {
      const api = (window as unknown as { api: import('../../src/shared/api').MathApi }).api
      await api.noteCreate({ title: '模式测试', bodyMd: '第一段\n\n$$E=mc^2$$' })
    })
    await page.reload()
    await navigateTo(page, '笔记')
    await page.locator('.note-item', { hasText: '模式测试' }).click()

    // 默认分屏：编辑器、预览、分隔条齐全
    await expect(page.locator('.note-textarea')).toBeVisible()
    await expect(page.locator('.note-preview')).toBeVisible()
    const divider = page.locator('.note-split-divider')
    await expect(divider).toBeVisible()

    // 向右拖拽分隔条 → 编辑器变宽
    const before = await page.locator('.note-editor-editor').evaluate((el) => el.getBoundingClientRect().width)
    const box = await divider.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + 160, box!.y + box!.height / 2, { steps: 5 })
    await page.mouse.up()
    const after = await page.locator('.note-editor-editor').evaluate((el) => el.getBoundingClientRect().width)
    expect(after).toBeGreaterThan(before + 50)

    // 阅读模式：编辑器隐藏但 textarea 仍挂载，预览整宽且公式已渲染
    await page.locator('.note-mode-switch button', { hasText: '阅读' }).click()
    await expect(page.locator('.note-editor-editor')).toBeHidden()
    await expect(page.locator('.note-textarea')).toHaveCount(1)
    await expect(page.locator('.note-preview .katex').first()).toBeVisible()

    // 重启：阅读模式保持（偏好走 settings.json）
    await app.app.close()
    const app2 = await launchApp(userData)
    const page2 = app2.page
    await navigateTo(page2, '笔记')
    await page2.locator('.note-item', { hasText: '模式测试' }).click()
    await expect(page2.locator('.note-editor-editor')).toBeHidden()
    expect(app2.consoleErrors).toEqual([])
    await app2.app.close()
  } finally {
    rmTempDir(userData)
  }
})
