import { expect, test } from '@playwright/test'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// P1 交互重排与可访问性验收：空状态主操作、弹窗焦点管理、模式首次提示、宽屏布局。

test('空文献给单一主操作「导入第一份材料」', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-p1-empty-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 启动默认视图是笔记；空库态断言在文献库视图
    await navigateTo(page, '文献')
    await expect(page.locator('.empty-title', { hasText: '从一篇文献开始' })).toBeVisible()
    const cta = page.getByRole('button', { name: '导入第一份文献' })
    await expect(cta).toBeVisible()
    // 次要说明存在，但不与主按钮竞争
    await expect(page.locator('.empty-actions .muted')).toContainText('学习区')
    // 有材料后空状态消失
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      join(process.cwd(), 'fixtures/text-basic.pdf')
    )
    await page.reload()
    await navigateTo(page, '文献')
    await expect(page.locator('.doc-item')).toBeVisible()
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})

test('弹窗焦点管理：打开聚焦、Tab 循环、Esc 关闭并归还焦点', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-p1-modal-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 新建学习区入口在顶栏切换器里（单左栏原则）：先开菜单，再点菜单项
    await page.locator('.scope-switch').click()
    await page.getByRole('menuitem', { name: '新建学习区', exact: true }).click()
    const dialog = page.locator('.modal')
    await expect(dialog).toBeVisible()
    // 打开即聚焦在弹窗内
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.modal') != null))
      .toBe(true)
    // Tab 循环：从最后一个可聚焦元素 Tab 应回第一个
    // 焦点陷阱用真实键盘验证（programmatic focus 在无 user activation 时会被 Chromium 拒绝）：
    // 真实点击输入框 → Shift+Tab 到关闭按钮 → 再 Shift+Tab 应经陷阱绕回最后一个可聚焦元素（更多设置）
    await page.locator('.modal input').click()
    await page.keyboard.press('Shift+Tab')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.includes('关闭') ?? false))
      .toBe(true)
    await page.keyboard.press('Shift+Tab')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName === 'SUMMARY'))
      .toBe(true)
    // 从最后一个再 Tab，应经陷阱回到第一个（关闭按钮）
    await page.keyboard.press('Tab')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.includes('关闭') ?? false))
      .toBe(true)
    // Esc 关闭，焦点归还触发按钮（顶栏学习区切换器）
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains('scope-switch') ?? false))
      .toBe(true)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})

test('阅读器模式首次提示：出现、可关闭、有内容后不再出现', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-p1-hint-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      join(process.cwd(), 'fixtures/text-basic.pdf')
    )
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item').click()
    await page
      .waitForFunction(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0) >= 1, null, { timeout: 20000 })
    // 阅读模式无提示
    await expect(page.locator('.mode-hint')).toHaveCount(0)
    // 切到摘录：提示出现，可手动关闭
    await page.locator('.seg-btn', { hasText: '摘录' }).click()
    await expect(page.locator('.mode-hint')).toBeVisible()
    await page.locator('.mode-hint button').click()
    await expect(page.locator('.mode-hint')).toHaveCount(0)
    // 手写模式同理
    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await expect(page.locator('.mode-hint')).toBeVisible()
    // 本页产生批注后，切走再切回提示不出现
    await page.locator('.swatch[aria-label="笔颜色 #1d2129"]').click()
    const c = (await page.locator('.page-wrap[data-page-index="0"] .page-canvas').boundingBox())!
    await page.mouse.move(c.x + 100, c.y + 100)
    await page.mouse.down()
    await page.mouse.move(c.x + 200, c.y + 110, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.ann-toolbar')?.textContent?.includes('1 笔') ?? false))
      .toBe(true)
    await page.locator('.seg-btn', { hasText: '阅读' }).click()
    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await expect(page.locator('.mode-hint')).toHaveCount(0)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})

test('宽屏 1920×1080 布局门禁', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-p1-wide-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      join(process.cwd(), 'fixtures/text-basic.pdf')
    )
    await page.reload()
    for (const nav of ['文献', '笔记', '待办']) {
      await navigateTo(page, nav)
      const audit = await page.evaluate(() => {
        const doc = document.scrollingElement ?? document.documentElement
        return { overflow: doc.scrollWidth > window.innerWidth + 1, sw: doc.scrollWidth }
      })
      expect(audit.overflow, `1920 宽度下 ${nav} 横向溢出 (${audit.sw})`).toBe(false)
    }
    // 列表内容限宽生效（有最大宽度约束而非无限拉伸）
    const listWidth = await page.evaluate(() => {
      const el = document.querySelector('.doc-list')
      return el ? el.getBoundingClientRect().width : 0
    })
    expect(listWidth).toBeLessThanOrEqual(1100)

    // DESIGN.md §1 铁律：搜索框与其下方列表**同左缘、同右缘**。
    // 外壳侧栏已整体退出（筛选收敛），内容列恒为最宽——这正是当初最容易暴露对齐断裂的形态
    await page.evaluate(async () => { await window.api.noteCreate({ title: '对齐校验笔记', bodyMd: '正文' }) })
    await page.reload()
    await expect(page.locator('.sidebar')).toHaveCount(0)
    for (const item of [
      { nav: '文献', search: '.library-search', list: '.doc-list' },
      { nav: '笔记', search: '.list-tools .search-field', list: '.note-list' }
    ]) {
      await navigateTo(page, item.nav)
      await expect(page.locator(item.list).first()).toBeVisible({ timeout: 15000 })
      const edges = await page.evaluate(({ search, list }) => {
        const s = document.querySelector(search)!.getBoundingClientRect()
        const first = document.querySelector(list)!.firstElementChild!.getBoundingClientRect()
        return { searchLeft: s.left, searchRight: s.right, listLeft: first.left, listRight: first.right }
      }, item)
      expect(Math.abs(edges.searchLeft - edges.listLeft), `${item.nav} 搜索框与列表左缘错开`).toBeLessThanOrEqual(1)
      expect(Math.abs(edges.searchRight - edges.listRight), `${item.nav} 搜索框与列表右缘错开`).toBeLessThanOrEqual(1)
    }
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})
