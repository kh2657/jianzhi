import { expect, test } from '@playwright/test'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// arXiv 每日论文全流程（本地 mock arXiv，不访问真实网络）：
// 创建订阅 → 抓取 → 列表展示 → 导入文献（下载 PDF、预填书目）→ 状态更新 → 重启持久化。

let mock: Server
let mockPort = 0

test.beforeAll(async () => {
  const pdfBytes = readFileSync(join(process.cwd(), 'fixtures/text-basic.pdf'))
  const atomRaw = readFileSync(join(process.cwd(), 'tests/fixtures/arxiv-sample.atom'), 'utf8')
  // 夹具的 published 日期是静态的；paperList 默认窗口 7 天——把日期动态替换进窗口，否则日期一过列表就少一条
  const inWindow = (daysAgo: number, time: string): string => {
    const d = new Date(Date.now() - daysAgo * 86400_000)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${time}`
  }
  const dated = atomRaw
    .replaceAll('2026-10-05T14:00:00Z', inWindow(1, '14:00:00Z'))
    .replaceAll('2026-10-04T09:30:00Z', inWindow(2, '09:30:00Z'))
    .replaceAll('2026-09-28T09:30:00Z', inWindow(2, '09:30:00Z'))
  mock = createServer((req, res) => {
    const url = req.url ?? '/'
    if (url.startsWith('/api/query')) {
      const body = dated.replaceAll('http://arxiv.org/pdf/', `http://127.0.0.1:${mockPort}/pdf/`)
      res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' })
      res.end(body)
      return
    }
    if (url.startsWith('/pdf/')) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' })
      res.end(pdfBytes)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r))
  mockPort = (mock.address() as { port: number }).port
})

test.afterAll(async () => {
  await new Promise<void>((r) => mock.close(() => r()))
})

test('每日论文：订阅 → 抓取 → 挑选导入 → 重启持久化', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-papers-'))
  const app = await launchApp(userData, {
    MATHWB_ARXIV_API: `http://127.0.0.1:${mockPort}/api/query`
  })
  try {
    const { page } = app

    // 进入每日论文，创建订阅
    await navigateTo(page, '每日论文')
    await page.getByRole('button', { name: '创建第一个订阅' }).click({ timeout: 10000 })
    await page.locator('.doc-info-form input').nth(0).fill('代数几何每日')
    await page.locator('.doc-info-form input').nth(1).fill('math.AG')
    await page.locator('.doc-info-form').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.modal')).toHaveCount(0)

    // 抓取（走 mock arXiv）
    await page.getByRole('button', { name: /抓取/ }).first().click()
    await expect(page.locator('.toast-success', { hasText: '新增 2 篇' })).toBeVisible({ timeout: 20000 })
    await expect(page.locator('.paper-card')).toHaveCount(2)
    await expect(page.locator('.paper-title').first()).toHaveText('Moduli Spaces of Stable Sheaves on K3 Surfaces')
    await expect(page.locator('.paper-authors').first()).toContainText('Alice Author')

    // 忽略第二篇（从待挑选列表消失）
    await page.locator('.paper-card').nth(1).getByRole('button', { name: '忽略' }).click()
    await expect(page.locator('.paper-card')).toHaveCount(1)

    // 导入第一篇（下载 mock PDF → 文献 → 预填标题）→ 待挑选清空
    await page.locator('.paper-card').first().getByRole('button', { name: '开始阅读' }).click()
    await expect(page.locator('.toast-success', { hasText: '已导入' })).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
    await expect(page.locator('.reader-title')).toContainText('Moduli Spaces')

    // 文献里出现该论文（标题为 arXiv 真实标题）
    await navigateTo(page, '文献')
    await expect(page.locator('.doc-title', { hasText: 'Moduli Spaces of Stable Sheaves on K3 Surfaces' })).toBeVisible()

    // 重启：条目与状态持久化，文献文档仍在
    await app.app.close()
    const app2 = await launchApp(userData, { MATHWB_ARXIV_API: `http://127.0.0.1:${mockPort}/api/query` })
    const page2 = app2.page
    await navigateTo(page2, '每日论文')
    // 论文状态筛选已收敛为视图内标签行
    await page2.locator('.filter-tabs[aria-label=\"论文状态\"] .chip', { hasText: '已在文献' }).click()
    await expect(page2.locator('.paper-title', { hasText: 'Moduli Spaces' })).toBeVisible()
    await navigateTo(page2, '文献')
    await expect(page2.locator('.doc-title', { hasText: 'Moduli Spaces' })).toBeVisible()
    expect(app2.consoleErrors).toEqual([])
    await app2.app.close()
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
