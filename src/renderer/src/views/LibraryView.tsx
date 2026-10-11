import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Nav } from '../App'
import { useToast } from '../components/Toast'
import { Modal, NotePicker, ImagePreview } from '../components/Picker'
import { ContextMenu, type ContextMenuEntry } from '../components/ContextMenu'
import { Icon } from '../components/Icon'
import { useStudySpace } from '../study-space'
import { useAsyncData } from '../lib/use-async-data'
import { useRemarkSaver } from '../lib/use-remark-saver'
import type { RemarkState } from '../lib/remark-saver'
import { entryToBibtex } from '@shared/bibtex'
import { DOC_TYPE_LABELS, SECTION_COLORS, type DocType, type EntryMeta, type FulltextIndexStatus, type LibraryConflict, type LibraryDiagnostics, type LibraryFacetKind, type LibrarySearchHit, type LibrarySection, type LibrarySort, type SectionColor } from '@shared/types'
import { assetUrl } from '@shared/api'

/** 排序偏好跨会话持久化（与阅读器布局同理：本地服务端口随机，localStorage 不可靠） */
const SORT_KEY = 'library-sort'

/** 照片备注保存状态行：saved 时静默（默认即已保存），其余状态可见、失败可重试（P0-3 状态机随照片迁入） */
function PhotoRemarkStatus({ state, onRetry }: { state: RemarkState | null; onRetry(): void }): React.ReactElement | null {
  if (!state || state.status === 'saved') return null
  if (state.status === 'dirty') return <div className="status-dirty small">未保存…</div>
  if (state.status === 'saving') return <div className="status-saving small">保存中…</div>
  return (
    <div className="status-error small" role="alert">
      保存失败：{state.error}
      <button className="btn btn-sm" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}

const SORT_OPTIONS: Array<[LibrarySort, string]> = [
  ['updated', '最近更新'],
  ['created', '最近导入'],
  ['title', '标题'],
  ['author', '第一作者'],
  ['year', '年份']
]

interface SectionsInfo {
  sections: LibrarySection[]
  conflicts: LibraryConflict[]
  diagnostics: LibraryDiagnostics
}

type Filters = Partial<Record<LibraryFacetKind, string[]>>

const SECTION_INBOX = '待整理'

/** 颜色标签的中文名（右键菜单与 aria-label 共用） */
const SECTION_COLOR_LABELS: Record<SectionColor, string> = {
  red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色', gray: '灰色'
}

/** 分区行上下文菜单的打开位置 */
interface SectionMenuState {
  name: string
  x: number
  y: number
}

export function LibraryView({ nav, initialNeedsReview, query, onQuery }: { nav: Nav; initialNeedsReview?: boolean; query: string; onQuery(value: string): void }): React.ReactElement {
  const { scope, spaces } = useStudySpace()
  const toast = useToast()
  const searchQ = query
  const [docType, setDocType] = useState<'all' | DocType>('all')
  const [starredOnly, setStarredOnly] = useState(false)
  // 分区管理弹窗：新建 / 重命名 / 删除（条目移回待整理）
  const [sectionModal, setSectionModal] = useState<null | { mode: 'create' } | { mode: 'rename'; name: string } | { mode: 'delete'; name: string; count: number }>(null)
  const [sectionName, setSectionName] = useState('')
  const [sectionBusy, setSectionBusy] = useState(false)
  const [sectionMenu, setSectionMenu] = useState<SectionMenuState | null>(null)
  // 导入方式菜单：浏览器 / Zotero / 移入已有材料 / 导入照片 收进主按钮旁的「⋯」，顶部不再排一排按钮
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null)
  const [importingPhotos, setImportingPhotos] = useState(false)
  const [photoPicking, setPhotoPicking] = useState<string | null>(null)
  const [previewImg, setPreviewImg] = useState<string | null>(null)

  /** 照片导入（原在收件箱；入口移到「⋯」菜单，落点与展示位都在文献库「待整理」） */
  const importPhotos = async (): Promise<void> => {
    setImportingPhotos(true)
    try {
      const paths = await window.api.dialogOpenImages()
      if (!paths?.length) return
      const results = await window.api.captureImport(paths)
      for (const r of results) {
        const name = r.path.split('/').pop() ?? r.path
        if (r.ok && r.duplicate) toast.push(`已导入过该照片：${name}`, 'info')
        else if (r.ok) toast.push(`已导入：${name}`, 'success')
        else toast.push(`导入失败 ${name}：${r.error}`, 'error')
      }
      await photos.reload()
    } catch (err) {
      toast.push(`导入出错：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setImportingPhotos(false)
    }
  }

  const archivePhoto = async (id: string): Promise<void> => {
    try {
      await window.api.captureSave(id, { inboxStatus: 'filed' })
      toast.push('已归档', 'success')
      await photos.reload()
    } catch (err) {
      toast.push(`操作失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const attachPhoto = async (captureId: string, noteId: string): Promise<void> => {
    try {
      const r = await window.api.noteAttachCapture(noteId, captureId)
      await window.api.captureSave(captureId, { inboxStatus: 'filed' })
      toast.push(r.already ? '该照片已关联此笔记' : '已关联并归档', r.already ? 'info' : 'success')
      setPhotoPicking(null)
      await photos.reload()
    } catch (err) {
      toast.push(`关联失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const [needsReview, setNeedsReview] = useState(initialNeedsReview ?? false)
  const [filters, setFilters] = useState<Filters>({})
  const [sort, setSort] = useState<LibrarySort>('updated')
  const [infoEntry, setInfoEntry] = useState<{ id: string; title: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [zoteroBusy, setZoteroBusy] = useState(false)
  const [browserImportHelp, setBrowserImportHelp] = useState(false)
  const [existing, setExisting] = useState<Awaited<ReturnType<typeof window.api.docList>> | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const currentSpace = spaces.find((s) => s.id === scope)

  // 检索式输入：防抖统一交给 useAsyncData（此前 250ms 手写防抖 + 120ms 框架防抖叠加，
  // 每次检索多等约 370ms，且手写计时器在组件重挂载后仍会 setState）
  const onQueryInput = (value: string) => {
    onQuery(value)
  }

  // 排序偏好：启动读回，切换即写盘（与阅读器布局同一套 pref 通道）
  useEffect(() => {
    let cancelled = false
    void window.api
      .prefGet(SORT_KEY)
      .then((v) => {
        if (!cancelled && SORT_OPTIONS.some(([k]) => k === v)) setSort(v as LibrarySort)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const switchSort = (next: LibrarySort): void => {
    setSort(next)
    void window.api.prefSet(SORT_KEY, next).catch(() => undefined)
  }

  const filtersKey = JSON.stringify(filters)
  // 检索与库信息（分区/冲突/诊断）拆成两份加载：全文索引完成只刷新诊断，不重跑标题/标签检索
  const search = useAsyncData(async () => {
    return window.api.librarySearch({
      q: searchQ,
      filters,
      spaceId: scope,
      status: needsReview ? 'needs-review' : 'all',
      starred: starredOnly ? true : undefined,
      sort
    })
  }, [searchQ, filtersKey, needsReview, scope, starredOnly, sort], { debounceMs: 250 })

  const infoList = useAsyncData(async () => {
    const [sections, conflicts, diagnostics] = await Promise.all([
      window.api.librarySections(),
      window.api.libraryConflicts(),
      window.api.libraryDiagnostics()
    ])
    return { sections, conflicts, diagnostics }
  }, [scope, needsReview])

  const res = search.data ?? null
  const info = infoList.data ?? null
  // 全量刷新（导入/元数据/分区操作后都走这里）：检索与库信息一起重取，语义与拆分前一致
  const refresh = useCallback((): Promise<void> => {
    return Promise.all([search.reload(), infoList.reload()]).then(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const refreshInfo = infoList.reload

  // 分页（「加载更多」）：第一页仍走 useAsyncData；追加页另存，避免与防抖/刷新互相打架
  const [extraHits, setExtraHits] = useState<LibrarySearchHit[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  // 第一页变化（查询/筛选/刷新）→ 清空追加页，避免混入上一条查询的结果
  useEffect(() => { setExtraHits([]) }, [res])
  const allHits = useMemo(() => (extraHits.length ? [...(res?.hits ?? []), ...extraHits] : (res?.hits ?? [])), [res, extraHits])
  const loadMore = async (): Promise<void> => {
    if (!res || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await window.api.librarySearch({
        q: searchQ, filters, spaceId: scope, status: needsReview ? 'needs-review' : 'all',
        starred: starredOnly ? true : undefined, sort, offset: allHits.length
      })
      setExtraHits((prev) => {
        const seen = new Set([...(res.hits ?? []).map((h) => h.entry.id), ...prev.map((h) => h.entry.id)])
        return [...prev, ...next.hits.filter((h) => !seen.has(h.entry.id))]
      })
    } catch (err) { toast.push(`加载更多失败：${errMsg(err)}`, 'error') }
    finally { setLoadingMore(false) }
  }

  // 库变更（本机写入或 iCloud 外部写入）自动刷新；视图因 key={scope} 会重挂载，必须取消订阅。
  // kind 全为 'fulltext' = 后台全文索引完成：只刷新诊断横幅，**不重跑检索**（architecture §15）
  useEffect(() => {
    return window.api.onLibraryChanged((payload) => {
      if (payload.kinds.length > 0 && payload.kinds.every((k) => k === 'fulltext')) {
        refreshInfo()
        return
      }
      void refresh()
      void refreshInfo()
      window.dispatchEvent(new Event('mathwb:counts-changed'))
    })
  }, [refresh, refreshInfo])

  // 阅读优先（2026-10-09 分流）：「阅读中」= 有阅读位置的文献，客户端过滤（不是分区，不走服务端筛选）
  const [readingOnly, setReadingOnly] = useState(false)
  const visible = useMemo(() => {
    return allHits.filter((h) =>
      (docType === 'all' || h.entry.docType === docType) && (!readingOnly || h.entry.readingState != null))
  }, [allHits, docType, readingOnly])

  const activeFacets = useMemo(() => Object.entries(filters).flatMap(([kind, values]) => (values ?? []).map((v) => ({ kind: kind as LibraryFacetKind, value: v }))), [filters])

  const toggleFacet = (kind: LibraryFacetKind, value: string) => {
    setFilters((prev) => {
      const current = prev[kind] ?? []
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
      const out = { ...prev }
      if (next.length) out[kind] = next
      else delete out[kind]
      return out
    })
  }

  /**
   * 左侧分区栏的选中态 = filters.section。
   * 单一来源：选中分区与分面筛选共用同一份 filters，因此「点分区 → 过滤」天然生效，
   * 顶部「生效筛选」芯片也随之出现，不会出现「侧栏高亮了一栏但列表没变」的错位。
   */
  const section = filters.section?.[0] ?? null
  const setSection = useCallback((name: string | null) => {
    setFilters((prev) => {
      const out = { ...prev }
      if (name) out.section = [name]
      else delete out.section
      return out
    })
  }, [])

  // 演草纸照片（收件箱已删，照片的展示位 = 文献库「待整理」；读取仍走 capture 索引，文件不动）
  const photos = useAsyncData(
    () => (!starredOnly && !readingOnly && section === SECTION_INBOX ? window.api.captureList({ inboxStatus: 'inbox' }) : Promise.resolve([])),
    [section, starredOnly, readingOnly]
  )
  // 照片备注：与原收件箱同一条自动保存管线（防抖 + baseHash 保护 + 冲刷握手），能力零丢失
  const { saver: photoSaver, states: photoStates } = useRemarkSaver((id, value) => window.api.captureSave(id, { context: value }))
  useEffect(() => {
    for (const c of photos.data ?? []) photoSaver.syncServer(c.id, c.context ?? '')
  }, [photos.data, photoSaver])
  useEffect(() => {
    nav.registerFlusher(() => photoSaver.flushAll())
    return () => nav.registerFlusher(null)
  }, [nav, photoSaver])

  const openSectionMenu = (name: string, x: number, y: number) => setSectionMenu({ name, x, y })
  /** 菜单入口：右键用指针坐标，「⋯」按钮用自身矩形上缘（菜单夹取逻辑会把它拉回视口内） */
  const openSectionMenuFrom = (name: string, e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'contextmenu' || e.clientX) { openSectionMenu(name, e.clientX, e.clientY); return }
    const r = e.currentTarget.getBoundingClientRect()
    openSectionMenu(name, r.right - 4, r.bottom + 4)
  }

  const openSectionFolder = async (name: string): Promise<void> => {
    try { await window.api.librarySectionReveal(name) }
    catch (err) { toast.push(`打开文件夹失败：${errMsg(err)}`, 'error') }
  }

  const setSectionColor = async (name: string, color: SectionColor | null): Promise<void> => {
    try {
      await window.api.librarySectionColor(name, color)
      await refresh()
    } catch (err) { toast.push(`设置颜色失败：${errMsg(err)}`, 'error') }
  }

  const importMaterials = async () => {
    setImporting(true)
    try {
      const paths = await window.api.dialogOpenDocuments()
      if (!paths?.length) return
      const results = await window.api.docImport(paths, {
        spaceId: scope ?? null,
        docType: filterDefault()
      })
      let fresh = 0
      for (const result of results) {
        if (result.ok && result.duplicate) toast.push(`文档已存在：${nameOf(result.path)}。可从文献库检索查看。`, 'info')
        else if (result.ok) {
          toast.push(`已导入：${nameOf(result.path)}（落入「${SECTION_INBOX}」分区）`, 'success')
          fresh++
        } else toast.push(`导入失败 ${nameOf(result.path)}：${result.error}`, 'error')
      }
      if (fresh) setSection(null)
      await refresh()
    } catch (err) { toast.push(`导入出错：${errMsg(err)}`, 'error') }
    finally { setImporting(false) }
  }
  const filterDefault = (): DocType => currentSpace?.kind === 'research' ? 'paper' : 'book'

  const importZotero = async () => {
    const jsonPath = await window.api.dialogOpenJsonFile()
    if (!jsonPath) return
    const withFiles = window.confirm('是否同时导入附件 PDF？选择「确定」后请指定附件目录（如 Zotero 导出文件夹或 storage 目录）；「取消」则仅导入书目信息。')
    const storageDir = withFiles ? await window.api.dialogOpenDirectory() : null
    setZoteroBusy(true)
    try {
      const r = await window.api.zoteroImport(jsonPath, storageDir)
      if (r.total === 0) {
        // 一条都没识别出来：大概率选错文件/格式，必须明确报错而不是显示「成功」
        const detail = r.skipped ? `读取了 ${r.skipped} 行，均无法识别为文献条目` : '文件里没有条目'
        toast.push(`Zotero 导入：${detail}。请确认选择的是 Zotero「导出文库 → CSL JSON」格式的文件。`, 'error')
      } else {
        const parts = [`新建 ${r.created}`, `重复跳过 ${r.duplicated}`]
        if (r.skipped) parts.push(`无法识别 ${r.skipped}`)
        if (r.failed) parts.push(`失败 ${r.failed}`)
        toast.push(`Zotero 导入完成：${parts.join('，')}`, r.failed || r.skipped ? 'info' : 'success')
      }
      if (r.errors.length) toast.push(`首个失败：${r.errors[0]}`, 'error')
      await refresh()
    } catch (err) { toast.push(`Zotero 导入失败：${errMsg(err)}`, 'error') }
    finally { setZoteroBusy(false) }
  }

  /** 诊断横幅：全文索引重建（把缺失/过期/失败的条目重新入队，后台串行执行） */
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildNotice, setRebuildNotice] = useState('')
  const rebuildFulltext = async (): Promise<void> => {
    setRebuilding(true)
    try {
      const r = await window.api.libraryFulltextRebuild()
      setRebuildNotice(r.queued > 0 ? `已排队 ${r.queued} 条，后台进行中…` : '没有需要重建的条目')
      await refresh()
    } catch (err) { toast.push(`重建失败：${errMsg(err)}`, 'error') }
    finally { setRebuilding(false) }
  }

  /** 诊断横幅：把散装文件导入文献库（原件导入后移入系统废纸篓，可恢复） */
  const importUnfiled = async (u: { fileRel: string; fileName: string }): Promise<void> => {
    if (!window.confirm(`导入「${u.fileName}」到文献库？\n\n会复制进「待整理」分区；原件随后移入系统废纸篓（可从废纸篓恢复）。`)) return
    try {
      const r = await window.api.libraryImportUnfiled(u.fileRel)
      if (!r.ok) throw new Error(r.error ?? '导入失败')
      toast.push(r.duplicate ? `已在文献库中：${u.fileName}（原件保留）` : `已导入：${u.fileName}（原件已移入废纸篓）`, 'success')
      await refresh()
    } catch (err) { toast.push(`导入失败：${errMsg(err)}`, 'error') }
  }

  const showExisting = async () => {
    try { setExisting((await window.api.docList()).filter((d) => d.spaceId !== scope)) }
    catch (err) { toast.push(`加载失败：${errMsg(err)}`, 'error') }
  }
  const moveExisting = async (id: string) => {
    if (typeof scope !== 'string' || moving) return
    setMoving(id)
    try {
      await window.api.assignSpace('document', id, scope)
      setExisting((items) => items?.filter((d) => d.id !== id) ?? null)
      await refresh()
      toast.push('已移入当前学习区；原有笔记来源保持有效', 'success')
    } catch (err) { toast.push(`移动失败：${errMsg(err)}`, 'error') }
    finally { setMoving(null) }
  }

  const inboxInfo = info?.sections.find((s) => s.name === SECTION_INBOX)
  const sectionList = useMemo(() => (info?.sections ?? []).filter((s) => s.name !== SECTION_INBOX), [info])
  const totalEntries = info?.sections.reduce((acc, s) => acc + s.count, 0) ?? 0

  // ---------- 分区管理 ----------
  const submitSectionModal = async (): Promise<void> => {
    if (sectionBusy || !sectionModal) return
    const name = sectionName.trim()
    setSectionBusy(true)
    try {
      if (sectionModal.mode === 'create') {
        await window.api.librarySectionCreate(name)
        setStarredOnly(false)
        setSection(name)
        toast.push(`已新建分区「${name}」`, 'success')
      } else if (sectionModal.mode === 'rename') {
        await window.api.librarySectionRename(sectionModal.name, name)
        if (section === sectionModal.name) setSection(name)
        toast.push('分区已重命名', 'success')
      } else {
        await window.api.librarySectionDelete(sectionModal.name)
        if (section === sectionModal.name) setSection(null)
        toast.push(`分区已删除，条目移回「${SECTION_INBOX}」`, 'success')
      }
      setSectionModal(null)
      await refresh()
    } catch (err) { toast.push(errMsg(err), 'error') }
    finally { setSectionBusy(false) }
  }

  const toggleStar = async (id: string, starred: boolean): Promise<void> => {
    try {
      await window.api.libraryEntryUpdate(id, { starred })
      await refresh()
    } catch (err) { toast.push(`收藏失败：${errMsg(err)}`, 'error') }
  }

  // ---------- 多选与批量操作 ----------
  // ⌘/Ctrl 点选切换、Shift 点选选区段；批量动作走既有单条接口循环，逐条计数失败数。
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const lastClickedRef = useRef<string | null>(null)

  const toggleSelect = (id: string): void => {
    lastClickedRef.current = id
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Shift 点选：从上次点击项到当前项的区间（按当前可见顺序） */
  const selectRange = (id: string): void => {
    const from = lastClickedRef.current
    const ids = visible.map((h) => h.entry.id)
    const a = from ? ids.indexOf(from) : -1
    const b = ids.indexOf(id)
    if (a < 0 || b < 0) {
      toggleSelect(id)
      return
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    setSelected(new Set(ids.slice(lo, hi + 1)))
    lastClickedRef.current = id
  }

  // 库内容/筛选变化后，已不可见的 id 要从选中集合里收敛掉，否则批量操作会作用到看不见的条目上
  useEffect(() => {
    if (!res) return
    setSelected((prev) => {
      if (!prev.size) return prev
      const visibleIds = new Set(visible.map((h) => h.entry.id))
      const next = new Set([...prev].filter((id) => visibleIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [res, visible])

  const runBulk = async (label: string, act: (id: string) => Promise<void>): Promise<void> => {
    const ids = [...selected]
    if (!ids.length) return
    setBulkBusy(true)
    let failed = 0
    for (const id of ids) {
      try {
        await act(id)
      } catch {
        failed++
      }
    }
    setBulkBusy(false)
    setSelected(new Set())
    await refresh()
    if (failed) toast.push(`${label}：成功 ${ids.length - failed} 条，失败 ${failed} 条（目标分区可能已有同名条目）`, 'error')
    else toast.push(`${label}：${ids.length} 条`, 'success')
  }

  // 空态文案分四种成因：搜不到 / 分区本身就是空的 / 其它筛选筛空 / 库里没东西
  const emptyCopy = (() => {
    if (readingOnly) return { title: '还没有读到一半的文献', body: '打开任意一篇开始读，读过的会出现在「阅读中」并记住位置。' }
    if (searchQ.trim()) return { title: '没有匹配的文献', body: '换个检索词，或清除筛选条件。' }
    if (section) {
      return totalEntries
        ? { title: `「${section}」里还没有文献`, body: '把材料移入这个分区，或换一个分区看看。' }
        : { title: '从一篇文献开始', body: '导入一篇论文或一本教材，打开就能开始读。' }
    }
    if (activeFacets.length) return { title: '没有匹配的文献', body: '清除筛选条件后重试。' }
    return totalEntries ? { title: '此筛选暂无文献', body: '换个材料类型或状态试试。' } : { title: '从一篇文献开始', body: '导入一篇论文或一本教材，打开就能开始读。' }
  })()

  return <div className="view library-view">
    <aside className="library-sections" aria-label="收藏与分区">
      <button className={`section-node ${readingOnly ? 'section-node-active' : ''}`} aria-pressed={readingOnly}
        title="有阅读位置的文献置顶显示"
        onClick={() => { setReadingOnly((v) => !v); setStarredOnly(false); setSection(null) }}>
        <Icon name="reader" size={15} /><span className="section-node-name">阅读中</span>
      </button>
      <button className={`section-node ${starredOnly ? 'section-node-active' : ''}`} aria-pressed={starredOnly} onClick={() => { setStarredOnly(true); setReadingOnly(false); setSection(null) }}>
        <Icon name="star" size={15} /><span className="section-node-name">收藏</span>
        <span className="section-count">{res?.starredCount ?? 0}</span>
      </button>
      <button className={`section-node ${!starredOnly && !readingOnly && section === null ? 'section-node-active' : ''}`} aria-pressed={!starredOnly && !readingOnly && section === null} onClick={() => { setStarredOnly(false); setReadingOnly(false); setSection(null) }}>
        <Icon name="library" size={15} /><span className="section-node-name">全部文献</span>
        <span className="section-count">{totalEntries}</span>
      </button>
      <button className={`section-node ${!starredOnly && !readingOnly && section === SECTION_INBOX ? 'section-node-active' : ''}`} aria-pressed={!starredOnly && !readingOnly && section === SECTION_INBOX}
        data-colored={inboxInfo?.color ?? undefined}
        style={inboxInfo?.color ? ({ '--sec-color': `var(--section-color-${inboxInfo.color})` } as CSSProperties) : undefined}
        onContextMenu={(e) => openSectionMenuFrom(SECTION_INBOX, e)}
        onClick={() => { setStarredOnly(false); setReadingOnly(false); setSection(SECTION_INBOX) }}>
        <Icon name="inbox" size={15} /><span className="section-node-name">{SECTION_INBOX}</span>
        <span className="section-count">{inboxInfo ? inboxInfo.count : 0}{inboxInfo?.needsReview ? <span className="section-review"> ·{inboxInfo.needsReview}待补全</span> : null}</span>
      </button>
      <div className="section-divider"><span>分区</span></div>
      {sectionList.map((s) => (
        <div key={s.name}
          className={`section-node section-node-row ${!starredOnly && section === s.name ? 'section-node-active' : ''}`}
          data-colored={s.color ?? undefined}
          style={s.color ? ({ '--sec-color': `var(--section-color-${s.color})` } as CSSProperties) : undefined}
          onContextMenu={(e) => openSectionMenuFrom(s.name, e)}>
          <button className="section-node-main" title={s.name} onClick={() => { setStarredOnly(false); setSection(s.name) }}>
            <Icon name="folder" size={15} /><span className="section-node-name">{s.name}</span>
            <span className="section-count">{s.count}{s.needsReview ? <span className="section-review"> ·{s.needsReview}</span> : null}</span>
          </button>
          <span className="section-node-actions">
            <button className="icon-btn section-node-menu" aria-label={`分区选项 ${s.name}`} title="分区选项：颜色标签 / 重命名 / 删除" onClick={(e) => openSectionMenuFrom(s.name, e)}><Icon name="more" size={14} /></button>
          </span>
        </div>
      ))}
      <button className="section-node section-create" onClick={() => { setSectionName(''); setSectionModal({ mode: 'create' }) }}>
        <Icon name="plus" size={15} /><span className="section-node-name">新建分区</span>
      </button>
    </aside>
    <div className="view view-scroll library-main">
    <div className="view-head">
      <h1>文献</h1>
      <div className="view-actions">
        <button
          className="btn"
          aria-haspopup="menu"
          aria-label="其他导入方式"
          title="浏览器导入 / Zotero 导入 / 移入已有材料"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setImportMenu({ x: r.left, y: r.bottom + 6 })
          }}
        >
          <Icon name="more" size={16} />
        </button>
        <button className="btn btn-primary" onClick={() => void importMaterials()} disabled={importing}><Icon name="plus" size={16} />{importing ? '导入中…' : '导入文献'}</button>
      </div>
    </div>
    <p className="muted view-desc">{currentSpace ? `新材料归入“${currentSpace.name}”学习区，文件存入「${SECTION_INBOX}」分区，稍后归类。` : '挑一篇开始读；读的时候随手记笔记，笔记跟着文献走。'}</p>
    <label className="search-field library-search">
      <Icon name="search" />
      <input className="input search-input" aria-label="检索文献（标题和关键词）" placeholder="搜索标题和关键词；字段示例：作者:张三 年份:2020-2025 标签:弱辨识" value={query} onChange={(e) => onQueryInput(e.target.value)} />
    </label>

    <div className="library-filters library-type-tabs" role="group" aria-label="材料类型筛选">
      {([['all', '全部'], ['book', '教材'], ['paper', '论文'], ['other', '其他']] as const).map(([kind, label]) =>
        <button key={kind} className={`chip ${docType === kind ? 'chip-active' : ''}`} aria-pressed={docType === kind} onClick={() => setDocType(kind)}>{label}</button>)}
      <button className={`chip ${needsReview ? 'chip-active' : ''}`} aria-pressed={needsReview} onClick={() => setNeedsReview((v) => !v)}>待补全{info?.sections.reduce((a, s) => a + s.needsReview, 0) ? ` ${info.sections.reduce((a, s) => a + s.needsReview, 0)}` : ''}</button>
      <label className="sort-field muted small">
        排序
        <select className="input sort-select" aria-label="文献排序方式" value={sort} onChange={(e) => switchSort(e.target.value as LibrarySort)}>
          {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <span className="muted small">{visible.length} / {res?.total ?? totalEntries} 条</span>
    </div>

    {/* 管理与诊断（2026-10-09 分流）：有需要处理的事项才出现，健康时零打扰；收纳冲突/坏文件/散装/全文索引 */}
    {info && (() => {
      const issues = info.conflicts.length + info.diagnostics.malformed.length + info.diagnostics.unfiled.length
      const ftPending = info.diagnostics.fulltext.pdfTotal > 0 ? info.diagnostics.fulltext.pdfTotal - info.diagnostics.fulltext.indexed : 0
      if (issues === 0 && ftPending === 0) return null
      return (
        <details className="conflict-banner lib-manage">
          <summary role="button">
            管理{issues > 0 ? ` · ${issues} 项待处理` : ''}{ftPending > 0 ? `${issues > 0 ? ' · ' : ' · '}全文索引 ${info.diagnostics.fulltext.indexed}/${info.diagnostics.fulltext.pdfTotal} 篇` : ''}
          </summary>
          {info.conflicts.length > 0 && (
            <>
              <h3 className="lib-manage-h">同步冲突副本 {info.conflicts.length} 个</h3>
              <ul>{info.conflicts.map((c) => <li key={c.path}><span className="mono small">{c.path}</span></li>)}</ul>
              <p className="muted small">这些文件多由网盘同步产生（两台机器同时改动）。请核对后手动保留正确版本、删除多余副本。</p>
            </>
          )}
          {info.diagnostics.malformed.length > 0 && (
            <>
              <h3 className="lib-manage-h">{info.diagnostics.malformed.length} 个文件无法读取</h3>
              <ul>{info.diagnostics.malformed.map((p) => <li key={p}><span className="mono small">{p}</span></li>)}</ul>
              <p className="muted small">
                这些文件仍在磁盘上（元数据类文件会先备份为 <span className="mono">.broken</span>）；应用不会自动修改它们。
                修复内容后等待自动重扫或重启应用即可恢复；笔记的 .md 文件保持原样，可直接在文件夹里修复。
              </p>
            </>
          )}
          {info.diagnostics.unfiled.length > 0 && (
            <>
              <h3 className="lib-manage-h">{info.diagnostics.unfiled.length} 个文件放在分区目录里但未入库</h3>
              <ul>{info.diagnostics.unfiled.map((u) => {
                const sec = sectionOfRel(u.fileRel)
                return <li key={u.fileRel} className="unfiled-row">
                  <span className="mono small">{u.fileName}</span>
                  <span className="muted small">{Math.max(1, Math.round(u.byteSize / 1024))} KB</span>
                  <button className="btn btn-sm" onClick={() => void importUnfiled(u)}>导入</button>
                  {sec && <button className="btn btn-sm" onClick={() => void openSectionFolder(sec)}>在文件夹中显示</button>}
                </li>
              })}</ul>
              <p className="muted small">
                这些文件不会被自动改动。点「导入」可把它收进文献库（复制进「待整理」，原件移入系统废纸篓、可恢复）；
                也可以手动把它移入某个条目文件夹。
              </p>
            </>
          )}
          {ftPending > 0 && (
            <div className="fulltext-banner">
              <span className="muted small">全文索引 {info.diagnostics.fulltext.indexed} / {info.diagnostics.fulltext.pdfTotal} 篇——用于打开文档后的正文查找；文献检索只搜标题和关键词，不受索引进度影响。</span>
              <button className="btn btn-sm" disabled={rebuilding} onClick={() => void rebuildFulltext()}>
                {rebuilding ? '排队中…' : '立即重建'}
              </button>
              {rebuildNotice && <span className="muted small">{rebuildNotice}</span>}
            </div>
          )}
        </details>
      )
    })()}

    {res && res.facets && (res.facets.author.length > 0 || res.facets.tag.length > 0 || res.facets.year.length > 0 || res.facets.venue.length > 0) &&
      <details className="list-filter" open={activeFacets.length > 0}>
        <summary>分面筛选</summary>
        {(['author', 'year', 'tag', 'venue'] as LibraryFacetKind[]).map((kind) => {
          const label = { author: '作者', year: '年份', tag: '标签', venue: '期刊', section: '分区' }[kind]
          const values = res.facets[kind]
          if (!values.length) return null
          return <div className="facet-row" key={kind}>
            <span className="facet-label muted small">{label}</span>
            <div className="facet-chips">
              {values.slice(0, 12).map((f) =>
                <button key={f.value} className={`chip ${(filters[kind] ?? []).includes(f.value) ? 'chip-active' : ''}`} aria-pressed={(filters[kind] ?? []).includes(f.value)} onClick={() => toggleFacet(kind, f.value)}>
                  {f.value} <span className="muted small">{f.count}</span>
                </button>)}
            </div>
          </div>
        })}
      </details>}

    {activeFacets.length > 0 && <div className="library-filters" aria-label="生效筛选">
      {activeFacets.map((f) =>
        <button key={`${f.kind}:${f.value}`} className="chip chip-active" onClick={() => toggleFacet(f.kind, f.value)}>
          {{ author: '作者', year: '年份', tag: '标签', venue: '期刊', section: '分区' }[f.kind]}:{f.value} ×
        </button>)}
    </div>}

    {search.loading && <div className="muted">检索中…</div>}
    {search.error && <div className="empty-state" role="alert">检索失败：{search.error}<button className="btn" onClick={() => void refresh()}>重试</button></div>}
    {!search.loading && !search.error && visible.length === 0 && <div className="empty-state">
      <div className="empty-title">{emptyCopy.title}</div>
      <div>{emptyCopy.body}</div>
      {totalEntries === 0 && <div className="empty-actions">
        <button className="btn btn-primary" onClick={() => void importMaterials()} disabled={importing}>{importing ? '导入中…' : '导入第一份文献'}</button>
        <span className="muted small">学习区可以之后再整理</span>
      </div>}
      {totalEntries > 0 && activeFacets.length > 0 && <div className="empty-actions">
        <button className="btn" onClick={() => { setFilters({}); setNeedsReview(false); setStarredOnly(false) }}>清除全部筛选</button>
      </div>}
    </div>}

    {selected.size > 0 && (
      <div className="bulk-bar" role="toolbar" aria-label="批量操作">
        <span className="small">已选 {selected.size} 条</span>
        <select
          className="input sort-select"
          aria-label="批量移入分区"
          value=""
          disabled={bulkBusy}
          onChange={(e) => {
            const target = e.target.value
            if (target) void runBulk(`已移入「${target}」`, (id) => window.api.libraryEntryMove(id, target))
          }}
        >
          <option value="">移入分区…</option>
          {(info?.sections ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <button className="btn btn-sm" disabled={bulkBusy} onClick={() => void runBulk('已收藏', (id) => window.api.libraryEntryUpdate(id, { starred: true }))}>收藏</button>
        <button className="btn btn-sm" disabled={bulkBusy} onClick={() => void runBulk('已取消收藏', (id) => window.api.libraryEntryUpdate(id, { starred: false }))}>取消收藏</button>
        <button className="btn btn-sm" disabled={bulkBusy} onClick={() => setSelected(new Set())}>清除选择</button>
        {bulkBusy && <span className="muted small">处理中…</span>}
      </div>
    )}

    <div className="doc-list">
      {visible.map((hit) => {
        const meta = hit.entry
        const file = meta.files[meta.files.length - 1]
        const hasFile = Boolean(file) && !file.missing
        const mediaType = file?.mediaType ?? 'application/pdf'
        const progress = meta.readingState?.pageIndex !== undefined && file?.pageCount ? Math.min(100, Math.round(((meta.readingState.pageIndex + 1) / file.pageCount) * 100)) : 0
        const authorsShort = meta.authors.length > 3 ? `${meta.authors.slice(0, 3).join(', ')} 等` : meta.authors.join(', ')
        return <div className={`material-row ${selected.has(meta.id) ? 'selected' : ''}`} key={meta.id}>
          <label className="row-select" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected.has(meta.id)}
              onChange={() => toggleSelect(meta.id)}
              aria-label={`选择：${meta.title}`}
            />
          </label>
          <button className="doc-item" title={hasFile ? undefined : '该条目只有书目信息，还没有原件文件'}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) { e.preventDefault(); toggleSelect(meta.id); return }
              if (e.shiftKey) { e.preventDefault(); selectRange(meta.id); return }
              // 全文命中带页码：点行直接打开到命中页（没有页码时按阅读位置打开）
              if (hasFile) nav.go({ kind: mediaType === 'text/html' ? 'html' : 'reader', documentId: meta.id, ...(hit.match?.page != null && mediaType !== 'text/html' ? { jumpPageIndex: hit.match.page } : {}) })
            }}>
            {hasFile
              ? <span className={`format-badge ${mediaType === 'text/html' ? 'format-html' : ''}`}>{mediaType === 'text/html' ? 'HTML' : 'PDF'}</span>
              : <span className="tag">无原件</span>}
            <div className="doc-item-main">
              <div className="doc-title">
                {meta.status === 'needs-review' && <span className="tag tag-amber" title="书目信息待补全">待补全</span>}
                {meta.title}
              </div>
              <div className="doc-meta muted">
                <span className={`tag doc-type-${meta.docType}`}>{DOC_TYPE_LABELS[meta.docType]}</span>
                {authorsShort ? ` ${authorsShort} · ` : ' '}
                {meta.year ? `${meta.year}` : ''}
                {meta.venue ? ` · ${meta.venue}` : ''}
                {meta.tags.length ? ` · ${meta.tags.map((t) => `#${t}`).join(' ')}` : ''}
              </div>
              {/* 命中理由：哪个字段、上下文片段——检索时最有用的一行（此前命中来源完全不可见） */}
              {hit.match && <div className="doc-snippet">
                <span className="tag">{hit.match.field}</span>
                {hit.match.page != null && <span className="muted small">第 {hit.match.page + 1} 页</span>}
                <span className="doc-snippet-text muted small" title={hit.match.snippet}>{hit.match.snippet}</span>
              </div>}
              {progress > 0 && <div className="progress-track" aria-hidden="true"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>}
            </div>
            {/*
              位置 / 篇幅 / 时间移到右侧成列：它们是「定位信息」，不是「辨识信息」。
              留在左侧会让每行多出一整行高度（每行 89px → 62px，一屏 6.6 行 → 约 9 行）。
            */}
            <div className="doc-aside muted">
              <span className="doc-aside-section">{hit.section}</span>
              <span className="doc-aside-sub">
                {file?.pageCount ? `${file.pageCount} 页` : ''}
                {meta.readingState?.pageIndex !== undefined ? ` · 读到 ${meta.readingState.pageIndex + 1}` : ''}
              </span>
              <span className="doc-updated">{timeAgo(meta.updatedAt)}</span>
            </div>
            {/* 无原件时左侧已有「无原件」标记，这里不再重复一遍同样的字 */}
            {hasFile && <span className="doc-open">阅读 <Icon name="arrow" size={15} /></span>}
          </button>
          <div className="material-actions">
            <button
              className={`icon-btn star-btn ${meta.starred ? 'star-on' : ''}`}
              aria-pressed={Boolean(meta.starred)}
              aria-label={meta.starred ? `取消收藏：${meta.title}` : `收藏：${meta.title}`}
              title={meta.starred ? '取消收藏' : '收藏'}
              onClick={() => void toggleStar(meta.id, !meta.starred)}
            >
              <Icon name="star" size={15} />
            </button>
            <button className="btn btn-ghost btn-sm doc-info-btn" title="书目信息 / 分区 / BibTeX" aria-label={`文献信息：${meta.title}`} onClick={() => setInfoEntry({ id: meta.id, title: meta.title })}>⋯</button>
          </div>
        </div>
      })}
    </div>

    {/* 演草纸照片：收件箱已删，「待整理」分区是照片的展示位（文件仍由 capture 索引托管，不搬目录） */}
    {!starredOnly && !readingOnly && section === SECTION_INBOX && photos.error && (
      <div className="empty-state" role="alert">
        照片加载失败：{photos.error}
        <button className="btn" onClick={() => void photos.retry()}>重试</button>
      </div>
    )}
    {!starredOnly && !readingOnly && section === SECTION_INBOX && (photos.data?.length ?? 0) > 0 && (
      <section className="inbox-section">
        <div className="section-title">演草纸照片（{photos.data!.length}）</div>
        <div className="capture-grid inbox-grid">
          {photos.data!.map((c) => (
            <div key={c.id} className="inbox-card">
              <button className="inbox-thumb" onClick={() => setPreviewImg(assetUrl(c.assetId, 'display'))} title="查看大图">
                <img src={assetUrl(c.assetId, 'thumb')} alt={c.originalName} />
              </button>
              <div className="inbox-card-body">
                <div className="inbox-name" title={c.originalName}>{c.originalName}</div>
                <div className="muted small">{new Date(c.createdAt).toLocaleString('zh-CN', { hour12: false })}</div>
                <input
                  className="input input-sm"
                  placeholder="一句话说明（可后补）"
                  value={photoStates.get(c.id)?.value ?? c.context ?? ''}
                  onChange={(e) => photoSaver.edit(c.id, e.target.value)}
                  aria-label={`备注：${c.originalName}`}
                />
                <PhotoRemarkStatus state={photoStates.get(c.id) ?? null} onRetry={() => photoSaver.retry(c.id)} />
                <div className="inbox-actions">
                  <button className="btn btn-sm" onClick={() => setPhotoPicking(c.id)}>关联笔记…</button>
                  <button className="btn btn-sm" onClick={() => void archivePhoto(c.id)}>归档</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    )}

    {res && allHits.length < res.total && (
      <div className="list-more">
        <button className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? '加载中…' : `加载更多（已显示 ${allHits.length} / 共 ${res.total}）`}
        </button>
      </div>
    )}

    {photoPicking && <NotePicker
      onPick={(n) => void attachPhoto(photoPicking, n.id)}
      onClose={() => setPhotoPicking(null)}
    />}
    {previewImg && <ImagePreview src={previewImg} onClose={() => setPreviewImg(null)} />}
    {existing && <Modal title="移入已有材料" onClose={() => setExisting(null)} width={660}>
      <p className="muted small">选择后会将材料移到“{currentSpace?.name}”。已有笔记和原文链接不会被删除。</p>
      {!existing.length && <p className="muted">没有其他材料可移入。可以直接导入新文件。</p>}
      <div className="picker-list">{existing.map((doc) => <button className="picker-item" key={doc.id} disabled={Boolean(moving)} onClick={() => void moveExisting(doc.id)}>
        <span className="picker-item-title">{doc.title}</span><span className="muted small">{spaces.find((s) => s.id === doc.spaceId)?.name ?? '未分区'}</span><span>{moving === doc.id ? '移动中…' : '移入'}</span>
      </button>)}</div>
    </Modal>}
    {infoEntry && <EntryMetaModal entryId={infoEntry.id} onClose={() => setInfoEntry(null)} onSaved={async (changed) => {
      setInfoEntry(null)
      if (changed) {
        await refresh()
        toast.push('已保存文献信息', 'success')
      }
    }} />}
    {browserImportHelp && <BrowserImportModal onClose={() => setBrowserImportHelp(false)} />}
    {sectionModal && <Modal
      title={sectionModal.mode === 'create' ? '新建分区' : sectionModal.mode === 'rename' ? '重命名分区' : '删除分区'}
      onClose={() => setSectionModal(null)}
      width={440}
    >
      {sectionModal.mode !== 'delete' ? (
        <form onSubmit={(e) => { e.preventDefault(); void submitSectionModal() }} className="space-form">
          <label>分区名称<input className="input" aria-label="分区名称" value={sectionName} onChange={(e) => setSectionName(e.target.value)} placeholder="例如：弱辨识、模型校准" maxLength={60} autoFocus required /></label>
          <p className="muted small">分区即文献库文件夹（iCloud 里的明文目录），重命名随时可以做，条目不会受影响。</p>
          <div className="doc-info-actions">
            <button className="btn" type="button" onClick={() => setSectionModal(null)}>取消</button>
            <button className="btn btn-primary" type="submit" disabled={sectionBusy || !sectionName.trim()}>{sectionModal.mode === 'create' ? '创建分区' : '保存'}</button>
          </div>
        </form>
      ) : (
        <div className="space-form">
          <p>删除分区「{sectionModal.name}」？其中的 {sectionModal.count} 个条目将移回「{SECTION_INBOX}」，<strong>文献本身不会被删除</strong>。</p>
          <div className="doc-info-actions">
            <button className="btn" onClick={() => setSectionModal(null)}>取消</button>
            <button className="btn" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={sectionBusy} onClick={() => void submitSectionModal()}>删除分区</button>
          </div>
        </div>
      )}
    </Modal>}
    {importMenu && <ContextMenu
      x={importMenu.x}
      y={importMenu.y}
      ariaLabel="其他导入方式"
      onClose={() => setImportMenu(null)}
      entries={[
        { kind: 'item', key: 'imp-file', label: '从文件导入…', icon: <Icon name="plus" size={15} />, onSelect: () => void importMaterials() },
        { kind: 'item', key: 'imp-photos', label: importingPhotos ? '照片导入中…' : '导入照片…', icon: <Icon name="inbox" size={15} />, disabled: importingPhotos, onSelect: () => void importPhotos() },
        { kind: 'item', key: 'imp-browser', label: '浏览器导入', icon: <Icon name="arrow" size={15} />, onSelect: () => setBrowserImportHelp(true) },
        { kind: 'item', key: 'imp-zotero', label: 'Zotero 导入', icon: <Icon name="library" size={15} />, disabled: zoteroBusy, onSelect: () => void importZotero() },
        ...(currentSpace ? [{ kind: 'item' as const, key: 'imp-existing', label: '移入已有材料', icon: <Icon name="folder" size={15} />, onSelect: () => void showExisting() }] : [])
      ]}
    />}
    {sectionMenu && <SectionContextMenu state={sectionMenu} current={info?.sections.find((s) => s.name === sectionMenu.name) ?? null}
      isActive={section === sectionMenu.name}
      onClose={() => setSectionMenu(null)}
      onOpen={() => { setStarredOnly(false); setSection(sectionMenu.name) }}
      onSetColor={(color) => void setSectionColor(sectionMenu.name, color)}
      onRename={() => { setSectionName(sectionMenu.name); setSectionModal({ mode: 'rename', name: sectionMenu.name }) }}
      onDelete={() => setSectionModal({ mode: 'delete', name: sectionMenu.name, count: info?.sections.find((s) => s.name === sectionMenu.name)?.count ?? 0 })}
      onReveal={() => void openSectionFolder(sectionMenu.name)}
      onCreate={() => { setSectionName(''); setSectionModal({ mode: 'create' }) }} />}
    </div>
  </div>
}

/**
 * 分区右键菜单（macOS 风格标签色 + 目录命令）。
 * 「待整理」是真实目录（可设色、可在文件夹中显示），但不可改名/删除，故命令按分区能力裁剪。
 */
function SectionContextMenu({ state, current, isActive, onClose, onOpen, onSetColor, onRename, onDelete, onReveal, onCreate }: {
  state: SectionMenuState
  current: LibrarySection | null
  isActive: boolean
  onClose(): void
  onOpen(): void
  onSetColor(color: SectionColor | null): void
  onRename(): void
  onDelete(): void
  onReveal(): void
  onCreate(): void
}): React.ReactElement {
  const { name } = state
  const isInbox = name === SECTION_INBOX
  const color = current?.color ?? null
  const entries: ContextMenuEntry[] = [
    {
      kind: 'item',
      key: 'open',
      label: isActive ? '已在此分区' : '只看这个分区',
      checked: isActive,
      disabled: isActive,
      icon: <Icon name="folder" size={14} />,
      onSelect: onOpen
    },
    { kind: 'separator', key: 'sep-1' },
    ...(isInbox ? [] : [{
      kind: 'item' as const,
      key: 'rename',
      label: '重命名分区',
      ariaLabel: `重命名分区 ${name}`,
      icon: <Icon name="edit" size={14} />,
      onSelect: onRename
    }]),
    { kind: 'item', key: 'reveal', label: '在文件夹中显示', icon: <Icon name="library" size={14} />, onSelect: onReveal },
    { kind: 'item', key: 'create', label: '新建分区…', icon: <Icon name="plus" size={14} />, onSelect: onCreate },
    { kind: 'separator', key: 'sep-2', label: '颜色标签' },
    {
      kind: 'custom',
      key: 'colors',
      node: <div className="color-row" role="group" aria-label={`分区颜色：${name}`}>
        {SECTION_COLORS.map((c) => (
          <button key={c} type="button" role="menuitemradio" aria-checked={color === c} aria-label={SECTION_COLOR_LABELS[c]}
            title={SECTION_COLOR_LABELS[c]} className={`color-swatch color-dot-${c} ${color === c ? 'color-swatch-on' : ''}`}
            onClick={() => { onClose(); onSetColor(c) }} />
        ))}
        <button type="button" role="menuitemradio" aria-checked={color === null} aria-label="无颜色" title="无颜色"
          className={`color-swatch color-swatch-none ${color === null ? 'color-swatch-on' : ''}`}
          onClick={() => { onClose(); onSetColor(null) }}>✕</button>
      </div>
    },
    ...(isInbox ? [] : [
      { kind: 'separator' as const, key: 'sep-3' },
      {
        kind: 'item' as const,
        key: 'delete',
        label: '删除分区…',
        ariaLabel: `删除分区 ${name}`,
        danger: true,
        icon: <Icon name="trash" size={14} />,
        onSelect: onDelete
      }
    ])
  ]
  return <ContextMenu x={state.x} y={state.y} entries={entries} onClose={onClose} ariaLabel={`分区 ${name} 的操作`} />
}

/** 浏览器导入说明弹窗：连接信息（端口/令牌，供扩展选项页粘贴）+ 安装步骤 */
function BrowserImportModal({ onClose }: { onClose(): void }): React.ReactElement {
  const toast = useToast()
  const [info, setInfo] = useState<{ port: number; token: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.api.importInfo().then(setInfo).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.push(`已复制${label}`, 'success')
    } catch (err) { toast.push(`复制失败：${errMsg(err)}`, 'error') }
  }

  return <Modal title="浏览器导入" onClose={onClose} width={560}>
    <p className="muted small">在 Chrome / Edge 安装工作台扩展后，打开论文网页或 PDF，点一下浏览器工具栏的扩展图标，文献就会进入「待整理」。导入发生在本机（127.0.0.1），无上传。</p>
    {error && <p role="alert" className="status-error">{error}</p>}
    {info && <>
      <div className="doc-info-row">
        <label>服务端口（扩展默认一致，一般不用改）<span className="browser-import-kv"><code className="mono">{info.port}</code><button className="btn btn-sm" onClick={() => void copy(String(info.port), '端口')}>复制</button></span></label>
        <label>连接令牌（粘贴到扩展选项页）<span className="browser-import-kv"><code className="mono small">{info.token.slice(0, 8)}…{info.token.slice(-4)}</code><button className="btn btn-sm" onClick={() => void copy(info.token, '令牌')}>复制令牌</button></span></label>
      </div>
    </>}
    <ol className="browser-import-steps">
      <li>点下方「打开扩展文件夹」，记住这个文件夹的位置。</li>
      <li>浏览器地址栏进入扩展管理页：<code className="mono">chrome://extensions</code>（Edge 为 <code className="mono">edge://extensions</code>）。</li>
      <li>打开「开发者模式」，点「加载已解压的扩展程序」，选择刚才的 extension 文件夹。</li>
      <li>固定工具栏图标；首次使用请到扩展的「选项」里核对服务地址并粘贴连接令牌。</li>
    </ol>
    <div className="doc-info-actions">
      <button className="btn" onClick={() => void window.api.importOpenExtensionDir().catch((err) => toast.push(errMsg(err), 'error'))}>打开扩展文件夹</button>
      <span style={{ flex: 1 }} />
      <button className="btn btn-primary" onClick={onClose}>完成</button>
    </div>
  </Modal>
}

/** 文献条目信息弹窗：书目元数据 / 分区 / 学习区 / BibTeX（草稿态，保存才生效） */
function EntryMetaModal({ entryId, onClose, onSaved }: {
  entryId: string
  onClose(): void
  onSaved(changed: boolean): void | Promise<void>
}): React.ReactElement {
  const { spaces } = useStudySpace()
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [meta, setMeta] = useState<EntryMeta | null>(null)
  const [section, setSection] = useState('')
  const initialSectionRef = useRef('')
  const [allSections, setAllSections] = useState<string[]>([])
  const [newSection, setNewSection] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [authorsText, setAuthorsText] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [initial, setInitial] = useState('')
  const [ftStatus, setFtStatus] = useState<FulltextIndexStatus | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        // 按 id 直取（library:entryGet）：库超过检索返回上限（200 条）时，检索结果里可能没有这条，
        // 但条目确实存在——旧实现会误报「条目不存在」，让用户以为数据丢了。
        const hit = await window.api.libraryEntryGet(entryId)
        if (!hit) throw new Error('条目不存在')
        setMeta(hit.entry)
        setSection(hit.section)
        initialSectionRef.current = hit.section
        setAllSections((await window.api.librarySections()).map((s) => s.name))
        setAuthorsText(hit.entry.authors.join(', '))
        setTagsText(hit.entry.tags.join(', '))
        void window.api.libraryFulltextStatus(entryId).then(setFtStatus).catch(() => undefined)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [entryId])

  const targetSection = section === '__new__' ? newSection.trim() : section
  /** 选了「＋ 新分区…」却没填名字：旧实现静默只存元数据、条目不动，用户以为已经归好类 */
  const needsNewSectionName = section === '__new__' && newSection.trim() === ''
  const dirty = useMemo(() => {
    if (!meta || initial === '') return false
    const current = JSON.stringify([
      meta.title.trim(), meta.docType, splitList(authorsText), meta.year, meta.venue, meta.doi,
      meta.arxivId, meta.abstract, splitList(tagsText), meta.note, meta.spaceId, meta.status, targetSection
    ])
    return current !== initial
  }, [meta, authorsText, tagsText, targetSection, initial])

  // 首次加载完成后记录快照（dirty 基线）
  useEffect(() => {
    if (meta && initial === '') {
      setInitial(JSON.stringify([
        meta.title.trim(), meta.docType, splitList(authorsText), meta.year, meta.venue, meta.doi,
        meta.arxivId, meta.abstract, splitList(tagsText), meta.note, meta.spaceId, meta.status, section
      ]))
    }
  })

  if (loading) return <Modal title="文献信息" onClose={onClose} width={560}><p className="muted">加载中…</p></Modal>
  if (!meta) return <Modal title="文献信息" onClose={onClose} width={560}><p role="alert" className="status-error">{error || '条目不存在'}</p></Modal>

  const save = async () => {
    if (saving || !meta) return
    setSaving(true)
    setError('')
    try {
      await window.api.libraryEntryUpdate(meta.id, {
        title: meta.title.trim(),
        docType: meta.docType,
        authors: splitList(authorsText),
        year: meta.year,
        venue: meta.venue,
        doi: meta.doi,
        arxivId: meta.arxivId,
        abstract: meta.abstract,
        tags: splitList(tagsText),
        note: meta.note,
        spaceId: meta.spaceId,
        status: meta.status
      })
      // 与「打开弹窗时的分区」比较（不能用当前选中值——选择已有分区时两者恒等，移动会被跳过）
      if (targetSection && targetSection !== initialSectionRef.current) await window.api.libraryEntryMove(meta.id, targetSection)
      await onSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const copyBibtex = async () => {
    if (!meta) return
    try {
      await navigator.clipboard.writeText(entryToBibtex(meta))
      toast.push('已复制 BibTeX', 'success')
    } catch (err) {
      toast.push(`复制失败：${errMsg(err)}`, 'error')
    }
  }

  return <Modal title="文献信息" onClose={onClose} width={560}>
    <div className="doc-info-form entry-form">
      <label>标题<input className="input" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} maxLength={200} autoFocus /></label>
      <div className="doc-info-row">
        <label>作者（逗号分隔）<input className="input" value={authorsText} onChange={(e) => setAuthorsText(e.target.value)} placeholder="张三, Li Si" /></label>
        <label>年份<input className="input" inputMode="numeric" value={meta.year ?? ''} onChange={(e) => setMeta({ ...meta, year: e.target.value === '' ? null : Number(e.target.value) || null })} placeholder="2024" /></label>
      </div>
      <div className="doc-info-row">
        <label>类型<select className="input" aria-label="材料类型" value={meta.docType} onChange={(e) => setMeta({ ...meta, docType: e.target.value as DocType })}>
          {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>期刊 / 出版社<input className="input" value={meta.venue ?? ''} onChange={(e) => setMeta({ ...meta, venue: e.target.value || null })} /></label>
      </div>
      <div className="doc-info-row">
        <label>DOI<input className="input mono" value={meta.doi ?? ''} onChange={(e) => setMeta({ ...meta, doi: e.target.value || null })} placeholder="10.xxxx/xxxx" /></label>
        <label>arXiv ID<input className="input mono" value={meta.arxivId ?? ''} onChange={(e) => setMeta({ ...meta, arxivId: e.target.value || null })} placeholder="2401.12345" /></label>
      </div>
      <label>标签（逗号分隔）<input className="input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="弱辨识, Heston" /></label>
      <label>摘要<textarea className="input" rows={3} value={meta.abstract ?? ''} onChange={(e) => setMeta({ ...meta, abstract: e.target.value || null })} /></label>
      <div className="doc-info-row">
        <label>分区<select className="input" aria-label="所属分区" value={section} onChange={(e) => setSection(e.target.value)}>
          {allSections.map((s) => <option key={s} value={s}>{s}</option>)}
          <option value="__new__">＋ 新分区…</option>
        </select></label>
        {section === '__new__' && <label>新分区名称<input className="input" value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="如：随机分析" maxLength={60} aria-invalid={needsNewSectionName} />{needsNewSectionName && <span className="muted small">新建分区需要填写名称</span>}</label>}
        <label>所属学习区<select className="input" aria-label="学习区归属" value={meta.spaceId ?? ''} onChange={(e) => setMeta({ ...meta, spaceId: e.target.value || null })}>
          <option value="">未分区</option>
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
      </div>
      <label className="entry-check"><input type="checkbox" checked={meta.status === 'needs-review'} onChange={(e) => setMeta({ ...meta, status: e.target.checked ? 'needs-review' : 'ok' })} /> 标记为「待补全」（书目信息还不完整）</label>
      {/* 全文索引状态：检索覆盖范围对用户可见（未建立/无文本层/失败原因） */}
      <p className="muted small">全文索引：{ftStatus
        ? ftStatus.status === 'ready'
          ? `已建立（${ftStatus.pages} 页${ftStatus.truncated ? '，已达提取上限' : ''}）`
          : ftStatus.status === 'empty'
            ? `无可提取文本${ftStatus.reason ? `（${ftStatus.reason}）` : ''}`
            : `建立失败${ftStatus.reason ? `（${ftStatus.reason}）` : ''}`
        : '未建立（将于后台自动补齐；也可在文献库横幅点「立即重建」）'}</p>
      <p className="muted small">{meta.files.length > 1 ? `${meta.files.length} 个文件 · ` : ''}{meta.files[meta.files.length - 1]?.pageCount ? `${meta.files[meta.files.length - 1].pageCount} 页 · ` : ''}移动分区=移动 iCloud 里的文件夹，锚点与笔记不断链。</p>
      {error && <p role="alert" className="status-error">{error}</p>}
      <div className="doc-info-actions">
        <button className="btn" onClick={() => void copyBibtex()}>复制 BibTeX</button>
        <button className="btn" onClick={() => void window.api.libraryReveal(meta.id).catch((err) => toast.push(errMsg(err), 'error'))}>在文件夹中显示</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty || needsNewSectionName}>{saving ? '保存中…' : '保存'}</button>
      </div>
    </div>
  </Modal>
}

function splitList(text: string): string[] {
  return text.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
}

/** 散装文件相对路径（文献库/<分区>/<文件>）→ 分区名；位于 文献库/ 根下时返回 null */
function sectionOfRel(fileRel: string): string | null {
  const parts = fileRel.split(/[\\/]/)
  return parts.length >= 3 ? parts[1] : null
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

function nameOf(path: string): string { return path.split(/[\\/]/).pop() ?? path }
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }
