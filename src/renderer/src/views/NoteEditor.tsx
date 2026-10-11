import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Nav } from '../App'
import { useToast } from '../components/Toast'
import { CapturePicker, ImagePreview } from '../components/Picker'
import { Icon } from '../components/Icon'
import { renderMarkdown } from '../md'
import { assetUrl } from '@shared/api'
import { noteDateLine, noteDateDetail } from '../lib/time-label'
import { SpaceSelect } from '../study-space'
import { NoteLearningView } from '../components/NoteLearningView'
import { collectTextRanges } from '../lib/text-find'
import { splitNoteBlocks } from '@shared/search-terms'
import {
  NOTE_TYPE_LABELS,
  type BacklinkView,
  type NoteFull,
  type NoteLearningState,
  type NoteLinkIndexEntry,
  type NoteSaveConflictInfo,
  type NoteType,
  type VerifiedStatus
} from '@shared/types'

type SaveStatus = 'loading' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'

type EditorMode = 'edit' | 'split' | 'read' | 'learn'
const NOTE_MODE_KEY = 'mathwb-note-mode'
const NOTE_SPLIT_KEY = 'mathwb-note-split'
const SPLIT_MIN = 20
const SPLIT_MAX = 80

const clampSplit = (value: number): number => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value))

export function NoteEditor({ nav, noteId, locateBlock }: { nav: Nav; noteId: string; locateBlock?: { heading: string | null; blockIndex: number } }): React.ReactElement {
  const toast = useToast()
  const [full, setFull] = useState<NoteFull | null>(null)
  const [title, setTitle] = useState('')
  const [noteType, setNoteType] = useState<NoteType>('note')
  const [aliasesText, setAliasesText] = useState('')
  const [body, setBody] = useState('')
  const [verified, setVerified] = useState<VerifiedStatus>('unchecked')
  const [status, setStatus] = useState<SaveStatus>('loading')
  const [savedAt, setSavedAt] = useState('')
  const [saveError, setSaveError] = useState('')
  const [revision, setRevision] = useState(1)
  /** 编辑起点的磁盘指纹（getNoteFull 给出、每次成功保存后用返回值刷新）：冲突检测的唯一依据 */
  const [baseHash, setBaseHash] = useState('')
  /** 未解决的保存冲突（磁盘版本 + 处理出口）——这是「待决策」状态，不是失败 */
  const [conflict, setConflict] = useState<NoteSaveConflictInfo | null>(null)
  const [viewMode, setViewMode] = useState<EditorMode>('split')
  const [splitRatio, setSplitRatio] = useState(50)
  const [previewHtml, setPreviewHtml] = useState('')
  const [previewImg, setPreviewImg] = useState<string | null>(null)
  const [showCapturePicker, setShowCapturePicker] = useState(false)

  // 双链：全库标题/别名索引、反向链接、[[ 输入辅助
  const [linkIndex, setLinkIndex] = useState<NoteLinkIndexEntry[]>([])
  const [backlinks, setBacklinks] = useState<BacklinkView[]>([])
  const [linkQuery, setLinkQuery] = useState<string | null>(null)
  const [linkSel, setLinkSel] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  /** 知识块自评（WP-8）：存在笔记 front-matter 里，随笔记保存管线落盘（跨设备同步） */
  const [learning, setLearning] = useState<NoteLearningState | null>(null)

  useEffect(() => {
    if (full?.note.title === '未命名笔记' && !full.note.bodyMd) textareaRef.current?.focus()
  }, [full?.note.id])

  // 编辑器视图偏好：模式与分栏比例落 settings.json（本地端口随机，localStorage 不可靠）
  useEffect(() => {
    void (async () => {
      try {
        const [mode, ratio] = await Promise.all([window.api.prefGet(NOTE_MODE_KEY), window.api.prefGet(NOTE_SPLIT_KEY)])
        if (mode === 'edit' || mode === 'split' || mode === 'read' || mode === 'learn') setViewMode(mode)
        if (ratio) {
          const n = Number(ratio)
          if (Number.isFinite(n)) setSplitRatio(clampSplit(n))
        }
      } catch { /* 偏好读取失败用默认值 */ }
    })()
  }, [])

  const switchMode = useCallback((m: EditorMode) => {
    setViewMode(m)
    void window.api.prefSet(NOTE_MODE_KEY, m).catch(() => undefined)
  }, [])

  const persistSplit = useCallback((value: number) => {
    void window.api.prefSet(NOTE_SPLIT_KEY, String(Math.round(value))).catch(() => undefined)
  }, [])

  // ---------- 检索结果定位（2026-10-09）：滚动到命中的知识块，不写任何用户状态 ----------
  // 只做 DOM 滚动/编辑器滚动——不写 learning.activeId、不动 revision/updatedAt/足迹（architecture §15）
  const locateAppliedRef = useRef<string>('')
  useEffect(() => {
    if (!locateBlock || !full) return
    const key = `${full.note.id}:${locateBlock.blockIndex}`
    if (locateAppliedRef.current === key) return
    const run = (): void => {
      locateAppliedRef.current = key
      const root = bodyRef.current
      if (!root) return
      if (viewMode === 'edit') {
        // 编辑态：按分块规则算块起始行，按比例滚动 textarea（最新草稿即所见）
        const ta = textareaRef.current
        if (!ta) return
        const blocks = splitNoteBlocks(body)
        const line = blocks.slice(0, locateBlock.blockIndex).reduce((n, b) => n + b.text.split('\n').length - 1, 0)
        const totalLines = Math.max(1, body.split('\n').length)
        ta.scrollTop = (line / totalLines) * Math.max(0, ta.scrollHeight - ta.clientHeight)
        return
      }
      const headings = Array.from(root.querySelectorAll('h2'))
      const target =
        (locateBlock.heading ? headings.find((h) => (h.textContent ?? '').trim() === locateBlock.heading) : undefined) ??
        (locateBlock.blockIndex > 0 ? headings[locateBlock.blockIndex - 1] : undefined)
      if (target) target.scrollIntoView({ block: 'start' })
      else root.scrollIntoView({ block: 'start' })
    }
    // 双 rAF：等 Markdown / 学习视图完成一次渲染
    const raf = requestAnimationFrame(() => requestAnimationFrame(run))
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateBlock, full, previewHtml, viewMode, body])

  // ---------- 笔记内查找（⌘F）：命中计数 + 上一处/下一处；只读定位，不修改笔记 ----------
  const [noteFindOpen, setNoteFindOpen] = useState(false)
  const [noteFindQuery, setNoteFindQuery] = useState('')
  const [noteFindIdx, setNoteFindIdx] = useState(0)
  const [noteFindTotal, setNoteFindTotal] = useState(0)
  const noteFindRangesRef = useRef<Range[]>([])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setNoteFindOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  // 关闭/卸载时清掉高亮（复用阅读器的高亮注册名与样式）
  useEffect(() => {
    if (noteFindOpen) return
    try {
      CSS.highlights?.delete('mathwb-find')
      CSS.highlights?.delete('mathwb-find-current')
    } catch { /* 环境不支持 Highlight API 时静默 */ }
  }, [noteFindOpen])
  useEffect(() => () => {
    try {
      CSS.highlights?.delete('mathwb-find')
      CSS.highlights?.delete('mathwb-find-current')
    } catch { /* 同上 */ }
  }, [])
  // 命中收集：编辑态在最新草稿字符串上找；阅读/学习态在已渲染 DOM 上找（CSS Highlight 标注）
  useEffect(() => {
    if (!noteFindOpen || !noteFindQuery.trim()) {
      noteFindRangesRef.current = []
      setNoteFindTotal(0)
      setNoteFindIdx(0)
      try {
        CSS.highlights?.delete('mathwb-find')
        CSS.highlights?.delete('mathwb-find-current')
      } catch { /* 同上 */ }
      return
    }
    if (viewMode === 'edit') {
      try {
        CSS.highlights?.delete('mathwb-find')
        CSS.highlights?.delete('mathwb-find-current')
      } catch { /* 同上 */ }
      const needle = noteFindQuery.trim().toLowerCase()
      const hay = body.toLowerCase()
      const offsets: number[] = []
      let from = 0
      for (;;) {
        const at = hay.indexOf(needle, from)
        if (at === -1) break
        offsets.push(at)
        from = at + needle.length
      }
      noteFindRangesRef.current = []
      setNoteFindTotal(offsets.length)
      setNoteFindIdx((i) => (offsets.length ? i % offsets.length : 0))
      return
    }
    const apply = (): boolean => {
      const root = bodyRef.current
      if (!root) return false
      const containers = Array.from(root.querySelectorAll('.note-preview, .note-learning'))
      const ranges = (containers.length ? containers : [root]).flatMap((c) => collectTextRanges(c, noteFindQuery.trim()))
      if (!ranges.length) return false
      noteFindRangesRef.current = ranges
      setNoteFindTotal(ranges.length)
      setNoteFindIdx((i) => i % ranges.length)
      try {
        CSS.highlights?.set('mathwb-find', new Highlight(...ranges))
        const active = ranges[Math.min(noteFindIdx, ranges.length - 1)]
        if (active) CSS.highlights.set('mathwb-find-current', new Highlight(active))
      } catch { /* 环境不支持 Highlight API 时静默 */ }
      return true
    }
    if (apply()) return
    const timers = [80, 250, 600].map((ms) => window.setTimeout(apply, ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteFindOpen, noteFindQuery, previewHtml, viewMode, body])
  const noteFindStep = useCallback((dir: 1 | -1): void => {
    const total = noteFindTotal
    if (!total) return
    const next = (noteFindIdx + dir + total) % total
    setNoteFindIdx(next)
    if (viewMode === 'edit') {
      const ta = textareaRef.current
      const needle = noteFindQuery.trim().toLowerCase()
      const hay = body.toLowerCase()
      const offsets: number[] = []
      let from = 0
      for (;;) {
        const at = hay.indexOf(needle, from)
        if (at === -1) break
        offsets.push(at)
        from = at + needle.length
      }
      const at = offsets[next]
      if (ta && at !== undefined) {
        ta.focus()
        ta.setSelectionRange(at, at + needle.length)
        const before = body.slice(0, at).split('\n').length
        const totalLines = Math.max(1, body.split('\n').length)
        ta.scrollTop = ((before - 1) / totalLines) * Math.max(0, ta.scrollHeight - ta.clientHeight)
      }
      return
    }
    const range = noteFindRangesRef.current[next]
    const el = range?.startContainer.parentElement
    if (el) el.scrollIntoView({ block: 'center' })
    try {
      CSS.highlights?.set('mathwb-find-current', new Highlight(range))
    } catch { /* 同上 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteFindTotal, noteFindIdx, viewMode, noteFindQuery, body])

  // 分栏拖拽：pointer capture 在分隔条上，宽度只改 flex 比例，textarea 全程保持挂载
  const applyDrag = (clientX: number): number => {
    const rect = bodyRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return NaN
    return clampSplit(((clientX - rect.left) / rect.width) * 100)
  }
  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    const next = applyDrag(e.clientX)
    if (!Number.isNaN(next)) setSplitRatio(next)
  }
  const onDividerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 已释放则忽略 */ }
    setSplitRatio((r) => { persistSplit(r); return r })
  }

  const snapshotRef = useRef('')
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const statusRef = useRef<SaveStatus>('loading')
  statusRef.current = status
  const conflictRef = useRef<NoteSaveConflictInfo | null>(null)
  conflictRef.current = conflict

  const parseAliases = (text: string): string[] =>
    text
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean)

  const payloadJson = useCallback(
    () => JSON.stringify({ title, noteType, body, aliases: parseAliases(aliasesText), verified, learning: learning ?? null }),
    [title, noteType, body, aliasesText, verified, learning]
  )

  const loadLinkData = useCallback(async () => {
    try {
      const [idx, back] = await Promise.all([window.api.noteLinkIndex(), window.api.noteBacklinks(noteId)])
      setLinkIndex(idx)
      setBacklinks(back)
    } catch {
      /* 双链数据加载失败不阻塞编辑 */
    }
  }, [noteId])

  const reload = useCallback(async () => {
    const f = await window.api.noteGet(noteId)
    setFull(f)
    setTitle(f.note.title)
    setNoteType(f.note.noteType)
    setAliasesText(f.note.aliases.join('，'))
    setBody(f.note.bodyMd)
    setVerified(f.note.verifiedStatus)
    setRevision(f.note.revisionNo)
    setLearning(f.note.learning)
    snapshotRef.current = JSON.stringify({
      title: f.note.title,
      noteType: f.note.noteType,
      body: f.note.bodyMd,
      aliases: f.note.aliases,
      verified: f.note.verifiedStatus,
      learning: f.note.learning ?? null
    })
    setStatus('saved')
    setSavedAt(f.note.updatedAt)
    setBaseHash(f.baseHash)
    setConflict(null)
    setSaveError('')
  }, [noteId])

  useEffect(() => {
    void reload()
    void loadLinkData()
  }, [reload, loadLinkData])

  const saveNow = useCallback(async (overridePayload?: string): Promise<void> => {
    if (statusRef.current === 'loading') return
    // 冲突未解决：绝不写盘（否则就是覆盖外部版本）。这里必须抛错——导航/关窗的冲刷据此阻止离开，
    // 本地草稿留在编辑器里，用户处理完冲突再离开（宁可拦住也不能丢内容）。
    if (conflictRef.current) throw new Error('存在未解决的保存冲突：请先选择「另存为独立笔记 / 以本地覆盖 / 载入磁盘版本」')
    const payload = overridePayload ?? payloadJson()
    const operation = saveQueueRef.current.catch(() => undefined).then(async () => {
      if (payload === snapshotRef.current) return
      const parsed = JSON.parse(payload) as { title: string; noteType: NoteType; body: string; aliases: string[]; verified: VerifiedStatus; learning?: NoteLearningState | null }
      setStatus('saving')
      try {
        const result = await window.api.noteSave({ id: noteId, title: parsed.title, noteType: parsed.noteType,
          bodyMd: parsed.body, aliases: parsed.aliases, verifiedStatus: parsed.verified, baseHash,
          learning: parsed.learning === undefined ? (learning ?? null) : parsed.learning })
        if (result.conflict) {
          // 冲突是「待决策」而非失败：草稿视为定稿（挂起自动保存），磁盘版本带回界面由用户选择
          snapshotRef.current = payload
          setConflict(result.disk ?? null)
          setStatus('conflict')
          setSaveError('检测到外部修改，本次保存未执行')
          return
        }
        snapshotRef.current = payload
        setStatus('saved')
        setSavedAt(result.savedAt)
        setRevision(result.revisionNo)
        setBaseHash(result.baseHash)
        setSaveError('')
        // 标题/别名/正文变化影响链接索引与反链，保存后静默刷新
        void loadLinkData()
      } catch (error) {
        setStatus('error')
        setSaveError(error instanceof Error ? error.message : String(error))
        throw error
      }
    })
    saveQueueRef.current = operation
    await operation
  }, [noteId, payloadJson, loadLinkData, baseHash])

  /** 冲突出口 1（默认，最安全）：把当前编辑内容另存为独立笔记；原笔记保持磁盘上的外部版本 */
  const resolveConflictAsCopy = useCallback(async (): Promise<void> => {
    const disk = conflictRef.current
    if (!disk) return
    const payload = payloadJson()
    try {
      setStatus('saving')
      const trimmed = title.trim() || '未命名笔记'
      // 与原笔记同名时加后缀，避免列表里两条一模一样分不清（用户可随时改名）
      const copyTitle = trimmed === disk.title.trim() ? `${trimmed}（本地副本）` : trimmed
      const copy = await window.api.noteSaveAsCopy({
        sourceId: noteId, title: copyTitle, noteType, bodyMd: body,
        aliases: parseAliases(aliasesText), verifiedStatus: verified
      })
      // 本地内容已落到新笔记：把当前编辑器状态标记为「已保存」，
      // 否则离开时的冲刷会拿本地草稿再写回原笔记——等于绕过冲突保护。
      // 注意：ref 必须在同一 tick 内显式清掉——nav.go 会立刻走冲刷，等不到重渲染同步 ref。
      snapshotRef.current = payload
      conflictRef.current = null
      setConflict(null)
      setStatus('saved')
      toast.push('已另存为新笔记；原笔记保持外部版本', 'success')
      nav.go({ kind: 'note', noteId: copy.id })
    } catch (err) {
      setStatus('conflict')
      toast.push(`另存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [aliasesText, body, noteId, noteType, nav, payloadJson, title, toast, verified])

  /** 冲突出口 2：以本地覆盖磁盘（写前由主进程把外部版本另存为独立笔记，双方内容都不丢） */
  const resolveConflictOverwrite = useCallback(async (): Promise<void> => {
    if (!conflictRef.current) return
    if (!window.confirm('用当前编辑内容覆盖磁盘上的版本？\n\n外部修改会另存为一条独立笔记保留，不会丢失。')) return
    const payload = payloadJson()
    try {
      setStatus('saving')
      const parsed = JSON.parse(payload) as { title: string; noteType: NoteType; body: string; aliases: string[]; verified: VerifiedStatus }
      const result = await window.api.noteSave({
        id: noteId, title: parsed.title, noteType: parsed.noteType, bodyMd: parsed.body,
        aliases: parsed.aliases, verifiedStatus: parsed.verified, baseHash, force: true
      })
      if (result.conflict) {
        // 极端竞态：写入前磁盘又变了 → 回到冲突态重新选择（不覆盖）
        conflictRef.current = result.disk ?? null
        setConflict(result.disk ?? null)
        setStatus('conflict')
        toast.push('磁盘版本在处理期间又发生了变化，请重新选择', 'info')
        return
      }
      snapshotRef.current = payload
      conflictRef.current = null
      setConflict(null)
      setBaseHash(result.baseHash)
      setSavedAt(result.savedAt)
      setRevision(result.revisionNo)
      setStatus('saved')
      setSaveError('')
      toast.push(result.archivedNoteId ? '已覆盖保存；外部修改已另存为独立笔记' : '已覆盖保存', 'success')
      void loadLinkData()
    } catch (err) {
      setStatus('conflict')
      toast.push(`覆盖保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [baseHash, loadLinkData, noteId, payloadJson, toast])

  /** 冲突出口 3：放弃本地修改、载入磁盘版本（显式确认，避免误点丢草稿） */
  const resolveConflictLoadDisk = useCallback((): void => {
    const disk = conflictRef.current
    if (!disk) return
    if (!window.confirm('放弃本地未保存的修改，载入磁盘上的版本？')) return
    setTitle(disk.title)
    setNoteType(disk.noteType)
    setBody(disk.bodyMd)
    setAliasesText(disk.aliases.join('，'))
    setVerified(disk.verifiedStatus)
    snapshotRef.current = JSON.stringify({ title: disk.title, noteType: disk.noteType, body: disk.bodyMd, aliases: disk.aliases, verified: disk.verifiedStatus, learning: learning ?? null })
    conflictRef.current = null
    setConflict(null)
    setBaseHash(disk.baseHash)
    setSavedAt(disk.updatedAt)
    setRevision(disk.revisionNo)
    setStatus('saved')
    setSaveError('')
    toast.push('已载入磁盘版本', 'info')
  }, [toast])

  // 关闭应用前的冲刷
  useEffect(() => {
    nav.registerFlusher(async () => { await saveNow() })
    return () => nav.registerFlusher(null)
  }, [nav, saveNow])

  // 自动保存（800ms 防抖；失败保留草稿并显示可重试状态）
  useEffect(() => {
    if (statusRef.current === 'loading') return
    if (conflictRef.current) return // 冲突未解决：挂起自动保存，等用户在冲突条上选择（避免反复撞冲突）
    if (payloadJson() === snapshotRef.current) return
    setStatus('dirty')
    const t = setTimeout(() => { void saveNow().catch(() => undefined) }, 800)
    return () => clearTimeout(t)
  }, [payloadJson, saveNow])

  // 预览（300ms 防抖）
  useEffect(() => {
    const t = setTimeout(() => setPreviewHtml(renderMarkdown(body)), 300)
    return () => clearTimeout(t)
  }, [body])

  // 预览中的双链：按索引标注已解析/未解析
  useEffect(() => {
    const container = document.querySelector('.note-preview')
    if (!container) return
    const names = new Map<string, string>()
    for (const e of linkIndex) {
      names.set(e.title.trim().toLowerCase(), e.id)
      for (const a of e.aliases) names.set(a.trim().toLowerCase(), e.id)
    }
    container.querySelectorAll<HTMLAnchorElement>('a.wikilink').forEach((a) => {
      const target = (a.dataset.wikilink ?? '').trim().toLowerCase()
      const hit = names.get(target)
      if (hit) {
        a.classList.add('wikilink-resolved')
        a.dataset.noteId = hit
      } else {
        a.classList.add('wikilink-unresolved')
      }
    })
  }, [previewHtml, linkIndex, viewMode])

  // 预览内点击双链 → 打开目标笔记
  const onPreviewClick = useCallback(
    (e: React.MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null
      if (!a) return
      e.preventDefault()
      const noteTarget = a.dataset.noteId
      if (noteTarget) nav.go({ kind: 'note', noteId: noteTarget })
      else toast.push(`没有匹配「${a.dataset.wikilink ?? ''}」的笔记（标题或别名）`, 'info')
    },
    [nav, toast]
  )

  // ---------- [[ 输入辅助 ----------
  const linkCandidates = useMemo(() => {
    if (linkQuery === null) return []
    const q = linkQuery.trim().toLowerCase()
    const scored = linkIndex
      .filter((e) => {
        if (!q) return true
        if (e.title.toLowerCase().includes(q)) return true
        return e.aliases.some((a) => a.toLowerCase().includes(q))
      })
      .slice(0, 8)
    return scored
  }, [linkIndex, linkQuery])

  const handleBodyChange = (value: string, caret: number): void => {
    setBody(value)
    const before = value.slice(0, caret)
    const open = before.lastIndexOf('[[')
    if (open !== -1) {
      const inner = before.slice(open + 2)
      if (!inner.includes(']]') && !inner.includes('\n') && inner.length <= 80) {
        setLinkQuery(inner)
        setLinkSel(0)
        return
      }
    }
    setLinkQuery(null)
  }

  const insertLink = useCallback(
    (entry: NoteLinkIndexEntry) => {
      const ta = textareaRef.current
      if (!ta) return
      const pos = ta.selectionStart
      const before = body.slice(0, pos)
      const open = before.lastIndexOf('[[')
      const text = open === -1 ? `${body}[[${entry.title}]] ` : `${body.slice(0, open)}[[${entry.title}]] ${body.slice(pos)}`
      setBody(text)
      setLinkQuery(null)
      requestAnimationFrame(() => {
        ta.focus()
        const p = (open === -1 ? body.length : open) + entry.title.length + 4
        ta.setSelectionRange(p, p)
      })
    },
    [body]
  )

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (linkQuery !== null && linkCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setLinkSel((i) => Math.min(i + 1, linkCandidates.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setLinkSel((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        insertLink(linkCandidates[linkSel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setLinkQuery(null)
        return
      }
    }
  }

  // ---------- 笔记插图（粘贴 / 文件选择，内容寻址存入 笔记/附件） ----------
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [imgBusy, setImgBusy] = useState(false)

  const insertBodyText = useCallback(
    (text: string): void => {
      const ta = textareaRef.current
      const start = ta?.selectionStart ?? body.length
      const end = ta?.selectionEnd ?? start
      setBody(`${body.slice(0, start)}${text}${body.slice(end)}`)
      requestAnimationFrame(() => {
        if (!ta) return
        ta.focus()
        const p = start + text.length
        ta.setSelectionRange(p, p)
      })
    },
    [body]
  )

  const addImageFiles = useCallback(
    async (files: Array<File | Blob>): Promise<void> => {
      if (files.length === 0) return
      setImgBusy(true)
      try {
        const parts: string[] = []
        for (const file of files) {
          const data = new Uint8Array(await file.arrayBuffer())
          const r = await window.api.noteImageAdd(data, (file as File).name)
          parts.push(`![](asset:${r.assetId})`)
        }
        insertBodyText(`\n${parts.join('\n\n')}\n`)
        toast.push(files.length > 1 ? `已插入 ${files.length} 张图片` : '已插入图片', 'success')
      } catch (err) {
        toast.push(`插图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      } finally {
        setImgBusy(false)
      }
    },
    [insertBodyText, toast]
  )

  const onBodyPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(
      (f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|hei[cf]|tiff?)$/i.test(f.name)
    )
    if (files.length === 0) return
    e.preventDefault()
    void addImageFiles(files)
  }

  const attachCapture = async (captureId: string): Promise<void> => {
    try {
      await saveNow()
      const r = await window.api.noteAttachCapture(noteId, captureId)
      toast.push(r.already ? '该照片已关联' : '已关联照片', r.already ? 'info' : 'success')
      setShowCapturePicker(false)
      await reload()
    } catch (err) {
      toast.push(`关联失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  if (!full) {
    return (
      <div className="view view-scroll">
        <div className="muted">加载笔记…</div>
      </div>
    )
  }

  return (
    <div className={`view note-editor ${viewMode === 'learn' ? 'note-editor-learning' : ''}`}>
      <div className="note-editor-head">
        <button className="btn" onClick={() => nav.go({ kind: 'notes' })}>
          ← 笔记
        </button>
        <div className="note-mode-switch" role="group" aria-label="编辑器视图">
          {([['learn', '学习'], ['edit', '编辑'], ['split', '分屏'], ['read', '阅读']] as Array<[EditorMode, string]>).map(([m, label]) => (
            <button key={m} className={viewMode === m ? 'note-mode-active' : ''} aria-pressed={viewMode === m} onClick={() => switchMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <div className="save-status" role="status">
          {status === 'loading' && <span className="muted">加载中…</span>}
          {status === 'dirty' && <span className="status-dirty">有未保存修改…</span>}
          {status === 'saving' && <span className="status-saving">保存中…</span>}
          {status === 'saved' && <span className="status-saved">已保存</span>}
          {status === 'conflict' && <span className="status-error">检测到外部修改 · 待处理</span>}
          {status === 'error' && (
            <span className="status-error">
              保存失败：{saveError}
              <button className="btn btn-sm" onClick={() => { void saveNow().catch(() => undefined) }}>
                重试
              </button>
            </span>
          )}
        </div>
      </div>

      {conflict && (
        <div className="save-conflict" role="alert" aria-label="保存冲突">
          <div className="save-conflict-main">
            <strong>检测到外部修改</strong>
            <span className="muted small">
              这篇笔记在磁盘上已被外部（另一台机器、同步工具或外部编辑器）修改。为避免覆盖，本次保存未执行——你的修改仍在编辑器中。
            </span>
            {conflict.parseFailed && (
              <span className="muted small">磁盘上的版本已损坏（front-matter 无法解析）；「载入磁盘版本」会把原始文本放进正文。</span>
            )}
          </div>
          <div className="save-conflict-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void resolveConflictAsCopy()}>另存为独立笔记</button>
            <button className="btn btn-sm" onClick={() => void resolveConflictOverwrite()}>以本地覆盖</button>
            <button className="btn btn-sm" onClick={resolveConflictLoadDisk}>载入磁盘版本</button>
          </div>
        </div>
      )}

      <input
        className="input note-title-input"
        placeholder="标题"
        aria-label="笔记标题"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      {/* 创建/最近更新日期：完整时间与修订次数经悬停或键盘聚焦（title 提示）查看 */}
      <div
        className="note-date-line muted small"
        tabIndex={0}
        role="note"
        aria-label={noteDateDetail(full.note.createdAt, savedAt, revision)}
        title={noteDateDetail(full.note.createdAt, savedAt, revision)}
      >
        {noteDateLine(full.note.createdAt, savedAt)}
      </div>

      {noteFindOpen && (
        <div className="reader-find note-find" role="search" aria-label="在笔记内查找">
          <input
            className="input find-input"
            autoFocus
            aria-label="在笔记内查找"
            placeholder="在笔记内查找…"
            value={noteFindQuery}
            onChange={(e) => setNoteFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); noteFindStep(e.shiftKey ? -1 : 1) }
              else if (e.key === 'Escape') { e.preventDefault(); setNoteFindOpen(false) }
            }}
          />
          <span className="muted small find-count" role="status">
            {!noteFindQuery.trim()
              ? '输入关键词（Enter 下一个，Shift+Enter 上一个）'
              : noteFindTotal === 0
                ? '无匹配'
                : `${noteFindIdx + 1} / ${noteFindTotal} 个匹配`}
          </span>
          <button className="btn btn-sm" aria-label="上一个匹配" disabled={noteFindTotal === 0} onClick={() => noteFindStep(-1)}><Icon name="pagePrev" size={15} /></button>
          <button className="btn btn-sm" aria-label="下一个匹配" disabled={noteFindTotal === 0} onClick={() => noteFindStep(1)}><Icon name="pageNext" size={15} /></button>
          <button className="icon-btn" aria-label="关闭查找" onClick={() => setNoteFindOpen(false)}>×</button>
        </div>
      )}

      <div className={`note-editor-body note-editor-body-links ${viewMode === 'learn' ? '' : 'note-editor-body-paper'} ${viewMode === 'split' ? 'note-editor-body-split' : ''} ${viewMode === 'read' ? 'note-editor-body-read' : ''}`} ref={bodyRef}>
        <div
          className={`note-editor-editor ${viewMode === 'read' || viewMode === 'learn' ? 'note-editor-editor-hidden' : ''}`}
          style={viewMode === 'split' ? { flex: `0 0 ${splitRatio}%` } : undefined}
        >
          <div className="note-edit-tools">
            <button className="btn btn-sm" disabled={imgBusy} onClick={() => fileInputRef.current?.click()}>
              {imgBusy ? '插图保存中…' : '插图…'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/heic,image/heif,image/tiff"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                void addImageFiles(files)
              }}
            />
            <span className="muted small">截图后直接在正文 ⌘/Ctrl+V 粘贴也可</span>
          </div>
          <textarea
            ref={textareaRef}
            className="note-textarea"
            aria-label="笔记正文"
            value={body}
            onChange={(e) => handleBodyChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onTextareaKeyDown}
            onPaste={onBodyPaste}
            placeholder={'从这里开始写，不用先选分类。\n支持 Markdown 和 LaTeX；输入 [[ 链接另一篇笔记。'}
            spellCheck={false}
          />
          {linkQuery !== null && (
            <div className="wikilink-pop" role="listbox" aria-label="链接到笔记">
              {linkCandidates.length === 0 && <div className="muted small wl-empty">没有匹配「{linkQuery}」的笔记，可直接留为未解析链接</div>}
              {linkCandidates.map((c, i) => (
                <button
                  key={c.id}
                  role="option"
                  aria-selected={i === linkSel}
                  className={`wl-item ${i === linkSel ? 'wl-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault() // 不让 textarea 失焦
                    insertLink(c)
                  }}
                  onMouseEnter={() => setLinkSel(i)}
                >
                  <span className={`tag tag-${c.id === noteId ? 'anchor' : 'note'}`}>{c.id === noteId ? '本笔记' : '笔记'}</span>
                  <span className="wl-title">{c.title}</span>
                  {c.aliases.length > 0 && <span className="muted small">{c.aliases.slice(0, 2).join('，')}</span>}
                </button>
              ))}
              <div className="muted small wl-hint">↑↓ 选择 · Enter 插入 · Esc 关闭</div>
            </div>
          )}
        </div>
        {viewMode === 'split' && (
          <div
            className="note-split-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整编辑与预览分栏宽度"
            title="拖拽调整宽度 · 双击复位"
            tabIndex={0}
            onDoubleClick={() => { setSplitRatio(50); persistSplit(50) }}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              const next = clampSplit(splitRatio + (e.key === 'ArrowLeft' ? -2 : 2))
              setSplitRatio(next)
              persistSplit(next)
            }}
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={onDividerUp}
            onPointerCancel={onDividerUp}
          />
        )}
        {viewMode === 'learn' && <NoteLearningView
          key={noteId}
          noteId={noteId}
          title={title}
          body={body}
          links={linkIndex}
          onOpen={id => nav.go({ kind: 'note', noteId: id })}
          learning={learning}
          onChange={(next) => {
            // 自评是显式动作：立即保存（走同一条保存管线，冲突保护与 baseHash 一并生效）
            const payload = JSON.stringify({
              title, noteType, body, aliases: parseAliases(aliasesText), verified, learning: next
            })
            setLearning(next)
            void saveNow(payload).catch(() => undefined)
          }}
          saveStatus={status}
          onRetry={() => { void saveNow().catch(() => undefined) }}
        />}
        {viewMode !== 'edit' && viewMode !== 'learn' && (
          <div className="note-preview md-body" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: previewHtml }} />
        )}
      </div>

      <details className="note-info">
        <summary>更多信息</summary>
        <div className="note-info-body">
          <div className="note-info-row">
            <label>分类（可选）<select className="input" value={noteType} onChange={(e) => setNoteType(e.target.value as NoteType)} aria-label="笔记类型">
              {Object.entries(NOTE_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select></label>
            <label>核对状态<button
              className={`btn ${verified === 'checked' ? 'btn-outline-active' : ''}`}
              onClick={() => setVerified(verified === 'checked' ? 'unchecked' : 'checked')}
              title="核对状态是人工记录，不代表任何自动判定"
            >
              {verified === 'checked' ? '✓ 已核对' : '未核对'}
            </button></label>
          </div>
          <label>别名（逗号分隔；搜索和双链都会用到）<input
            className="input aliases-input"
            placeholder="例如：MVT、Lagrange中值定理"
            value={aliasesText}
            onChange={(e) => setAliasesText(e.target.value)}
          /></label>
          <div><span className="muted small" style={{ display: 'block', marginBottom: 6 }}>所属学习区</span>
            <SpaceSelect entity="note" id={noteId} value={full.note.spaceId} onChanged={(spaceId) => {
              setFull((previous) => previous ? { ...previous, note: { ...previous.note, spaceId } } : previous)
            }} />
          </div>
        </div>
      </details>

      <details className="note-relations" open={backlinks.length + full.anchors.length + full.documents.length + full.captures.length > 0}>
        <summary>来源与关联</summary>
      <div className="note-sources">
        <div className="section-title">反向链接（{backlinks.length}）</div>
        {backlinks.length === 0 && <div className="muted small">还没有其他笔记链接到这里。在别的笔记正文里输入 [[本笔记标题]] 即可建立联系。</div>}
        {backlinks.map((b) => (
          <div key={b.fromNoteId} className="source-row backlink-row">
            <div className="source-main">
              <div className="source-title">
                <span className={`tag tag-${b.fromNoteType}`}>{NOTE_TYPE_LABELS[b.fromNoteType]}</span>
                {b.fromTitle}
              </div>
              <div className="source-quote muted">{b.snippet}</div>
            </div>
            <button className="btn btn-sm" onClick={() => nav.go({ kind: 'note', noteId: b.fromNoteId })}>
              打开
            </button>
          </div>
        ))}

        {full.documents.length > 0 && <>
          <div className="section-title">材料来源（{full.documents.length}）</div>
          {full.documents.map((source) => <div className="source-row" key={source.documentId}>
            <div className="source-main"><div className="source-title">{source.title}</div><div className="muted small">整份 {source.mediaType === 'text/html' ? 'HTML' : 'PDF'} 材料</div></div>
            <button className="btn btn-sm" onClick={() => nav.go({ kind: source.mediaType === 'text/html' ? 'html' : 'reader', documentId: source.documentId })}>打开材料</button>
          </div>)}
        </>}
        <div className="section-title">PDF 来源（{full.anchors.length}）</div>
        {full.anchors.length === 0 && <div className="muted small">暂无。可在阅读器中框选后关联到本笔记。</div>}
        {full.anchors.map((a) => (
          <div key={a.id} className="source-row">
            <div className="source-main">
              <div className="source-title">
                {a.documentTitle} · 第 {a.pageIndex + 1} 页{a.pageLabel ? `（标签 ${a.pageLabel}）` : ''}
              </div>
              {a.quote && <div className="source-quote muted">{a.quote.slice(0, 120)}</div>}
            </div>
            <button
              className="btn btn-sm"
              onClick={() => nav.go({ kind: 'reader', documentId: a.documentId, jumpAnchorId: a.id, noteId })}
            >
              回原文 · 第 {a.pageIndex + 1} 页
            </button>
          </div>
        ))}

        <div className="section-title">
          照片附件（{full.captures.length}）
          <button className="btn btn-sm" onClick={() => setShowCapturePicker(true)}>
            添加照片
          </button>
        </div>
        {full.captures.length === 0 && <div className="muted small">暂无。演草纸照片可从收件箱关联。</div>}
        <div className="capture-grid">
          {full.captures.map((c) => (
            <button key={c.id} className="capture-thumb" onClick={() => setPreviewImg(assetUrl(c.assetId, 'display'))}>
              <img src={assetUrl(c.assetId, 'thumb')} alt={c.originalName} />
              <span className="capture-name">{c.originalName}</span>
            </button>
          ))}
        </div>

        {/* 失效来源：来源对象被删除后不再无声消失——显式列出，避免用户以为「笔记还连着原文」 */}
        {full.missingSources.length > 0 && <>
          <div className="section-title">已失效来源（{full.missingSources.length}）</div>
          {full.missingSources.map((m) => (
            <div key={`${m.kind}-${m.id}`} className="source-row">
              <div className="source-main">
                <div className="source-title muted">来源已删除，无法回跳</div>
                <div className="muted small">
                  {m.kind === 'anchor' ? '原文摘录' : m.kind === 'capture' ? '收件箱照片' : '材料'} · {m.id.slice(0, 8)}
                </div>
              </div>
            </div>
          ))}
        </>}
      </div>

      </details>

      {showCapturePicker && (
        <CapturePicker
          onPick={(id) => void attachCapture(id)}
          onClose={() => setShowCapturePicker(false)}
        />
      )}
      {previewImg && <ImagePreview src={previewImg} onClose={() => setPreviewImg(null)} />}
    </div>
  )
}
