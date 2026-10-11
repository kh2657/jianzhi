import { expect, test } from '@playwright/test'
import { navigateTo, fixture, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 第一阶段交付的核心判据（执行指令 §第一阶段的明确交付）：
// 导入 PDF → 框选 → 建笔记 → 编辑（含公式）→ 导入照片并关联 → 关闭重启 → 搜索找到 → 点击来源回到原文区域。

let userData: string
let app1: LaunchedApp
let noteId = ''

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-vertical-'))
  app1 = await launchApp(userData)
})

test.afterAll(async () => {
  await app1?.app.close().catch(() => undefined)
  rmTempDir(userData)
})

test('纵向流程：导入 → 框选 → 笔记 → 公式 → 照片关联', async () => {
  const { page } = app1
  app1.setPhase('import')

  // 1. 导入 PDF（与 UI 按钮走同一 IPC 通道；对话框本身无法自动化）
  const importResult = await page.evaluate(
    (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
    fixture('text-basic.pdf')
  )
  expect(importResult[0].ok).toBe(true)
  expect(importResult[0].duplicate).toBe(false)

  await page.reload()
  await navigateTo(page, '文献')
  await page.locator('.doc-item', { hasText: 'text-basic' }).first().click()

  // 2. 页面渲染完成
  await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
    .toBeGreaterThanOrEqual(1)

  // 3. 框选已知区域 [72,310,520,440]（scale=canvas宽度/612，rotation 0）
  await page.locator('.seg-btn', { hasText: '摘录' }).click()
  const canvas = (await page.locator('.page-wrap[data-page-index="0"] .page-canvas').boundingBox())!
  expect(canvas).toBeTruthy()
  const s = canvas.width / 612
  await page.mouse.move(canvas.x + 72 * s, canvas.y + (792 - 440) * s)
  await page.mouse.down()
  await page.mouse.move(canvas.x + 520 * s, canvas.y + (792 - 310) * s, { steps: 5 })
  await page.mouse.up()

  await expect(page.locator('.sel-popover')).toBeVisible()
  await page.locator('.sel-body').fill('中值定理：f(b)-f(a)=f(c)(b-a)。先记下原文，回头补证明。')
  await page.getByRole('button', { name: '记在这里' }).click()
  await expect(page.locator('.toast', { hasText: '已记在这里' })).toBeVisible()

  // 4. 存储层里的锚点矩形 ≈ 已知区域（±2 PDF 单位），页码 0 起
  const stored = await page.evaluate(async () => {
    const api = (window as unknown as { api: import('../../src/shared/api').MathApi }).api
    const notes = await api.noteList()
    const full = await api.noteGet(notes[0].id)
    return {
      noteId: notes[0].id,
      title: full.note.title,
      bodyMd: full.note.bodyMd,
      rects: full.anchors[0].rects,
      pageIndex: full.anchors[0].pageIndex,
      documentTitle: full.anchors[0].documentTitle
    }
  })
  expect(stored.bodyMd).toContain('中值定理')
  expect(stored.pageIndex).toBe(0)
  const expected = [72, 310, 520, 440]
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(stored.rects[0][i] - expected[i]), `rect[${i}]`).toBeLessThan(2)
  }
  noteId = stored.noteId

  // 5. 打开笔记编辑：正文 + 公式 + 自动保存
  app1.setPhase('note-edit')
  await navigateTo(page, '笔记')
  // 2026-10-09 分流：读文献时记的笔记默认收在文献上下文——先打开「含文献笔记」再进列表
  await page.getByRole('button', { name: '含文献笔记' }).click()
  await page.locator('.note-item', { hasText: '第 1 页摘录' }).click()
  await page.locator('.note-textarea').fill(
    "中值定理证明尝试：设 $g(x)=f(x)-\\eta(x)$，其中 $\\eta$ 为线性插值。\n\n$$\\int_a^b f'(t)\\,dt = f(b)-f(a)$$"
  )
  await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.note-preview .katex').first()).toBeVisible()
  await expect(page.locator('.note-preview .katex-display').first()).toBeVisible()

  // 6. 导入演草纸照片并关联笔记。夹具按平台选择：macOS 用 photo.heic 验证 sips 派生路线；
  //    其他平台该夹具不存在（gen-fixtures 仅 macOS 生成），改用 photo.png 验证原生显示路线。
  app1.setPhase('photo')
  const photoName = process.platform === 'darwin' ? 'photo.heic' : 'photo.png'
  const capImport = await page.evaluate(
    (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.captureImport([p]),
    fixture(photoName)
  )
  expect(capImport[0].ok).toBe(true)

  // 照片的展示位 = 文献库「待整理」（收件箱已删）：点左栏待整理分区，卡片可见且缩略图可解码
  await navigateTo(page, '文献')
  await page.locator('.section-node', { hasText: '待整理' }).first().click()
  const card = page.locator('.inbox-card').first()
  await expect(card).toBeVisible()
  // HEIC → sips JPEG 派生 / PNG 原生——两条路线缩略图都必须真实可解码
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('.inbox-card img') as HTMLImageElement)?.naturalWidth ?? 0))
    .toBeGreaterThan(0)

  await card.getByRole('button', { name: '关联笔记…' }).click()
  await page.locator('.picker-item', { hasText: '第 1 页摘录' }).click()
  await expect(page.locator('.toast', { hasText: '已关联并归档' })).toBeVisible()
  // 归档后照片离开「待整理」展示位（文件与侧车原样保留在收件箱目录，仅状态变 filed）
  await expect(page.locator('.inbox-card')).toHaveCount(0)
  expect(noteId).not.toBe('')
})

test('重启后：搜索找到笔记，点击来源回到原文区域（±3px）', async () => {
  // 关闭应用（会经历「冲刷保存→退出」路径），再以同一 userData 启动
  await app1.app.close()

  const app2 = await launchApp(userData)
  const { page } = app2
  app2.setPhase('restart-search')

  // 搜索（中文 5 字 → FTS trigram）
  await navigateTo(page, '笔记')
  await page.locator('.search-input').fill('中值定理')
  await expect(page.locator('.note-item', { hasText: '第 1 页摘录' })).toBeVisible()

  // 打开笔记：正文（公式）、照片附件、PDF 来源均在
  await page.locator('.note-item', { hasText: '第 1 页摘录' }).click()
  await expect(page.locator('.note-textarea')).toHaveValue(/证明尝试/)
  await expect(page.locator('.capture-thumb img').first()).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (document.querySelector('.capture-thumb img') as HTMLImageElement)?.naturalWidth ?? 0))
    .toBeGreaterThan(0)

  // 回原文（统一回源语义：按钮带页码）
  app2.setPhase('jump')
  await page.getByRole('button', { name: /回原文 · 第/ }).click()
  await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => Number(document.querySelector('.page-wrap[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
    .toBeGreaterThanOrEqual(1)

  // 页码正确（回到第 1 页，物理页索引 0）
  await expect(page.locator('.page-input')).toHaveValue('1')

  // 高亮区域几何与期望一致（独立公式重算，非读取应用自身状态）
  const flash = page.locator('.anchor-rect-flash').first()
  await expect(flash).toBeVisible()
  console.log('DBG:', await page.evaluate(() => JSON.stringify({
    dpr: window.devicePixelRatio,
    canvasAttr: (document.querySelector('.page-wrap[data-page-index="0"] .page-canvas') as HTMLCanvasElement)?.width,
    zoom: document.querySelector('.reader-toolbar')?.textContent?.match(/\d+%/)?.[0]
  })))
  const flashBox = (await flash.boundingBox())!
  const canvas = (await page.locator('.page-wrap[data-page-index="0"] .page-canvas').boundingBox())!
  const s2 = canvas.width / 612
  const expLeft = canvas.x + 72 * s2
  const expTop = canvas.y + (792 - 440) * s2
  const expW = (520 - 72) * s2
  const expH = (440 - 310) * s2
  console.log('DBG2:', JSON.stringify({
    flashBox, canvasBox: canvas, s2,
    exp: [expLeft, expTop, expW, expH],
    wrap: (await page.locator('.page-wrap[data-page-index="0"]').boundingBox())!
  }))
  expect(Math.abs(flashBox.x - expLeft)).toBeLessThan(3)
  expect(Math.abs(flashBox.y - expTop)).toBeLessThan(3)
  expect(Math.abs(flashBox.width - expW)).toBeLessThan(3)
  expect(Math.abs(flashBox.height - expH)).toBeLessThan(3)

  await app2.app.close()
})
