import { expect, test } from '@playwright/test'
import { navigateTo, fixture, killStrayApps, launchApp, rmTempDir } from './helpers/launch'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 回归：设置里的「重启应用」曾是 `app.relaunch(); app.exit(0)`。
// app.exit() 不触发 close，因此完全绕过「等渲染层冲刷完成再退出」的握手，
// 未落盘的笔记正文、备注、阅读记录、墨迹会被直接丢掉。
//
// 这里注入 reading:save 故障，让冲刷必然失败：修复后应用应当**留在原地**，
// 修复前会无条件退出——所以「应用还活着」就是这条回归的判据。
// （成功路径用的是与关窗完全相同的握手，已由其它 E2E 覆盖。）
test('重启应用走保存握手：冲刷失败时不退出，应用保持可用', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-relaunch-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const api = (p: string): Promise<unknown> =>
      page.evaluate(
        (path) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([path]),
        p
      )

    const imp = (await api(fixture('text-basic.pdf'))) as Array<{ ok: boolean }>
    expect(imp[0].ok).toBe(true)
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    // 等阅读器就绪：此时它的 flusher 已注册，且会调用 reading:save
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    // 让冲刷必然失败
    await page.evaluate(() =>
      (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testIpcFail({
        channel: 'reading:save',
        error: '模拟保存失败'
      })
    )

    await page.evaluate(() => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.appRelaunch())
    await page.waitForTimeout(2500)

    // 修复前：app.exit(0) 已让进程消失，下面两条断言都会失败
    expect(app.app.process()?.exitCode ?? null).toBeNull()
    await expect(page.locator('.reader-toolbar')).toBeVisible()

    // 解除故障后应用仍能正常工作
    await page.evaluate(() =>
      (window as unknown as { api: import('../../src/shared/api').MathApi }).api.testIpcFail({ channel: null })
    )
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await expect(page.getByLabel('页码')).toHaveValue('2')
  } finally {
    await app.app.close().catch(() => undefined)
    // 冲刷若意外成功，应用会真的重启并留下不受 Playwright 句柄管理的孤儿进程
    killStrayApps(userData)
    rmTempDir(userData)
  }
})
