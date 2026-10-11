import { Command } from 'cmdk'
import type { ReactNode } from 'react'

export interface PaletteItem {
  key: string
  label: string
  icon?: ReactNode
  shortcut?: string
  /** 次要说明（分区 / 年份 / 页码 / 摘录出处等；内容搜索结果用） */
  hint?: string
  /**
   * 额外参与 cmdk 过滤的关键词（内容搜索结果用：命中词/命中片段）。
   * cmdk 会用自身模糊匹配过滤 item，未通过则**整组隐藏**——内容结果必须把命中词放进来。
   */
  keywords?: string[]
  onSelect: () => void
}

export interface PaletteGroup {
  heading: string
  items: PaletteItem[]
}

/** ⌘K/Ctrl+K 命令面板：键盘优先的全局入口（导航 / 学习区 / 常用操作 / 全库内容搜索） */
export function CommandPalette(props: {
  open: boolean
  onClose: () => void
  groups: PaletteGroup[]
  /** 输入变化回调（App 据此跑内容搜索，把结果作为额外分组传回） */
  onQueryChange?: (query: string) => void
}): React.ReactElement | null {
  if (!props.open) return null
  return (
    <div className="cmdk-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
      <Command className="cmdk" loop onKeyDown={(e) => { if (e.key === 'Escape') props.onClose() }}>
        <Command.Input
          autoFocus
          placeholder="搜索命令，或输入关键词搜文献 / 笔记 / 摘录…"
          onValueChange={(v) => props.onQueryChange?.(v)}
        />
        <Command.List>
          <Command.Empty>没有匹配的命令或内容</Command.Empty>
          {props.groups.map((group) => (
            <Command.Group key={group.heading} heading={group.heading}>
              {group.items.map((item) => (
                <Command.Item
                  key={item.key}
                  value={`${item.label} ${item.key} ${item.hint ?? ''}`}
                  keywords={item.keywords}
                  onSelect={() => { props.onClose(); item.onSelect() }}
                >
                  {item.icon}
                  <span className="cmdk-item-label">{item.label}</span>
                  {item.hint && <span className="cmdk-item-hint muted small">{item.hint}</span>}
                  {item.shortcut && <span className="kbd" style={{ marginLeft: 'auto' }}>{item.shortcut}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  )
}
