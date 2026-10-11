import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Nav } from '../App'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { FootprintPanel, footprintOpenState } from '../components/FootprintPanel'
import { LoadError } from '../components/LoadError'
import { useAsyncData } from '../lib/use-async-data'
import { useStudySpace } from '../study-space'
import { NOTE_TYPE_LABELS, type NoteSummary, type NoteType, type SearchAnchorHit, type SearchNoteHit } from '@shared/types'
import { updateLabel, fullStamp } from '../lib/time-label'

export function NotesView({ nav, refreshApp, typeFilter, onTypeFilter, typeCounts, query, onQuery }: {
  nav: Nav
  refreshApp(): void
  typeFilter: 'all' | NoteType
  onTypeFilter(value: 'all' | NoteType): void
  typeCounts: Record<string, number>
  query: string
  onQuery(value: string): void
}): React.ReactElement {
  const { scope } = useStudySpace()
  // 展开状态走会话内持久：从足迹记录跳去阅读/编辑再返回，面板保持展开
  const [footprintOpen, setFootprintOpen] = useState(footprintOpenState.get())
  const toast = useToast()
  const creatingRef = useRef(false)
  const mounted = useRef(true)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // 列表与搜索统一走 useAsyncData：查询防抖 250ms，失败可重试（P0-2）。
  // 2026-10-09（architecture §15）：搜索态只发一次 search（分组命中），不再与 noteList 双路扫描
  const list = useAsyncData(
    async () => {
      const q = query.trim()
      if (!q) return { mode: 'browse' as const, notes: await window.api.noteList(undefined, scope), anchorHits: [] as SearchAnchorHit[], notesTotal: 0, anchorsTotal: 0 }
      const s = await window.api.search(q, scope)
      return { mode: 'search' as const, notes: s.notes, anchorHits: s.anchors, notesTotal: s.notesTotal, anchorsTotal: s.anchorsTotal }
    },
    [query, scope],
    { debounceMs: 250 }
  )

  const newNote = useCallback(async () => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    try {
      const note = await window.api.noteCreate({ title: '未命名笔记', noteType: 'note', spaceId: scope ?? null })
      if (!mounted.current) return
      refreshApp()
      nav.go({ kind: 'note', noteId: note.id })
    } catch (err) {
      toast.push(`创建失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally { creatingRef.current = false; if (mounted.current) setCreating(false) }
  }, [nav, refreshApp, toast, scope])

  const notes = list.data?.notes ?? []
  const anchorHits = list.data?.anchorHits ?? []
  const searching = list.data?.mode === 'search'
  // 文献笔记分流（2026-10-09）：浏览时默认只显示「自己的知识笔记」；搜索时不过滤（明确意图，结果全量）。
  // 口径 = sources 含 anchor/document
  const [showDocNotes, setShowDocNotes] = useState(false)
  // 搜索态元素是 SearchNoteHit（分组命中），浏览态是 NoteSummary
  const searchNotes = searching ? (notes as unknown as SearchNoteHit[]) : []
  const browseNotes = searching ? [] : (notes as unknown as NoteSummary[])
  const visibleSearch = useMemo(
    () => searchNotes.filter((n) => typeFilter === 'all' || n.noteType === typeFilter),
    [searchNotes, typeFilter]
  )
  const visibleBrowse = useMemo(
    () => browseNotes.filter((n) => (showDocNotes || !n.fromDoc) && (typeFilter === 'all' || n.noteType === typeFilter)),
    [browseNotes, typeFilter, showDocNotes]
  )
  // 被隐藏的文献笔记数（提示用，让用户知道不是丢了；只统计浏览口径）
  const hiddenDocCount = useMemo(
    () => browseNotes.filter((n) => n.fromDoc && (typeFilter === 'all' || n.noteType === typeFilter)).length,
    [browseNotes, typeFilter]
  )
  const visibleCount = visibleSearch.length + visibleBrowse.length
  const openNote = (id: string, hit: SearchNoteHit, blockIndex?: number): void => {
    const block = (blockIndex !== undefined ? hit.blockHits?.find((b) => b.blockIndex === blockIndex) : undefined) ?? hit.blockHits?.[0]
    nav.go({ kind: 'note', noteId: id, ...(block ? { locateBlock: { heading: block.heading, blockIndex: block.blockIndex } } : {}) })
  }
  return (
    <div className="view view-scroll">
      <div className="view-head">
        <h1>笔记</h1>
        <div className="view-actions">
          <button className="btn" aria-expanded={footprintOpen} onClick={() => setFootprintOpen((v) => { footprintOpenState.set(!v); return !v })}>
            学习足迹
          </button>
          <button
            className={`btn ${showDocNotes ? 'btn-outline-active' : ''}`}
            aria-pressed={showDocNotes}
            onClick={() => setShowDocNotes((v) => !v)}
            title="读文献时记的笔记默认收在文献上下文；打开后在笔记区一并显示"
          >
            {showDocNotes ? '✓ 含文献笔记' : '含文献笔记'}
          </button>
          <button className="btn btn-primary" disabled={creating} onClick={() => void newNote()}>
            {creating ? '创建中…' : '＋ 新笔记'}
          </button>
        </div>
      </div>
      <p className="muted view-desc">先写下来，标题随时可以改。</p>
      {/* 笔记类型筛选：原为外壳侧栏维度，筛选收敛后移入视图内的下划线标签行（带计数） */}
      <div className="filter-tabs" role="group" aria-label="笔记类型">
        <button className={`chip ${typeFilter === 'all' ? 'chip-active' : ''}`} aria-pressed={typeFilter === 'all'} onClick={() => onTypeFilter('all')}>
          全部{(typeCounts.all ?? 0) > 0 && <span className="tab-count">{typeCounts.all}</span>}
        </button>
        {(Object.entries(NOTE_TYPE_LABELS) as Array<[NoteType, string]>).map(([kind, label]) => (
          <button key={kind} className={`chip ${typeFilter === kind ? 'chip-active' : ''}`} aria-pressed={typeFilter === kind} onClick={() => onTypeFilter(kind)}>
            {label}{(typeCounts[kind] ?? 0) > 0 && <span className="tab-count">{typeCounts[kind]}</span>}
          </button>
        ))}
      </div>
      {footprintOpen && <FootprintPanel nav={nav} />}
      <div className="list-tools">
        <label className="search-field"><Icon name="search" size={17} /><input
          className="input search-input"
          aria-label="搜索笔记"
          placeholder="搜索标题、别名与正文…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        /></label>
      </div>
      {list.data && query.trim() && (
        <div className="muted small">
          {list.data.notesTotal > visibleCount
            ? `已显示 ${visibleCount} / 共 ${list.data.notesTotal} 条笔记（关键词更精确可缩小范围）`
            : `${visibleCount} 条笔记`}
          {` · ${anchorHits.length}${
            list.data.anchorsTotal > anchorHits.length ? ` / 共 ${list.data.anchorsTotal}` : ''
          } 条摘录`}
        </div>
      )}
      {!showDocNotes && hiddenDocCount > 0 && (
        <div className="muted small">
          另有 {hiddenDocCount} 条读文献时记的笔记未在此显示——它们跟着文献走，点「含文献笔记」可一并查看。
        </div>
      )}
      {list.error ? (
        <LoadError message={list.error} onRetry={list.retry} />
      ) : (
        <>
          {list.loading && <div className="muted">搜索中…</div>}
          {!list.loading && visibleCount === 0 && anchorHits.length === 0 && (
            <div className="empty-state">
              <div className="empty-title">
                {query.trim() || typeFilter !== 'all'
                  ? '没有匹配结果'
                  : !showDocNotes && hiddenDocCount > 0
                    ? '还没有独立的笔记'
                    : '还没有笔记'}
              </div>
              <div>
                {query.trim()
                  ? '换个关键词试试。'
                  : typeFilter !== 'all'
                    ? '换个筛选条件试试。'
                    : !showDocNotes && hiddenDocCount > 0
                      ? `读文献时记的 ${hiddenDocCount} 条笔记跟着文献走；点上方「含文献笔记」查看，或点「新笔记」写一篇自己的。`
                      : '点「新笔记」直接写，或在阅读时随手记录。'}
              </div>
            </div>
          )}
          <div className="note-list">
            {visibleSearch.map((hit) => (
              <div key={hit.id} className="note-item note-hit">
                <button className="note-hit-main" onClick={() => openNote(hit.id, hit)}>
                  <Icon name="note" size={17} />
                  <span className="note-title">{hit.title}</span>
                  <span className="muted small note-time" title={`最近更新：${fullStamp(hit.updatedAt ?? '')}`}>{updateLabel(hit.updatedAt ?? '')}</span>
                  <span className="muted small">{hit.blockHitCount ?? 0} 处命中</span>
                </button>
                {hit.blockHits && hit.blockHits.length > 0 && (
                  <div className="note-hit-blocks">
                    {hit.blockHits.map((b) => (
                      <button key={b.blockIndex} className="note-hit-block" onClick={() => openNote(hit.id, hit, b.blockIndex)}
                        title={b.heading ? `定位到「${b.heading}」` : '定位到正文开头'}>
                        <span className="note-hit-heading">{b.heading ?? '（开头）'}</span>
                        <span className="muted small">{b.snippet}</span>
                      </button>
                    ))}
                    {(hit.blockHitCount ?? 0) > 3 && (
                      <span className="muted small note-hit-more">还有 {hit.blockHitCount! - 3} 处命中</span>
                    )}
                  </div>
                )}
              </div>
            ))}
            {visibleBrowse.map((n) => (
              <button key={n.id} className="note-item" onClick={() => nav.go({ kind: 'note', noteId: n.id })}>
                <Icon name="note" size={17} />
                <span className="note-title">{n.title}</span>
                <span className="muted small note-time" title={`最近更新：${fullStamp(n.updatedAt)}`}>{updateLabel(n.updatedAt)}</span>
                {(n.anchorCount > 0 || n.captureCount > 0) && (
                  <span className="muted small">
                    {n.anchorCount > 0 ? `${n.anchorCount} 来源 ` : ''}
                    {n.captureCount > 0 ? `${n.captureCount} 照片` : ''}
                  </span>
                )}
              </button>
            ))}
          </div>
          {anchorHits.length > 0 && (
            <>
              <div className="section-title">匹配的摘录</div>
              <div className="note-list">
                {anchorHits.map((a) => (
                  <button
                    key={a.anchorId}
                    className="note-item"
                    onClick={() => nav.go({ kind: 'reader', documentId: a.documentId, jumpAnchorId: a.anchorId })}
                  >
                    <span className="tag tag-anchor">摘录</span>
                    <span className="note-title">
                      {a.documentTitle} · 第 {a.pageIndex + 1} 页
                    </span>
                    <span className="muted small">{a.quote?.slice(0, 40) ?? '（区域）'}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
