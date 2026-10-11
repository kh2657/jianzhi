// 研究问题视图端到端（#29）：
//  ① 空库空态（「先写一篇 problem 类型笔记作为问题枢纽」）；
//  ② 活动条入口 + 和弦 G Q 可达；③ problem 枢纽排最前、三段聚合正确；
//  ④ 相关笔记行跳到笔记编辑器、相关文献行跳到阅读器；
//  ⑤ 过滤框收窄枢纽列表；⑥ 布局审计与零控制台错误。
import { expect, test } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir, layoutAudit, fixture } from './helpers/launch'

test('研究问题：空态 → 聚合三段 → 跳转 → 过滤', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-question-'))
  let app = await launchApp(userData)
  try {
    const { page } = app

    // ① 空库空态
    await navigateTo(page, '研究问题')
    await expect(page.getByText('先写一篇 problem 类型笔记作为问题枢纽')).toBeVisible()
    expect(await layoutAudit(page, 'question-empty')).toEqual([])

    // ② 备料：枢纽（problem）+ 链入笔记 + 链出目标 + 文献（含 document 级来源）
    await page.evaluate(async (pdf) => {
      const [imp] = await window.api.docImport([pdf], { docType: 'book' })
      await window.api.noteCreate({ title: '普通概念', noteType: 'concept', bodyMd: 'x' })
      // 证据链：先建（后面枢纽正文链出到它 → out 方向）
      await window.api.noteCreate({ title: '证据链', noteType: 'problem', bodyMd: '独立内容，不链回枢纽。' })
      const hub = await window.api.noteCreate({ title: '收敛问题', noteType: 'problem', bodyMd: '待研究。' })
      await window.api.noteCreate({ title: '链入笔记', bodyMd: '依赖 [[收敛问题]]。', documentId: imp.documentId! })
      await window.api.noteSave({
        id: hub.id,
        title: '收敛问题',
        noteType: 'problem',
        bodyMd: '待研究，先看 [[证据链]]。',
        aliases: [],
        verifiedStatus: 'unchecked',
        learning: { records: { b1: { status: 'question', fingerprint: 'fp1' } } }
      })
    }, fixture('text-basic.pdf'))

    // 重新挂载视图取最新列表
    await navigateTo(page, '文献')
    await navigateTo(page, '研究问题')

    // ③ problem 枢纽排最前：默认选中「收敛问题」（最近更新的 problem）
    const hubs = page.locator('.question-hub')
    await expect(hubs.first()).toContainText('收敛问题')
    await expect(page.locator('.question-detail h1')).toHaveText('收敛问题')

    // 三段聚合：相关笔记 2（证据链 out + 链入笔记 in）、相关文献 1、知识块状态有疑问 1
    await expect(page.locator('.question-section').filter({ hasText: '相关笔记（2）' })).toBeVisible()
    await expect(page.locator('.question-section').filter({ hasText: '相关文献（1）' })).toBeVisible()
    await expect(page.locator('.question-block-stat').filter({ hasText: '有疑问' })).toContainText('1')
    const inRow = page.locator('.question-detail .note-item', { hasText: '链入笔记' })
    await expect(inRow).toContainText('链入本问题')
    await expect(page.locator('.question-detail .note-item', { hasText: '证据链' })).toContainText('本问题链出')

    // ④ 相关笔记行 → 笔记编辑器
    await inRow.click()
    await expect(page.locator('.note-title-input')).toHaveValue('链入笔记')

    // ④ 相关文献行 → 阅读器
    await navigateTo(page, '研究问题')
    await page.locator('.question-detail .note-item', { hasText: 'text-basic' }).click()
    await expect(page.locator('.reader-toolbar, .reader').first()).toBeVisible()

    // ⑤ 过滤框收窄枢纽列表
    await navigateTo(page, '研究问题')
    await page.locator('[aria-label="过滤问题枢纽"]').fill('证据')
    await expect(page.locator('.question-hub')).toHaveCount(1)
    await expect(page.locator('.question-hub')).toContainText('证据链')

    expect(await layoutAudit(page, 'question-view')).toEqual([])
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('研究问题：和弦 G Q 与 ⌘K 入口', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-question-chord-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await navigateTo(page, '文献')
    await page.keyboard.press('g')
    await page.keyboard.press('q')
    await expect(page.locator('.workspace-tabs .nav-item[aria-label="研究问题"]')).toHaveAttribute('aria-current', 'page')

    await page.keyboard.press('Meta+k')
    const palette = page.locator('.cmdk')
    await expect(palette).toBeVisible()
    // cmdk 的 Command.Item 渲染为 [cmdk-item] 属性，没有 .cmdk-item 类名
    const item = palette.locator('[cmdk-item]', { hasText: '研究问题' })
    await expect(item).toBeVisible()
    await expect(item).toContainText('G Q')
    await page.keyboard.press('Escape')

    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
