// 对照工作空间（设计提案 2026-10-10 §3.1/§7 阶段 2）：
//  ① 默认进入对照（材料 60% ∥ 笔记面板 40%）；② 专注/对照切换 + Ctrl+\；
//  ③ 随手记 → 就地编辑 → 预览（KaTeX）→ 保存三态；④ 回原文留在对照态；
//  ⑤ 分栏比例与状态持久化（重启恢复）；⑥ 分隔条双击复位与键盘调宽。
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, fixture, launchApp, rmTempDir } from './helpers/launch'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('对照工作空间：默认对照、切专注、回源不退对照、预览公式、比例持久化', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-split-ws-'))
  const app = await launchApp(userData)
  let reopened: Awaited<ReturnType<typeof launchApp>> | null = null
  try {
    const { page } = app
    await page.evaluate(async (p) => { await window.api.docImport([p]) }, fixture('text-basic.pdf'))
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item').first().click()
    await expect(page.locator('.reading-workspace')).toBeVisible()

    // 默认对照：材料 ≈60%，面板可见
    const body = page.locator('.reader-body')
    await expect(body).toHaveClass(/split/)
    const width60 = await page.evaluate(() => document.querySelector('.page-scroll')!.getBoundingClientRect().width)
    expect(width60).toBeGreaterThan(400)

    // 随手记 → 建一条笔记（自动展开为就地编辑态）；对照态预览默认开，公式渲染成 KaTeX
    await page.getByLabel('随手记内容').fill('速率定理的条件：$p>\\beta/2$，对照 Lemma 3.2。')
    await page.getByRole('button', { name: '记下来', exact: true }).click()
    const item = page.locator('.mnp-item').first()
    await expect(item.locator('.mnp-textarea')).toBeVisible({ timeout: 5000 })
    await expect(item.locator('.mnp-preview .katex').first()).toBeVisible()

    // 打字 → 未保存… → 已保存（三态圆点语义，对照态内完成）
    await item.locator('.mnp-textarea').fill('速率来自偏差与稳定性的竞争。补充：$p>\\beta/2$。')
    await expect(page.locator('.reader-side').getByText('编辑中…', { exact: true })).toBeVisible()
    await expect(page.locator('.reader-side').getByText('已保存', { exact: true })).toBeVisible({ timeout: 5000 })

    // 回原文（笔记锚点）→ 定位材料，但不退出对照
    const back = item.locator('.mnp-item-foot').getByRole('button', { name: /回原文 · 第/ })
    await expect(back).toBeVisible()
    await back.click()
    await expect(body).toHaveClass(/split/)
    await expect(page.locator('.reading-workspace')).toBeVisible()

    // 分隔条键盘调宽 + 双击复位
    const divider = page.locator('.reader-split-divider')
    await divider.focus()
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    const widthAfter = await page.evaluate(() => document.querySelector('.page-scroll')!.getBoundingClientRect().width)
    expect(widthAfter).toBeGreaterThan(width60)
    await divider.dblclick()
    await expect.poll(async () => page.evaluate(() => document.querySelector('.page-scroll')!.getBoundingClientRect().width), { timeout: 3000 }).toBeLessThan(widthAfter + 2)

    // 状态与比例持久化：重启后仍是对照（比例字段写入阅读记录）
    await app.app.close()
    const app2 = reopened = await launchApp(userData)
    const page2 = app2.page
    await navigateTo(page2, '文献')
    await page2.locator('.doc-item').first().click()
    await expect(page2.locator('.reader-body')).toHaveClass(/split/)
    await expect(page2.locator('.reading-workspace')).toBeVisible()

    // Ctrl+\ 切专注：面板隐藏但组件仍在（草稿不丢）；再切回对照
    await page2.keyboard.press(`${mod}+\\`)
    await expect(page2.locator('.reader-body')).toHaveClass(/focus/)
    await expect(page2.locator('.reader-side')).toBeHidden()
    await page2.keyboard.press(`${mod}+\\`)
    await expect(page2.locator('.reader-body')).toHaveClass(/split/)
    await expect(page2.locator('.reading-workspace')).toBeVisible()
    expect(app2.consoleErrors).toEqual([])
  } finally {
    await reopened?.app.close().catch(() => undefined)
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
