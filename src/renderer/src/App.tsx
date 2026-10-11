import { useCallback, useEffect, useRef, useState } from 'react'
import { type NoteType, type PaperStatus, type LibrarySearchHit, type SearchAnchorHit, type SearchMemoHit, type SearchNoteHit, type StudySpace } from '@shared/types'
// 界面里只显示 34×34：用 136×136 的显示版（23KB）而不是 1254×1254 的原图（1.4MB）——
// 原图每次启动都要传 1.4MB，白白拖慢首屏，也让 E2E 的「零网络错误」断言在并行负载下变脆。
// 原图仍留在 resources/logo.png，供 README 头图与图标源使用。
import appIcon from '../../../resources/logo-136.png'
import { ToastProvider, useToast } from './components/Toast'
import { Modal } from './components/Picker'
import { Icon } from './components/Icon'
import { CommandPalette, type PaletteGroup } from './components/CommandPalette'
import { ContextMenu, type ContextMenuEntry } from './components/ContextMenu'
import { QuickCapture } from './components/QuickCapture'
import { SettingsModal } from './components/SettingsModal'
import { LibraryView } from './views/LibraryView'
import { ReaderView } from './views/ReaderView'
import { HtmlReaderView } from './views/HtmlReaderView'
import { NotesView } from './views/NotesView'
import { NoteEditor } from './views/NoteEditor'
import { TodosView } from './views/TodosView'
import { QuestionView } from './views/QuestionView'
import { IdeasView } from './views/IdeasView'
import { FootprintPanel } from './components/FootprintPanel'
import { ReadingTypography } from './components/ReadingTypography'
import { PapersView } from './views/PapersView'
import { StudySpaceContext, type SpaceScope } from './study-space'

export type View =
  | { kind: 'library'; needsReview?: boolean }
  | { kind: 'todos' }
  | { kind: 'ideas' }
  | { kind: 'footprint' }
  | { kind: 'question'; noteId?: string }
  | { kind: 'papers' }
  | { kind: 'notes' }
  | { kind: 'reader'; documentId: string; jumpAnchorId?: string; jumpPageIndex?: number; noteId?: string }
  | { kind: 'html'; documentId: string }
  | { kind: 'note'; noteId: string; locateBlock?: { heading: string | null; blockIndex: number } }

export interface Nav {
  go(view: View): void
  registerFlusher(fn: (() => Promise<void>) | null): void
}

/** G 前缀和弦的落点：命令面板里给这些视图标了 G L / G T / G P / G N / G Q，这里让它们真的能按。
 *  收件箱视图已删除（设计提案 2026-10-10 §8）：G I 沿用肌肉记忆改指待办（未整理速记就在那里）。 */
const VIEW_CHORDS: Record<string, View> = {
  l: { kind: 'library' },
  i: { kind: 'todos' },
  t: { kind: 'todos' },
  p: { kind: 'papers' },
  n: { kind: 'notes' },
  q: { kind: 'question' }
}

type WorkGroup = 'learning' | 'plan' | 'sources'
const workGroup = (v: View): WorkGroup =>
  v.kind === 'todos' || v.kind === 'footprint' ? 'plan'
    : v.kind === 'library' || v.kind === 'papers' ? 'sources' : 'learning'
const groupLabels: Record<WorkGroup, string> = { learning: '学习', plan: '计划', sources: '资料' }
const groupViews: Record<WorkGroup, Array<{ kind: View['kind']; label: string }>> = {
  learning: [{ kind: 'notes', label: '笔记' }, { kind: 'ideas', label: 'Idea' }, { kind: 'question', label: '研究问题' }],
  plan: [{ kind: 'todos', label: '待办' }, { kind: 'footprint', label: '学习足迹' }],
  sources: [{ kind: 'library', label: '文献' }, { kind: 'papers', label: '每日论文' }]
}

export function App(): React.ReactElement {
  return <ToastProvider><Workspace /></ToastProvider>
}

function Workspace(): React.ReactElement {
  // 首屏进笔记：笔记是日常主入口，文献库是查找资料时才去的次级入口
  const [view, setView] = useState<View>({ kind: 'notes' })
  const [spaces, setSpaces] = useState<StudySpace[]>([])
  const [scope, setScope] = useState<SpaceScope>(undefined)
  const [editing, setEditing] = useState<StudySpace | 'new' | null>(null)
  const [spaceName, setSpaceName] = useState('')
  const [spaceKind, setSpaceKind] = useState<'course' | 'research'>('course')
  const [savingSpace, setSavingSpace] = useState(false)
  const [formError, setFormError] = useState('')
  const [counts, setCounts] = useState<{ unfiled: number; bySpace: Record<string, number> }>({ unfiled: 0, bySpace: {} })
  const [deepLinkPaperId, setDeepLinkPaperId] = useState<string | null>(null)
  // 每日论文的状态筛选已收敛进 PapersView 内的标签行；笔记类型筛选在 NotesView 内（筛选收敛，设计提案 §2.2）
  const [paperTab, setPaperTab] = useState<PaperStatus | 'all'>('new')
  const [noteTypeFilter, setNoteTypeFilter] = useState<'all' | NoteType>('all')
  const [noteTypeCounts, setNoteTypeCounts] = useState<Record<string, number>>({})
  const [noteQuery, setNoteQuery] = useState('')
  const [libraryQuery, setLibraryQuery] = useState('')
  // Shell 状态：主题（跟随系统，可覆盖）、命令面板
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('mathwb-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [paletteOpen, setPaletteOpen] = useState(false)
  // 顶栏「学习区」切换器：文献/笔记页的第一维度不再占用左栏（单左栏原则，见设计提案 3.2）
  const [scopeMenu, setScopeMenu] = useState<{ x: number; y: number } | null>(null)
  const [workspaceMenu, setWorkspaceMenu] = useState<{ x: number; y: number } | null>(null)
  // ⌘K 内容搜索：命令 + 全库（文献/笔记/摘录）一个入口——场景「忘了在哪篇里见过」的落点
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteHits, setPaletteHits] = useState<{ library: LibrarySearchHit[]; notes: SearchNoteHit[]; anchors: SearchAnchorHit[]; memos: SearchMemoHit[] } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 速记浮层：全局快捷键（主进程派发）与待办/⌘K 的应用内入口共用同一状态
  const [captureOpen, setCaptureOpen] = useState(false)
  const [ideaOpen, setIdeaOpen] = useState(false)
  const openCapture = useCallback(() => { setIdeaOpen(false); setCaptureOpen(true) }, [])
  const lastWork = useRef<Record<WorkGroup, View>>({ learning: { kind: 'notes' }, plan: { kind: 'todos' }, sources: { kind: 'library' } })
  const readingResume = useRef<View | null>(null)
  // G 和弦待触发提示（P5：键位可发现性）——按下 G 后 1.5s 内显示，松开即隐
  const [chordHint, setChordHint] = useState(false)
  const flusherRef = useRef<(() => Promise<void>) | null>(null)
  const navigating = useRef(false)
  const navigationRequested = useRef(false)
  const [, bumpVersion] = useState(0)
  const toast = useToast()
  const current = spaces.find((space) => space.id === scope)
  const scopeName = current?.name ?? (scope === null ? '未分区' : '全部学习资料')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('mathwb-theme', theme)
  }, [theme])

  // ⌘K / Ctrl+K 命令面板；G 前缀和弦切视图（按下 G 显示轻提示，键位可发现性）
  useEffect(() => {
    let chordTimer: number | null = null
    const disarm = () => {
      setChordHint(false)
      if (chordTimer !== null) window.clearTimeout(chordTimer)
      chordTimer = null
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        disarm()
        if (e.key.toLowerCase() === 'k') {
          e.preventDefault()
          setPaletteOpen((v) => !v)
        }
        return
      }
      // 正在输入框里打字时不吃按键（否则搜索框里敲 g 会被当成和弦）
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (key !== 'g') return
      e.preventDefault()
      setChordHint(true)
      if (chordTimer !== null) window.clearTimeout(chordTimer)
      chordTimer = window.setTimeout(disarm, 1500)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      disarm()
    }
  }, [])
  // 和弦第二键：独立监听（第一键监听只认 G，避免 disarm 时序问题）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!chordHint) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const dest = VIEW_CHORDS[e.key.toLowerCase()]
      if (!dest) return
      e.preventDefault()
      setChordHint(false)
      void navigateRef.current(dest)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chordHint])

  useEffect(() => {
    void window.api.spaceList().then((list) => {
      setSpaces(list)
      const saved = localStorage.getItem('study-space')
      if (saved === 'unfiled') setScope(null)
      else if (list.some((item) => item.id === saved)) setScope(saved!)
    }).catch((err) => toast.push(`学习区加载失败：${String(err)}`, 'error'))
  }, [])

  // 计数（学习区材料/笔记类型）：本机写库、外部（iCloud）写入、以及各视图显式请求刷新
  // 都收敛到这里。此前只有 LibraryView 订阅 library:changed，导致在写库后计数长期陈旧——
  // App 常驻，订阅放这里才与视图无关。
  const loadCounts = useCallback(() => {
    void window.api.docList().then((all) => {
      const next = { unfiled: 0, bySpace: {} as Record<string, number> }
      for (const d of all) {
        if (d.spaceId) next.bySpace[d.spaceId] = (next.bySpace[d.spaceId] ?? 0) + 1
        else next.unfiled++
      }
      setCounts(next)
    }).catch(() => undefined)
    void window.api.noteList().then((all) => {
      const next: Record<string, number> = {}
      for (const n of all) next[n.noteType] = (next[n.noteType] ?? 0) + 1
      setNoteTypeCounts(next)
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    loadCounts()
    window.addEventListener('mathwb:counts-changed', loadCounts)
    // 主进程在库发生任何变化（含外部同步）时广播；这是「不以当前视图为条件」的兜底刷新
    const off = window.api.onLibraryChanged(loadCounts)
    return () => {
      window.removeEventListener('mathwb:counts-changed', loadCounts)
      off()
    }
  }, [loadCounts])

  const navigate = useCallback(async (next: View, changeScope?: { value: SpaceScope }) => {
    navigationRequested.current = true
    if (navigating.current) return
    navigating.current = true
    try {
      await flusherRef.current?.()
      if (changeScope) {
        setScope(changeScope.value)
        localStorage.setItem('study-space', changeScope.value === undefined ? 'all' : changeScope.value === null ? 'unfiled' : changeScope.value)
      }
      if (view.kind !== 'ideas' && view.kind !== 'question') lastWork.current[workGroup(view)] = view
      if (next.kind === 'reader' || next.kind === 'html') readingResume.current = next
      setView(next)
    } catch (err) { toast.push(`未能保存，已保留当前页面：${err instanceof Error ? err.message : String(err)}`, 'error') }
    finally { navigating.current = false }
  }, [toast, view])
  // 启动恢复只在尚无用户导航/邮件入口时进行，避免异步结果抢走当前页面。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const id = await window.api.readingLastDocument()
      if (!id) return
      const doc = await window.api.docOpen(id)
      if (!cancelled && !navigationRequested.current) {
        const resumed: View = { kind: doc.mediaType === 'text/html' ? 'html' : 'reader', documentId: id }
        readingResume.current = resumed
        setView(resumed)
      }
    })().catch((err) => toast.push(`上次材料恢复失败，可从文献重试：${String(err)}`, 'error'))
    return () => { cancelled = true }
  }, [])

  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(() => {
    // 必须返回取消订阅：preload 提供了 off，丢弃返回值会让监听器随 HMR/重挂载叠加
    return window.api.onDeepLink((payload) => {
      if (payload.kind !== 'paper') return
      setDeepLinkPaperId(payload.baseId)
      void navigateRef.current({ kind: 'papers' })
    })
  }, [])

  // 主进程主动通知（浏览器扩展导入结果）：列表由 library:changed 驱动刷新，这里只负责提示
  useEffect(() => {
    return window.api.onNotice((notice) => toast.push(notice.message, notice.kind))
  }, [toast])

  // 全局速记快捷键（⌥⌘N / Ctrl+Alt+N）：主进程已把窗口带到前台，这里只负责开浮层
  useEffect(() => window.api.onQuickCapture(openCapture), [openCapture])

  const nav: Nav = {
    go: (next) => { void navigate(next) },
    registerFlusher: (fn) => { flusherRef.current = fn }
  }
  // 「刷新」不只换 key：侧栏计数也要重取（收件箱归档、新建笔记等路径不会广播 library:changed）
  const refreshApp = useCallback(() => {
    bumpVersion((n) => n + 1)
    loadCounts()
  }, [loadCounts])
  const selectSpace = (value: SpaceScope) => {
    // 学习区侧栏只在 文库/笔记 显示；命令面板里切换学习区时也回到这两个视图
    void navigate({ kind: view.kind === 'notes' || view.kind === 'note' ? 'notes' : 'library' }, { value })
  }

  // 面板里的内容搜索：防抖 + 过期丢弃；关闭面板即清空。
  // 库变更（元数据/笔记写入）→ 重查一次；后台全文索引完成（kind 全为 'fulltext'）**不重查**——
  // 检索只搜标题/标签/笔记，与全文索引进度无关（architecture §15）。
  const [paletteNonce, setPaletteNonce] = useState(0)
  useEffect(() => {
    if (!paletteOpen) return
    return window.api.onLibraryChanged((payload) => {
      if (payload.kinds.length > 0 && payload.kinds.every((k) => k === 'fulltext')) return
      setPaletteNonce((n) => n + 1)
    })
  }, [paletteOpen])
  useEffect(() => {
    if (!paletteOpen) {
      setPaletteQuery('')
      setPaletteHits(null)
      return
    }
    const q = paletteQuery.trim()
    if (q.length < 2) {
      setPaletteHits(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void Promise.all([
        window.api.librarySearch({ q, spaceId: scope }),
        window.api.search(q, scope)
      ]).then(([lib, s]) => {
        if (cancelled) return
        setPaletteHits({ library: lib.hits.slice(0, 5), notes: s.notes.slice(0, 5), anchors: s.anchors.slice(0, 5), memos: s.memos.slice(0, 5) })
      }).catch(() => { if (!cancelled) setPaletteHits(null) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [paletteOpen, paletteQuery, scope, paletteNonce])

  useEffect(() => {
    // 渲染层未捕获错误落主进程日志（远程可诊断；本地 console 保留原样）
    const onError = (e: ErrorEvent) => window.api.logToMain('error', 'renderer', `${e.message} @ ${e.filename}:${e.lineno}`)
    const onRejection = (e: PromiseRejectionEvent) => window.api.logToMain('error', 'renderer', `unhandled rejection: ${String(e.reason).slice(0, 300)}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  useEffect(() => {
    // 同上：关窗冲刷握手监听必须可取消，否则 HMR 下会叠加多次触发同一 flusher
    return window.api.onFlushRequest(async () => {
      try { await flusherRef.current?.() }
      catch (err) {
        toast.push(`保存失败，窗口已保留，请重试：${String(err)}`, 'error')
        throw err
      }
    })
  }, [])

  const editSpace = (space: StudySpace | 'new') => {
    setEditing(space)
    setSpaceName(space === 'new' ? '' : space.name)
    setSpaceKind(space === 'new' ? 'course' : space.kind)
    setFormError('')
  }
  const saveSpace = async (event: React.FormEvent) => {
    event.preventDefault()
    if (savingSpace || !spaceName.trim()) return
    setSavingSpace(true)
    setFormError('')
    try {
      let id: string
      if (editing === 'new') id = (await window.api.spaceCreate({ name: spaceName.trim(), kind: spaceKind })).id
      else if (editing) { id = editing.id; await window.api.spaceUpdate(id, { name: spaceName.trim(), kind: spaceKind }) }
      else return
      setSpaces(await window.api.spaceList())
      setEditing(null)
      await navigate({ kind: 'library' }, { value: id })
    } catch (err) { setFormError(err instanceof Error ? err.message : String(err)) }
    finally { setSavingSpace(false) }
  }

  const isLibraryView = ['library', 'reader', 'html'].includes(view.kind)
  const isNotesView = view.kind === 'notes' || view.kind === 'note'
  const activeGroup = workGroup(view)
  const viewLabel = view.kind === 'ideas' ? 'Idea' : view.kind === 'footprint' ? '学习足迹' : isLibraryView ? '文献'
    : view.kind === 'todos' ? '待办'
    : view.kind === 'question' ? '研究问题'
    : view.kind === 'papers' ? '每日论文'
    : '笔记'
  // 面包屑第二段：文献/笔记用顶栏切换器表达学习区；状态类筛选都在视图内标签行
  const crumbName = ''
  const totalDocs = counts.unfiled + Object.values(counts.bySpace).reduce((a, b) => a + b, 0)
  const noteTotal = Object.values(noteTypeCounts).reduce((a, b) => a + b, 0)
  // 状态栏按当前视图给对应计数
  const statusText = isLibraryView ? `${totalDocs} 份材料`
    : isNotesView ? `${noteTotal} 篇笔记 · ${totalDocs} 份材料`
    : viewLabel
  const commandGroups: PaletteGroup[] = [
    {
      heading: '视图',
      items: [
        { key: 'ideas', label: 'Idea · 想法记录', icon: <Icon name="edit" size={15} />, onSelect: () => nav.go({ kind: 'ideas' }) },
        { key: 'notes', label: '笔记', icon: <Icon name="note" size={15} />, shortcut: 'G N', onSelect: () => nav.go({ kind: 'notes' }) },
        { key: 'todos', label: '待办（速记待办与未整理速记）', icon: <Icon name="check" size={15} />, shortcut: 'G T', onSelect: () => nav.go({ kind: 'todos' }) },
        { key: 'question', label: '研究问题', icon: <Icon name="question" size={15} />, shortcut: 'G Q', onSelect: () => nav.go({ kind: 'question' }) },
        { key: 'library', label: '文献', icon: <Icon name="library" size={15} />, shortcut: 'G L', onSelect: () => nav.go({ kind: 'library' }) },
        { key: 'papers', label: '每日论文', icon: <Icon name="papers" size={15} />, shortcut: 'G P', onSelect: () => nav.go({ kind: 'papers' }) }
      ]
    },
    {
      heading: '学习区',
      items: [
        { key: 'scope-all', label: '全部学习资料', icon: <Icon name="library" size={15} />, onSelect: () => selectSpace(undefined) },
        { key: 'scope-unfiled', label: '未分区', icon: <Icon name="inbox" size={15} />, onSelect: () => selectSpace(null) },
        ...spaces.map((space) => ({
          key: `scope-${space.id}`,
          label: space.name,
          icon: <Icon name="library" size={15} />,
          onSelect: () => selectSpace(space.id)
        }))
      ]
    },
    {
      heading: '操作',
      items: [
        { key: 'quick-capture', label: '写速记（直接存为草稿笔记）', icon: <Icon name="plus" size={15} />, shortcut: '⌥⌘N', onSelect: openCapture },
        { key: 'new-space', label: '新建学习区', icon: <Icon name="plus" size={15} />, onSelect: () => editSpace('new') },
        { key: 'toggle-theme', label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', icon: theme === 'dark' ? <Icon name="sun" size={15} /> : <Icon name="moon" size={15} />, onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
        { key: 'settings', label: '设置：数据文件夹…', icon: <Icon name="settings" size={15} />, onSelect: () => setSettingsOpen(true) }
      ]
    }
  ]

  // 学习区切换器（顶栏）：条目与旧的侧栏「学习区」导航同源，选中即切换并记住
  const openScopeMenu = (e: React.MouseEvent<HTMLElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    setScopeMenu({ x: rect.left, y: rect.bottom + 6 })
  }
  const workspaceEntries: ContextMenuEntry[] = (['learning', 'plan', 'sources'] as WorkGroup[]).map((group) => ({
    kind: 'item', key: group, label: groupLabels[group], checked: activeGroup === group,
    onSelect: () => nav.go(lastWork.current[group])
  }))
  const scopeEntries: ContextMenuEntry[] = [
    { kind: 'item', key: 'scope-all', label: '全部学习资料', checked: scope === undefined, onSelect: () => selectSpace(undefined) },
    { kind: 'item', key: 'scope-unfiled', label: '未分区', checked: scope === null, onSelect: () => selectSpace(null) },
    ...(spaces.length > 0 ? [{ kind: 'separator' as const, key: 'scope-sep', label: '学习区' }] : []),
    ...spaces.map((space): ContextMenuEntry => ({
      kind: 'item',
      key: `scope-${space.id}`,
      label: space.name,
      checked: scope === space.id,
      icon: <Icon name="folder" size={15} />,
      onSelect: () => selectSpace(space.id)
    })),
    { kind: 'separator', key: 'scope-sep-2' },
    { kind: 'item', key: 'scope-new', label: '新建学习区', icon: <Icon name="plus" size={15} />, onSelect: () => editSpace('new') },
    ...(current ? [{ kind: 'item' as const, key: 'scope-edit', label: '编辑学习区', icon: <Icon name="edit" size={15} />, onSelect: () => editSpace(current) }] : [])
  ]

  // 内容搜索结果分组（在命令分组之前：用户输入关键词时，内容通常才是想找的东西）
  const contentGroups: PaletteGroup[] = paletteHits ? [
    ...(paletteHits.library.length ? [{
      heading: '文献',
      items: paletteHits.library.map((h) => {
        const file = h.entry.files[h.entry.files.length - 1]
        const hint = [
          h.section,
          h.entry.year ? String(h.entry.year) : '',
          h.match ? `${h.match.field}命中${h.match.page != null ? ` · 第 ${h.match.page + 1} 页` : ''}` : ''
        ].filter(Boolean).join(' · ')
        return {
          key: `palette-lib-${h.entry.id}`,
          label: h.entry.title,
          icon: <Icon name="library" size={15} />,
          hint,
          keywords: h.match ? [h.match.term, h.match.field, h.match.snippet] : [h.section],
          onSelect: () => {
            if (file && !file.missing && file.mediaType === 'text/html') nav.go({ kind: 'html', documentId: h.entry.id })
            else if (file && !file.missing) nav.go({ kind: 'reader', documentId: h.entry.id, ...(h.match?.page != null ? { jumpPageIndex: h.match.page } : {}) })
            else nav.go({ kind: 'library' })
          }
        }
      })
    }] : []),
    ...(paletteHits.notes.length ? [{
      heading: '笔记',
      items: paletteHits.notes.map((n) => ({
        key: `palette-note-${n.id}`,
        label: n.title,
        icon: <Icon name="note" size={15} />,
        hint: n.snippet.slice(0, 48),
        keywords: [n.snippet, n.title],
        onSelect: () => nav.go({ kind: 'note', noteId: n.id })
      }))
    }] : []),
    ...(paletteHits.memos.length ? [{
      heading: '速记',
      items: paletteHits.memos.map((m) => ({
        key: `palette-memo-${m.id}`,
        label: m.snippet.slice(0, 60) || '速记',
        icon: <Icon name="inbox" size={15} />,
        hint: `${m.todo ? '待办 · ' : ''}${new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}`,
        keywords: [m.snippet],
        onSelect: () => nav.go({ kind: m.todo ? 'todos' : 'ideas' })
      }))
    }] : []),
    ...(paletteHits.anchors.length ? [{
      heading: '摘录',
      items: paletteHits.anchors.map((a) => ({
        key: `palette-anchor-${a.anchorId}`,
        label: a.quote ? a.quote.slice(0, 60) : `第 ${a.pageIndex + 1} 页标记`,
        icon: <Icon name="note" size={15} />,
        hint: `${a.documentTitle} · 第 ${a.pageIndex + 1} 页`,
        keywords: [a.quote ?? '', a.documentTitle],
        onSelect: () => nav.go({ kind: 'reader', documentId: a.documentId, jumpAnchorId: a.anchorId })
      }))
    }] : [])
  ] : []
  const paletteGroups: PaletteGroup[] = [...contentGroups, ...commandGroups]

  return <StudySpaceContext.Provider value={{ spaces, scope }}>
    <div className={`app-shell ${ideaOpen ? 'app-idea-open' : ''}`}>
      <aside className="activity-bar">
        <div className="activity-brand" title="数学学习工作台"><img src={appIcon} alt="数学学习工作台" width="34" height="34" /></div>
        <span className="workspace-brand-name">数学学习工作台</span>
        <nav className="nav workspace-primary" aria-label="主导航">
          {(['learning', 'plan', 'sources'] as WorkGroup[]).map((group) => <button key={group} className={`nav-item ${activeGroup === group ? 'active' : ''}`} aria-label={groupLabels[group]} aria-current={activeGroup === group ? 'page' : undefined} onClick={() => { if (activeGroup !== group) nav.go(lastWork.current[group]) }}>
            <Icon name={group === 'learning' ? 'note' : group === 'plan' ? 'check' : 'library'} size={18} /><span>{groupLabels[group]}</span>
          </button>)}
        </nav>
        <span className="workspace-local">本地工作空间</span>
      </aside>
      <main className="main">
        <div className="scope-bar">
          <div className="scope-bar-left">
            <button className="workspace-crumb" aria-label="切换工作空间" aria-haspopup="menu" aria-expanded={workspaceMenu !== null} onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setWorkspaceMenu({ x: rect.left, y: rect.bottom + 6 })
            }}>工作空间</button>
            <Icon name="pageNext" size={12} />
            <button className="workspace-crumb workspace-crumb-current" aria-label={`返回${groupLabels[activeGroup]}工作区`} title={`返回${groupLabels[activeGroup]}工作区`} onClick={() => nav.go({ kind: activeGroup === 'learning' ? 'notes' : activeGroup === 'plan' ? 'todos' : 'library' })}>{groupLabels[activeGroup]}</button>
          </div>
          <div className="scope-bar-actions">
            <button className="btn btn-sm" aria-label="记一下" aria-expanded={ideaOpen} aria-controls="idea-capture" onClick={() => setIdeaOpen((v) => !v)}><Icon name="plus" size={14} />记一下</button>
            <button className="icon-btn" aria-label="命令面板" title="命令面板 (Ctrl+K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={16} /></button>
            <button className="icon-btn" aria-label="切换主题" title="切换深色 / 浅色主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? <Icon name="sun" size={15} /> : <Icon name="moon" size={15} />}
            </button>
            <button className="icon-btn" aria-label="设置" title="设置（数据文件夹）" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={15} /></button>
          </div>
        </div>
        <div className="workspace-tabs">
          <nav className="workspace-peers" aria-label={`${groupLabels[activeGroup]}功能`}>
            {groupViews[activeGroup].map((item) => {
              const selected = view.kind === item.kind || (item.kind === 'notes' && view.kind === 'note')
              return <button key={item.kind} className={`nav-item ${selected ? 'active' : ''}`} aria-label={item.label} aria-current={selected ? 'page' : undefined} onClick={() => nav.go({ kind: item.kind } as View)}>{item.label}</button>
            })}
          </nav>
          <div className="workspace-tools">
            {(isLibraryView || isNotesView) ? (
              <button className="scope-switch" aria-haspopup="menu" aria-label={`切换学习区（当前：${scopeName}）`} title="切换学习区" onClick={openScopeMenu}>
                <span className="scope-switch-name">{scopeName}</span>
                <Icon name="pageNext" size={12} style={{ transform: 'rotate(90deg)' }} />
              </button>
            ) : null}
            {activeGroup === 'learning' && readingResume.current && view.kind !== 'reader' && view.kind !== 'html' && <button className="btn btn-ghost btn-sm workspace-resume" onClick={() => nav.go(readingResume.current!)}>继续阅读<Icon name="pageNext" size={13} /></button>}
            <ReadingTypography />
          </div>
        </div>
        <div className="workspace-content" key={scope === undefined ? 'all' : scope ?? 'unfiled'}>
          {view.kind === 'library' && <LibraryView key={view.needsReview ? 'lib-review' : 'lib'} nav={nav} initialNeedsReview={view.needsReview === true} query={libraryQuery} onQuery={setLibraryQuery} />}
          {view.kind === 'reader' && <ReaderView key={view.documentId} nav={nav} documentId={view.documentId} jumpAnchorId={view.jumpAnchorId} jumpPageIndex={view.jumpPageIndex} initialNoteId={view.noteId} />}
          {view.kind === 'html' && <HtmlReaderView key={view.documentId} nav={nav} documentId={view.documentId} />}
          {view.kind === 'ideas' && <IdeasView nav={nav} onCapture={() => setIdeaOpen(true)} />}
          {view.kind === 'footprint' && <div className="view view-scroll"><div className="view-head"><h1>学习足迹</h1></div><FootprintPanel nav={nav} /></div>}
          {view.kind === 'todos' && <TodosView nav={nav} refreshApp={refreshApp} onQuickCapture={openCapture} />}
          {view.kind === 'question' && <QuestionView key={view.noteId ?? 'question'} nav={nav} noteId={view.noteId} />}
          {view.kind === 'papers' && <PapersView nav={nav} deepLinkBaseId={deepLinkPaperId} statusTab={paperTab} onStatusTab={setPaperTab} />}
          {view.kind === 'notes' && <NotesView nav={nav} refreshApp={refreshApp} typeFilter={noteTypeFilter} onTypeFilter={setNoteTypeFilter} typeCounts={noteTypeCounts} query={noteQuery} onQuery={setNoteQuery} />}
          {view.kind === 'note' && <NoteEditor key={view.noteId} nav={nav} noteId={view.noteId} locateBlock={view.locateBlock} />}
        </div>
        <div className="status-bar">
          <span>{statusText}</span>
          <span>本地库 · 无上传</span>
        </div>
      </main>
      {editing && <Modal title={editing === 'new' ? '新建学习区' : '编辑学习区'} onClose={() => { if (!savingSpace) setEditing(null) }}>
        <form onSubmit={(e) => void saveSpace(e)} className="space-form">
          <label>学习区名称<input className="input" aria-label="学习区名称" value={spaceName} onChange={(e) => setSpaceName(e.target.value)} placeholder="例如：微积分、线性代数" maxLength={80} autoFocus required /></label>
          <details className="space-options" open={editing !== 'new'}><summary>更多设置</summary><label>学习区类型<select className="input" aria-label="学习区类型" value={spaceKind} onChange={(e) => setSpaceKind(e.target.value as 'course' | 'research')}><option value="course">课程</option><option value="research">论文专题</option></select></label></details>
          <p className="muted small">起个名字就能开始，之后随时可以修改。</p>
          {formError && <p role="alert" className="status-error">{formError}</p>}
          <button className="btn btn-primary" type="submit" disabled={savingSpace || !spaceName.trim()}>{savingSpace ? '保存中…' : editing === 'new' ? '创建学习区' : '保存学习区'}</button>
        </form>
      </Modal>}
      <QuickCapture open={ideaOpen} mode="idea" spaceId={scope} onClose={() => setIdeaOpen(false)} onSaved={(landed) => { toast.push(landed.kind === 'memo' && landed.memo.todo ? '已记为待办，见「待办」' : '已记录到 Idea', 'success'); loadCounts() }} />
      <QuickCapture
        open={captureOpen}
        spaceId={scope}
        onClose={() => setCaptureOpen(false)}
        onSaved={(landed) => {
          if (landed.kind === 'note') {
            toast.push('已存为草稿笔记', 'success')
            nav.go({ kind: 'note', noteId: landed.id })
          } else {
            toast.push('已记为待办，见「待办」', 'success')
          }
          loadCounts()
        }}
      />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} groups={paletteGroups} onQueryChange={setPaletteQuery} />
      {workspaceMenu && <ContextMenu x={workspaceMenu.x} y={workspaceMenu.y} entries={workspaceEntries} onClose={() => setWorkspaceMenu(null)} ariaLabel="切换工作空间" />}
      {scopeMenu && <ContextMenu x={scopeMenu.x} y={scopeMenu.y} entries={scopeEntries} onClose={() => setScopeMenu(null)} ariaLabel="切换学习区" />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {chordHint && <div className="chord-hint" role="status">G…　N 笔记 · T 待办 · Q 研究问题 · L 文献 · P 每日论文</div>}
    </div>
  </StudySpaceContext.Provider>
}
