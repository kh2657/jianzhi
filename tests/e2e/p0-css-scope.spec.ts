import { expect, test } from '@playwright/test'
import { navigateTo, fixture, launchApp, layoutAudit, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// P0-1 回归守卫：pdf_viewer.css 是 PDF.js 整套查看器样式，其中的全局 .sidebar/.toolbar 等
// 规则曾按打包顺序覆盖应用自身侧栏样式（打开阅读器后侧栏变白、宽度被改）。
// 修复方式：构建时把该文件的所有选择器收进 .pdfjs-root 作用域（见 scripts/scope-pdfjs-css.ts）。
// 本测试断言「打开阅读器后」应用侧栏仍是主题样式，且 PDF 文本层样式未被破坏（划选摘录依赖它）。

let userData: string
let app: LaunchedApp

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-p0css-'))
  app = await launchApp(userData)
})

test.afterAll(async () => {
  await app?.app.close().catch(() => undefined)
  rmTempDir(userData)
})

test('打开 PDF 阅读器后，应用侧栏保持主题样式，文本层可选中', async () => {
  const { page } = app
  app.setPhase('import')

  const importResult = await page.evaluate(
    (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
    fixture('text-basic.pdf')
  )
  expect(importResult[0].ok).toBe(true)

  app.setPhase('reader')
  await page.reload()
  await navigateTo(page, '文献')
  await page.locator('.doc-item', { hasText: 'text-basic' }).first().click()
  await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
    .toBeGreaterThanOrEqual(1)

  // 文本层就绪（TextLayer 渲染出 span，划选文字摘录依赖它）
  await expect
    .poll(() => page.evaluate(() => document.querySelectorAll('.textLayer span').length))
    .toBeGreaterThan(0)

  const textLayer = await page.evaluate(() => {
    const el = document.querySelector('.textLayer')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { position: cs.position, opacity: cs.opacity }
  })
  // pdfjs 文本层基础样式在作用域内仍然生效
  expect(textLayer?.position).toBe('absolute')
  expect(textLayer?.opacity).toBe('1')
  expect(await layoutAudit(page, 'reader')).toEqual([])

  // 外壳侧栏已整体退出（筛选收敛）：pdfjs 作用域守卫改查常驻的 chrome 面 .activity-bar——
  // pdf_viewer.css 的污染是全局的，只要应用 chrome 仍按主题渲染即证明作用域化有效
  const chrome = await page.evaluate(() => {
    const el = document.querySelector('.activity-bar')!
    const cs = getComputedStyle(el)
    // token 当前计算色：断言跟随调色演进，不写死色值
    const probe = document.createElement('div')
    probe.style.background = 'var(--navigation-bg)'
    document.body.appendChild(probe)
    const navigationBg = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { background: cs.backgroundColor, borderRadius: cs.borderRadius, position: cs.position, navigationBg }
  })
  // 应用主题（styles.css .activity-bar：浅灰 chrome、无圆角、正常流布局），未被 pdf_viewer.css 覆盖
  expect(chrome.background).toBe(chrome.navigationBg)
  expect(chrome.borderRadius).toBe('0px')
  expect(chrome.position).not.toBe('fixed')

  expect(app.consoleErrors).toEqual([])
})
