import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cssToPdfRect, pdfRectRoundtrip, pdfRectToCssBox } from '@shared/coords'

// 用真实夹具 PDF（node 环境的 legacy 构建，无 worker）验证：
// 页数 / page.view / page.rotate / 文本层有无，以及在真实 viewport 上的坐标往返。
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

interface ManifestFixture {
  file: string
  pages: number
  pageView: number[]
  rotate: number
  hasText: boolean
}

// describe 体在收集期执行，manifest 必须同步就绪
const manifest: { targetRect: [number, number, number, number]; fixtures: Record<string, ManifestFixture> } =
  JSON.parse(readFileSync(join('fixtures', 'manifest.json'), 'utf8'))

async function load(fixture: ManifestFixture): Promise<{ doc: Awaited<ReturnType<(typeof pdfjs)['getDocument']>['promise']>; destroy(): Promise<void> }> {
  const data = new Uint8Array(readFileSync(join('fixtures', fixture.file)))
  const task = pdfjs.getDocument({ data, useSystemFonts: false })
  const doc = await task.promise
  return { doc, destroy: () => task.destroy() }
}

describe('PDF 夹具（文本/扫描/旋转/裁切）', () => {
  for (const [name, fixture] of Object.entries(manifest.fixtures) as Array<[string, ManifestFixture]>) {
    it(`${name}：页数 / page.view / rotate`, async () => {
      const { doc, destroy } = await load(fixture)
      expect(doc.numPages).toBe(fixture.pages)
      const page = await doc.getPage(1)
      expect([...page.view]).toEqual(fixture.pageView)
      expect(page.rotate).toBe(fixture.rotate)
      await destroy()
    })

    it(`${name}：真实 viewport 上的矩形往返（多缩放/旋转组合）`, async () => {
      const { doc, destroy } = await load(fixture)
      const page = await doc.getPage(1)
      const target = manifest.targetRect
      for (const [scale, extraRot] of [
        [1, 0],
        [1.33, 0],
        [0.75, 0],
        [1, 90],
        [1, 180],
        [1, 270],
        [1.5, 270]
      ] as Array<[number, number]>) {
        const viewport = page.getViewport({ scale, rotation: (fixture.rotate + extraRot) % 360 })
        const back = pdfRectRoundtrip(target, viewport)
        for (let i = 0; i < 4; i++) {
          expect(Math.abs(back[i] - target[i]), `${name} scale=${scale} rot=${extraRot} dim=${i}`).toBeLessThan(1e-6)
        }
      }
      await destroy()
    })

    it(`${name}：旋转 0 时与独立换算公式一致（含裁切偏移）`, async () => {
      const { doc, destroy } = await load(fixture)
      const page = await doc.getPage(1)
      const viewport = page.getViewport({ scale: 1.25, rotation: fixture.rotate })
      if (fixture.rotate !== 0) {
        await destroy()
        return
      }
      const [vx0, vy0, vx1, vy1] = page.view
      const s = 1.25
      const target = manifest.targetRect
      const box = pdfRectToCssBox(target, viewport)
      const expectLeft = (target[0] - vx0) * s
      const expectTop = (vy1 - target[3]) * s
      expect(Math.abs(box.left - expectLeft)).toBeLessThan(1e-6)
      expect(Math.abs(box.top - expectTop)).toBeLessThan(1e-6)
      expect(Math.abs(box.width - (target[2] - target[0]) * s)).toBeLessThan(1e-6)
      const viaCss = cssToPdfRect(box.left, box.top, box.left + box.width, box.top + box.height, viewport)
      for (let i = 0; i < 4; i++) expect(Math.abs(viaCss[i] - target[i])).toBeLessThan(1e-6)
      await destroy()
    })

    it(`${name}：文本层 ${fixture.hasText ? '存在' : '不存在'}`, async () => {
      const { doc, destroy } = await load(fixture)
      const page = await doc.getPage(1)
      const tc = await page.getTextContent()
      const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ')
      if (fixture.hasText) expect(text).toContain('THEOREM')
      else expect(text.trim()).toBe('')
      await destroy()
    })
  }

  it('文本夹具的指纹稳定可获取', async () => {
    const { doc, destroy } = await load(manifest.fixtures['text-basic'])
    const fp = doc.fingerprints?.[0]
    expect(typeof fp).toBe('string')
    expect(fp!.length).toBeGreaterThan(8)
    await destroy()
  })
})
