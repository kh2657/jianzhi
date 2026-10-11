import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'

test('文献库：导入→待整理→检索式搜索→分面→分区移动→条目信息', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-lib-'))
  const app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const { page } = app
    // 导入两篇文献（走真实 IPC 管道）并补全书目（P4 之前由测试直接写入元数据）
    await page.evaluate(async () => {
      const importOne = async (name: string, patch: { title: string; authors?: string[]; year?: number | null; venue?: string | null; tags?: string[] }) => {
        const [r] = await window.api.docImport([`fixtures/${name}`], { docType: 'paper' })
        if (!r.documentId) throw new Error(r.error ?? '导入失败')
        await window.api.libraryEntryUpdate(r.documentId, patch)
        return r.documentId
      }
      await importOne('text-basic.pdf', { title: '弱辨识性研究', authors: ['张三', '李四'], year: 2024, venue: 'Annals of Statistics', tags: ['弱辨识', 'Heston'] })
      await importOne('scanned.pdf', { title: 'Heston 模型校准', authors: ['王五'], year: 2021, venue: null, tags: ['Heston'] })
    })
    await page.reload()
    await navigateTo(page, '文献')

    // 左侧分区栏出现「待整理」节点（计数 2）；两篇都在
    const sectionNav = page.locator('.library-sections')
    await expect(sectionNav.locator('.section-node', { hasText: '待整理' })).toBeVisible()
    await expect(page.locator('.doc-item', { hasText: '弱辨识性研究' })).toBeVisible()
    await expect(page.locator('.doc-item', { hasText: 'Heston 模型校准' })).toBeVisible()

    // 检索式：作者；年份区间
    const search = page.getByLabel('检索文献')
    await search.fill('作者:张三')
    await expect(page.locator('.doc-item', { hasText: '弱辨识性研究' })).toBeVisible()
    await expect(page.locator('.doc-item', { hasText: 'Heston 模型校准' })).toHaveCount(0)
    await search.fill('年份:2020-2022')
    await expect(page.locator('.doc-item', { hasText: 'Heston 模型校准' })).toBeVisible()
    await expect(page.locator('.doc-item', { hasText: '弱辨识性研究' })).toHaveCount(0)
    await search.fill('')

    // 分面：标签 Heston 命中两篇；再点作者 王五 剩一篇；清除后恢复
    await page.getByText('分面筛选').click()
    const tagFacet = page.locator('.facet-row', { hasText: '标签' })
    await tagFacet.locator('.chip', { hasText: 'Heston' }).first().click()
    await expect(page.locator('.doc-item')).toHaveCount(2)
    const authorFacet = page.locator('.facet-row', { hasText: '作者' })
    await authorFacet.locator('.chip', { hasText: '王五' }).first().click()
    await expect(page.locator('.doc-item')).toHaveCount(1)
    const activeRow = page.locator('.library-filters').filter({ hasText: '作者:' })
    await activeRow.locator('.chip', { hasText: '王五' }).click()
    await expect(page.locator('.doc-item')).toHaveCount(2) // 作者筛选已移除，标签 Heston 仍生效（两篇都有）
    await tagFacet.locator('.chip', { hasText: 'Heston' }).first().click()
    await expect(page.locator('.doc-item')).toHaveCount(2) // 全部清除 → 全库 2 篇

    // 侧栏新建分区「随机分析」
    await page.locator('.section-create').click()
    await page.getByLabel('分区名称').fill('随机分析')
    await page.getByRole('button', { name: '创建分区' }).click()
    await expect(sectionNav.locator('.section-node', { hasText: '随机分析' })).toBeVisible()

    // 点击分区即过滤（此前只高亮不改列表）；空分区给出针对性空态
    await sectionNav.locator('.section-node-main', { hasText: '随机分析' }).click()
    await expect(page.locator('.doc-item')).toHaveCount(0)
    await expect(page.locator('.empty-title')).toHaveText('「随机分析」里还没有文献')
    await sectionNav.locator('.section-node', { hasText: '待整理' }).click()
    await expect(page.locator('.doc-item')).toHaveCount(2)
    await expect(page.locator('.library-filters', { hasText: '分区:待整理' })).toBeVisible()

    // 收藏标记：星标两篇 → 收藏节点计数 2，收藏视图只剩这两篇；取消一篇恢复
    await page.locator('.material-row', { hasText: '弱辨识性研究' }).locator('.star-btn').click()
    await page.locator('.material-row', { hasText: 'Heston 模型校准' }).locator('.star-btn').click()
    await page.waitForTimeout(300)
    await sectionNav.locator('.section-node', { hasText: '收藏' }).click()
    await expect(page.locator('.doc-item', { hasText: '弱辨识性研究' })).toBeVisible()
    await expect(page.locator('.doc-item', { hasText: 'Heston 模型校准' })).toBeVisible()
    await page.locator('.material-row', { hasText: 'Heston 模型校准' }).locator('.star-btn').click()
    await expect(page.locator('.doc-item', { hasText: 'Heston 模型校准' })).toHaveCount(0)
    await sectionNav.locator('.section-node', { hasText: '全部文献' }).click()
    await expect(page.locator('.doc-item')).toHaveCount(2)

    // 分区重命名与删除（条目移回待整理）：统一从行内「⋯」→ 右键菜单进入
    const openSectionMenu = async (name: string) => {
      await sectionNav.locator('.section-node-row', { hasText: name }).hover()
      await sectionNav.getByLabel(`分区选项 ${name}`).click()
      await expect(page.locator('.context-menu')).toBeVisible()
    }
    await openSectionMenu('随机分析')
    await page.getByRole('menuitem', { name: '重命名分区 随机分析' }).click()
    await page.getByLabel('分区名称').fill('贝叶斯专题')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(sectionNav.locator('.section-node', { hasText: '贝叶斯专题' })).toBeVisible()
    // 移一条进去再删分区，条目应回待整理
    await page.locator('.doc-info-btn', { hasText: '⋯' }).first().click()
    const dialog = page.locator('[role=dialog][aria-label=文献信息]')
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('所属分区').selectOption('贝叶斯专题')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(sectionNav.locator('.section-node', { hasText: '贝叶斯专题' })).toContainText('1')
    await openSectionMenu('贝叶斯专题')
    await page.getByRole('menuitem', { name: '删除分区 贝叶斯专题' }).click()
    await page.getByRole('button', { name: '删除分区', exact: true }).click()
    await expect(sectionNav.locator('.section-node', { hasText: '贝叶斯专题' })).toHaveCount(0)
    await sectionNav.locator('.section-node', { hasText: '待整理' }).click()
    await expect(page.locator('.doc-item')).toHaveCount(2)

    // 分区颜色标签：右键设色 → 行左缘色条；重启后仍在（落在库根 分区.json）
    await sectionNav.locator('.section-node', { hasText: '待整理' }).click({ button: 'right' })
    await expect(page.locator('.context-menu')).toBeVisible()
    await page.locator('.color-swatch[aria-label="橙色"]').click()
    await expect(sectionNav.locator('.section-node[data-colored]')).toHaveCount(1)
    await page.reload()
    await navigateTo(page, '文献')
    await expect(sectionNav.locator('.section-node[data-colored]')).toHaveCount(1)
    // 清除颜色后不再有色条
    await sectionNav.locator('.section-node', { hasText: '待整理' }).click({ button: 'right' })
    await page.locator('.color-swatch[aria-label="无颜色"]').click()
    await expect(sectionNav.locator('.section-node[data-colored]')).toHaveCount(0)
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})
