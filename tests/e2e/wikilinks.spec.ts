import { expect, test } from '@playwright/test'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 双向链接全流程：建两条笔记 → B 正文里用 [[ 输入辅助链接 A → A 的反向链接面板出现 B
// → preview 内点击 wikilink 跳转 → 未解析链接样式 → 重启持久。

test('双链：输入辅助、反向链接、点击跳转、持久化', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-links-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 笔记 A（定理）
    await navigateTo(page, '笔记')
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await page.locator('.note-title-input').fill('中值定理')
    await page.locator('details.note-info summary').click()
    await page.locator('.aliases-input').fill('MVT')
    await page.locator('.note-textarea').fill('定理陈述：存在 ξ 使得 f(b)-f(a)=f(ξ)(b-a)。')
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    await navigateTo(page, '笔记')

    // 笔记 B：正文里输入 [[ 触发输入辅助，选择 A
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await page.locator('.note-title-input').fill('证明尝试')
    // 等标题保存与链接索引刷新完成，避免候选竞态
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    const ta = page.locator('.note-textarea')
    await ta.click()
    await ta.pressSequentially('证明依赖 [[')
    await expect(page.locator('.wikilink-pop')).toBeVisible()
    await page.locator('.wl-item', { hasText: '中值定理' }).first().click()
    await expect(ta).toHaveValue(/证明依赖 \[\[中值定理\]\] /)
    await expect(page.locator('.wikilink-pop')).toHaveCount(0)
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })

    // 预览中的双链：已解析样式 + 点击跳转到 A
    await expect(page.locator('.note-preview a.wikilink')).toBeVisible()
    await expect(page.locator('.note-preview a.wikilink.wikilink-resolved')).toBeVisible()
    await page.locator('.note-preview a.wikilink').first().click()
    await expect(page.locator('.note-title-input')).toHaveValue('中值定理')

    // A 的反向链接面板出现 B，附上下文片段；点击打开 B
    await expect(page.locator('.backlink-row', { hasText: '证明尝试' })).toBeVisible()
    await expect(page.locator('.backlink-row').first()).toContainText('[[中值定理]]')
    await page.locator('.backlink-row').first().getByRole('button', { name: '打开' }).click()
    await expect(page.locator('.note-title-input')).toHaveValue('证明尝试')

    // 未解析链接：C 链接一个不存在的标题 → preview 虚线样式，反链不出现
    await navigateTo(page, '笔记')
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await page.locator('.note-title-input').fill('随手记')
    await page.locator('.note-textarea').fill('关联 [[尚不存在的笔记]]。')
    await expect(page.locator('.note-preview a.wikilink.wikilink-unresolved')).toBeVisible()
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })

    // 重启：反链与链接持久
    await app.app.close()
    const app2 = await launchApp(userData)
    const page2 = app2.page
    await navigateTo(page2, '笔记')
    await page2.locator('.note-item', { hasText: '中值定理' }).click()
    await expect(page2.locator('.backlink-row', { hasText: '证明尝试' })).toBeVisible()
    expect(app2.consoleErrors).toEqual([])
    await app2.app.close()
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
