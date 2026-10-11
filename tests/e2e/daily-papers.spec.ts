import { expect, test } from '@playwright/test'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 计划 §4 验收：清单导入 → 基础 ID 去重 → 多来源 → deep link 定位（校验路径与 open-url 相同）。
// 清单文件夹经隔离 userData 的 settings.json 指向测试目录，绝不写用户真实 Documents。

function manifest(items: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'daily-paper-mailer', items })
}

test('清单导入：入库与坏条目跳过；重复读取幂等；deep link 定位与校验', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-daily-e2e-'))
  const folder = join(userData, 'daily')
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'day1.json'),
    manifest([
      { provider: 'arxiv', providerId: '2601.77777', version: 'v1', title: '清单导入测试论文 A', authors: ['A Author'], abstract: '第一条。', publishedAt: new Date().toISOString(), matchedFeeds: [] },
      { provider: 'arxiv', providerId: '2601.88888', title: '清单导入测试论文 B', authors: ['B'], abstract: '第二条。', publishedAt: new Date().toISOString(), matchedFeeds: [] },
      { provider: 'arxiv', providerId: 'bad-id', title: '坏条目', authors: [], abstract: '', publishedAt: new Date().toISOString() }
    ])
  )
  // 预写隔离设置：清单目录指向测试文件夹
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ daily: { folder, autoCheck: false } }))

  const app = await launchApp(userData, { MATHWB_E2E: '1' })
  try {
    const { page } = app
    // 建一个订阅（清单来源需要落点）
    await navigateTo(page, '每日论文')
    await page.getByRole('button', { name: '创建第一个订阅' }).click({ timeout: 10000 })
    await page.locator('.doc-info-form input').nth(0).fill('测试订阅')
    await page.locator('.doc-info-form input').nth(1).fill('math.AG')
    await page.locator('.doc-info-form').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.modal')).toHaveCount(0)

    // 读取清单文件夹：2 篇导入（坏条目跳过），文件归档
    await page.getByRole('button', { name: '读取清单文件夹' }).click()
    await expect(page.locator('.toast', { hasText: '导入 2 篇' })).toBeVisible({ timeout: 20000 })
    const { existsSync, readdirSync } = await import('node:fs')
    expect(existsSync(join(folder, 'day1.json'))).toBe(false)
    expect(readdirSync(join(folder, 'imported')).some((f) => f.endsWith('day1.json'))).toBe(true)
    await expect(page.locator('.paper-title', { hasText: '清单导入测试论文 A' })).toBeVisible()

    // 重复投递同内容文件：幂等
    writeFileSync(join(folder, 'day1-again.json'), manifest([
      { provider: 'arxiv', providerId: '2601.77777', version: 'v1', title: '清单导入测试论文 A', authors: ['A Author'], abstract: '第一条。', publishedAt: new Date().toISOString(), matchedFeeds: [] }
    ]))
    await page.getByRole('button', { name: '读取清单文件夹' }).click()
    await expect(page.locator('.toast', { hasText: '没有新增' })).toBeVisible({ timeout: 20000 })
    const api = (windowRef: typeof page) => windowRef
    void api

    // deep link：合法 ID → 定位高亮；非法 URL → 无任何反应
    await page.evaluate(() => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testDeepLink('mathworkbench://paper?id=2601.88888'))
    await expect(page.locator('.paper-card-target', { hasText: '清单导入测试论文 B' })).toBeVisible({ timeout: 15000 })
    await page.evaluate(() => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testDeepLink('mathworkbench://evil?id=2601.88888'))
    await page.evaluate(() => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testDeepLink('mathworkbench://paper?id=../../etc'))
    await page.waitForTimeout(400)
    // 目标未变（仍是 B 的卡片），无崩溃
    await expect(page.locator('.paper-card-target', { hasText: '清单导入测试论文 B' })).toBeVisible()
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close()
    rmTempDir(userData)
  }
})
