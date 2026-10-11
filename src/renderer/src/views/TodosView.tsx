import { useMemo } from 'react'
import type { Nav } from '../App'
import { LoadError } from '../components/LoadError'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toast'
import { useAsyncData } from '../lib/use-async-data'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 待办：不存新的东西，也不做通用 todo 清单——队列全部从已有对象里长出来：
 * 速记（标了待办的在前，未整理的跟后；收件箱视图已删除，这里就是速记的家）、
 * 知识块自评「有疑问」的笔记、书目「待补全」的文献。
 * 完成一条待办 = 把它从队列摘出去（速记归档），内容本身不删；速记可就地转成笔记。
 */
export function TodosView({ nav, refreshApp, onQuickCapture }: { nav: Nav; refreshApp(): void; onQuickCapture(): void }): React.ReactElement {
  const toast = useToast()
  const memos = useAsyncData(() => window.api.memoList({ inboxStatus: 'inbox' }), [])
  const notes = useAsyncData(() => window.api.noteList(), [])
  // 待补全走检索接口的状态维度（docList 不带 status）；空查询 + 状态筛选就是列表口径
  const review = useAsyncData(() => window.api.librarySearch({ q: '', status: 'needs-review' }), [])

  // 待办的排前面；未整理速记跟在后面——同一队列、同一套动作（完成 / 转成笔记 / 删除）
  const inboxMemos = useMemo(
    () => [...(memos.data ?? [])].sort((a, b) => Number(b.todo ?? false) - Number(a.todo ?? false)),
    [memos.data]
  )
  const todoCount = useMemo(() => inboxMemos.filter((m) => m.todo).length, [inboxMemos])
  const questionNotes = useMemo(() => (notes.data ?? []).filter((n) => n.questionCount > 0), [notes.data])
  const reviewDocs = useMemo(() => (review.data?.hits ?? []).map((h) => ({ id: h.entry.id, title: h.entry.title })), [review.data])

  const reloadAll = async (): Promise<void> => {
    await Promise.all([memos.reload(), notes.reload(), review.reload()])
  }
  const retryAll = (): void => {
    memos.retry()
    notes.retry()
    review.retry()
  }

  const completeMemo = async (id: string): Promise<void> => {
    try {
      await window.api.memoSave(id, { inboxStatus: 'filed' })
      toast.push('已完成，速记移入已归档', 'success')
      await reloadAll()
      refreshApp()
    } catch (err) {
      toast.push(`操作失败：${errMsg(err)}`, 'error')
    }
  }

  const memoToNote = async (id: string): Promise<void> => {
    try {
      const note = await window.api.memoToNote(id)
      toast.push(`已转成笔记《${note.title}》`, 'success')
      await reloadAll()
      refreshApp()
    } catch (err) {
      toast.push(`转笔记失败：${errMsg(err)}`, 'error')
    }
  }

  const removeMemo = async (id: string): Promise<void> => {
    try {
      const r = await window.api.memoDelete(id)
      toast.push(r.trashed ? '已删除，文件在系统废纸篓里可恢复' : '已删除', 'success')
      await reloadAll()
      refreshApp()
    } catch (err) {
      toast.push(`删除失败：${errMsg(err)}`, 'error')
    }
  }

  const error = memos.error ?? notes.error ?? review.error
  const loading = memos.loading || notes.loading || review.loading
  const total = inboxMemos.length + questionNotes.length + reviewDocs.length

  return (
    <div className="view view-scroll">
      <div className="view-head">
        <h1>待办</h1>
        <div className="view-actions">
          {total > 0 && <span className="muted">{total} 件事等你处理</span>}
          <button className="btn btn-primary" onClick={onQuickCapture} title="速记（⌥⌘N / Ctrl+Alt+N，应用在后台也能唤起）">
            写速记
          </button>
        </div>
      </div>
      <p className="muted view-desc">
        待办不单独存放：它们是你已有对象里还没处理完的部分——标了待办的速记、还没整理的速记、自评「有疑问」的知识块、书目待补全的文献。想到新东西按 ⌥⌘N（Windows：Ctrl+Alt+N）记下来，以 ! 开头就是待办。
      </p>
      {error ? (
        <LoadError message={error} onRetry={retryAll} />
      ) : (
        <>
          {loading && <div className="muted">加载中…</div>}
          {!loading && total === 0 && (
            <div className="empty-state">
              <div className="empty-title">没有待办</div>
              <div>速记、知识块、书目都清了。想到新东西按 ⌥⌘N（Windows：Ctrl+Alt+N）记下来，以 ! 开头就是待办。</div>
            </div>
          )}

          {inboxMemos.length > 0 && (
            <section className="inbox-section">
              <div className="section-title">速记（{inboxMemos.length}{todoCount > 0 ? ` · ${todoCount} 条待办` : ''}）</div>
              <div className="memo-list">
                {inboxMemos.map((m) => (
                  <div key={m.id} className="todo-row">
                    {m.todo && (
                      <button
                        className="todo-check"
                        aria-label="完成这条待办"
                        title="完成：速记移入已归档（内容保留）"
                        onClick={() => void completeMemo(m.id)}
                      >
                        <Icon name="check" size={14} />
                      </button>
                    )}
                    {!m.todo && <span className="todo-dot" aria-hidden="true" />}
                    <button className="todo-label" onClick={() => nav.go({ kind: 'todos' })} style={{ cursor: 'default' }}>
                      {m.text}
                    </button>
                    <span className="memo-actions">
                      <button className="btn btn-sm" onClick={() => void memoToNote(m.id)}>转成笔记</button>
                      <button className="btn btn-sm btn-danger" onClick={() => void removeMemo(m.id)}>删除</button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {questionNotes.length > 0 && (
            <section className="inbox-section">
              <div className="section-title">有疑问的知识块（{questionNotes.length} 篇笔记）</div>
              <div className="memo-list">
                {questionNotes.map((n) => (
                  <div key={n.id} className="todo-row">
                    <span className="todo-dot" aria-hidden="true" />
                    <button className="todo-label" onClick={() => nav.go({ kind: 'note', noteId: n.id })}>
                      《{n.title}》 · {n.questionCount} 块标了「有疑问」
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {reviewDocs.length > 0 && (
            <section className="inbox-section">
              <div className="section-title">书目待补全（{reviewDocs.length}）</div>
              <div className="memo-list">
                {reviewDocs.slice(0, 20).map((d) => (
                  <div key={d.id} className="todo-row">
                    <span className="todo-dot" aria-hidden="true" />
                    <button className="todo-label" onClick={() => nav.go({ kind: 'library', needsReview: true })}>
                      {d.title}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
