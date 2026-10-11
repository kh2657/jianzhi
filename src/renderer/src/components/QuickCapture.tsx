import { useEffect, useRef, useState } from 'react'
import type { MemoRecord, SpaceScope } from '@shared/types'

/** 与主进程 QUICK_CAPTURE_ACCELERATOR 同源；两种平台写法都标出来，省得猜当前系统 */
const HOTKEY_HINT = '⌥⌘N / Ctrl+Alt+N'

/** 速记落点：默认直接成草稿笔记；`!` 开头 → 待办（未整理速记在「待办」视图分诊） */
export type QuickCaptureLanding =
  | { kind: 'note'; id: string }
  | { kind: 'memo'; memo: MemoRecord }

/**
 * 速记浮层：零仪式捕获——输入、Enter 存、Esc 丢，不问标题/分区。
 * 默认落为草稿笔记（标题取首行，正文原样，随写随改）；以 `!` 开头则记为待办，进「待办」分诊。
 */
export function QuickCapture({
  open,
  mode = 'note',
  spaceId,
  onClose,
  onSaved
}: {
  open: boolean
  mode?: 'note' | 'idea'
  spaceId: SpaceScope
  onClose(): void
  onSaved(landed: QuickCaptureLanding): void
}): React.ReactElement | null {
  const [text, setText] = useState(() => mode === 'idea' ? localStorage.getItem('mathwb-idea-draft') ?? '' : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const submitting = useRef(false)
  const trigger = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (mode === 'idea') localStorage.setItem('mathwb-idea-draft', text)
  }, [text, mode])

  useEffect(() => {
    if (!open) return
    if (mode === 'note') setText('')
    trigger.current = document.activeElement as HTMLElement | null
    setError('')
    // 浮层常伴随「窗口刚被全局快捷键唤起」出现：让出一帧再聚焦，否则焦点会被窗口激活动作抢走
    const timer = window.setTimeout(() => areaRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // Esc 在浮层内任意位置都能关（点击可能已把焦点挪出输入框）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting.current) {
        e.preventDefault()
        onClose()
        if (mode === 'idea') trigger.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, mode])

  if (!open) return null

  const submit = async (): Promise<void> => {
    const value = text.trim()
    if (!value || submitting.current) return
    submitting.current = true
    setSaving(true)
    setError('')
    try {
      if (mode === 'idea' || value.startsWith('!') || value.startsWith('！')) {
        // 待办：沿用速记存储（待办视图直接读取）；存储层从 `!` 前缀推导 todo 并剥掉标记
        const memo = await window.api.memoCreate({ text: value, spaceId })
        onSaved({ kind: 'memo', memo })
      } else {
        const title = value.replace(/\s+/g, ' ').slice(0, 60)
        const note = await window.api.noteCreate({ title, noteType: 'note', bodyMd: value, spaceId })
        onSaved({ kind: 'note', id: note.id })
      }
      setText('')
      onClose()
      if (mode === 'idea') trigger.current?.focus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <div className={mode === 'idea' ? 'idea-capture-slot' : 'quick-capture-backdrop'} role="presentation" onMouseDown={mode === 'note' ? () => { if (!submitting.current) onClose() } : undefined}>
      <div id={mode === 'idea' ? 'idea-capture' : undefined} className={`quick-capture ${mode === 'idea' ? 'idea-capture' : ''}`} role={mode === 'idea' ? 'region' : 'dialog'} aria-modal={mode === 'note' ? true : undefined} aria-label={mode === 'idea' ? '想法随记' : '速记'} onMouseDown={(e) => e.stopPropagation()}>
        {mode === 'idea' && <div className="idea-capture-head"><strong>想法随记</strong><button className="btn btn-ghost btn-sm" aria-label="关闭想法" disabled={saving} onClick={() => { onClose(); trigger.current?.focus() }}>关闭</button></div>}
        <textarea
          ref={areaRef}
          className="quick-capture-input"
          rows={3}
          value={text}
          aria-label={mode === 'idea' ? '想法内容' : '速记内容'}
          disabled={saving}
          placeholder={mode === 'idea' ? '先记下来，不用起标题或分类…' : '想到什么就写下来，Enter 直接存为草稿笔记…（以 ! 开头记为待办）'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!e.nativeEvent.isComposing && e.key === 'Enter' && (mode === 'idea' ? e.metaKey || e.ctrlKey : !e.shiftKey)) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {error && (
          <div className="status-error small" role="alert">
            没存下：{error}
          </div>
        )}
        <div className="quick-capture-foot">
          <span className="muted small">{mode === 'idea' ? '⌘ / Ctrl + Enter 记录 · Esc 收起，草稿保留' : `Enter 保存 · Shift+Enter 换行 · Esc 取消 · ${HOTKEY_HINT} 随时唤起`}</span>
          <button className="btn btn-primary btn-sm" disabled={saving || text.trim() === ''} onClick={() => void submit()}>
            {saving ? '保存中…' : '记下来'}
          </button>
        </div>
      </div>
    </div>
  )
}
