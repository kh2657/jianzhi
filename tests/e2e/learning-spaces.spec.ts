import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, fixture as fixturePdf, launchApp, rmTempDir } from './helpers/launch'

test('筛选收敛：外壳侧栏整体退出，类型/状态在视图内标签行；学习区在顶栏切换', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mathwb-sidebar-labels-'))
  const launched = await launchApp(data, undefined, { visible: true })
  try {
    const { page } = launched
    // 外壳侧栏整体退出（筛选收敛）：任何视图都不再有 .sidebar，也没有折叠开关
    await navigateTo(page, '文献')
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.getByLabel('折叠或展开侧栏')).toHaveCount(0)

    // 笔记类型 → 视图内下划线标签行（「全部」默认激活）
    await navigateTo(page, '笔记')
    const tabs = page.locator('.filter-tabs[aria-label=\"笔记类型\"]')
    await expect(tabs).toBeVisible()
    await expect(tabs.locator('.chip', { hasText: '全部' })).toHaveAttribute('aria-pressed', 'true')
    await tabs.locator('.chip', { hasText: '概念' }).click()
    await expect(tabs.locator('.chip', { hasText: '概念' })).toHaveAttribute('aria-pressed', 'true')

    // 每日论文状态 → 同款标签行，默认「待挑选」
    await navigateTo(page, '每日论文')
    const ptabs = page.locator('.filter-tabs[aria-label=\"论文状态\"]')
    await expect(ptabs).toBeVisible()
    await expect(ptabs.locator('.chip', { hasText: '待挑选' })).toHaveAttribute('aria-pressed', 'true')

    // 顶栏学习区切换器仍可用（含「新建学习区」入口，空态也有去处）；切换器在文献/笔记视图常驻
    await expect(page.locator('.sidebar-hint', { hasText: '建一个学习区' })).toHaveCount(0)
    await navigateTo(page, '笔记')
    await page.locator('.scope-switch').click()
    const menu = page.getByRole('menu', { name: '切换学习区' })
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('全部学习资料')
    await expect(menu).toContainText('未分区')
    const newBtn = menu.getByRole('menuitem', { name: '新建学习区', exact: true })
    await expect(newBtn).toBeVisible()
    await newBtn.click()
    await expect(page.getByLabel('学习区名称')).toBeVisible()
    await page.keyboard.press('Escape')

    expect(launched.consoleErrors).toEqual([])
  } finally {
    await launched.app.close()
    rmTempDir(data)
  }
})

test('文献库只保留一列左栏：外壳侧栏退出，学习区在顶栏切换', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mathwb-single-rail-'))
  const launched = await launchApp(data, undefined, { visible: true })
  try {
    const { page } = launched
    await page.evaluate(async () => { await window.api.spaceCreate({ name: '概率论', kind: 'course' }) })
    await page.reload()
    await navigateTo(page, '文献')
    // 单左栏：文献自带分区栏，外壳侧栏与其开关都不再出现
    await expect(page.locator('.library-sections')).toBeVisible()
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.scope-bar-left').getByLabel('折叠或展开侧栏')).toHaveCount(0)
    // 顶栏切换器可切学习区，选中后名称只出现一次（切换器内）
    await page.locator('.scope-switch').click()
    await page.getByRole('menuitem', { name: '概率论', exact: true }).click()
    await expect(page.locator('.scope-switch')).toContainText('概率论')
    await page.locator('.scope-switch').click()
    await page.getByRole('menuitem', { name: '全部学习资料', exact: true }).click()
    await expect(page.locator('.scope-switch')).toContainText('全部学习资料')
    expect(launched.consoleErrors).toEqual([])
  } finally {
    await launched.app.close()
    rmTempDir(data)
  }
})

test('自行新建课程学习区，切换时只看该区笔记且及时保存', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mathwb-spaces-ui-'))
  const launched = await launchApp(data, undefined, { visible: true })
  try {
    const { page } = launched
    // 学习区操作统一走顶栏切换器（单左栏原则）
    const openSwitcher = async (): Promise<void> => {
      await page.locator('.scope-switch').click()
      await expect(page.getByRole('menu', { name: '切换学习区' })).toBeVisible()
    }
    const createSpace = async (name: string): Promise<void> => {
      await openSwitcher()
      await page.getByRole('menuitem', { name: '新建学习区', exact: true }).click()
      await page.getByLabel('学习区名称').fill(name)
      await page.getByRole('button', { name: '创建学习区', exact: true }).click()
    }
    const chooseSpace = async (name: string): Promise<void> => {
      await openSwitcher()
      await page.getByRole('menuitem', { name, exact: true }).click()
    }
    await createSpace('概率论')
    await expect(page.locator('.scope-switch')).toContainText('概率论')
    await createSpace('泛函分析')
    await chooseSpace('概率论')
    await navigateTo(page, '笔记')
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await page.locator('.note-title-input').fill('大数定律学习记录')
    await page.locator('.note-textarea').fill('刚输入就切换学习区，仍须完整保存。')
    await chooseSpace('泛函分析')
    await navigateTo(page, '笔记')
    await expect(page.locator('.note-item')).toHaveCount(0)
    await chooseSpace('概率论')
    await navigateTo(page, '笔记')
    await page.locator('.note-item', { hasText: '大数定律学习记录' }).click()
    await expect(page.locator('.note-textarea')).toHaveValue('刚输入就切换学习区，仍须完整保存。')
    expect(launched.consoleErrors).toEqual([])
  } finally {
    await launched.app.close()
    rmTempDir(data)
  }
})

test('文档信息弹窗：改名、改类型、移动学习区一次完成', async () => {
  const data = mkdtempSync(join(tmpdir(), 'mathwb-docinfo-'))
  const launched = await launchApp(data, undefined, { visible: true })
  try {
    const { page } = launched
    await page.locator('.scope-switch').click()
    await page.getByRole('menuitem', { name: '新建学习区', exact: true }).click()
    await page.getByLabel('学习区名称').fill('论文专题A')
    await page.getByRole('button', { name: '创建学习区', exact: true }).click()
    await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p], { spaceId: null }),
      fixturePdf('text-basic.pdf')
    )
    // 顶栏切换器选「未分区」scope（导入后该条目带计数，菜单项名称保持固定）
    await page.locator('.scope-switch').click()
    await page.getByRole('menuitem', { name: '未分区', exact: true }).click()
    const row = page.locator('.material-row', { hasText: 'text-basic' })
    await expect(row).toBeVisible()
    await row.locator('.doc-info-btn').click()
    await page.locator('.doc-info-form input.input').first().fill('我的教材（改名）')
    await page.locator('.doc-info-form select').first().selectOption('paper')
    // P3 改版后弹窗 select 顺序：类型 / 所属分区 / 所属学习区
    const spaceSelect = page.locator('.doc-info-form select').nth(2)
    await expect(spaceSelect.locator('option', { hasText: '论文专题A' })).toHaveCount(1)
    await spaceSelect.selectOption({ label: '论文专题A' })
    await page.locator('.doc-info-form').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.modal')).toHaveCount(0)
    // 文档已随保存移入论文专题A：当前（未分区）列表应不再显示，切过去可见新名
    await expect(page.locator('.doc-title', { hasText: '我的教材（改名）' })).toHaveCount(0)
    await page.locator('.scope-switch').click()
    await page.getByRole('menuitem', { name: '论文专题A', exact: true }).click()
    await expect(page.locator('.doc-title', { hasText: '我的教材（改名）' })).toBeVisible()
    expect(launched.consoleErrors).toEqual([])
  } finally {
    await launched.app.close()
    rmTempDir(data)
  }
})
