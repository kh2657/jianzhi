// 足迹功能视觉复核：临时库造数据 → 双主题截图 笔记列表/编辑页日期行/足迹面板
// 用法：node scripts/shoot-footprint.mjs（需先 npm run build）
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const outDir = join(tmpdir(), 'mathwb-footprint-shots')
const userData = mkdtempSync(join(tmpdir(), 'mathwb-footprint-vis-'))

const app = await electron.launch({
  args: ['out/main/index.js', `--user-data-dir=${userData}`],
  env: { ...process.env, MATHWB_E2E: '1' }
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })

// 造数据：两篇笔记（今天一篇、API 把另一篇建成空笔记再补正文）+ 一篇不同类型
await page.evaluate(async () => {
  const api = window.api
  await api.noteCreate({ title: '弱收敛与强收敛的差别', bodyMd: '弱收敛只保证线性泛函有界收敛；强收敛额外要求范数收敛。' })
  await api.noteCreate({ title: 'Banach 不动点待整理' })
})
await page.reload()
await page.locator('.workspace-primary [aria-label="学习"]').click()
await page.locator('.workspace-tabs [aria-label="笔记"]').click()

// 第二篇补正文（当天新建）
await page.locator('.note-item', { hasText: 'Banach 不动点待整理' }).click()
await page.getByLabel('笔记正文').fill('压缩映射原理：T 在完备空间上 Lip 常数 < 1。')
await page.locator('.workspace-primary [aria-label="学习"]').click()
await page.locator('.workspace-tabs [aria-label="笔记"]').click()

for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
  // 列表 + 编辑页日期行
  await page.screenshot({ path: join(outDir, `notes-${theme}.png`) })
  await page.locator('.note-item', { hasText: '弱收敛' }).click()
  await page.screenshot({ path: join(outDir, `editor-${theme}.png`) })
  await page.locator('.workspace-primary [aria-label="学习"]').click()
  await page.locator('.workspace-tabs [aria-label="笔记"]').click()
  // 足迹面板
  await page.getByRole('button', { name: '学习足迹' }).click()
  await page.locator('.footprint').waitFor()
  await page.screenshot({ path: join(outDir, `footprint-${theme}.png`) })
  // 窄窗口
  await page.setViewportSize({ width: 1080, height: 760 })
  await page.screenshot({ path: join(outDir, `footprint-${theme}-1080.png`) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: '学习足迹' }).click()
}

console.log('shots →', outDir)
await app.close()
rmSync(userData, { recursive: true, force: true })
