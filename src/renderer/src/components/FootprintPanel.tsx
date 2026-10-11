import { useEffect, useMemo, useRef, useState } from 'react'
import type { Nav } from '../App'
import { useStudySpace } from '../study-space'
import type { ActivityDayItem, ActivityPanelData } from '@shared/types'
import { localDateKey, shortDate } from '../lib/time-label'
import { buildMonthGrid, clampSelectable, firstDayKeyOfMonth, monthLabel, shiftMonthKey, type CalendarDay } from '../lib/learning-calendar'
import { LoadError } from './LoadError'

type ScopeSel = 'current' | 'all'

// ---- 会话内状态：从记录跳去别的视图再回来，月份/选中日/范围原样恢复（不落盘，重启回到今天） ----
const view = { month: '', selected: '', scope: 'current' as ScopeSel, init: false }
let openInNotes = false
export const footprintOpenState = {
  get: (): boolean => openInNotes,
  set: (v: boolean): void => { openInNotes = v }
}

// ---- 会话内缓存（stale-while-revalidate）：翻回看过的月份/日期即时呈现，后台再校新 ----
interface MonthSlice {
  monthDays: string[]
  rangeStart: string
  rangeEnd: string
  summary: ActivityPanelData['summary']
  startedAt: string
  healthy: boolean
}
const monthCache = new Map<string, MonthSlice>()
const dayCache = new Map<string, ActivityDayItem[]>()
let startedDayKnown = '' // 启用日（本地日期键），任意一次响应后已知；'' = 尚未知
const CACHE_MAX = 48
function cachePut<V>(m: Map<string, V>, k: string, v: V): void {
  m.set(k, v)
  if (m.size > CACHE_MAX) m.delete(m.keys().next().value!)
}

const KIND_META = {
  note: { cls: 'kind-note', label: '笔记' },
  anchors: { cls: 'kind-excerpt', label: '摘录' },
  read: { cls: 'kind-read', label: '阅读' },
  ink: { cls: 'kind-excerpt', label: '批注' },
  review: { cls: 'kind-question', label: '自评' }
} as const

function fmtDuration(seconds: number): string {
  const m = Math.round(seconds / 60)
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`
}

/** 一条记录的叙述：标题是主语，动作一句话；次数/页数/时长退到次级详情 */
function entryLines(item: ActivityDayItem): { action: string; metrics?: string } {
  switch (item.kind) {
    case 'note': {
      const from = item.fromDocumentTitle ? `来自《${item.fromDocumentTitle}》` : undefined
      return {
        action: item.created ? '新建了这篇笔记' : '修改了这篇笔记',
        metrics: [from, item.anchorCount > 0 ? `含 ${item.anchorCount} 条摘录` : undefined].filter(Boolean).join(' · ') || undefined
      }
    }
    case 'anchors':
      return { action: '在这份材料上添加了摘录', metrics: `${item.anchorCount} 条` }
    case 'read':
      return { action: '阅读了这份材料', metrics: `${item.reads ?? 1} 次 · ${item.pages ?? 0} 页 · 约 ${fmtDuration(item.seconds ?? 0)}` }
    case 'ink':
      return { action: '写下手写批注', metrics: `${item.strokes ?? 0} 笔` }
    case 'review':
      return { action: '知识块自评', metrics: `有疑问 ${item.questions ?? 0} 块 · 已理解 ${item.understands ?? 0} 块` }
  }
}

/**
 * 学习足迹 → 个人学习日历（DESIGN.md v8）：月历主视图，周一起始、前后翻月、回到今天；
 * 有记录日期用统一小标记（不做深浅/连续天数）；当日记录以对象归并、可打开；
 * 统计撤下大号摘要与热力图，收进「月度小结」次级详情（历史月份口径走 anchor）。
 */
export function FootprintPanel({ nav }: { nav: Nav }): React.ReactElement {
  const { scope, spaces } = useStudySpace()
  const today = useMemo(() => localDateKey(new Date()), [])
  const currentMonth = today.slice(0, 7)
  if (!view.init) {
    view.month = currentMonth
    view.selected = today
    view.init = true
  }
  const [month, setMonth] = useState(view.month)
  const [selected, setSelected] = useState(view.selected)
  const [scopeSel, setScopeSel] = useState<ScopeSel>(view.scope)
  useEffect(() => {
    view.month = month
    view.selected = selected
    view.scope = scopeSel
  }, [month, selected, scopeSel])

  const spaceId = scopeSel === 'all' ? undefined : scope
  const scopeKey = scopeSel === 'all' ? 'all' : `cur:${scope ?? ''}`
  const slice = monthCache.get(`${month}|${scopeKey}`)
  const dayItems = dayCache.get(`${selected}|${scopeKey}`) ?? []

  const [startedDay, setStartedDay] = useState(startedDayKnown)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setLoading(true)
    // anchor = 展示月 1 日（不越今天）：月度小结与对象统计跟随展示月口径（DESIGN.md v8 / 方案 A）
    const anchor = firstDayKeyOfMonth(month) > today ? today : firstDayKeyOfMonth(month)
    window.api.activityPanel({ range: 'month', month, date: selected, anchor, spaceId })
      .then((d) => {
        if (seqRef.current !== seq) return
        cachePut(monthCache, `${month}|${scopeKey}`, {
          monthDays: d.monthDays, rangeStart: d.rangeStart, rangeEnd: d.rangeEnd,
          summary: d.summary, startedAt: d.startedAt, healthy: d.healthy
        })
        cachePut(dayCache, `${selected}|${scopeKey}`, d.items)
        startedDayKnown = localDateKey(new Date(d.startedAt))
        setStartedDay(startedDayKnown)
        setError('')
        setLoading(false)
      })
      .catch((err) => {
        if (seqRef.current !== seq) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [month, selected, scopeKey, spaceId, today, tick])

  const grid = useMemo(
    () => buildMonthGrid(month, { today, startedDay: startedDayKnown, recordDays: slice?.monthDays ?? [] }),
    [month, today, startedDay, slice]
  )

  const goPrev = (): void => {
    const m = shiftMonthKey(month, -1)
    setMonth(m)
    setSelected(clampSelectable(firstDayKeyOfMonth(m), today, startedDay))
  }
  const goNext = (): void => {
    if (month >= currentMonth) return
    const m = shiftMonthKey(month, 1)
    setMonth(m)
    setSelected(clampSelectable(firstDayKeyOfMonth(m), today, startedDay))
  }
  const goToday = (): void => {
    setMonth(currentMonth)
    setSelected(today)
  }

  // 月历键盘导航：方向键在可用日期间移动（roving tabindex），Tab 只进网格一次
  const onGridKeyDown = (e: React.KeyboardEvent): void => {
    const cells = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button.cal-day:not(:disabled)'))
    const i = cells.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    let j = -1
    if (e.key === 'ArrowRight') j = i + 1
    else if (e.key === 'ArrowLeft') j = i - 1
    else if (e.key === 'ArrowDown') j = i + 7
    else if (e.key === 'ArrowUp') j = i - 7
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = cells.length - 1
    else return
    e.preventDefault()
    cells[j]?.focus()
  }

  const openItem = (item: ActivityDayItem): void => {
    if (item.deleted) return
    if ((item.kind === 'note' || item.kind === 'review') && item.noteId) nav.go({ kind: 'note', noteId: item.noteId })
    else if (item.documentId) {
      nav.go(item.mediaType === 'text/html' ? { kind: 'html', documentId: item.documentId } : { kind: 'reader', documentId: item.documentId })
    }
  }

  const dayCell = (c: CalendarDay): React.ReactElement => {
    const disabled = c.future || c.beforeStart
    const cls = [
      'cal-day',
      c.inMonth ? '' : 'is-other',
      c.isToday ? 'is-today' : '',
      !disabled && c.date === selected ? 'is-selected' : '',
      !disabled && c.hasRecord ? 'has-rec' : ''
    ].filter(Boolean).join(' ')
    const state = c.future ? '，未到来' : c.beforeStart ? '，足迹启用日之前' : c.hasRecord ? '，有记录' : ''
    return (
      <button
        key={c.date}
        type="button"
        className={cls}
        disabled={disabled}
        tabIndex={c.date === selected ? 0 : -1}
        aria-pressed={!disabled && c.date === selected}
        aria-label={`${c.date}${c.isToday ? '，今天' : ''}${state}`}
        title={c.beforeStart && startedDay ? `足迹自 ${shortDate(`${startedDay}T12:00:00`)} 起记录` : undefined}
        onClick={() => {
          if (disabled) return
          setSelected(c.date)
          if (!c.inMonth) setMonth(c.date.slice(0, 7))
        }}
      >
        <span className="cal-day-num">{c.day}</span>
        {!disabled && c.hasRecord && <span className="cal-mark" aria-hidden="true" />}
      </button>
    )
  }

  const spaceName = scopeSel === 'current' ? spaces.find((s) => s.id === scope)?.name : undefined
  const dayHead = shortDate(`${selected}T12:00:00`)
  const beforeStart = startedDay !== '' && selected < startedDay

  return (
    <div className="footprint" role="region" aria-label="学习足迹">
      <div className="footprint-bar">
        <div className="footprint-filters" role="group" aria-label="学习区范围">
          <button type="button" className={`chip ${scopeSel === 'current' ? 'chip-active' : ''}`} aria-pressed={scopeSel === 'current'} onClick={() => setScopeSel('current')}>
            当前学习区
          </button>
          <button type="button" className={`chip ${scopeSel === 'all' ? 'chip-active' : ''}`} aria-pressed={scopeSel === 'all'} onClick={() => setScopeSel('all')}>
            全部学习区
          </button>
          {scopeSel === 'current' && spaceName && <span className="muted small">{spaceName}</span>}
        </div>
        <span className="muted small">{monthLabel(month)}{slice ? ` · ${slice.monthDays.length} 天有记录` : ''}</span>
      </div>

      {slice && !slice.healthy && (
        <div className="muted small footprint-warn">活动记录暂时不可用（最近写入失败，正文保存不受影响）</div>
      )}

      {error ? (
        <LoadError message={error} onRetry={() => setTick((t) => t + 1)} />
      ) : (
        <div className="footprint-layout">
          <div className="footprint-cal">
            <div className="cal-head">
              <span className="cal-month" aria-live="polite">{monthLabel(month)}</span>
              <div className="cal-nav">
                <button type="button" className="cal-nav-btn" onClick={goPrev} aria-label="上一个月">上月</button>
                <button type="button" className="cal-nav-btn" onClick={goToday} disabled={month === currentMonth && selected === today}>回到今天</button>
                <button type="button" className="cal-nav-btn" onClick={goNext} disabled={month >= currentMonth} aria-label="下一个月">下月</button>
              </div>
            </div>
            <div className="cal-week" aria-hidden="true">
              {['一', '二', '三', '四', '五', '六', '日'].map((d) => <span key={d}>{d}</span>)}
            </div>
            <div className="cal-grid" role="grid" aria-label={`学习月历，${monthLabel(month)}；方向键移动，Enter 选定日期`} onKeyDown={onGridKeyDown}>
              {grid.map(dayCell)}
            </div>
            <div className="cal-legend">
              <span className="cal-legend-item"><i className="cal-mark" aria-hidden="true" />有记录</span>
              <span className="cal-legend-item"><span className="cal-legend-today">今天</span></span>
            </div>
          </div>

          <div className="footprint-journal">
            <div className="footprint-day-head">
              <span className="footprint-day-eyebrow">当日学习记录</span>
              <span className="footprint-day-title">{dayHead}</span>
              {selected === today && <span className="footprint-today-badge">今天</span>}
            </div>
            {loading && dayItems.length === 0 ? (
              <div className="footprint-skel" role="status" aria-label="加载中"><i /><i /><i /></div>
            ) : beforeStart ? (
              <div className="footprint-empty">
                足迹从 {startedDay ? shortDate(`${startedDay}T12:00:00`) : ''} 起记录，这一天在此之前，没有可回看的内容。
              </div>
            ) : dayItems.length === 0 ? (
              <div className="footprint-empty">{loading ? '正在载入这一天的记录…' : '这一天在当前范围没有学习记录。'}</div>
            ) : (
              <ul className={`footprint-list${loading ? ' is-refreshing' : ''}`} key={`${selected}|${scopeKey}`}>
                {dayItems.map((item) => {
                  const meta = KIND_META[item.kind]
                  const lines = entryLines(item)
                  return (
                    <li key={item.key}>
                      {item.deleted ? (
                        <div className="footprint-entry-deleted">
                          <div className="footprint-entry-top">
                            <span className={`footprint-kind ${meta.cls}`}>{meta.label}</span>
                            <span className="tag">已删除 · 不可打开</span>
                          </div>
                          <div className="footprint-entry-title">{item.title}</div>
                          <div className="footprint-entry-action">{lines.action}</div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="footprint-entry"
                          aria-label={`${meta.label}：${item.title}`}
                          title={item.fromDocumentTitle ? `来自《${item.fromDocumentTitle}》的摘录` : undefined}
                          onClick={() => openItem(item)}
                        >
                          <div className="footprint-entry-top">
                            <span className={`footprint-kind ${meta.cls}`}>{meta.label}</span>
                          </div>
                          <div className="footprint-entry-title">{item.title}</div>
                          <div className="footprint-entry-action">{lines.action}</div>
                          {lines.metrics && <div className="footprint-entry-metrics">{lines.metrics}</div>}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            <details className="footprint-monthfoot">
              <summary>月度小结（{monthLabel(month)}）</summary>
              {slice && (
                <>
                  <div className="footprint-monthstats">
                    <span><b>{slice.summary.activeDays}</b> 天有记录</span>
                    <span><b>{slice.summary.created}</b> 篇新建</span>
                    <span><b>{slice.summary.updated}</b> 篇修改</span>
                    <span>阅读约 <b>{slice.summary.readMinutes}</b> 分钟 · {slice.summary.readPages} 页</span>
                    <span><b>{slice.summary.reviews}</b> 次自评</span>
                  </div>
                  <p className="muted small">口径：{shortDate(`${slice.rangeStart}T12:00:00`)} – {shortDate(`${slice.rangeEnd}T12:00:00`)}。只陈述做过什么，不生成「已掌握 / 效率」类结论。</p>
                </>
              )}
            </details>
          </div>
        </div>
      )}

      <p className="muted small footprint-note">
        统计应用内笔记新建与修改、摘录添加、阅读会话（≥10 秒或翻过页才计）、手写批注与知识块自评；
        {startedDay ? `自 ${shortDate(`${startedDay}T12:00:00`)} 起记录。` : ''}打开、浏览、导入、改名与整理操作不计入。
        点「打开」看到的是对象当前内容，不是当日版本；已删除对象保留记录、不可打开。不做连续天数统计。
      </p>
    </div>
  )
}
