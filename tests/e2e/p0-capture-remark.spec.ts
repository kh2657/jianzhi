import { expect, test, type Page } from '@playwright/test'
import { navigateTo, fixture, launchApp, layoutAudit, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// P0-3 回归守卫：照片备注必须有清晰的 未保存/保存中/失败可重试 状态，
// 且切页（导航冲刷）与关窗（app:flush 协议）不丢内容。历史缺陷：仅防抖保存、失败不可见。
// 收件箱删除后照片展示位 = 文献库「待整理」分区；备注状态机原样随迁。

let userData: string
let app1: LaunchedApp
let app2: LaunchedApp | null = null

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-p0remark-'))
  app1 = await launchApp(userData, { MATHWB_E2E: '1' })
})

test.afterAll(async () => {
  await app1?.app.close().catch(() => undefined)
  await app2?.app.close().catch(() => undefined)
  rmTempDir(userData)
})

async function importAndOpenPhotos(page: Page): Promise<void> {
  // photo.jpg 仅 macOS 生成（gen-fixtures）；其他平台用 photo.png 验证原生显示路线
  const photoName = process.platform === 'darwin' ? 'photo.jpg' : 'photo.png'
  const capImport = await page.evaluate(
    (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.captureImport([p]),
    fixture(photoName)
  )
  expect(capImport[0].ok).toBe(true)
  await navigateTo(page, '文献')
  await page.locator('.section-node', { hasText: '待整理' }).first().click()
  await expect(page.locator('.inbox-card').first()).toBeVisible()
}

function remarkInput(page: Page) {
  return page.getByLabel(/备注：/)
}

/** 轮询服务器侧备注值（不依赖 UI 状态） */
function serverContext(page: Page): Promise<string | null | undefined> {
  return page.evaluate(async () => {
    const list = await (window as unknown as { api: import('../../src/shared/api').MathApi }).api.captureList()
    return list[0]?.context ?? null
  })
}

test('备注自动保存：状态可见，落库后静默', async () => {
  const { page } = app1
  app1.setPhase('remark-save')
  await importAndOpenPhotos(page)

  const input = remarkInput(page)
  await input.fill('演草备注 A')
  await expect(page.locator('.inbox-card').first().locator('.status-dirty')).toBeVisible()
  // 落库后状态行消失（saved 静默）
  await expect(page.locator('.inbox-card').first().locator('.status-error')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => serverContext(page), { timeout: 15000 }).toBe('演草备注 A')
  await expect(page.locator('.inbox-card').first().locator('.status-dirty,.status-saving')).toHaveCount(0)
})

test('切页冲刷：输入后立即离开，备注不丢', async () => {
  const { page } = app1
  app1.setPhase('remark-nav-flush')

  await remarkInput(page).fill('演草备注 B')
  // 立即切换视图（App.navigate 会先 await flusher = flushAll）
  await navigateTo(page, '笔记')
  await expect(page.locator('.view-head h1')).toHaveText('笔记')

  await navigateTo(page, '文献')
  await page.locator('.section-node', { hasText: '待整理' }).first().click()
  await expect(remarkInput(page)).toHaveValue('演草备注 B')
  await expect.poll(() => serverContext(page), { timeout: 15000 }).toBe('演草备注 B')
})

test('保存失败可见、可重试，重试成功后落库', async () => {
  const { page } = app1
  app1.setPhase('remark-failure')

  await page.evaluate(
    () =>
      (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testIpcFail({
        channel: 'capture:save',
        error: '模拟保存失败'
      })
  )
  await remarkInput(page).fill('演草备注 C')
  const card = page.locator('.inbox-card').first()
  await expect(card.locator('.status-error')).toBeVisible({ timeout: 15000 })
  await expect(card.locator('.status-error')).toContainText('模拟保存失败')

  await page.evaluate(
    () =>
      (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testIpcFail({ channel: null })
  )
  await card.getByRole('button', { name: '重试' }).click()
  await expect(card.locator('.status-error')).toHaveCount(0, { timeout: 15000 })
  await expect.poll(() => serverContext(page), { timeout: 15000 }).toBe('演草备注 C')

  expect(await layoutAudit(page, 'inbox')).toEqual([])
  expect(app1.consoleErrors).toEqual([])
})

test('关窗冲刷：输入后立即关闭应用，重启后备注仍在', async () => {
  const { page } = app1
  app1.setPhase('remark-close-flush')

  await remarkInput(page).fill('演草备注 D')
  await page.waitForTimeout(120) // 处于 dirty、防抖定时器未触发
  await app1.app.close() // 主进程 close → app:flush → flushAll → app:flushed

  app2 = await launchApp(userData)
  app2.setPhase('remark-after-restart')
  await navigateTo(app2.page, '文献')
  await app2.page.locator('.section-node', { hasText: '待整理' }).first().click()
  await expect(remarkInput(app2.page)).toHaveValue('演草备注 D')
  expect(app2.consoleErrors).toEqual([])
})
