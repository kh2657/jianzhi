import { useMemo, useState } from 'react'
import type { Nav } from '../App'
import { Icon } from '../components/Icon'
import { LoadError } from '../components/LoadError'
import { useAsyncData } from '../lib/use-async-data'
import { type NoteSummary } from '@shared/types'
import { updateLabel, fullStamp } from '../lib/time-label'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 链接方向的界面用词：研究问题视图只关心「谁引向谁」，不暴露 in/out 字段名 */
const LINK_LABELS: Record<'in' | 'out' | 'both', string> = {
  in: '链入本问题',
  out: '本问题链出',
  both: '双向链接'
}

/**
 * 研究问题聚合：研究者按「问题」工作，不按文件。
 * 左侧是候选枢纽（problem 类型排最前），右侧三段全部由主进程从已有链接实时聚合——
 * 不新增任何存储，删掉一条 [[链接]] 或摘录来源，聚合立刻跟着变。
 */
export function QuestionView({ nav, noteId }: { nav: Nav; noteId?: string }): React.ReactElement {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(noteId ?? null)

  // 候选枢纽：全部笔记（problem 排最前），过滤框按标题筛
  const list = useAsyncData(() => window.api.noteList(), [])
  const candidates = useMemo(() => {
    const all = list.data ?? []
    const q = filter.trim()
    const filtered = q ? all.filter((n) => n.title.includes(q)) : all
    return [...filtered].sort((a, b) => {
      const pa = a.noteType === 'problem' ? 0 : 1
      const pb = b.noteType === 'problem' ? 0 : 1
      if (pa !== pb) return pa - pb
      return b.updatedAt.localeCompare(a.updatedAt)
    })
  }, [list.data, filter])

  const hubId = selected ?? candidates.find((n) => n.noteType === 'problem')?.id ?? candidates[0]?.id ?? null
  const agg = useAsyncData(
    () => (hubId ? window.api.questionAggregate(hubId) : Promise.resolve(null)),
    [hubId]
  )

  if (list.error) return <div className="view view-scroll"><LoadError message={errMsg(list.error)} onRetry={list.retry} /></div>

  // 空库：说明这个视图靠什么工作（problem 类型笔记是枢纽），不放教程
  if (!list.loading && candidates.length === 0 && !filter.trim()) {
    return (
      <div className="view view-scroll">
        <div className="view-head"><h1>研究问题</h1></div>
        <div className="empty-state">
          <div className="empty-title">先写一篇 problem 类型笔记作为问题枢纽</div>
          <div>问题视图把与它相连的笔记、文献和知识块状态聚到一屏——链接与摘录就是这里的全部数据。</div>
        </div>
      </div>
    )
  }

  // 局部别名：TS 无法把 `agg.data` 的非空收窄带进 onClick 闭包（属性每次读取都可能变）
  const data = agg.data

  return (
    <div className="view question-view">
      <aside className="question-hubs" aria-label="问题枢纽">
        <div className="question-hubs-head">
          <label className="search-field"><Icon name="search" size={16} /><input
            className="input search-input"
            aria-label="过滤问题枢纽"
            placeholder="过滤问题…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          /></label>
        </div>
        <div className="question-hub-list">
          {candidates.length === 0 && <div className="muted small question-hub-empty">没有匹配的问题。</div>}
          {candidates.map((n: NoteSummary) => (
            <button
              key={n.id}
              className={`question-hub ${n.id === hubId ? 'question-hub-active' : ''}`}
              aria-pressed={n.id === hubId}
              onClick={() => setSelected(n.id)}
              title={n.title}
            >
              <Icon name="note" size={15} />
              <span className="question-hub-title">{n.title}</span>
              {n.noteType === 'problem' && <span className="tag tag-problem">问题</span>}
            </button>
          ))}
        </div>
      </aside>

      <div className="view view-scroll question-detail">
        {agg.error ? (
          <LoadError message={errMsg(agg.error)} onRetry={agg.retry} />
        ) : !data ? (
          <div className="muted">加载中…</div>
        ) : (
          <>
            <div className="view-head">
              <h1>{data.hub.title}</h1>
              <div className="view-actions">
                <button className="btn btn-sm" onClick={() => nav.go({ kind: 'note', noteId: data.hub.id })}>
                  打开枢纽笔记
                </button>
              </div>
            </div>

            <section className="question-section">
              <div className="section-title">相关笔记（{data.notes.length}）</div>
              {data.notes.length === 0 ? (
                <p className="muted small">还没有其他笔记与这个问题相连。在别处正文里输入 [[{data.hub.title}]] 即可建立联系。</p>
              ) : (
                <div className="note-list">
                  {data.notes.map((n) => (
                    <button key={n.id} className="note-item" onClick={() => nav.go({ kind: 'note', noteId: n.id })}>
                      <Icon name="note" size={17} />
                      <span className="note-title">{n.title}</span>
                      {n.questionCount > 0 && <span className="tag tag-amber">{n.questionCount} 块有疑问</span>}
                      {n.understoodCount > 0 && <span className="tag tag-concept">{n.understoodCount} 块已理解</span>}
                      <span className="tag">{LINK_LABELS[n.link]}</span>
                      <span className="muted small note-time" title={`最近更新：${fullStamp(n.updatedAt)}`}>{updateLabel(n.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="question-section">
              <div className="section-title">相关文献（{data.documents.length}）</div>
              {data.documents.length === 0 ? (
                <p className="muted small">枢纽与相关笔记还没有挂上文献来源（摘录或「关联整份材料」）。</p>
              ) : (
                <div className="note-list">
                  {data.documents.map((d) => (
                    <button
                      key={d.id}
                      className="note-item"
                      onClick={() => nav.go({ kind: d.mediaType === 'text/html' ? 'html' : 'reader', documentId: d.id })}
                    >
                      <Icon name="library" size={17} />
                      <span className="note-title">{d.title}</span>
                      <span className="tag">{d.mediaType === 'text/html' ? 'HTML' : 'PDF'}</span>
                      {d.anchorCount > 0 && <span className="muted small">{d.anchorCount} 条摘录</span>}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="question-section">
              <div className="section-title">知识块状态</div>
              {data.blocks.total === 0 ? (
                <p className="muted small">还没有自评标记。在笔记的「学习」页给知识块标「已理解 / 有疑问」，这里会汇总。</p>
              ) : (
                <div className="question-blocks">
                  <div className="question-block-stat">
                    <span className="question-block-num">{data.blocks.total}</span>
                    <span className="muted small">知识块</span>
                  </div>
                  <div className="question-block-stat">
                    <span className="question-block-num">{data.blocks.understood}</span>
                    <span className="muted small">已理解</span>
                  </div>
                  <div className="question-block-stat">
                    <span className="question-block-num">{data.blocks.question}</span>
                    <span className="muted small">有疑问</span>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
