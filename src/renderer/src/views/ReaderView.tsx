import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { Nav } from '../App'
import { collectTextRanges } from '../lib/text-find'
import { useToast } from '../components/Toast'
import { Icon } from '../components/Icon'
import { ReadingWorkspacePanel } from '../components/ReadingWorkspacePanel'
import { NotePicker } from '../components/Picker'
import {
  PageSurface,
  MIN_SCALE,
  MAX_SCALE,
  PEN_COLORS,
  PEN_WIDTHS,
  HL_COLORS,
  destToPageIndex,
  type PageSurfaceApi,
  type PendingSelection,
  type ReaderMode,
  type AnnTool
} from '../components/PageSurface'
import { type PdfRect } from '@shared/coords'
import { type OpenDocumentResult, type ReaderFindResult, type ReaderSplitState } from '@shared/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

type ReaderLayout = 'continuous' | 'single'

/** pdf.js 大纲节点的最小形状（其类型定义未随包导出，这里按实际用到的字段收窄） */
interface OutlineItem {
  title?: string
  dest: unknown
  items?: OutlineItem[]
}

/** 拍平后的目录项：pageIndex 为 null 表示该节点指向的位置解析不出来，不可跳转 */
interface OutlineEntry {
  title: string
  pageIndex: number | null
  depth: number
}

const LAYOUT_KEY = 'mathwb-reader-layout'
/** 与 styles.css `.page-scroll.continuous` 的 padding/gap 严格一致 */
const SLOT_PAD = 24
const SLOT_GAP = 24

export function ReaderView({
  nav,
  documentId,
  jumpAnchorId,
  jumpPageIndex,
  initialNoteId
}: {
  nav: Nav
  documentId: string
  jumpAnchorId?: string
  /** 从文献库检索结果直接打开到命中页（0 基；优先于阅读位置、低于锚点跳转） */
  jumpPageIndex?: number
  initialNoteId?: string
}): React.ReactElement {
  const toast = useToast()
  const [open, setOpen] = useState<OpenDocumentResult | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageSizes, setPageSizes] = useState<Array<{ w: number; h: number }> | null>(null)
  const [docState, setDocState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [docError, setDocError] = useState('')
  // 当前页 = 视口中心所在页（连续滚动时随滚动更新；单页模式即唯一显示页）
  const [pageIndex, setPageIndex] = useState(0)
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0) // 用户附加旋转（0/90/180/270）
  const [layout, setLayout] = useState<ReaderLayout>('continuous')
  // 专注/对照工作空间（设计提案 2026-10-10 §3.1）：默认对照（材料 ∥ 笔记 60:40，
  // 延续「写笔记不打断阅读」）；初值先给默认，面板的工作区数据到达后同步持久化值。
  // 写入经由面板持有的 splitWriter（工作区 JSON 的单一写入者），避免与面板保存竞态
  const [wsSplit, setWsSplit] = useState<ReaderSplitState>({ mode: 'split', ratio: 60 })
  const splitWriterRef = useRef<{ set(split: ReaderSplitState): void } | null>(null)
  const onReaderSplitInit = useCallback((s: ReaderSplitState | undefined) => { if (s) setWsSplit(s) }, [])
  const bindSplitWriter = useCallback((api: { set(split: ReaderSplitState): void } | null) => { splitWriterRef.current = api }, [])
  const updateWsSplit = useCallback((patch: Partial<ReaderSplitState>) => {
    setWsSplit((prev) => {
      const next = { ...prev, ...patch }
      splitWriterRef.current?.set(next)
      return next
    })
  }, [])
  // Ctrl+\ 在专注/对照之间切换（原侧栏开关的键位沿用过来）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        updateWsSplit({ mode: wsSplit.mode === 'split' ? 'focus' : 'split' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wsSplit.mode, updateWsSplit])
  const [mode, setMode] = useState<ReaderMode>('read')
  const [tool, setTool] = useState<AnnTool>('pen')
  const [penColor, setPenColor] = useState(PEN_COLORS[1])
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1].css)
  const [hlColor, setHlColor] = useState(HL_COLORS[0])
  const [inkStatuses, setInkStatuses] = useState<Map<number, { count: number; dirty: boolean; saving: boolean }>>(new Map())
  const [anchorCounts, setAnchorCounts] = useState<Map<number, number>>(new Map())
  const [activeRange, setActiveRange] = useState<[number, number]>([0, 1])
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null)
  const [selTitle, setSelTitle] = useState('')
  const [selBody, setSelBody] = useState('')
  const [pickingForAnchor, setPickingForAnchor] = useState<PendingSelection | null>(null)
  const [panelKey, setPanelKey] = useState(0)
  const [anchorRefreshKey, setAnchorRefreshKey] = useState(0)
  const [flash, setFlash] = useState<{ page: number; rects: PdfRect[]; key: number } | null>(null)
  /**
   * 页码输入草稿：键入期间不受滚动/跳页回写干扰，且允许中间态为空串。
   * 旧实现直接把 pageIndex 当 value，清空输入框时 Number('') === 0 会立刻跳回第 1 页，
   * 想跳第 300 页只能全选替换。
   */
  const [pageDraft, setPageDraft] = useState<string | null>(null)
  const [hintDismissed, setHintDismissed] = useState<{ rect: boolean; ann: boolean }>({ rect: false, ann: false })
  const [selectedNoteId, setSelectedNoteId] = useState<string | undefined>(initialNoteId)
  // 文档内查找（⌘F）：主进程用已索引全文按页统计，渲染层用 CSS Highlight 在已渲染页上高亮
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<ReaderFindResult | null>(null)
  const [findPageIdx, setFindPageIdx] = useState(0)
  const [findOrdinal, setFindOrdinal] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pageApisRef = useRef(new Map<number, PageSurfaceApi>())
  const panelFlushers = useRef(new Set<() => Promise<void>>())
  const positionRef = useRef({ documentId, pageIndex, scale, rotation })
  positionRef.current = { documentId, pageIndex, scale, rotation }
  /** 阅读会话：挂载起计时，页面挂载即记入去重页数；冲刷/卸载时汇总成一条足迹事件 */
  const sessionRef = useRef({ startedAt: Date.now(), pages: new Set<number>() })
  const labelsRef = useRef<string[] | null>(null)
  const metaReported = useRef(false)
  const jumpConsumed = useRef(false)
  const restoreScrollRef = useRef<number | null>(null)

  const registerPanelFlusher = useCallback((fn: () => Promise<void>) => {
    panelFlushers.current.add(fn)
    return () => {
      panelFlushers.current.delete(fn)
    }
  }, [])
  const registerPageApi = useCallback((page: number, api: PageSurfaceApi | null) => {
    if (api) {
      pageApisRef.current.set(page, api)
      // 页面挂载 = 这一页真的被看到过：阅读会话的去重页数由此而来
      sessionRef.current.pages.add(page)
    } else {
      pageApisRef.current.delete(page)
    }
  }, [])

  /** 汇总上报当前阅读会话并重新计时；太短的会话主进程会忽略（打开又关掉不算学习） */
  const flushReadingSession = useCallback(async (): Promise<void> => {
    const s = sessionRef.current
    sessionRef.current = { startedAt: Date.now(), pages: new Set() }
    const seconds = Math.round((Date.now() - s.startedAt) / 1000)
    if (seconds < 10 && s.pages.size === 0) return
    try {
      await window.api.activityRecordSession({ documentId, pages: s.pages.size, seconds })
    } catch {
      /* 足迹是旁路统计：上报失败不影响阅读本身 */
    }
  }, [documentId])

  useEffect(() => {
    nav.registerFlusher(async () => {
      await Promise.all([...panelFlushers.current].map((fn) => fn()))
      for (const api of pageApisRef.current.values()) await api.flushPending()
      if (docState === 'ready') await window.api.readingSave(positionRef.current)
      await flushReadingSession()
    })
    return () => nav.registerFlusher(null)
  }, [docState, flushReadingSession])

  // 卸载兜底：不经 navigate 的卸载（换文档重挂载等）也要把这段会话记上
  useEffect(() => () => { void flushReadingSession() }, [flushReadingSession])

  // ---------- 目录（PDF 大纲） ----------
  // 读论文时「跳到第 3 节」是高频动作，而 pdf.js 的大纲此前完全没用起来。
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  useEffect(() => {
    if (!pdf || docState !== 'ready') return
    let cancelled = false
    void (async () => {
      try {
        const raw = await pdf.getOutline()
        const out: OutlineEntry[] = []
        const walk = async (items: OutlineItem[], depth: number): Promise<void> => {
          for (const item of items) {
            const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest).catch(() => null) : item.dest
            const pageIndex = await destToPageIndex(pdf, dest)
            out.push({ title: (item.title ?? '').trim() || '(无标题)', pageIndex, depth })
            if (item.items?.length) await walk(item.items, depth + 1)
          }
        }
        await walk((raw ?? []) as OutlineItem[], 0)
        if (!cancelled) setOutline(out)
      } catch {
        if (!cancelled) setOutline([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pdf, docState])

  const jumpFlashTimer = useRef<number | null>(null)
  const setJumpFlash = useCallback((page: number, rects: PdfRect[]) => {
    setFlash({ page, rects, key: Date.now() + Math.random() })
    // 计时器要能取消：快速连续跳转或卸载后不应再 setState
    if (jumpFlashTimer.current) window.clearTimeout(jumpFlashTimer.current)
    jumpFlashTimer.current = window.setTimeout(() => setFlash((f) => (f && f.page === page ? null : f)), 2800)
  }, [])
  useEffect(() => () => { if (jumpFlashTimer.current) window.clearTimeout(jumpFlashTimer.current) }, [])

  // ---------- 槽位几何（连续模式的布局唯一来源，与 CSS 常量严格一致） ----------
  const slotTops = useMemo((): number[] => {
    if (!pageSizes) return []
    const tops: number[] = []
    let acc = SLOT_PAD
    for (const size of pageSizes) {
      tops.push(acc)
      acc += swappedHeight(size, rotation) * scale + SLOT_GAP
    }
    return tops
  }, [pageSizes, scale, rotation])

  // ---------- 滚动 → 当前页 + 可视区范围（连续模式虚拟化） ----------
  const syncFromScroll = useCallback(() => {
    const sc = scrollRef.current
    if (!sc || layout !== 'continuous' || slotTops.length === 0) return
    const n = slotTops.length
    const center = sc.scrollTop + sc.clientHeight / 2
    let cur = n - 1
    for (let i = 0; i < n; i++) {
      const h = swappedHeight(pageSizes![i], rotation) * scale
      if (center < slotTops[i] + h || i === n - 1) {
        cur = i
        break
      }
    }
    // 可视区 ± 一页缓冲内挂载重资源
    const buffer = 792 * scale + SLOT_GAP
    const viewTop = sc.scrollTop - buffer
    const viewBottom = sc.scrollTop + sc.clientHeight + buffer
    let first = n - 1
    let last = 0
    for (let i = 0; i < n; i++) {
      const h = swappedHeight(pageSizes![i], rotation) * scale
      if (slotTops[i] + h > viewTop) {
        first = i
        break
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      if (slotTops[i] < viewBottom) {
        last = i
        break
      }
    }
    setPageIndex((prev) => (prev === cur ? prev : cur))
    setActiveRange((prev) => (prev[0] === first && prev[1] === last ? prev : [first, last]))
  }, [layout, slotTops, pageSizes, scale, rotation])

  useEffect(() => {
    const sc = scrollRef.current
    if (!sc) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        syncFromScroll()
      })
    }
    sc.addEventListener('scroll', onScroll, { passive: true })
    return () => sc.removeEventListener('scroll', onScroll)
  }, [syncFromScroll])

  // 布局/缩放/旋转变化后立即重算可视区（不依赖滚动事件）
  useEffect(() => {
    if (layout === 'single') {
      setActiveRange((prev) => (prev[0] === pageIndex && prev[1] === pageIndex ? prev : [pageIndex, pageIndex]))
      return
    }
    syncFromScroll()
  }, [layout, pageIndex, syncFromScroll])

  /** 滚动让目标页成为当前页（页顶对齐） */
  const scrollToPage = useCallback(
    (page: number) => {
      const sc = scrollRef.current
      const clamped = clampPage(page, pdf?.numPages ?? 1)
      if (!sc || layout !== 'continuous' || slotTops.length === 0) {
        setPageIndex(clamped)
        if (sc && layout === 'single') sc.scrollTop = 0
        return
      }
      const top = Math.max(0, (slotTops[clamped] ?? 0) - SLOT_PAD)
      sc.scrollTo({ top, behavior: 'auto' })
      setPageIndex(clamped)
      syncFromScroll()
    },
    [pdf, layout, slotTops, syncFromScroll]
  )

  // ---------- 文档加载 ----------
  useEffect(() => {
    let cancelled = false
    let task: pdfjs.PDFDocumentLoadingTask | null = null
    setDocState('loading')
    ;(async () => {
      const opened = await window.api.docOpen(documentId)
      if (cancelled) return
      setOpen(opened)
      task = pdfjs.getDocument({
        url: opened.url,
        cMapUrl: './pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: './pdfjs/standard_fonts/',
        wasmUrl: './pdfjs/wasm/'
      })
      const loaded = await task.promise
      if (cancelled) {
        void task.destroy().catch(() => undefined)
        return
      }
      labelsRef.current = await loaded.getPageLabels().catch(() => null)
      if (cancelled) return
      if (!metaReported.current) {
        metaReported.current = true
        void window.api.docSetMeta(opened.versionId, {
          pageCount: loaded.numPages,
          fingerprint: loaded.fingerprints?.[0] ?? undefined
        })
      }
      // 预量每页尺寸（连续模式的槽位布局需要）
      const sizes: Array<{ w: number; h: number }> = []
      for (let i = 1; i <= loaded.numPages; i++) {
        const p = await loaded.getPage(i)
        const vp = p.getViewport({ scale: 1 })
        sizes.push({ w: vp.width, h: vp.height })
      }
      if (cancelled) return
      setPageSizes(sizes)
      // 起始页：跳转锚点 > 检索命中页 > 阅读位置 > 第 1 页
      if (jumpAnchorId && !jumpConsumed.current) {
        jumpConsumed.current = true
        try {
          const anchor = await window.api.anchorGet(jumpAnchorId)
          if (!cancelled) {
            restoreScrollRef.current = clampPage(anchor.pageIndex, loaded.numPages)
            setJumpFlash(clampPage(anchor.pageIndex, loaded.numPages), anchor.rects)
          }
        } catch {
          /* 锚点失效时退回阅读位置 */
        }
      } else if (jumpPageIndex !== undefined) {
        restoreScrollRef.current = clampPage(jumpPageIndex, loaded.numPages)
      } else if (opened.readingState) {
          restoreScrollRef.current = clampPage(opened.readingState.pageIndex, loaded.numPages)
        setScale(clampScale(opened.readingState.scale))
        setRotation(((opened.readingState.rotation % 360) + 360) % 360)
      }
      if (!cancelled) {
        setPdf(loaded)
        setDocState('ready')
      }
    })().catch((err) => {
      if (cancelled) return
      setDocState('error')
      setDocError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      cancelled = true
      if (!task) return
      const loadingTask = task
      // 不能在加载中途 task.destroy()：pdf.js 会在 worker 内部抛出主线程无法捕获的
      // "Worker was terminated"（ensureNotTerminated 路径）。等加载自然结束后再销毁
      // 文档；失败或长时间未决时才直接终止加载任务。
      const forceDestroy = setTimeout(() => { void loadingTask.destroy().catch(() => undefined) }, 60_000)
      void loadingTask.promise.then(
        (doc) => { clearTimeout(forceDestroy); void doc.destroy().catch(() => undefined) },
        () => { clearTimeout(forceDestroy); void loadingTask.destroy().catch(() => undefined) }
      )
    }
  }, [documentId, jumpAnchorId, jumpPageIndex, setJumpFlash])

  // 初始滚动定位：槽位提交到 DOM 后立即恢复（同步执行，避免首帧后再跳一下）
  useEffect(() => {
    if (!pdf || !pageSizes || docState !== 'ready') return
    if (restoreScrollRef.current === null) return
    const target = restoreScrollRef.current
    restoreScrollRef.current = null
    scrollToPage(target)
    syncFromScroll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, pageSizes, docState])

  // ---------- 阅读位置持久化 ----------
  useEffect(() => {
    if (!open || docState !== 'ready') return
    const t = setTimeout(() => {
      void window.api.readingSave({ documentId: open.documentId, pageIndex, scale, rotation }).catch((err) => toast.push(`阅读位置保存失败：${String(err)}`, 'error'))
    }, 800)
    return () => clearTimeout(t)
  }, [open, docState, pageIndex, scale, rotation])

  // ---------- 键盘翻页/缩放（PDF 惯例：空格翻页，⌘+/−/0/1 缩放） ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'f') {
        // ⌘F 文档内查找（阅读器最常用的动作之一；此前完全缺失）
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (meta && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setScale((s) => clampScale(s * 1.15))
      } else if (meta && e.key === '-') {
        e.preventDefault()
        setScale((s) => clampScale(s / 1.15))
      } else if (meta && e.key === '0') {
        e.preventDefault()
        setScale(1)
      } else if (meta && e.key === '1') {
        e.preventDefault()
        void fitWidth()
      } else if (e.key === ' ' && !meta) {
        // 空格是阅读时翻页的主键，但不能抢走已聚焦按钮/链接的键盘激活（Tab 到「适宽」后按空格应触发按钮）
        const active = document.activeElement
        const interactive = active instanceof HTMLElement &&
          (active.tagName === 'BUTTON' || active.tagName === 'A' || active.getAttribute('role') === 'button')
        if (interactive) return
        e.preventDefault()
        scrollToPage(pageIndex + (e.shiftKey ? -1 : 1))
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') scrollToPage(pageIndex + 1)
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') scrollToPage(pageIndex - 1)
      else if (!meta && (e.key === '=' || e.key === '+')) setScale((s) => clampScale(s * 1.15))
      else if (!meta && e.key === '-') setScale((s) => clampScale(s / 1.15))
      else if (e.key === 'Escape' && mode !== 'read') setMode('read')
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && mode === 'ann') {
        e.preventDefault()
        pageApisRef.current.get(pageIndex)?.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, mode, pageIndex, scrollToPage])

  // ---------- 单页模式滚轮：页内滚到底再翻页（连续模式走原生滚动） ----------
  useEffect(() => {
    const sc = scrollRef.current
    if (!sc || layout !== 'single') return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 1) return
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2
      const atTop = sc.scrollTop <= 2
      if (e.deltaY > 0 && atBottom) {
        e.preventDefault()
        scrollToPage(pageIndex + 1)
      } else if (e.deltaY < 0 && atTop) {
        e.preventDefault()
        scrollToPage(pageIndex - 1)
      }
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    return () => sc.removeEventListener('wheel', onWheel)
  }, [layout, pageIndex, scrollToPage])

  // ---------- 摘录浮层：点击浮层以外区域视为取消 ----------
  useEffect(() => {
    if (!pendingSel) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.sel-popover')) return
      setPendingSel(null)
      window.getSelection()?.removeAllRanges()
    }
    // 按下事件发生在浮层打开前的那次点击之后的下一帧起才生效，避免误关
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
    }
  }, [pendingSel])

  const closePendingSel = () => {
    setPendingSel(null)
    setSelBody('')
    setSelTitle('')
    window.getSelection()?.removeAllRanges()
  }

  /** 「记在这里」：标记 + 笔记一次事务，成功后右栏就地出现并选中，不离开阅读器 */
  const saveAsNoteHere = async (): Promise<void> => {
    if (!pendingSel || !open) return
    try {
      const title = selTitle.trim() || (pendingSel.quote ? pendingSel.quote.slice(0, 30) : `第 ${pendingSel.pageIndex + 1} 页摘录`)
      const { note } = await window.api.anchorCreateWithNote({
        anchor: {
          documentVersionId: open.versionId,
          pageIndex: pendingSel.pageIndex,
          pageLabel: labelsRef.current?.[pendingSel.pageIndex] ?? null,
          rects: pendingSel.rects,
          quote: pendingSel.quote || null
        },
        note: { title, noteType: 'note', bodyMd: selBody, spaceId: open.spaceId }
      })
      toast.push('已记在这里', 'success')
      setJumpFlash(pendingSel.pageIndex, pendingSel.rects)
      closePendingSel()
      setPanelKey((k) => k + 1)
      setAnchorRefreshKey((k) => k + 1)
      setSelectedNoteId(note.id)
    } catch (err) {
      toast.push(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  /** 「加到已有笔记」：只建标记并挂到所选笔记 */
  const attachToExisting = async (noteId: string): Promise<void> => {
    if (!pickingForAnchor || !open) return
    try {
      const anchor = await window.api.anchorCreate({
        documentVersionId: open.versionId,
        pageIndex: pickingForAnchor.pageIndex,
        pageLabel: labelsRef.current?.[pickingForAnchor.pageIndex] ?? null,
        rects: pickingForAnchor.rects,
        quote: pickingForAnchor.quote || null
      })
      const r = await window.api.noteAttachAnchor(noteId, anchor.id)
      toast.push(r.already ? '该标记已在此笔记中' : '已加到所选笔记', r.already ? 'info' : 'success')
      setJumpFlash(pickingForAnchor.pageIndex, pickingForAnchor.rects)
      setPickingForAnchor(null)
      closePendingSel()
      setPanelKey((k) => k + 1)
      setAnchorRefreshKey((k) => k + 1)
      setSelectedNoteId(noteId)
    } catch (err) {
      toast.push(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  /** 「只留标记」：不建笔记，右栏「仅标记」区可回跳 */
  const saveAnchorOnly = async (): Promise<void> => {
    if (!pendingSel || !open) return
    try {
      await window.api.anchorCreate({
        documentVersionId: open.versionId,
        pageIndex: pendingSel.pageIndex,
        pageLabel: labelsRef.current?.[pendingSel.pageIndex] ?? null,
        rects: pendingSel.rects,
        quote: pendingSel.quote || null
      })
      toast.push('已留下标记', 'success')
      setJumpFlash(pendingSel.pageIndex, pendingSel.rects)
      closePendingSel()
      setPanelKey((k) => k + 1)
      setAnchorRefreshKey((k) => k + 1)
    } catch (err) {
      toast.push(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const fitWidth = async (): Promise<void> => {
    if (!pdf || !scrollRef.current) return
    const page = await pdf.getPage(pageIndex + 1)
    const vp1 = page.getViewport({ scale: 1, rotation })
    const avail = scrollRef.current.clientWidth - 48
    setScale(clampScale(avail / vp1.width))
  }

  // 布局偏好跨会话持久化（本地服务端口随机，localStorage 不可靠）
  useEffect(() => {
    let cancelled = false
    void window.api.prefGet(LAYOUT_KEY).then((v) => {
      if (!cancelled && (v === 'single' || v === 'continuous')) setLayout(v)
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 首次打开自动适宽（WP-7）：没有保存过的阅读状态时（记忆缩放优先，不动已有阅读状态），
   * 以大屏为例 100% 缩放只占约 1/4 宽——先给一个「读得进去」的视图，用户仍可自由缩放。
   */
  const initialFitDone = useRef(false)
  useEffect(() => {
    if (docState !== 'ready' || !pdf || !open) return
    if (initialFitDone.current) return
    initialFitDone.current = true
    if (open.readingState) return
    void fitWidth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docState, pdf, open])

  const switchLayout = (next: ReaderLayout): void => {
    setLayout(next)
    void window.api.prefSet(LAYOUT_KEY, next).catch(() => undefined)
  }

  const onInkStatus = useCallback((page: number, status: { count: number; dirty: boolean; saving: boolean }) => {
    setInkStatuses((prev) => {
      const old = prev.get(page)
      if (old && old.count === status.count && old.dirty === status.dirty && old.saving === status.saving) return prev
      const next = new Map(prev)
      next.set(page, status)
      return next
    })
  }, [])

  const onAnchorCount = useCallback((page: number, count: number) => {
    setAnchorCounts((prev) => {
      if (prev.get(page) === count) return prev
      const next = new Map(prev)
      next.set(page, count)
      return next
    })
  }, [])

  const openExternal = useCallback(
    (url: string) =>
      void window.api.appOpenExternal(url).catch((err) => toast.push(`无法打开链接：${err instanceof Error ? err.message : String(err)}`, 'error')),
    [toast]
  )
  const onRenderError = useCallback((m: string) => toast.push(`页面渲染失败：${m}`, 'error'), [toast])
  const jumpToPage = useCallback((t: number) => scrollToPage(t), [scrollToPage])

  // ---------- 文档内查找（⌘F） ----------
  // 命中统计走主进程的全文索引（跨全部页、毫秒级）；高亮在渲染层用 CSS Custom Highlight
  // 标在已渲染页的文字层上（不改 DOM，pdf.js 重渲染也不会打架）。
  useEffect(() => {
    if (!findOpen || !open || !findQuery.trim()) {
      setFindResult(null)
      setFindPageIdx(0)
      setFindOrdinal(0)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api.readerFind(open.versionId, findQuery)
        .then((res) => {
          if (cancelled) return
          setFindResult(res)
          setFindPageIdx(0)
          setFindOrdinal(0)
          if (res.pages.length) scrollToPage(res.pages[0].pageIndex)
        })
        .catch(() => { if (!cancelled) setFindResult({ indexed: false, total: 0, pages: [] }) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [findOpen, findQuery, open, scrollToPage])

  const findTotal = findResult?.total ?? 0
  const findOrdinalGlobal = findResult
    ? findResult.pages.slice(0, findPageIdx).reduce((n, p) => n + p.count, 0) + findOrdinal
    : 0
  const gotoFindMatch = useCallback((pageIdx: number, ordinal: number) => {
    setFindResult((res) => {
      if (res?.pages[pageIdx]) scrollToPage(res.pages[pageIdx].pageIndex)
      return res
    })
    setFindPageIdx(pageIdx)
    setFindOrdinal(ordinal)
  }, [scrollToPage])
  const findStep = useCallback((dir: 1 | -1) => {
    setFindResult((res) => {
      if (!res?.pages.length) return res
      const cur = res.pages[Math.min(findPageIdx, res.pages.length - 1)]
      let pageIdx = findPageIdx
      let ordinal = findOrdinal + dir
      if (ordinal >= cur.count) {
        pageIdx = (findPageIdx + 1) % res.pages.length
        ordinal = 0
      } else if (ordinal < 0) {
        pageIdx = (findPageIdx - 1 + res.pages.length) % res.pages.length
        ordinal = res.pages[pageIdx].count - 1
      }
      scrollToPage(res.pages[pageIdx].pageIndex)
      setFindPageIdx(pageIdx)
      setFindOrdinal(ordinal)
      return res
    })
  }, [findPageIdx, findOrdinal, scrollToPage])

  // 高亮：文本层可能还没渲染完（虚拟化 / 缩放后重渲染），按几档延迟重试
  useEffect(() => {
    const clear = () => {
      try {
        CSS.highlights?.delete('mathwb-find')
        CSS.highlights?.delete('mathwb-find-current')
      } catch { /* 环境不支持 Highlight API 时静默 */ }
    }
    const target = findOpen && findQuery.trim() ? findResult?.pages[findPageIdx] : undefined
    if (!target) {
      clear()
      return
    }
    const apply = (): boolean => {
      const layer = document.querySelector(`.page-wrap[data-page-index="${target.pageIndex}"] .textLayer`)
      if (!layer) return false
      const ranges = collectTextRanges(layer, findQuery)
      if (!ranges.length) return false
      clear()
      CSS.highlights.set('mathwb-find', new Highlight(...ranges))
      const active = ranges[Math.min(findOrdinal, ranges.length - 1)]
      if (active) CSS.highlights.set('mathwb-find-current', new Highlight(active))
      return true
    }
    if (apply()) return clear
    const timers = [80, 250, 600].map((ms) => window.setTimeout(apply, ms))
    return () => {
      timers.forEach((t) => window.clearTimeout(t))
      clear()
    }
  }, [findOpen, findQuery, findResult, findPageIdx, findOrdinal, pageIndex, scale, rotation, activeRange, layout])

  const numPages = pdf?.numPages ?? 1
  const curStatus = inkStatuses.get(pageIndex)
  const curAnchorCount = anchorCounts.get(pageIndex) ?? 0

  // ---------- 视图 ----------
  if (docState === 'error') {
    return (
      <div className="view view-scroll">
        <div className="view-head">
          <button className="btn" onClick={() => nav.go({ kind: 'library' })}>
            ← 返回
          </button>
        </div>
        <div className="empty-state">
          <div className="empty-title">文档无法打开</div>
          <div className="mono small">{docError}</div>
          <div className="muted">来源文件可能缺失或已损坏。笔记与锚点仍然保留。</div>
        </div>
      </div>
    )
  }

  /** 提交页码草稿：空串/非法值视为放弃（不改页码），合法值夹取到 1..numPages */
  const commitPageInput = (): void => {
    const raw = pageDraft
    setPageDraft(null)
    if (raw === null || raw.trim() === '') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    scrollToPage(clampPage(Math.floor(value) - 1, numPages))
  }

  const estPageSize = (i: number): { w: number; h: number } => {
    const size = pageSizes?.[i]
    if (!size) return { w: 612 * scale, h: 792 * scale }
    const sw = rotation % 180 !== 0
    return sw
      ? { w: Math.floor(size.h * scale), h: Math.floor(size.w * scale) }
      : { w: Math.floor(size.w * scale), h: Math.floor(size.h * scale) }
  }

  const renderPageSurface = (i: number): React.ReactElement => (
    <PageSurface
      key={i}
      versionId={open!.versionId}
      pdf={pdf!}
      pageIndex={i}
      scale={scale}
      rotation={rotation}
      mode={mode}
      tool={tool}
      penColor={penColor}
      penWidth={penWidth}
      hlColor={hlColor}
      estSize={estPageSize(i)}
      jumpFlashRects={flash?.page === i ? flash.rects : null}
      anchorRefreshKey={anchorRefreshKey}
      registerFlusher={registerPanelFlusher}
      registerApi={registerPageApi}
      onStatus={onInkStatus}
      onAnchorCount={onAnchorCount}
      onPendingSelection={setPendingSel}
      onLinkInternal={jumpToPage}
      onLinkExternal={openExternal}
      onRenderError={onRenderError}
    />
  )

  let pages: React.ReactNode = null
  if (pdf && open && docState === 'ready') {
    if (layout === 'single') {
      pages = renderPageSurface(pageIndex)
    } else {
      const list: React.ReactNode[] = []
      const [a, b] = activeRange
      for (let i = 0; i < numPages; i++) {
        if (i < a || i > b) {
          const size = pageSizes?.[i]
          const h = size ? swappedHeight(size, rotation) * scale : 792 * scale
          const w = size ? swappedWidth(size, rotation) * scale : 612 * scale
          list.push(
            <div
              key={i}
              className="page-wrap page-placeholder"
              data-page-index={i}
              style={{ width: Math.floor(w), height: Math.floor(h) }}
            />
          )
          continue
        }
        list.push(renderPageSurface(i))
      }
      pages = list
    }
  }

  return (
    <div className="reader pdfjs-root">
      <div className="reader-toolbar">
        <button className="btn" onClick={() => nav.go({ kind: 'library' })}>
          ← 文献
        </button>
        <span className="reader-title" title={open?.title}>
          {open?.title ?? '加载中…'}
        </span>
        {/* 定位与视图：目录/查找 · 翻页 · 缩放/旋转，用发丝分隔而不是把 10 个控件排成一串 */}
        <div className="toolbar-group">
          <button
            className={`btn btn-sm ${outlineOpen ? 'btn-selected' : ''}`}
            aria-pressed={outlineOpen}
            disabled={docState !== 'ready' || outline.length === 0}
            title={outline.length ? '文档目录' : '这份文档没有目录'}
            onClick={() => setOutlineOpen((v) => !v)}
          >
            目录
          </button>
          <button
            className={`btn btn-sm ${findOpen ? 'btn-selected' : ''}`}
            aria-pressed={findOpen}
            disabled={docState !== 'ready'}
            title="在文档内查找 (⌘F)"
            onClick={() => setFindOpen((v) => !v)}
          >
            查找
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            className="btn btn-sm"
            aria-label="上一页" disabled={pageIndex <= 0} onClick={() => scrollToPage(pageIndex - 1)}
          >
            <Icon name="pagePrev" size={15} />
          </button>
          <input
            className="page-input"
            disabled={docState !== 'ready'}
            type="number"
            aria-label="页码"
            min={1}
            max={numPages}
            value={pageDraft ?? String(pageIndex + 1)}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => commitPageInput()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitPageInput()
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                setPageDraft(null)
                e.currentTarget.blur()
              }
            }}
          />
          <span className="muted">/ {pdf?.numPages ?? '…'}</span>
          <button
            className="btn btn-sm"
            aria-label="下一页"
            disabled={!pdf || pageIndex >= numPages - 1}
            onClick={() => scrollToPage(pageIndex + 1)}
          >
            <Icon name="pageNext" size={15} />
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button className="btn btn-sm" aria-label="缩小" onClick={() => setScale((s) => clampScale(s / 1.15))}>
            <Icon name="zoomOut" size={15} />
          </button>
          <span className="muted">{Math.round(scale * 100)}%</span>
          <button className="btn btn-sm" aria-label="放大" onClick={() => setScale((s) => clampScale(s * 1.15))}>
            <Icon name="zoomIn" size={15} />
          </button>
          <button className="btn btn-sm" onClick={() => void fitWidth()}>
            适宽
          </button>
          <button className="btn btn-sm" aria-label="顺时针旋转 90 度" onClick={() => setRotation((r) => (r + 90) % 360)}>
            <Icon name="rotate" size={15} />
          </button>
        </div>
        <div className="toolbar-group">
          {/* 工作空间两状态：专注（材料独占）/ 对照（材料 ∥ 笔记 60:40 起） */}
          <div className="segmented" role="tablist" aria-label="工作空间">
            <button
              role="tab"
              aria-selected={wsSplit.mode === 'focus'}
              aria-label={`工作空间 专注${wsSplit.mode === 'focus' ? '（当前）' : ''}`}
              className={`seg-btn ${wsSplit.mode === 'focus' ? 'seg-active' : ''}`}
              disabled={docState !== 'ready'}
              onClick={() => updateWsSplit({ mode: 'focus' })}
            >
              专注
            </button>
            <button
              role="tab"
              aria-selected={wsSplit.mode === 'split'}
              aria-label={`工作空间 对照${wsSplit.mode === 'split' ? '（当前）' : ''}`}
              className={`seg-btn ${wsSplit.mode === 'split' ? 'seg-active' : ''}`}
              disabled={docState !== 'ready'}
              onClick={() => updateWsSplit({ mode: 'split' })}
            >
              对照
            </button>
          </div>
          <span className="toolbar-sep" aria-hidden="true" />
          <div className="segmented" role="tablist" aria-label="阅读模式">
            {([['read', '阅读'], ['rect', '摘录'], ['ann', '手写']] as Array<[ReaderMode, string]>).map(([m, label]) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                className={`seg-btn ${mode === m ? 'seg-active' : ''}`}
                disabled={docState !== 'ready'}
                onClick={() => {
                  setMode(m)
                  window.getSelection()?.removeAllRanges()
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="toolbar-sep" aria-hidden="true" />
          <div className="segmented" role="tablist" aria-label="查看方式">
            {([['continuous', '连续'], ['single', '单页']] as Array<[ReaderLayout, string]>).map(([l, label]) => (
              <button
                key={l}
                role="tab"
                aria-selected={layout === l}
                aria-label={`查看方式 ${label}`}
                className={`seg-btn ${layout === l ? 'seg-active' : ''}`}
                disabled={docState !== 'ready'}
                onClick={() => switchLayout(l)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {findOpen && (
        <div className="reader-find" role="search" aria-label="在文档内查找">
          <input
            className="input find-input"
            autoFocus
            aria-label="在文档内查找"
            placeholder="在文档内查找…"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1) }
              else if (e.key === 'Escape') { e.preventDefault(); setFindOpen(false) }
            }}
          />
          <span className="muted small find-count" role="status">
            {!findQuery.trim()
              ? '输入关键词（Enter 下一个，Shift+Enter 上一个）'
              : !findResult
                ? '查找中…'
                : !findResult.indexed
                  ? '本文档没有可搜索的文本层（扫描版），无法查找'
                  : findResult.total === 0
                    ? '无匹配'
                    : `${findOrdinalGlobal + 1} / ${findResult.total} 个匹配 · 第 ${(findResult.pages[findPageIdx]?.pageIndex ?? 0) + 1} 页`}
          </span>
          <button className="btn btn-sm" aria-label="上一个匹配" disabled={findTotal === 0} onClick={() => findStep(-1)}><Icon name="pagePrev" size={15} /></button>
          <button className="btn btn-sm" aria-label="下一个匹配" disabled={findTotal === 0} onClick={() => findStep(1)}><Icon name="pageNext" size={15} /></button>
          <button className="icon-btn" aria-label="关闭查找" onClick={() => setFindOpen(false)}>×</button>
        </div>
      )}

      {mode === 'rect' && !hintDismissed.rect && curAnchorCount === 0 && (
        <div className="mode-hint" role="status">
          在页面上拖出一个矩形框选原文区域；文字也可以在「阅读」模式下直接划选。
          <button aria-label="关闭提示" onClick={() => setHintDismissed((h) => ({ ...h, rect: true }))}>×</button>
        </div>
      )}
      {mode === 'ann' && !hintDismissed.ann && (curStatus?.count ?? 0) === 0 && (
        <div className="mode-hint" role="status">
          选好颜色后直接在页面上书写；「橡皮」按笔画擦除，⌘Z 可撤销。
          <button aria-label="关闭提示" onClick={() => setHintDismissed((h) => ({ ...h, ann: true }))}>×</button>
        </div>
      )}
      {mode === 'ann' && (
        <div className="ann-toolbar" role="toolbar" aria-label="手写批注工具">
          <span className="ann-tool-label">笔</span>
          <div className="swatch-row">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${tool === 'pen' && penColor === c ? 'swatch-active' : ''}`}
                style={{ background: c }}
                aria-label={`笔颜色 ${c}`}
                onClick={() => {
                  setTool('pen')
                  setPenColor(c)
                }}
              />
            ))}
          </div>
          <div className="width-row">
            {PEN_WIDTHS.map((w) => (
              <button
                key={w.label}
                className={`width-dot-btn ${tool === 'pen' && penWidth === w.css ? 'swatch-active' : ''}`}
                aria-label={`笔宽 ${w.label}`}
                onClick={() => {
                  setTool('pen')
                  setPenWidth(w.css)
                }}
              >
                <span className="width-dot" style={{ width: w.css + 2, height: w.css + 2 }} />
              </button>
            ))}
          </div>
          <span className="ann-divider" />
          <span className="ann-tool-label">荧光笔</span>
          <div className="swatch-row">
            {HL_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch swatch-hl ${tool === 'highlight' && hlColor === c ? 'swatch-active' : ''}`}
                style={{ background: c }}
                aria-label={`荧光笔 ${c}`}
                onClick={() => {
                  setTool('highlight')
                  setHlColor(c)
                }}
              />
            ))}
          </div>
          <span className="ann-divider" />
          <button
            className={`btn btn-sm ${tool === 'eraser' ? 'btn-selected' : ''}`}
            onClick={() => setTool('eraser')}
          >
            <Icon name="eraser" size={15} /> 橡皮
          </button>
          <button className="btn btn-sm" onClick={() => pageApisRef.current.get(pageIndex)?.undo()} disabled={!curStatus?.count} title="撤销（⌘Z）">
            <Icon name="undo" size={15} /> 撤销
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={!curStatus?.count}
            title="清空本页手写批注（可在本页撤销）"
            onClick={() => {
              const count = curStatus?.count ?? 0
              if (!count) return
              if (!window.confirm(`清空本页的 ${count} 笔批注？可在本页按 ⌘Z 撤销。`)) return
              pageApisRef.current.get(pageIndex)?.clearPage()
            }}
          >
            清空本页
          </button>
          <span className="muted small ann-status">
            本页 {curStatus?.count ?? 0} 笔{curStatus?.saving ? ' · 保存中…' : curStatus?.dirty ? ' · 待保存' : ''}
          </span>
        </div>
      )}

      <div
        className={`reader-body ${wsSplit.mode === 'split' ? 'split' : 'focus'}`}
        style={{ '--split': `${wsSplit.ratio}%` } as React.CSSProperties}
      >
        {outlineOpen && outline.length > 0 && (
          <nav className="reader-outline" aria-label="文档目录">
            <div className="reader-outline-head">
              <span className="small">目录</span>
              <button className="icon-btn" aria-label="收起目录" onClick={() => setOutlineOpen(false)}>×</button>
            </div>
            <ul>
              {outline.map((item, i) => (
                <li key={`${i}-${item.title}`}>
                  <button
                    className={`outline-item ${item.pageIndex === pageIndex ? 'active' : ''}`}
                    style={{ paddingLeft: 10 + item.depth * 12 }}
                    disabled={item.pageIndex === null}
                    aria-current={item.pageIndex === pageIndex ? 'true' : undefined}
                    onClick={() => { if (item.pageIndex !== null) scrollToPage(item.pageIndex) }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={`page-scroll ${layout === 'continuous' ? 'continuous' : ''}`} ref={scrollRef}>
          {docState === 'loading' && <div className="muted reader-loading">正在打开文档…</div>}
          {pages}
        </div>

        {wsSplit.mode === 'split' && (
          <div
            className="reader-split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整材料与笔记分栏宽度"
            title="拖拽调整 · 双击复位 60:40"
            tabIndex={0}
            onDoubleClick={() => updateWsSplit({ ratio: 60 })}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              updateWsSplit({ ratio: Math.round(Math.min(70, Math.max(40, wsSplit.ratio + (e.key === 'ArrowLeft' ? -2 : 2)))) })
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              const startX = e.clientX
              const startRatio = wsSplit.ratio
              const width = (e.currentTarget.parentElement?.getBoundingClientRect().width) || 1
              const onMove = (ev: PointerEvent): void => {
                const next = startRatio + ((ev.clientX - startX) / width) * 100
                updateWsSplit({ ratio: Math.round(Math.min(70, Math.max(40, next))) })
              }
              const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
          />
        )}

        <aside className="reader-side">
          {open && docState === 'ready' ? (
            <ReadingWorkspacePanel
              docType={open.docType}
              spaceId={open.spaceId}
              registerFlusher={registerPanelFlusher}
              documentId={open.documentId}
              versionId={open.versionId}
              pageIndex={pageIndex}
              refreshKey={panelKey}
              initialSelectedNoteId={selectedNoteId}
              notePreviewDefaultOn={wsSplit.mode === 'split'}
              onReaderSplitInit={onReaderSplitInit}
              bindSplitWriter={bindSplitWriter}
              onJumpToAnchor={(_anchorId, targetPage, rects) => {
                scrollToPage(targetPage)
                setJumpFlash(targetPage, rects)
              }}
              onOpenFullEditor={(noteId) => nav.go({ kind: 'note', noteId })}
            />
          ) : (
            <div className="muted small">打开材料后，这里会显示它的笔记。</div>
          )}
        </aside>
      </div>

      {pendingSel && (
        <div
          className="sel-popover"
          style={{
            // 选区靠下/靠右时把浮层夹回视口内：否则浮层（约 300px 高）会伸出屏幕，按钮点不到
            left: Math.max(8, Math.min(pendingSel.x + 12, window.innerWidth - 352)),
            top: Math.max(8, Math.min(pendingSel.y + 12, window.innerHeight - 308))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              closePendingSel()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void saveAsNoteHere()
            }
          }}
        >
          <div className="sel-popover-head">在这里记笔记</div>
          {pendingSel.quote && <div className="sel-quote">{pendingSel.quote.slice(0, 200)}</div>}
          <textarea
            className="input sel-body"
            placeholder="写下你的理解或问题…（支持 Markdown / LaTeX）"
            value={selBody}
            onChange={(e) => setSelBody(e.target.value)}
            rows={3}
            autoFocus
            aria-label="笔记内容"
          />
          <details className="sel-optional">
            <summary className="muted small">改个名字（可选）</summary>
            <div className="sel-popover-row">
              <input
                className="input"
                placeholder={pendingSel.quote ? pendingSel.quote.slice(0, 30) : `第 ${pendingSel.pageIndex + 1} 页摘录`}
                value={selTitle}
                onChange={(e) => setSelTitle(e.target.value)}
                aria-label="笔记标题"
              />

            </div>
          </details>
          <div className="sel-popover-actions">
            <button className="btn btn-primary" onClick={() => void saveAsNoteHere()}>
              记在这里
            </button>
            <button className="btn" onClick={() => setPickingForAnchor(pendingSel)}>
              加到已有笔记…
            </button>
            <button className="btn btn-ghost" onClick={() => void saveAnchorOnly()}>
              只留标记
            </button>
          </div>
        </div>
      )}
      {pickingForAnchor && (
        <NotePicker
          onPick={(n) => void attachToExisting(n.id)}
          onClose={() => setPickingForAnchor(null)}
        />
      )}
    </div>
  )
}

/** 旋转是否交换宽高（90°/270°） */
function swappedHeight(size: { w: number; h: number }, rotation: number): number {
  return Math.floor((rotation % 180 !== 0 ? size.w : size.h))
}
function swappedWidth(size: { w: number; h: number }, rotation: number): number {
  return Math.floor((rotation % 180 !== 0 ? size.h : size.w))
}

function clampPage(p: number, numPages: number): number {
  return Math.max(0, Math.min(p, numPages - 1))
}

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s))
}
