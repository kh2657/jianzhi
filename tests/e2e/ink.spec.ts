import { expect, test } from '@playwright/test'
import { navigateTo, fixture, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 批注墨迹全流程：画笔/荧光笔 → 像素级验证 → 翻页往返 → 重载 → 重启持久化 → 撤销/橡皮/清空。
// 像素断言独立于应用状态（直接采样 ink-canvas 位图），不依赖实现细节。

// 连续滚动模式下多页同时挂载：所有画布/墨迹采样都按 data-page-index 定位到第 1 页
const P1_CANVAS = '.page-wrap[data-page-index="0"] .page-canvas'
const P1_INK = '.page-wrap[data-page-index="0"] .ink-canvas'

test('批注墨迹：绘制、持久化、撤销、橡皮', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-ink-'))
  const app = await launchApp(userData)
  let app2: LaunchedApp | null = null
  const errors: string[] = []
  try {
    const { page } = app
    page.on('pageerror', (e) => errors.push(e.message))

    const imp = await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('text-basic.pdf')
    )
    expect(imp[0].ok).toBe(true)
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    // 切到批注模式，选红色笔
    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await expect(page.locator('.ann-toolbar')).toBeVisible()
    await page.locator('.swatch[aria-label="笔颜色 #d54941"]').click()

    const drawAndSample = async (): Promise<void> => {
      const canvas = (await page.locator(P1_CANVAS).boundingBox())!
      // 红笔：从 (100, 400) 到 (400, 424)（canvas CSS 坐标）
      await page.mouse.move(canvas.x + 100, canvas.y + 400)
      await page.mouse.down()
      await page.mouse.move(canvas.x + 250, canvas.y + 412, { steps: 10 })
      await page.mouse.move(canvas.x + 400, canvas.y + 424, { steps: 10 })
      await page.mouse.up()
      await expect
        .poll(() => page.evaluate(() => document.querySelectorAll('.ann-toolbar')[0]?.textContent?.includes('1 笔') ?? false))
        .toBe(true)
    }
    await drawAndSample()

    // 中点附近应有红色像素（采样窗口 ±8 CSS px）
    const hasRed = () =>
      page.evaluate(() => {
        const c = document.querySelector('.page-wrap[data-page-index="0"] .ink-canvas') as HTMLCanvasElement
        const ctx = c.getContext('2d')!
        const k = c.width / c.clientWidth
        const cx = 250 * k
        const cy = 412 * k
        const d = ctx.getImageData(cx - 8 * k, cy - 8 * k, 16 * k, 16 * k).data
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 140 && d[i] - d[i + 1] > 60 && d[i] - d[i + 2] > 60) return true
        }
        return false
      })
    await expect.poll(hasRed).toBe(true)

    // 荧光笔黄线（multiply 混合后 ≈ r255 g241 b173）
    await page.locator('.swatch[aria-label="荧光笔 #ffd400"]').click()
    const canvas2 = (await page.locator(P1_CANVAS).boundingBox())!
    await page.mouse.move(canvas2.x + 120, canvas2.y + 300)
    await page.mouse.down()
    await page.mouse.move(canvas2.x + 320, canvas2.y + 306, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.ann-toolbar')?.textContent?.includes('2 笔') ?? false))
      .toBe(true)
    const hasYellow = () =>
      page.evaluate(() => {
        const c = document.querySelector('.page-wrap[data-page-index="0"] .ink-canvas') as HTMLCanvasElement
        const ctx = c.getContext('2d')!
        const k = c.width / c.clientWidth
        const d = ctx.getImageData(200 * k - 8 * k, 303 * k - 6 * k, 16 * k, 12 * k).data
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 200 && d[i + 1] > 140 && d[i + 2] < 120) return true
        }
        return false
      })
    await expect.poll(hasYellow).toBe(true)

    // 等防抖落库，翻页再回来 → 连续模式下页 1 常驻、页 2 被渲染
    await page.waitForTimeout(900)
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="1"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)
    await expect(page.getByLabel('页码')).toHaveValue('2')
    await page.locator('.page-input').fill('1')
    await page.locator('.page-input').press('Enter')
    await expect(page.getByLabel('页码')).toHaveValue('1')
    await expect.poll(hasRed).toBe(true)
    await expect.poll(hasYellow).toBe(true)

    // 整页 reload 后仍在（启动恢复直接回到上次材料）
    await page.reload()
    await expect(page.locator('[data-page-index="0"]').locator('.page-canvas')).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)
    await expect.poll(hasRed).toBe(true)

    // 应用重启后仍在
    await app.app.close()
    app2 = await launchApp(userData)
    const page2 = app2.page
    page2.on('pageerror', (e) => errors.push(e.message))
    // 启动直接恢复上次材料。
    await expect(page2.locator('[data-page-index="0"]').locator('.page-canvas')).toBeVisible()
    await expect
      .poll(() => page2.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)
    const hasRed2 = async () =>
      page2.evaluate(() => {
        const c = document.querySelector('.page-wrap[data-page-index="0"] .ink-canvas') as HTMLCanvasElement
        if (!c) return false
        const ctx = c.getContext('2d')!
        const k = c.width / c.clientWidth
        const d = ctx.getImageData(250 * k - 8 * k, 412 * k - 8 * k, 16 * k, 16 * k).data
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 140 && d[i] - d[i + 1] > 60 && d[i] - d[i + 2] > 60) return true
        }
        return false
      })
    await expect.poll(hasRed2).toBe(true)

    // 撤销：undo 两次 → 荧光笔与红笔依次消失
    await page2.locator('.seg-btn', { hasText: '手写' }).click()
    // 重启后撤销栈为空（内存态），改用橡皮验证删除语义：红笔A + 新画蓝笔B，擦A留B
    await page2.locator('.swatch[aria-label="笔颜色 #2456b3"]').click()
    const c3 = (await page2.locator(P1_CANVAS).boundingBox())!
    await page2.mouse.move(c3.x + 150, c3.y + 500)
    await page2.mouse.down()
    await page2.mouse.move(c3.x + 350, c3.y + 505, { steps: 8 })
    await page2.mouse.up()
    await expect
      .poll(() => page2.evaluate(() => document.querySelector('.ann-toolbar')?.textContent?.includes('3 笔') ?? false))
      .toBe(true)

    // 橡皮擦掉红色线（沿线多点擦除）
    const eraserBtn = page2.locator('.ann-toolbar button', { hasText: '橡皮' })
    await eraserBtn.click()
    await expect(eraserBtn).toHaveClass(/btn-selected/)
    for (const dx of [150, 250, 350]) {
      await page2.mouse.click(c3.x + dx, c3.y + (406 + (dx - 100) * 0.08))
    }
    const hasBlue = () =>
      page2.evaluate(() => {
        const c = document.querySelector('.page-wrap[data-page-index="0"] .ink-canvas') as HTMLCanvasElement
        const ctx = c.getContext('2d')!
        const k = c.width / c.clientWidth
        const d = ctx.getImageData(250 * k - 8 * k, 502 * k - 8 * k, 16 * k, 16 * k).data
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 2] > 140 && d[i + 2] - d[i] > 40) return true
        }
        return false
      })
    await expect.poll(hasBlue).toBe(true)
    await expect.poll(hasRed2).toBe(false) // 红线被擦除

    // 清空本页（破坏性操作，有二次确认；Playwright 默认会「取消」对话框，这里显式接受）
    page2.on('dialog', (d) => void d.accept())
    await page2.locator('button', { hasText: '清空本页' }).click()
    await expect
      .poll(() => page2.evaluate(() => document.querySelector('.ann-toolbar')?.textContent?.includes('0 笔') ?? false))
      .toBe(true)
    await expect.poll(hasBlue).toBe(false)

    expect(errors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    await app2?.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

// 回归：墨迹冲刷曾在「防抖还没触发」时一个字节都不写，却报告成功。
// 500ms 防抖每落一笔都会重置计时器，所以连续书写时从来不存在「正在保存」的中间态——
// 旧实现只保存那个中间态，于是落笔后立刻离开（切视图/关窗）会静默丢笔画。
test('落笔后立刻离开：未过防抖的笔画也不丢', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-inkflush-'))
  const app = await launchApp(userData)
  const errors: string[] = []
  try {
    const { page } = app
    page.on('pageerror', (e) => errors.push(e.message))

    const imp = await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('text-basic.pdf')
    )
    expect(imp[0].ok).toBe(true)
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await page.locator('.swatch[aria-label="笔颜色 #d54941"]').click()

    // 连续落三笔（每笔都重置 500ms 防抖），然后**不等**防抖立刻离开阅读器
    const canvas = (await page.locator(P1_CANVAS).boundingBox())!
    for (let i = 0; i < 3; i++) {
      const y = 300 + i * 60
      await page.mouse.move(canvas.x + 100, canvas.y + y)
      await page.mouse.down()
      await page.mouse.move(canvas.x + 400, canvas.y + y, { steps: 6 })
      await page.mouse.up()
    }
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.ann-toolbar')?.textContent?.includes('3 笔') ?? false))
      .toBe(true)

    // 立刻切走（触发冲刷）——此时防抖尚未到点
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    // 三笔都在（重进阅读器是阅读模式，要先切回手写才看得到批注工具条）
    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.ann-toolbar')?.textContent?.includes('3 笔') ?? false))
      .toBe(true)
    expect(errors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

// 回归：「清空本页」是破坏性最强的一步，却既无确认也无危险色；
// 撤销栈又随虚拟化卸载清空，连续模式下「清空 → 滚走 → 滚回」就永久丢失。
test('清空本页：有二次确认，且撤销能跨虚拟化卸载', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-inkclear-'))
  const app = await launchApp(userData)
  const errors: string[] = []
  try {
    const { page } = app
    page.on('pageerror', (e) => errors.push(e.message))

    const imp = await page.evaluate(
      (p) => (window as unknown as { api: import('../../src/shared/api').MathApi }).api.docImport([p]),
      fixture('text-basic.pdf')
    )
    expect(imp[0].ok).toBe(true)
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item', { hasText: 'text-basic' }).click()
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await page.locator('.swatch[aria-label="笔颜色 #d54941"]').click()
    const canvas = (await page.locator(P1_CANVAS).boundingBox())!
    await page.mouse.move(canvas.x + 100, canvas.y + 400)
    await page.mouse.down()
    await page.mouse.move(canvas.x + 400, canvas.y + 400, { steps: 8 })
    await page.mouse.up()
    const countText = () => page.evaluate(() => document.querySelector('.ann-toolbar')?.textContent ?? '')
    await expect.poll(async () => (await countText()).includes('1 笔')).toBe(true)

    // 取消确认 → 不清空
    page.once('dialog', (d) => void d.dismiss())
    await page.locator('button', { hasText: '清空本页' }).click()
    await expect.poll(async () => (await countText()).includes('1 笔')).toBe(true)

    // 确认 → 清空
    page.once('dialog', (d) => void d.accept())
    await page.locator('button', { hasText: '清空本页' }).click()
    await expect.poll(async () => (await countText()).includes('0 笔')).toBe(true)

    // 滚走（第 3 页）再滚回第 1 页：第 1 页被虚拟化卸载又重挂载
    await page.locator('.page-input').fill('3')
    await page.locator('.page-input').press('Enter')
    await expect(page.getByLabel('页码')).toHaveValue('3')
    await page.locator('.page-input').fill('1')
    await page.locator('.page-input').press('Enter')
    await expect(page.getByLabel('页码')).toHaveValue('1')
    await expect
      .poll(() => page.evaluate(() => Number(document.querySelector('[data-page-index="0"]')?.getAttribute('data-render-seq') ?? 0)))
      .toBeGreaterThanOrEqual(1)

    // 撤销仍能把清空前的笔画找回来
    await page.locator('.seg-btn', { hasText: '手写' }).click()
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await countText()).includes('1 笔')).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
