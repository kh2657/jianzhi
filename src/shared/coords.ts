// PDF 锚点坐标契约（计划 §3）：
// - 持久化矩形一律为 PDF 用户空间 [xMin, yMin, xMax, yMax]（原页面单位，未应用显示旋转，
//   不假定 CropBox 左下角为 (0,0)，不手工乘 UserUnit）。
// - 屏幕(页面容器内 CSS 像素)与 PDF 坐标之间只通过 PDF.js viewport 的正逆变换转换，
//   缩放/旋转/CropBox/Retina 由 viewport 统一处理，不在此重复实现。

export type PdfRect = [number, number, number, number]

/** PDF.js PageViewport 的最小结构接口，便于在纯 Node 测试中替代 */
export interface ViewportLike {
  convertToPdfPoint(x: number, y: number): number[]
  convertToViewportPoint(x: number, y: number): number[]
}

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): PdfRect {
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
}

/**
 * 页面容器内 CSS 像素矩形 → PDF 用户空间矩形。
 * left/top/right/bottom 是相对页面容器（canvas 与文字层共同原点）的坐标。
 */
export function cssToPdfRect(
  left: number,
  top: number,
  right: number,
  bottom: number,
  viewport: ViewportLike
): PdfRect {
  const p1 = viewport.convertToPdfPoint(left, top)
  const p2 = viewport.convertToPdfPoint(right, bottom)
  return normalizeRect(p1[0], p1[1], p2[0], p2[1])
}

/**
 * PDF 用户空间矩形 → 页面容器内 CSS 像素盒子（用于回显高亮）。
 * PDF.js v6 起不再提供 convertToViewportRectangle；对 90° 倍数旋转，
 * 对两个对角点分别 convertToViewportPoint 再规范化是等价实现。
 */
export function pdfRectToCssBox(rect: PdfRect, viewport: ViewportLike): {
  left: number
  top: number
  width: number
  height: number
} {
  const p1 = viewport.convertToViewportPoint(rect[0], rect[1])
  const p2 = viewport.convertToViewportPoint(rect[2], rect[3])
  const [x1, y1, x2, y2] = normalizeRect(p1[0], p1[1], p2[0], p2[1])
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
}

export interface ClientRectLike {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 文字选区的 getClientRects() → PDF 矩形数组（每行一个矩形）。
 * origin 为页面容器(getBoundingClientRect)的 left/top，用于把视口坐标换算到容器坐标。
 */
export function clientRectsToPdfRects(
  rects: ClientRectLike[],
  origin: { left: number; top: number },
  viewport: ViewportLike
): PdfRect[] {
  const out: PdfRect[] = []
  for (const r of rects) {
    if (r.right - r.left < 0.5 || r.bottom - r.top < 0.5) continue
    out.push(
      cssToPdfRect(r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top, viewport)
    )
  }
  return out
}

/** 往返校验：PDF 矩形 → 视口 → PDF 是否还原（用于单元测试与自检） */
export function pdfRectRoundtrip(rect: PdfRect, viewport: ViewportLike): PdfRect {
  const box = pdfRectToCssBox(rect, viewport)
  return cssToPdfRect(box.left, box.top, box.left + box.width, box.top + box.height, viewport)
}

/** 点到线段的最短距离（与坐标系无关，ReaderView 橡皮笔画命中用） */
export function pointSegmentDist(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const apx = p[0] - a[0]
  const apy = p[1] - a[1]
  const len2 = abx * abx + aby * aby
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2))
  return Math.hypot(apx - t * abx, apy - t * aby)
}
