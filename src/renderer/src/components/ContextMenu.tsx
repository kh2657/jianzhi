import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SectionColor } from '@shared/types'

/**
 * 轻量上下文菜单（右键 / 键盘唤出）。
 *
 * 与 Modal 的分工：Modal 是遮挡式对话（焦点陷阱、Tab 循环）；这里是就地弹出的一小组命令，
 * 故不做焦点陷阱，只保证：打开即有可聚焦项、Esc 关闭、方向键在项间移动、关闭后焦点归还原处。
 * 定位用 position: fixed 并夹取到视口内，不受滚动容器裁剪。
 */

export interface ContextMenuItem {
  kind: 'item'
  key: string
  label: string
  onSelect(): void
  icon?: ReactNode
  /** 无障碍名称（可见文本是通用动词时补足宾语，如「重命名分区 随机分析」） */
  ariaLabel?: string
  /** 行首色点（分区颜色标签） */
  swatch?: SectionColor | null
  /** 危险操作（删除）——红字 */
  danger?: boolean
  /** 当前生效项（打勾） */
  checked?: boolean
  disabled?: boolean
}

/** 分隔线；可带小标题（如「颜色标签」） */
export interface ContextMenuSeparator {
  kind: 'separator'
  key: string
  label?: string
}

/** 自定义行（颜色样本条等）；不参与键盘方向键导航 */
export interface ContextMenuCustom {
  kind: 'custom'
  key: string
  node: ReactNode
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator | ContextMenuCustom

const FOCUSABLE = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
  ariaLabel
}: {
  x: number
  y: number
  entries: ContextMenuEntry[]
  onClose(): void
  ariaLabel: string
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const restoreRef = useRef<HTMLElement | null>(null)

  // 打开前聚焦的元素：关闭后归还（右键唤出时通常是分区行）
  if (restoreRef.current === null) {
    const active = document.activeElement
    restoreRef.current = active instanceof HTMLElement && active !== document.body ? active : null
  }

  // 量出实际尺寸后夹取到视口内（贴右下角唤出时向左上翻）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const nx = Math.max(margin, Math.min(x, window.innerWidth - r.width - margin))
    const ny = Math.max(margin, Math.min(y, window.innerHeight - r.height - margin))
    if (nx !== x || ny !== y) setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => restoreRef.current?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      const el = ref.current
      if (!el) return
      const focusables = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (!focusables.length) return
      const current = focusables.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        focusables[(current + step + focusables.length) % focusables.length].focus()
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        focusables[e.key === 'Home' ? 0 : focusables.length - 1].focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const onPointerDown = useCallback((e: MouseEvent) => {
    if (!ref.current?.contains(e.target as Node)) onClose()
  }, [onClose])

  // 关闭时机：点击别处、滚动、窗口尺寸变化、窗口失焦——菜单不该在页面已动的情况下仍挂着
  useEffect(() => {
    document.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose, onPointerDown])

  return (
    <div
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry) => {
        if (entry.kind === 'separator') {
          return (
            <div className={`context-menu-sep ${entry.label ? 'context-menu-sep-labeled' : ''}`} key={entry.key} role="separator">
              {entry.label && <span className="context-menu-sep-label">{entry.label}</span>}
            </div>
          )
        }
        if (entry.kind === 'custom') return <div className="context-menu-custom" key={entry.key}>{entry.node}</div>
        return (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            className={`context-menu-item ${entry.danger ? 'context-menu-danger' : ''}`}
            disabled={entry.disabled}
            aria-label={entry.ariaLabel}
            aria-checked={entry.checked}
            onClick={() => { onClose(); entry.onSelect() }}
          >
            <span className="context-menu-icon" aria-hidden="true">
              {entry.swatch !== undefined ? <span className={`color-dot color-dot-${entry.swatch ?? 'none'}`} /> : entry.icon}
            </span>
            <span className="context-menu-label">{entry.label}</span>
            {entry.checked && <span className="context-menu-check" aria-hidden="true">✓</span>}
          </button>
        )
      })}
    </div>
  )
}
