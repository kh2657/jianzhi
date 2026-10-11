import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MemoRecord } from '@shared/types'
import type { Nav } from '../App'
import { LoadError } from '../components/LoadError'
import { useToast } from '../components/Toast'
import { useAsyncData } from '../lib/use-async-data'
import './IdeasView.css'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const dateLabel = (value: string): string => new Date(value).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
})

/** 想法沿用速记文件；归档与转笔记均保留原文，不增加新的存储格式。 */
export function IdeasView({ nav, onCapture }: { nav: Nav; onCapture(): void }): React.ReactElement {
  const toast = useToast()
  const memos = useAsyncData(() => window.api.memoList(), [])
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [editing, setEditing] = useState<{ id: string; original: string; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const savePromise = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)
  const reloadRef = useRef(memos.reload)
  reloadRef.current = memos.reload
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  useEffect(() => window.api.onLibraryChanged(({ kinds }) => {
    if (kinds.includes('memos')) void reloadRef.current()
  }), [])

  const saveEdit = useCallback(async (): Promise<void> => {
    if (savePromise.current) return savePromise.current
    if (!editing) return
    const text = editing.text.trim()
    if (!text) throw new Error('想法内容不能为空；取消编辑可保留原文')
    if (text === editing.original) {
      setEditing(null)
      return
    }
    const pending = (async (): Promise<void> => {
      setBusyId(editing.id)
      try {
        await window.api.memoSave(editing.id, { text })
        setEditing(null)
        await reloadRef.current()
      } finally {
        setBusyId(null)
      }
    })()
    savePromise.current = pending
    try { await pending } finally { savePromise.current = null }
  }, [editing])

  useEffect(() => {
    nav.registerFlusher(saveEdit)
    return () => nav.registerFlusher(null)
  }, [nav, saveEdit])

  const ideas = useMemo(() => (memos.data ?? []).filter((memo) => !memo.todo), [memos.data])
  const activeCount = ideas.filter((memo) => memo.inboxStatus === 'inbox').length
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return ideas.filter((memo) => memo.id === editing?.id || (
      (memo.inboxStatus === 'filed') === archived && (!needle || memo.text.toLocaleLowerCase().includes(needle))
    )).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [ideas, query, archived, editing?.id])

  const save = (): void => {
    void saveEdit().then(() => toast.push('想法已保存', 'success')).catch((error) => toast.push(`保存失败：${messageOf(error)}`, 'error'))
  }

  const capture = (): void => {
    void saveEdit().then(() => { if (mounted.current) onCapture() }).catch((error) => toast.push(`先保存当前想法：${messageOf(error)}`, 'error'))
  }

  const archive = async (memo: MemoRecord): Promise<void> => {
    if (busyId) return
    setBusyId(memo.id)
    try {
      await window.api.memoSave(memo.id, { inboxStatus: memo.inboxStatus === 'filed' ? 'inbox' : 'filed' })
      await reloadRef.current()
      toast.push(memo.inboxStatus === 'filed' ? '已恢复到想法' : '已归档，原文保留', 'success')
    } catch (error) {
      toast.push(`操作失败：${messageOf(error)}`, 'error')
    } finally { setBusyId(null) }
  }

  const convert = async (memo: MemoRecord): Promise<void> => {
    if (busyId) return
    setBusyId(memo.id)
    try {
      const note = await window.api.memoToNote(memo.id)
      toast.push('已转成笔记，原想法保留在已归档', 'success')
      await reloadRef.current()
      if (mounted.current) nav.go({ kind: 'note', noteId: note.id })
    } catch (error) {
      toast.push(`转笔记失败：${messageOf(error)}`, 'error')
    } finally { setBusyId(null) }
  }

  return (
    <div className="view view-scroll ideas-view">
      <div className="view-head">
        <h1>想法</h1>
        <div className="view-actions"><button className="btn btn-primary" disabled={Boolean(busyId)} onClick={capture}>新想法</button></div>
      </div>
      <p className="muted view-desc">先记下来，再慢慢展开。想法在这里独立保存，需要深入时再转成笔记。</p>
      <div className="ideas-toolbar">
        <div className="ideas-tabs" role="group" aria-label="想法状态">
          <button className={`btn btn-sm${!archived ? ' active' : ''}`} aria-pressed={!archived} disabled={Boolean(editing) || Boolean(busyId)} onClick={() => setArchived(false)}>想法 · {activeCount}</button>
          <button className={`btn btn-sm${archived ? ' active' : ''}`} aria-pressed={archived} disabled={Boolean(editing) || Boolean(busyId)} onClick={() => setArchived(true)}>已归档 · {ideas.length - activeCount}</button>
        </div>
        <input type="search" className="input ideas-search" aria-label="搜索想法" placeholder="搜索想法…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {memos.error ? <LoadError message={memos.error} onRetry={memos.retry} /> : (
        <>
          {memos.loading && <div className="muted" role="status">加载中…</div>}
          {!memos.loading && visible.length === 0 && (
            <div className="empty-state">
              <div className="empty-title">{query.trim() ? '没有匹配的想法' : archived ? '还没有归档的想法' : '把第一个想法记下来'}</div>
              <div className="muted">{query.trim() ? '试试其他关键词，或清空搜索。' : archived ? '归档和转成笔记后，原文会留在这里。' : '一个问题、一句灵感，暂时不用起标题或分类。'}</div>
              {!query.trim() && !archived && <button className="btn" disabled={Boolean(busyId)} onClick={capture}>写第一个想法</button>}
            </div>
          )}
          <div className="ideas-list">
            {visible.map((memo) => (
              <article className="ideas-row" key={memo.id} data-idea-id={memo.id}>
                <div className="memo-body">
                  {editing?.id === memo.id ? (
                    <textarea className="input ideas-editor" aria-label="编辑想法" autoFocus rows={5} maxLength={20000} value={editing.text} disabled={busyId === memo.id}
                      onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); save() }
                        if (event.key === 'Escape' && !busyId) { event.preventDefault(); setEditing(null) }
                      }} />
                  ) : <div className="memo-text">{memo.text}</div>}
                  <div className="memo-meta muted small"><time dateTime={memo.createdAt}>{dateLabel(memo.createdAt)}</time>{memo.inboxStatus === 'filed' && <span>已归档 · 原文保留</span>}</div>
                </div>
                <div className="memo-actions">
                  {editing?.id === memo.id ? (
                    <><button className="btn btn-primary btn-sm" disabled={Boolean(busyId) || !editing.text.trim()} onClick={save}>{busyId === memo.id ? '保存中…' : '保存'}</button><button className="btn btn-sm" disabled={Boolean(busyId)} onClick={() => setEditing(null)}>取消</button></>
                  ) : (
                    <><button className="btn btn-sm" disabled={Boolean(busyId) || Boolean(editing)} onClick={() => setEditing({ id: memo.id, original: memo.text, text: memo.text })}>编辑</button>{memo.inboxStatus !== 'filed' && <button className="btn btn-sm" disabled={Boolean(busyId) || Boolean(editing)} onClick={() => void convert(memo)}>转成笔记</button>}<button className="btn btn-sm" disabled={Boolean(busyId) || Boolean(editing)} onClick={() => void archive(memo)}>{memo.inboxStatus === 'filed' ? '恢复' : '归档'}</button></>
                  )}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
