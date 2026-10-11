import { useEffect, useRef, useState, type ReactNode } from 'react'
import { assetUrl } from '@shared/api'
import { NOTE_TYPE_LABELS, type NoteSummary } from '@shared/types'
import { LoadError } from './LoadError'
import { useAsyncData } from '../lib/use-async-data'

// 弹窗外最近一次持有焦点的元素（打开者）。挂载快照会被弹窗内 autoFocus 污染，
// 因此用 focusin 持续追踪外部焦点，关闭时归还。
// 焦点事件不冒泡，无法挂在 React 树上，故监听 document。追踪器必须常驻：
// 打开弹窗的那次 focusin 发生在弹窗挂载之前，等挂载才注册会永远错过打开者，
// 关闭时焦点将无处归还。挂在 window 上，HMR 重载模块时复用同一监听器与状态，
// 不会叠加多个 handler。
interface FocusTrackerHost {
  __mathwbLastOutsideFocus?: HTMLElement | null
  __mathwbFocusTracker?: (e: Event) => void
}
const focusHost = window as typeof window & FocusTrackerHost
if (!focusHost.__mathwbFocusTracker) {
  focusHost.__mathwbFocusTracker = (e: Event) => {
    const t = e.target as HTMLElement
    if (!t.closest?.('.modal')) focusHost.__mathwbLastOutsideFocus = t
  }
  document.addEventListener('focusin', focusHost.__mathwbFocusTracker, true)
}

export function Modal({
  title,
  onClose,
  children,
  width = 520
}: {
  title: string
  onClose(): void
  children: ReactNode
  width?: number
}): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null)
  // 焦点归还：打开时聚焦弹窗，关闭时还给打开者（由常驻 focusin 追踪器记录）
  useEffect(() => {
    dialogRef.current?.focus()
    return () => focusHost.__mathwbLastOutsideFocus?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      // Tab 焦点陷阱：Tab 循环留在弹窗内（disabled 与不可见元素由浏览器原生跳过，这里同样排除）
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('disabled') && el.checkVisibility() && el.tabIndex >= 0)
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal-head">
          <span>{title}</span>
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** 从笔记列表中搜索选择一个笔记 */
export function NotePicker({
  onPick,
  onClose
}: {
  onPick(note: NoteSummary): void
  onClose(): void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  // 搜索防抖 200ms；失败可重试（P0-2）
  const list = useAsyncData(() => window.api.noteList(query.trim() || undefined), [query], { debounceMs: 200 })
  const notes = list.data ?? []

  return (
    <Modal title="选择笔记" onClose={onClose}>
      <input
        className="input"
        placeholder="搜索标题 / 别名 / 正文…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />
      <div className="picker-list">
        {list.error ? (
          <LoadError message={list.error} onRetry={list.retry} />
        ) : (
          <>
            {list.loading && <div className="muted">搜索中…</div>}
            {!list.loading && notes.length === 0 && <div className="muted">没有匹配的笔记</div>}
            {notes.map((n) => (
              <button key={n.id} className="picker-item" onClick={() => onPick(n)}>
                <span className={`tag tag-${n.noteType}`}>{NOTE_TYPE_LABELS[n.noteType]}</span>
                <span className="picker-item-title">{n.title}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </Modal>
  )
}

/** 查看原始照片（显示副本） */
export function ImagePreview({ src, onClose }: { src: string; onClose(): void }): React.ReactElement {
  return (
    <Modal title="原图预览" onClose={onClose} width={900}>
      <img className="image-preview" src={src} alt="原图预览" />
    </Modal>
  )
}

/** 选择一张演草纸照片（照片托管在 capture 索引；展示位=文献库「待整理」） */
export function CapturePicker({
  onPick,
  onClose
}: {
  onPick(captureId: string): void
  onClose(): void
}): React.ReactElement {
  const list = useAsyncData(() => window.api.captureList(), [])
  const items = (list.data ?? []).map((c) => ({ id: c.id, assetId: c.assetId, originalName: c.originalName }))
  const [failed, setFailed] = useState<Record<string, boolean>>({})

  return (
    <Modal title="选择演草纸照片" onClose={onClose} width={760}>
      {list.error ? (
        <LoadError message={list.error} onRetry={list.retry} />
      ) : (
        <>
          {list.loading && <div className="muted">加载中…</div>}
          {!list.loading && items.length === 0 && <div className="muted">还没有照片。到「文献 → 待整理」用「⋯ → 导入照片」收进来。</div>}
          <div className="capture-grid">
            {items.map((c) => (
              <button key={c.id} className="capture-thumb" onClick={() => onPick(c.id)}>
                <img
                  src={assetUrl(c.assetId, 'thumb')}
                  alt={c.originalName}
                  onError={() => setFailed((f) => ({ ...f, [c.id]: true }))}
                />
                {failed[c.id] ? (
                  <span className="capture-broken">预览生成失败</span>
                ) : (
                  <span className="capture-name">{c.originalName}</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

export { assetUrl }
