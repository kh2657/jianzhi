import { expect, test, type Page } from '@playwright/test'
import { navigateTo, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// P0-2 回归守卫：列表/搜索类 IPC 失败必须进入「可读错误 + 重试」状态，
// 不允许永久停留在「加载中/搜索中」（历史缺陷：NotesView/NotePicker/InboxView 无 catch/finally）。
// 故障注入通道见 src/main/ipc.ts（仅 MATHWB_E2E=1 时注册 test:ipcFail）。

let userData: string
let app: LaunchedApp

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-p0async-'))
  app = await launchApp(userData, { MATHWB_E2E: '1' })
})

test.afterAll(async () => {
  await app?.app.close().catch(() => undefined)
  rmTempDir(userData)
})

function injectIpcFail(page: Page, channel: string | null, error?: string): Promise<{ ok: true }> {
  return page.evaluate(
    ([ch, msg]) =>
      (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testIpcFail({
        channel: ch,
        error: msg
      }),
    [channel, error] as const
  )
}

test('笔记列表 IPC 失败 → 显示错误并可重试，恢复后显示最新列表', async () => {
  const { page } = app
  app.setPhase('notes-error')

  await injectIpcFail(page, 'notes:list', '模拟 IPC 故障')
  await navigateTo(page, '笔记')

  // 错误可见、可读，且没有卡死在「搜索中…」
  await expect(page.getByText('加载失败')).toBeVisible()
  await expect(page.getByText('模拟 IPC 故障')).toBeVisible()
  await expect(page.locator('.view-scroll')).not.toContainText('搜索中…')

  // 恢复 → 重试 → 正常空状态
  await injectIpcFail(page, null)
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('还没有笔记')).toBeVisible()
})

test('照片列表 IPC 失败 → 显示错误并可重试，恢复后消失（照片展示位=文献库待整理）', async () => {
  const { page } = app
  app.setPhase('inbox-error')

  await injectIpcFail(page, 'capture:list', '模拟 IPC 故障')
  await navigateTo(page, '文献')
  await page.locator('.section-node', { hasText: '待整理' }).first().click()

  await expect(page.getByText('照片加载失败')).toBeVisible()
  await expect(page.getByText('模拟 IPC 故障')).toBeVisible()

  await injectIpcFail(page, null)
  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByText('照片加载失败')).toHaveCount(0)
})

test('故障注入与恢复全程零控制台错误', async () => {
  expect(app.consoleErrors).toEqual([])
})
