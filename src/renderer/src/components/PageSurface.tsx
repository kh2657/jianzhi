import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist'
import { clientRectsToPdfRects, cssToPdfRect, pdfRectToCssBox, normalizeRect, pointSegmentDist, type PdfRect } from '@shared/coords'
import type { InkStroke, PageAnchorView } from '@shared/types'

/**
 * 阅读器的单页画布：canvas 渲染 + 文字层（划选）+ 链接注释层 + 墨迹层 + 锚点层 + 摘录捕获。
 * 连续滚动模式下每页一个实例（仅可视区附近的实例挂载重资源），单页模式下只有一个实例。
 * 墨迹与锚点以「磁盘为真相」：失活/卸载前冲刷未保存笔画，重新激活时从磁盘重载。
 */

export type ReaderMode = 'read' | 'rect' | 'ann'
export type AnnTool = 'pen' | 'highlight' | 'eraser'

export interface PendingSelection {
  pageIndex: number
  rects: PdfRect[]
  quote: string
  x: number
  y: number
}

interface CssBox {
  left: number
  top: number
  width: number
  height: number
}

interface PageLink {
  box: CssBox
  kind: 'internal' | 'external'
  pageIndex?: number
  url?: string
}

/** 暴露给父级（工具栏撤销/清空、关闭前冲刷）的单页能力 */
export interface PageSurfaceApi {
  pageIndex: number
  undo(): void
  clearPage(): void
  flushPending(): Promise<void>
}

const MIN_SCALE = 0.4
const MAX_SCALE = 4

/**
 * 撤销栈按「版本 + 页」放在模块级，不随组件走。
 *
 * 连续滚动只挂载可视区 ±1 页，栈若留在组件里，「清空本页 → 往下滚两页 → 滚回来」
 * 就再也撤销不了——而清空是破坏性最强的一步（整页批注）。
 * 栈里的下标之所以在重挂载后仍然有效：卸载时会冲刷墨迹（flushInk），
 * 所以重新挂载读到的磁盘状态与记录操作时的状态一致。
 * 上限 50 页，超出丢最早进入的（撤销是就近操作，老页面的历史价值低）。
 */
const inkUndoStacks = new Map<string, UndoOp[]>()
const INK_UNDO_PAGE_LIMIT = 50

function inkUndoStack(key: string): UndoOp[] {
  let stack = inkUndoStacks.get(key)
  if (!stack) {
    stack = []
    inkUndoStacks.set(key, stack)
    if (inkUndoStacks.size > INK_UNDO_PAGE_LIMIT) {
      const oldest = inkUndoStacks.keys().next().value
      if (oldest !== undefined) inkUndoStacks.delete(oldest)
    }
  }
  return stack
}

const PEN_COLORS = ['#1d2129', '#d54941', '#2456b3', '#1f7a4d', '#8a3fc6']
const HL_COLORS = ['#ffd400', '#7cd992', '#6ec3ff']
const PEN_WIDTHS = [
  { label: '细', css: 2 },
  { label: '中', css: 3.5 },
  { label: '粗', css: 6 }
]
const HL_WIDTH_CSS = 14
const ERASER_RADIUS_CSS = 10
/** 采点最小间距（CSS 像素）——显著减小存储与平滑抖动 */
const POINT_MIN_DIST = 1.5

interface UndoOp {
  type: 'add' | 'remove' | 'clear'
  index?: number
  strokes?: InkStroke[]
}

export function PageSurface({
  versionId,
  pdf,
  pageIndex,
  scale,
  rotation,
  mode,
  tool,
  penColor,
  penWidth,
  hlColor,
  estSize,
  jumpFlashRects,
  anchorRefreshKey,
  registerFlusher,
  registerApi,
  onStatus,
  onAnchorCount,
  onPendingSelection,
  onLinkInternal,
  onLinkExternal,
  onRenderError
}: {
  /** 文档版本 ID（= 文件 sha256），锚点与墨迹存储的键 */
  versionId: string
  pdf: PDFDocumentProxy
  pageIndex: number
  scale: number
  rotation: number
  mode: ReaderMode
  tool: AnnTool
  penColor: string
  penWidth: number
  hlColor: string
  /** 预量页面尺寸（scale/rotation 换算后）：首帧即可占位，容器立即可滚 */
  estSize: { w: number; h: number }
  jumpFlashRects: PdfRect[] | null
  anchorRefreshKey: number
  registerFlusher: (fn: () => Promise<void>) => () => void
  registerApi: (pageIndex: number, api: PageSurfaceApi | null) => void
  onStatus: (pageIndex: number, status: { count: number; dirty: boolean; saving: boolean }) => void
  onAnchorCount: (pageIndex: number, count: number) => void
  onPendingSelection: (sel: PendingSelection | null) => void
  onLinkInternal: (targetPage: number) => void
  onLinkExternal: (url: string) => void
  onRenderError: (message: string) => void
}): React.ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inkCanvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<PageViewport | null>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)
  const [renderSeq, setRenderSeq] = useState(0)
  const [wrapSize, setWrapSize] = useState<{ w: number; h: number } | null>(null)
  const [pageAnchors, setPageAnchors] = useState<PageAnchorView[]>([])
  const [overlayBoxes, setOverlayBoxes] = useState<Array<{ id: string; boxes: CssBox[]; flash: boolean }>>([])
  const [linkBoxes, setLinkBoxes] = useState<PageLink[]>([])
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [dragCur, setDragCur] = useState<{ x: number; y: number } | null>(null)
  const [strokes, setStrokes] = useState<InkStroke[]>([])
  const [inkDirty, setInkDirty] = useState(false)
  const [annSaving, setAnnSaving] = useState(false)

  const liveStrokeRef = useRef<Array<{ x: number; y: number }> | null>(null)
  // 撤销栈不随组件走：连续滚动的虚拟化会随时卸载不可见页（见文件顶部 inkUndoStack）
  const undoStack = inkUndoStack(`${versionId}:${pageIndex}`)
  const strokesRef = useRef<InkStroke[]>([])
  strokesRef.current = strokes
  const inkDirtyRef = useRef(false)
  inkDirtyRef.current = inkDirty
  const erasingRef = useRef(false)
  const mouseDownRef = useRef<{ x: number; y: number } | null>(null)
  const destCacheRef = useRef(new Map<string, Promise<number | null>>())
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onAnchorCountRef = useRef(onAnchorCount)
  onAnchorCountRef.current = onAnchorCount

  const reportStatus = useCallback(
    (count: number, dirty: boolean, saving: boolean) => onStatusRef.current(pageIndex, { count, dirty, saving }),
    [pageIndex]
  )

  // ---------- 页面渲染（canvas + 文字层 + 链接 + 叠加层） ----------
  useEffect(() => {
    if (!wrapRef.current) return
    let cancelled = false
    ;(async () => {
      try {
        renderTaskRef.current?.cancel()
        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled) return
        const effectiveRotation = (((page.rotate + rotation) % 360) + 360) % 360
        const viewport = page.getViewport({ scale, rotation: effectiveRotation })
        const canvas = canvasRef.current
        if (!canvas) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('无法创建 canvas 上下文')
        const renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        })
        renderTaskRef.current = renderTask
        await renderTask.promise
        if (cancelled) return

        viewportRef.current = viewport
        setWrapSize({ w: Math.floor(viewport.width), h: Math.floor(viewport.height) })

        // 墨迹画布与页面同尺寸
        const ink = inkCanvasRef.current
        if (ink) {
          ink.width = Math.floor(viewport.width * dpr)
          ink.height = Math.floor(viewport.height * dpr)
          ink.style.width = `${Math.floor(viewport.width)}px`
          ink.style.height = `${Math.floor(viewport.height)}px`
        }

        // 文字层（文本型 PDF 才能划选摘录）
        const layer = textLayerRef.current
        if (layer) {
          layer.replaceChildren()
          const textContent = await page.getTextContent()
          if (cancelled) return
          const tl = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: layer,
            viewport
          })
          await tl.render()
          if (cancelled) return
        }

        // 链接注释层：参考文献/目录的内跳与外部 URL。只收集不拦截事件——
        // 点击命中在页面容器上做几何判定（见 onPageClick），划选文本完全不受影响。
        const links: PageLink[] = []
        try {
          const annots = (await page.getAnnotations()) as Array<{
            subtype: string
            rect: number[]
            url?: unknown
            unsafeUrl?: unknown
            dest?: unknown
            action?: unknown
          }>
          for (const a of annots) {
            if (a.subtype !== 'Link' || !Array.isArray(a.rect) || a.rect.length !== 4) continue
            const box = pdfRectToCssBox(normalizeRect(a.rect[0], a.rect[1], a.rect[2], a.rect[3]), viewport)
            if (box.width < 1 || box.height < 1) continue
            const url = typeof a.url === 'string' ? a.url : typeof a.unsafeUrl === 'string' ? a.unsafeUrl : null
            if (url && /^https?:\/\//i.test(url)) {
              links.push({ box, kind: 'external', url })
              continue
            }
            if (a.dest != null) {
              const target =
                typeof a.dest === 'string' ? await resolveNamedDest(pdf, a.dest, destCacheRef.current) : await destToPageIndex(pdf, a.dest)
              if (cancelled) return
              if (target !== null) links.push({ box, kind: 'internal', pageIndex: target })
              continue
            }
            const named = typeof a.action === 'string' ? namedActionPageIndex(a.action, pageIndex, pdf.numPages) : null
            if (named !== null) links.push({ box, kind: 'internal', pageIndex: named })
          }
        } catch {
          /* 注释读取失败不影响正文渲染 */
        }
        if (cancelled) return
        setLinkBoxes(links)
        setRenderSeq((s) => s + 1)
      } catch (err) {
        if (cancelled) return
        if (err instanceof pdfjs.RenderingCancelledException) return
        onRenderError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
    // pageAnchors/jumpFlashRects/strokes 变化只重算叠加层，不重渲染画布
  }, [pdf, pageIndex, scale, rotation, onRenderError])

  // ---------- 本页锚点列表 ----------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const got = await window.api.anchorListPage(versionId, pageIndex)
        if (!cancelled) {
          setPageAnchors(got)
          onAnchorCountRef.current(pageIndex, got.length)
        }
      } catch {
        /* 列表失败不阻塞阅读 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pdf, pageIndex, anchorRefreshKey])

  // ---------- 叠加层（锚点 + 跳转高亮） ----------
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const boxes: Array<{ id: string; boxes: CssBox[]; flash: boolean }> = pageAnchors.map((a) => ({
      id: a.id,
      boxes: a.rects.map((r) => pdfRectToCssBox(r, viewport)),
      flash: false
    }))
    if (jumpFlashRects) {
      boxes.push({ id: '__jump__', boxes: jumpFlashRects.map((r) => pdfRectToCssBox(r, viewport)), flash: true })
    }
    setOverlayBoxes(boxes)
  }, [pageAnchors, jumpFlashRects, renderSeq])

  // ---------- 批注墨迹：加载 / 保存 ----------
  useEffect(() => {
    let cancelled = false
    setStrokes([])
    ;(async () => {
      try {
        const got = await window.api.inkGet(versionId, pageIndex)
        if (!cancelled) setStrokes(got)
      } catch {
        /* 加载失败静默（无墨迹等价） */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pdf, pageIndex])

  const persistInk = useCallback(
    async (data: InkStroke[]) => {
      setAnnSaving(true)
      try {
        await window.api.inkSave(versionId, pageIndex, data)
        // 保存期间可能又落笔：只有内容没再变时才清脏标记
        if (strokesRef.current === data) {
          inkDirtyRef.current = false
          setInkDirty(false)
        }
      } catch {
        inkDirtyRef.current = true
        setInkDirty(true)
      } finally {
        setAnnSaving(false)
      }
    },
    [pdf, pageIndex]
  )

  /**
   * 冲刷未落盘的笔画。判据必须是 inkDirty，不能是「有没有正在保存的那一份」：
   * 500ms 防抖的依赖里含 strokes，每落一笔都会重置计时器，所以**连续书写时
   * 从来没有过「正在保存」的中间态**——按后者冲刷会在一个字节都没写的情况下
   * 报告成功，关窗即静默丢笔画。
   */
  const flushInk = useCallback(async (): Promise<void> => {
    if (!inkDirtyRef.current) return
    const data = strokesRef.current
    try {
      await window.api.inkSave(versionId, pageIndex, data)
      if (strokesRef.current === data) inkDirtyRef.current = false
    } catch (err) {
      // 保持脏标记，并让异常传到关窗握手（main 侧据此保留窗口而不是关掉）
      inkDirtyRef.current = true
      throw err instanceof Error ? err : new Error(String(err))
    }
  }, [versionId, pageIndex])

  // 笔画变化 → 500ms 防抖保存
  useEffect(() => {
    if (!inkDirty) return
    const t = setTimeout(() => void persistInk(strokesRef.current), 500)
    return () => clearTimeout(t)
  }, [strokes, inkDirty, persistInk])

  // 卸载时冲刷未保存的批注（连续模式的虚拟化会随时卸载不可见页）
  useEffect(() => () => { void flushInk().catch(() => undefined) }, [flushInk])

  useEffect(() => registerFlusher(flushInk), [registerFlusher, flushInk])

  // ---------- 墨迹绘制 ----------
  /** viewport 的等效缩放（CSS 像素 / PDF 单位），旋转安全 */
  const effScaleOf = (viewport: PageViewport): number => {
    const a = viewport.convertToViewportPoint(0, 0)
    const b = viewport.convertToViewportPoint(1, 0)
    return Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  }

  const redrawInk = useCallback(
    (withLive = false) => {
      const ink = inkCanvasRef.current
      const viewport = viewportRef.current
      if (!ink || !viewport) return
      const ctx = ink.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, ink.width, ink.height)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const drawStroke = (s: InkStroke) => {
        if (s.pts.length < 2) return
        ctx.beginPath()
        const first = viewport.convertToViewportPoint(s.pts[0][0], s.pts[0][1])
        ctx.moveTo(first[0], first[1])
        for (let i = 1; i < s.pts.length; i++) {
          const p = viewport.convertToViewportPoint(s.pts[i][0], s.pts[i][1])
          ctx.lineTo(p[0], p[1])
        }
        if (s.k === 'highlight') {
          // source-over + alpha：multiply 在透明叠加层上的合成行为不可预期（Chromium 实测偏淡 4 倍）
          ctx.globalAlpha = 0.35
          ctx.globalCompositeOperation = 'source-over'
          ctx.lineWidth = s.w
          ctx.strokeStyle = s.c
        } else {
          ctx.globalAlpha = 1
          ctx.globalCompositeOperation = 'source-over'
          ctx.lineWidth = s.w
          ctx.strokeStyle = s.c
        }
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      }
      for (const s of strokesRef.current) drawStroke(s)
      // 正在画的实时笔画（CSS 空间点，直接绘制）
      const live = liveStrokeRef.current
      if (withLive && live && live.length >= 2) {
        ctx.beginPath()
        ctx.moveTo(live[0].x, live[0].y)
        for (let i = 1; i < live.length; i++) ctx.lineTo(live[i].x, live[i].y)
        if (tool === 'highlight') {
          ctx.globalAlpha = 0.35
          ctx.globalCompositeOperation = 'source-over'
          ctx.lineWidth = HL_WIDTH_CSS
          ctx.strokeStyle = hlColor
        } else {
          ctx.lineWidth = penWidth
          ctx.strokeStyle = penColor
        }
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      }
    },
    [tool, penColor, penWidth, hlColor]
  )

  // state 笔画 / 渲染完成 → 重画；状态上报（工具栏「本页 N 笔」）
  useEffect(() => {
    redrawInk(false)
  }, [strokes, renderSeq, redrawInk])
  useEffect(() => {
    reportStatus(strokes.length, inkDirty, annSaving)
  }, [strokes.length, inkDirty, annSaving, reportStatus])

  const annPointerDown = (e: React.PointerEvent): void => {
    if (mode !== 'ann') return
    e.preventDefault()
    const viewport = viewportRef.current
    if (!viewport) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const wrap = wrapRef.current!
    const wr = wrap.getBoundingClientRect()
    const x = e.clientX - wr.left
    const y = e.clientY - wr.top
    if (tool === 'eraser') {
      eraseAt(x, y, e.pointerId, e.currentTarget as HTMLElement)
      return
    }
    liveStrokeRef.current = [{ x, y }]
    redrawInk(true)
  }

  const annPointerMove = (e: React.PointerEvent): void => {
    if (mode !== 'ann') return
    const wrap = wrapRef.current
    if (!wrap) return
    const wr = wrap.getBoundingClientRect()
    const x = e.clientX - wr.left
    const y = e.clientY - wr.top
    if (tool === 'eraser') {
      if (erasingRef.current) eraseAt(x, y, e.pointerId, e.currentTarget as HTMLElement)
      return
    }
    const live = liveStrokeRef.current
    if (!live) return
    const last = live[live.length - 1]
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : []
    const samples = events.length ? events : [e.nativeEvent]
    for (const ev of samples) {
      const ex = ev.clientX - wr.left
      const ey = ev.clientY - wr.top
      if (Math.hypot(ex - last.x, ey - last.y) >= POINT_MIN_DIST) {
        live.push({ x: ex, y: ey })
      }
    }
    redrawInk(true)
  }

  const annPointerUp = (): void => {
    if (mode !== 'ann') return
    if (erasingRef.current) {
      erasingRef.current = false
      return
    }
    const live = liveStrokeRef.current
    liveStrokeRef.current = null
    const viewport = viewportRef.current
    if (!live || live.length < 2 || !viewport) {
      redrawInk(false)
      return
    }
    const eff = effScaleOf(viewport)
    const cssWidth = tool === 'highlight' ? HL_WIDTH_CSS : penWidth
    const pts = live.map((p) => {
      const pdfPt = viewport.convertToPdfPoint(p.x, p.y)
      return [pdfPt[0], pdfPt[1]] as [number, number]
    })
    const stroke: InkStroke = {
      k: tool === 'highlight' ? 'highlight' : 'pen',
      c: tool === 'highlight' ? hlColor : penColor,
      w: Math.max(0.5, cssWidth / eff),
      pts
    }
    undoStack.push({ type: 'add', index: strokesRef.current.length })
    if (undoStack.length > 100) undoStack.shift()
    setStrokes((prev) => [...prev, stroke])
    setInkDirty(true)
  }

  // ---------- 橡皮（笔画级删除） ----------
  const eraseAt = (cssX: number, cssY: number, pointerId: number, el: HTMLElement): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    if (!erasingRef.current) {
      erasingRef.current = true
      el.setPointerCapture(pointerId)
    }
    const eff = effScaleOf(viewport)
    const rPdf = ERASER_RADIUS_CSS / eff
    const px = viewport.convertToPdfPoint(cssX, cssY)
    const removed: Array<{ stroke: InkStroke; index: number }> = []
    const next: InkStroke[] = []
    strokesRef.current.forEach((s, i) => {
      const hit =
        s.pts.some((p) => Math.hypot(p[0] - px[0], p[1] - px[1]) < rPdf + s.w / 2) ||
        s.pts.some(
          (p, j) =>
            j > 0 &&
            pointSegmentDist(px as [number, number], s.pts[j - 1] as [number, number], p as [number, number]) <
              rPdf + s.w / 2
        )
      if (hit) removed.push({ stroke: s, index: i })
      else next.push(s)
    })
    if (removed.length) {
      for (const r of removed) undoStack.push({ type: 'remove', strokes: [r.stroke] })
      if (undoStack.length > 100) undoStack.splice(0, undoStack.length - 100)
      setStrokes(next)
      setInkDirty(true)
    }
  }

  const undoInk = useCallback(() => {
    const op = undoStack.pop()
    if (!op) return
    if (op.type === 'add' && op.index !== undefined) {
      const index = op.index
      setStrokes((prev) => {
        // 栈跨重挂载保留，理论上下标仍对得上；真对不上时跳过，而不是错删别的笔画
        if (index >= prev.length) return prev
        return prev.filter((_, i) => i !== index)
      })
    } else if (op.type === 'remove' && op.strokes) {
      // 简化：恢复到末尾（笔画顺序在纯删除流中足够近似）
      setStrokes((prev) => [...prev, ...op.strokes!])
    } else if (op.type === 'clear' && op.strokes) {
      setStrokes(op.strokes)
    }
    setInkDirty(true)
  }, [undoStack])

  const clearPageInk = useCallback(() => {
    if (!strokesRef.current.length) return
    undoStack.push({ type: 'clear', strokes: strokesRef.current })
    setStrokes([])
    setInkDirty(true)
  }, [undoStack])

  // ---------- 暴露给父级：撤销/清空/冲刷（回调注册式，父级按页码收集） ----------
  const apiRef = useRef<PageSurfaceApi>({ pageIndex, undo: () => {}, clearPage: () => {}, flushPending: async () => {} })
  apiRef.current = {
    pageIndex,
    undo: undoInk,
    clearPage: clearPageInk,
    flushPending: flushInk
  }
  const registerApiRef = useRef(registerApi)
  registerApiRef.current = registerApi
  useEffect(() => {
    registerApiRef.current(pageIndex, apiRef.current)
    return () => registerApiRef.current(pageIndex, null)
  }, [pageIndex])

  // ---------- 链接点击（阅读模式：参考文献内跳/外部网址；按下-抬起位移判定与划选互不干扰） ----------
  const hitLinkAt = (clientX: number, clientY: number): PageLink | null => {
    const wrap = wrapRef.current
    if (!wrap) return null
    const wr = wrap.getBoundingClientRect()
    const x = clientX - wr.left
    const y = clientY - wr.top
    for (const l of linkBoxes) {
      if (
        x >= l.box.left - 2 &&
        x <= l.box.left + l.box.width + 2 &&
        y >= l.box.top - 2 &&
        y <= l.box.top + l.box.height + 2
      ) {
        return l
      }
    }
    return null
  }

  const onPageMouseDown = (e: React.MouseEvent): void => {
    mouseDownRef.current = { x: e.clientX, y: e.clientY }
  }

  const onPageClick = (e: React.MouseEvent): void => {
    if (mode !== 'read') return
    const down = mouseDownRef.current
    mouseDownRef.current = null
    if (!down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return // 拖动 = 划选摘录，不触发链接
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    const link = hitLinkAt(e.clientX, e.clientY)
    if (!link) return
    if (link.kind === 'internal' && link.pageIndex != null) {
      onLinkInternal(link.pageIndex)
    } else if (link.kind === 'external' && link.url) {
      onLinkExternal(link.url)
    }
  }

  const onPageMouseMove = (e: React.MouseEvent): void => {
    if (mode !== 'read' || !wrapRef.current) return
    wrapRef.current.style.cursor = hitLinkAt(e.clientX, e.clientY) ? 'pointer' : ''
  }

  useEffect(() => {
    if (mode !== 'read' && wrapRef.current) wrapRef.current.style.cursor = ''
  }, [mode])

  // ---------- 文字摘录（划选，仅阅读模式） ----------
  const onMouseUp = (e: React.MouseEvent): void => {
    if (mode !== 'read') return
    const sel = window.getSelection()
    const layer = textLayerRef.current
    if (!sel || sel.isCollapsed || !sel.rangeCount || !layer) return
    const range = sel.getRangeAt(0)
    if (!layer.contains(range.commonAncestorContainer)) return
    const quote = sel.toString().replace(/\s+/g, ' ').trim()
    const viewport = viewportRef.current
    const wrap = wrapRef.current
    if (!quote || !viewport || !wrap) return
    const wrapRect = wrap.getBoundingClientRect()
    const rects = clientRectsToPdfRects(Array.from(range.getClientRects()), wrapRect, viewport)
    if (!rects.length) return
    onPendingSelection({ pageIndex, rects, quote, x: e.clientX, y: e.clientY })
  }

  // ---------- 框选摘录（仅框选模式） ----------
  const relDragBox = (): CssBox | null => {
    if (!dragStart || !dragCur || !wrapRef.current) return null
    const wr = wrapRef.current.getBoundingClientRect()
    const left = Math.min(dragStart.x, dragCur.x) - wr.left
    const top = Math.min(dragStart.y, dragCur.y) - wr.top
    return { left, top, width: Math.abs(dragCur.x - dragStart.x), height: Math.abs(dragCur.y - dragStart.y) }
  }

  const onCatcherPointerDown = (e: React.PointerEvent): void => {
    if (mode !== 'rect') return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDragStart({ x: e.clientX, y: e.clientY })
    setDragCur({ x: e.clientX, y: e.clientY })
  }
  const onCatcherPointerMove = (e: React.PointerEvent): void => {
    if (dragStart) setDragCur({ x: e.clientX, y: e.clientY })
  }
  const onCatcherPointerUp = (e: React.PointerEvent): void => {
    if (!dragStart) return
    const viewport = viewportRef.current
    const wrap = wrapRef.current
    const start = dragStart
    setDragStart(null)
    setDragCur(null)
    if (!viewport || !wrap) return
    const wr = wrap.getBoundingClientRect()
    const left = Math.min(start.x, e.clientX) - wr.left
    const top = Math.min(start.y, e.clientY) - wr.top
    const right = Math.max(start.x, e.clientX) - wr.left
    const bottom = Math.max(start.y, e.clientY) - wr.top
    if (right - left < 8 || bottom - top < 8) return
    const rect = cssToPdfRect(left, top, right, bottom, viewport)
    onPendingSelection({ pageIndex, rects: [rect], quote: '', x: e.clientX, y: e.clientY })
  }

  const dragBox = relDragBox()

  return (
    // pdfjs-root：pdf_viewer.css 经构建期作用域化（scripts/scope-pdfjs-css.ts），全部规则限定在本子树内
    <div
      className={`page-wrap mode-${mode}`}
      ref={wrapRef}
      data-page-index={pageIndex}
      data-render-seq={renderSeq}
      style={{
        width: wrapSize?.w ?? estSize.w,
        height: wrapSize?.h ?? estSize.h,
        ['--scale-factor' as string]: String(scale)
      }}
      onMouseUp={onMouseUp}
      onMouseDown={onPageMouseDown}
      onClick={onPageClick}
      onMouseMove={onPageMouseMove}
    >
      <>
          <canvas ref={canvasRef} className="page-canvas" />
          <div className="textLayer" ref={textLayerRef} />
          <div className="pdf-link-layer" aria-hidden="true">
            {linkBoxes.map((l, i) => (
              <div
                key={i}
                className="pdf-link-hit"
                data-pdf-link-kind={l.kind}
                data-pdf-link-target={l.kind === 'internal' ? String(l.pageIndex ?? '') : l.url ?? ''}
                style={{ left: l.box.left, top: l.box.top, width: l.box.width, height: l.box.height }}
              />
            ))}
          </div>
          <canvas ref={inkCanvasRef} className="ink-canvas" />
          <div className="anchor-layer">
            {overlayBoxes.map((o) =>
              o.boxes.map((b, i) => (
                <div
                  key={`${o.id}-${i}`}
                  className={`anchor-rect ${o.flash ? 'anchor-rect-flash' : ''}`}
                  style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
                />
              ))
            )}
            {dragBox && (
              <div
                className="drag-rect"
                style={{ left: dragBox.left, top: dragBox.top, width: dragBox.width, height: dragBox.height }}
              />
            )}
          </div>
          {mode === 'rect' && (
            <div
              className="rect-catcher"
              onPointerDown={onCatcherPointerDown}
              onPointerMove={onCatcherPointerMove}
              onPointerUp={onCatcherPointerUp}
            />
          )}
          {mode === 'ann' && (
            <div
              className={`ink-catcher ${tool === 'eraser' ? 'ink-eraser' : ''}`}
              onPointerDown={annPointerDown}
              onPointerMove={annPointerMove}
              onPointerUp={annPointerUp}
              onPointerCancel={() => {
                liveStrokeRef.current = null
                erasingRef.current = false
                redrawInk(false)
              }}
            />
          )}
      </>
    </div>
  )
}

/** 命名目的地（字符串）→ 目标页索引，带实例级缓存 */
async function resolveNamedDest(doc: PDFDocumentProxy, name: string, cache: Map<string, Promise<number | null>>): Promise<number | null> {
  const key = `${doc.fingerprints?.[0] ?? ''}:${name}`
  let p = cache.get(key)
  if (!p) {
    p = doc
      .getDestination(name)
      .then((resolved) => destToPageIndex(doc, resolved))
      .catch(() => null)
    cache.set(key, p)
  }
  return p
}

/** 链接目的地（[ref, /XYZ …] 形式）→ 目标页索引；解析失败返回 null。目录面板也用这条 */
export async function destToPageIndex(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  if (!Array.isArray(dest) || dest.length === 0) return null
  try {
    return await doc.getPageIndex(dest[0] as Parameters<PDFDocumentProxy['getPageIndex']>[0])
  } catch {
    return null
  }
}

/** pdf.js 命名动作 → 相对当前页的目标页索引（仅处理翻页类；其余返回 null 忽略） */
function namedActionPageIndex(action: string, currentPage: number, numPages: number): number | null {
  switch (action) {
    case 'NextPage':
      return Math.min(currentPage + 1, numPages - 1)
    case 'PrevPage':
      return Math.max(currentPage - 1, 0)
    case 'FirstPage':
      return 0
    case 'LastPage':
      return numPages - 1
    default:
      return null
  }
}

export { MIN_SCALE, MAX_SCALE, PEN_COLORS, HL_COLORS, PEN_WIDTHS }
