import { describe, expect, it } from 'vitest'
import { cssToPdfRect, normalizeRect, pdfRectRoundtrip, pdfRectToCssBox, clientRectsToPdfRects, pointSegmentDist } from '@shared/coords'

// 直接构造 PDF.js PageViewport，覆盖旋转 / 裁切偏移 / 缩放 / UserUnit 的纯数学契约。
// 若导出不可用则跳过手工构造部分（真实文档驱动的等价覆盖见 pdf-fixtures.spec.ts）。
type VP = import('pdfjs-dist').PageViewport

async function makeViewport(opts: Record<string, unknown>): Promise<VP | null> {
  // Node 环境用 legacy 构建（主构建的 PageViewport 依赖 DOMMatrix）
  const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    PageViewport?: new (o: unknown) => VP
  }
  if (!mod.PageViewport) return null
  return new mod.PageViewport({ dontFlip: false, ...opts })
}

const CLOSE = 1e-6

describe('坐标契约（计划 §3）', () => {
  it('normalizeRect 端点规范化', () => {
    expect(normalizeRect(5, 8, 1, 3)).toEqual([1, 3, 5, 8])
  })

  it('clientRects → PDF 矩形：容器原点换算', () => {
    const vp = {
      convertToPdfPoint: (x: number, y: number) => [x, 792 - y] as number[],
      convertToViewportPoint: (x: number, y: number) => [x, 792 - y] as number[],
      convertToViewportRectangle: (r: number[]) => [r[0], 792 - r[3], r[2], 792 - r[1]] as number[]
    }
    const rects = clientRectsToPdfRects(
      [
        { left: 100, top: 200, right: 300, bottom: 216 },
        { left: 100, top: 220, right: 180, bottom: 236 }
      ],
      { left: 40, top: 60 },
      vp
    )
    expect(rects).toEqual([
      [60, 792 - 156, 260, 792 - 140],
      [60, 792 - 176, 140, 792 - 160]
    ])
  })

  const CASES: Array<{ name: string; opts: Record<string, unknown>; manual?: (x: number, y: number) => [number, number] }> = [
    {
      name: '旋转 0 / 缩放 1.5 / 标准 A4',
      opts: { viewBox: [0, 0, 612, 792], userUnit: 1, scale: 1.5, rotation: 0 },
      manual: (x, y) => [x * 1.5, (792 - y) * 1.5]
    },
    {
      name: '旋转 0 / 裁切偏移 CropBox [54,72,558,720] / 缩放 0.8',
      opts: { viewBox: [54, 72, 558, 720], userUnit: 1, scale: 0.8, rotation: 0 },
      manual: (x, y) => [(x - 54) * 0.8, (648 - (y - 72)) * 0.8]
    },
    { name: '旋转 90 / 缩放 1.33', opts: { viewBox: [0, 0, 612, 792], userUnit: 1, scale: 1.33, rotation: 90 } },
    { name: '旋转 180 / 缩放 2', opts: { viewBox: [0, 0, 612, 792], userUnit: 1, scale: 2, rotation: 180 } },
    { name: '旋转 270 / 缩放 1', opts: { viewBox: [0, 0, 612, 792], userUnit: 1, scale: 1, rotation: 270 } },
    {
      name: 'UserUnit 2（viewport 参数层面）',
      opts: { viewBox: [0, 0, 612, 792], scale: 1, rotation: 0, userUnit: 2 }
    }
  ]

  for (const c of CASES) {
    it(`往返 + 独立公式：${c.name}`, async () => {
      const vp = await makeViewport(c.opts)
      if (!vp) {
        console.warn('[coords] PageViewport 未导出，跳过手工构造用例（由 pdf-fixtures.spec.ts 真实文档覆盖）')
        return
      }
      const rect = [72, 310, 520, 440] as [number, number, number, number]
      const box = pdfRectToCssBox(rect, vp)
      if (c.manual) {
        const [ex0, ey0] = c.manual(rect[0], rect[3])
        const [ex1, ey1] = c.manual(rect[2], rect[1])
        expect(Math.abs(box.left - ex0)).toBeLessThan(CLOSE)
        expect(Math.abs(box.top - ey0)).toBeLessThan(CLOSE)
        expect(Math.abs(box.width - (ex1 - ex0))).toBeLessThan(CLOSE)
        expect(Math.abs(box.height - (ey1 - ey0))).toBeLessThan(CLOSE)
      }
      const back = pdfRectRoundtrip(rect, vp)
      for (let i = 0; i < 4; i++) expect(Math.abs(back[i] - rect[i])).toBeLessThan(CLOSE)
      // css → pdf 也应与原矩形一致
      const viaCss = cssToPdfRect(box.left, box.top, box.left + box.width, box.top + box.height, vp)
      for (let i = 0; i < 4; i++) expect(Math.abs(viaCss[i] - rect[i])).toBeLessThan(CLOSE)
    })
  }
})

// 橡皮「点到线段」命中（回归：曾把 y 分量误写成 x 分量拷贝，横线附近的笔画全被误擦）
describe('pointSegmentDist（橡皮笔画命中）', () => {
  const CLOSE = 1e-6

  it('垂足在线段内：取垂直距离', () => {
    const d = pointSegmentDist([2, 5], [0, 0], [4, 0])
    expect(Math.abs(d - 5)).toBeLessThan(CLOSE)
  })

  it('垂足在端点外：取端点距离', () => {
    const d = pointSegmentDist([6, 0], [0, 0], [4, 0])
    expect(Math.abs(d - 2)).toBeLessThan(CLOSE)
  })

  it('回归：水平线上方远点不得因 x 分量凑巧而误判为 0 距离', () => {
    // 橡皮点 (150,382)，蓝笔画段 (150,292)→(350,287)：真实距离 ≈ 90，绝不能算成 0
    const d = pointSegmentDist([150, 382], [150, 292], [350, 287])
    expect(d).toBeGreaterThan(80)
    // 橡皮点 (150,382)，黄色荧光笔中间段 (145,489)→(170,488)：真实距离 ≈ 107
    const d2 = pointSegmentDist([150, 382], [145, 489], [170, 488.25])
    expect(d2).toBeGreaterThan(100)
  })

  it('零长度线段（单击成点）退化为点距', () => {
    const d = pointSegmentDist([3, 4], [0, 0], [0, 0])
    expect(Math.abs(d - 5)).toBeLessThan(CLOSE)
  })
})
