import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, layoutAudit, type LaunchedApp, rmTempDir } from './helpers/launch'

async function openSeed(app: LaunchedApp) {
  const id = await app.page.evaluate(async (path) => {
    const api = window.api
    const [imported] = await api.docImport([path], { docType: 'paper' })
    const doc = await api.docOpen(imported.documentId!)
    await api.anchorCreateWithNote({
      anchor: { documentVersionId: doc.versionId, pageIndex: 0, rects: [[72, 310, 520, 440]] },
      note: { title: '边界条件疑问', noteType: 'problem', bodyMd: '为何需要这个条件？' }
    })
    return doc.documentId
  }, join(process.cwd(), 'fixtures/text-basic.pdf'))
  await app.page.reload()
  await navigateTo(app.page, '文献')
  await app.page.locator('.doc-item').click()
  await expect(app.page.locator('.page-wrap[data-page-index="0"]')).toHaveAttribute('data-page-index', '0')
  return id
}

test('右栏保存失败阻止离开和关闭，重试后立即关闭不丢最后输入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-reading-flush-'))
  let app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const id = await openSeed(app)
    const { page } = app
    await page.locator('.mnp-item-head', { hasText: '边界条件疑问' }).click()
    await page.evaluate(() => window.api.testIpcFail({ channel: 'note:save', error: '模拟右栏保存失败' }))
    await page.locator('.mnp .mnp-textarea').fill('最后输入：条件是否必要？')
    await page.locator('.workspace-primary .nav-item[aria-label="资料"]').click()
    await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('.mnp .mnp-textarea')).toHaveValue('最后输入：条件是否必要？')
    await expect(page.locator('.toast', { hasText: '未能保存' })).toBeVisible()
    await app.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect(page.locator('.toast', { hasText: '窗口已保留' })).toBeVisible()
    expect(page.isClosed()).toBe(false)
    await page.evaluate(() => window.api.testIpcFail({ channel: null }))
    await page.locator('.mnp .mnp-textarea').fill('最后输入：重试后保留的新内容。')
    await app.app.close()
    app = await launchApp(dir)
    await expect(app.page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
    await expect(app.page.locator('.mnp .mnp-textarea')).toHaveValue('最后输入：重试后保留的新内容。')
    const notes = await app.page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(notes[0].bodyMd).toBe('最后输入：重试后保留的新内容。')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.page.evaluate(() => window.api.testIpcFail({ channel: null })).catch(() => undefined)
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('精读卡保留原文、人工核对与回源；未完草稿和阅读现场重启恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-reading-card-'))
  let app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const id = await openSeed(app)
    const { page } = app
    const networkErrors: string[] = []
    // 同 simple-ui：导航/重载取消的在途请求（net::ERR_ABORTED）不算加载失败
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? ''
      if (reason.includes('ERR_ABORTED')) return
      networkErrors.push(`${reason} ${request.url()}`)
    })
    page.on('response', (response) => { if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`) })
    await page.locator('.rw-settings > summary').click()
    await page.getByLabel('阅读核心问题').fill('边界条件能否放宽？')
    await page.getByLabel('随手记内容').fill('尚未提交的下一条疑问')
    await page.getByRole('tab', { name: '整理', exact: true }).click()
    const section = page.getByTestId('card-section-findings')
    await section.locator('textarea').fill('结论只在所列边界条件下成立，必要性待核查。')
    await expect(section).toContainText('待核对')
    await section.locator('summary').click()
    await section.getByRole('checkbox', { name: /依据/ }).check()
    await expect(section).toContainText('待核对')
    await section.getByRole('checkbox', { name: /确认核对/ }).check()
    await expect(section).toContainText('已核对')
    await section.locator('textarea').fill('结论只在所列边界条件下成立。修改之后重新核查。')
    await expect(section.getByRole('checkbox', { name: /确认核对/ })).not.toBeChecked()
    await expect(section).toContainText('待核对')
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await section.getByRole('button', { name: /回原文/ }).click()
    await expect(page.locator('.page-input')).toHaveValue('1')
    await expect(page.locator('.anchor-rect-flash').first()).toBeVisible()
    for (const size of [{ width: 1080, height: 720 }, { width: 1366, height: 768 }, { width: 1512, height: 982 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
      await page.setViewportSize(size)
      expect(await layoutAudit(page, `reading-card ${size.width}`)).toEqual([])
      const metrics = await page.evaluate(() => {
        const source = document.querySelector('.page-scroll')!.getBoundingClientRect()
        const side = document.querySelector('.reader-side')!.getBoundingClientRect()
        return { sourceWidth: source.width, sideWidth: side.width, overlap: source.right > side.left + 1,
          sideOverflow: document.querySelector('.reader-side')!.scrollWidth > side.width + 1 }
      })
      expect(metrics.sourceWidth).toBeGreaterThan(300)
      expect(metrics.sideWidth).toBeGreaterThanOrEqual(300)
      expect(metrics.overlap).toBe(false)
      expect(metrics.sideOverflow).toBe(false)
      await page.screenshot({ path: `docs/screenshots/simple-card-${size.width}.png` })
    }
    await page.getByLabel('阅读阶段').selectOption('paused')
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await app.app.close()
    app = await launchApp(dir)
    await expect(app.page.locator('.page-input')).toHaveValue('2')
    await expect(app.page.getByRole('tab', { name: '整理', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(app.page.getByLabel('阅读核心问题')).toHaveValue('边界条件能否放宽？')
    await expect(app.page.getByLabel('阅读阶段')).toHaveValue('paused')
    await expect(app.page.getByTestId('card-section-findings').locator('textarea')).toHaveValue(/修改之后重新核查/)
    await app.page.getByRole('tab', { name: '随手记', exact: true }).click()
    await expect(app.page.getByLabel('随手记内容')).toHaveValue('尚未提交的下一条疑问')
    await app.page.locator('.rw-quick-options > summary').click()
    await app.page.getByRole('button', { name: '记下疑问', exact: true }).click()
    await expect(app.page.locator('.mnp-item', { hasText: '尚未提交' })).toBeVisible()
    const notes = await app.page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(notes.find(note => note.title === '尚未提交的下一条疑问')?.anchors[0].pageIndex).toBe(1)
    await app.page.locator('.rw-question', { hasText: '尚未提交' }).getByRole('button', { name: '标为已解决' }).click()
    await expect(app.page.locator('.rw-details > summary', { hasText: '未解决的问题' })).toContainText('1')
    expect(networkErrors).toEqual([])
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})
