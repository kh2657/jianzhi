// 对打包产物做真实 GUI 冒烟（Windows: dist/win-unpacked/*.exe；macOS: dist/mac-arm64/*.app）：
// 启动 → 阅读与手写 → 翻页持久 → 无分类快速记录 → 零控制台错误
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const winExe = join(process.cwd(), 'dist/win-unpacked/数学学习工作台.exe')
const macBundle = join(process.cwd(), 'dist/mac-arm64/数学学习工作台.app')
const macApp = join(macBundle, 'Contents/MacOS/数学学习工作台')

// dist 里的构建副本一旦被系统注册，启动台/Apps 就会出现第二个「数学学习工作台」，
// 结束后立刻注销，日常使用只保留 /Applications 那份
function unregisterMacBundle() {
  if (process.platform !== 'darwin' || !existsSync(macBundle)) return
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  spawnSync(lsregister, ['-u', macBundle], { stdio: 'ignore' })
}
const appPath = existsSync(winExe) ? winExe : macApp
if (!existsSync(appPath)) throw new Error(`未找到打包产物：先 npm run dist:win 或 npm run dist（${winExe} / ${macApp} 均不存在）`)
const userData = mkdtempSync(join(tmpdir(), 'mathwb-packaged-gui-'))
const app = await electron.launch({ executablePath: appPath, args: [`--user-data-dir=${userData}`] })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

await new Promise((r) => setTimeout(r, 2500))
const url = page.url()
if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error(`渲染页面不是本地服务：${url}`)

const imp = await page.evaluate((p) => window.api.docImport([p]), join(process.cwd(), 'fixtures/text-basic.pdf'))
if (!imp[0].ok) throw new Error(`导入失败：${imp[0].error}`)
await page.reload()
// 首屏进笔记（2026-10-09 起）：先切到文献再打开条目；文献库不再是启动落点
await page.locator('.workspace-primary [aria-label="资料"]').click()
await page.locator('.workspace-tabs [aria-label="文献"]').click()
await page.locator('.doc-item').first().click()
const seq = await page
  .waitForFunction(() => Number(document.querySelector('.page-wrap')?.getAttribute('data-render-seq') ?? 0) >= 1, null, { timeout: 20000 })
  .then(() => 'rendered')
  .catch(() => 'TIMEOUT')

// 批注：画一条红笔，验证墨迹像素与翻页持久
let inkDrawn = false
let inkPersists = false
if (seq === 'rendered') {
  await page.locator('.seg-btn', { hasText: '手写' }).click()
  await page.locator('.swatch[aria-label="笔颜色 #d54941"]').click()
  const c = await page.locator('.page-wrap[data-page-index="0"] .page-canvas').boundingBox()
  await page.mouse.move(c.x + 100, c.y + 400)
  await page.mouse.down()
  await page.mouse.move(c.x + 400, c.y + 420, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(900) // 防抖落库
  const hasRed = () =>
    page.evaluate(() => {
      const ink = document.querySelector('.page-wrap[data-page-index="0"] .ink-canvas')
      const ctx = ink.getContext('2d')
      const k = ink.width / ink.clientWidth
      const d = ctx.getImageData(250 * k - 8 * k, 410 * k - 8 * k, 16 * k, 16 * k).data
      for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i] - d[i + 1] > 60 && d[i] - d[i + 2] > 60) return true
      return false
    })
  inkDrawn = await hasRed()
  await page.locator('.page-input').fill('2')
  await page.locator('.page-input').press('Enter')
  await page.locator('.page-input').fill('1')
  await page.locator('.page-input').press('Enter')
  // 对照态下面面更窄，翻页往返后第 1 页按需渲染需要重新挂载：等 ink-canvas 回到 DOM 再查墨迹
  await page.waitForFunction(() => document.querySelector('.page-wrap[data-page-index="0"] .ink-canvas'), null, { timeout: 15000 })
  await page.waitForTimeout(400)
  inkPersists = await hasRed()
}

let quickNoteSaved = false
if (seq === 'rendered') {
  await page.locator('.reader-toolbar .seg-btn', { hasText: '阅读' }).click()
  await page.getByLabel('随手记内容').fill('打包版：直接记录，不先选择分类。')
  await page.getByRole('button', { name: '记下来', exact: true }).click()
  await page.locator('.mnp-item', { hasText: '打包版：直接记录' }).waitFor({ state: 'visible' })
  const notes = await page.evaluate(id => window.api.notesForDocument(id), imp[0].documentId)
  quickNoteSaved = notes.some(note => note.noteType === 'note' && note.bodyMd === '打包版：直接记录，不先选择分类。' && note.anchors[0]?.pageIndex === 0)
}

await app.close()
unregisterMacBundle()
const ok = seq === 'rendered' && inkDrawn && inkPersists && quickNoteSaved && errors.length === 0
console.log(JSON.stringify({ ok, url, render: seq, inkDrawn, inkPersists, quickNoteSaved, consoleErrors: errors.slice(0, 3) }, null, 1))
process.exit(ok ? 0 : 1)
