import { expect, test } from '@playwright/test'
import { navigateTo, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

// 浏览器扩展导入端到端：本地服务 /api/import 接收扩展风格的提交（元数据+PDF base64），
// 落入文献库「待整理」并推 toast。等价于扩展后台脚本真实发出的请求。

let userData: string
let app: LaunchedApp

const PDF_BASE64 = Buffer.from('%PDF-1.4\n%e2e-browser-import\n').toString('base64')

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-webimport-'))
  app = await launchApp(userData, { MATHWB_E2E: '1' })
})

test.afterAll(async () => {
  await app?.app.close().catch(() => undefined)
  rmTempDir(userData)
})

test('扩展风格提交 → toast 提示 + 文献库「待整理」出现条目', async () => {
  const { page } = app
  app.setPhase('browser-import')
  // 启动默认视图是笔记；扩展导入的条目要到文献库列表里核对
  await navigateTo(page, '文献')

  // 端口 = 渲染页面所在本地服务；令牌 = 启动时落 settings.json 的 prefs.importToken
  const port = new URL(page.url()).port
  expect(port).toBeTruthy()
  const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { prefs?: Record<string, string> }
  const token = settings.prefs?.importToken ?? ''
  expect(token).toBeTruthy()

  const res = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token },
    body: JSON.stringify({
      title: '浏览器导入的 E2E 论文',
      authors: ['测试作者'],
      year: 2026,
      sourceUrl: 'https://arxiv.org/abs/2401.12345',
      arxivId: '2401.12345',
      pdfBase64: PDF_BASE64
    })
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; duplicate?: boolean }
  expect(body.ok).toBe(true)
  expect(body.duplicate).toBe(false)

  // 主进程推送 toast；文献库列表经 library:changed 自动刷新出条目
  await expect(page.locator('.toast').getByText('浏览器导入成功：浏览器导入的 E2E 论文')).toBeVisible()
  await expect(page.locator('.doc-list').getByText('浏览器导入的 E2E 论文')).toBeVisible()

  // 再次提交同 DOI/arXiv：报告「已在库中」而非重复建条目
  const again = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MWB-Token': token },
    body: JSON.stringify({ title: '换个名字的同篇', arxivId: '2401.12345' })
  })
  const againBody = (await again.json()) as { ok: boolean; duplicate?: boolean }
  expect(againBody.duplicate).toBe(true)
  await expect(page.locator('.toast').getByText('已在文献库中：换个名字的同篇')).toBeVisible()

  expect(app.consoleErrors, app.consoleErrors.map((e) => e.text).join('\n')).toEqual([])
})
