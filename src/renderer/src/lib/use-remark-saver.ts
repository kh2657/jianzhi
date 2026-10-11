import { useEffect, useRef, useState } from 'react'
import { createRemarkSaver, type RemarkSaver, type RemarkState } from './remark-saver'

/**
 * 照片备注保存状态机的 React 接入。
 * - save 经 ref 取最新闭包；
 * - 状态变化驱动重渲染，states 为当前快照（Map）；
 * - 卸载时 dispose（冲刷由 App 的 flusher 管线在卸载前完成，见 InboxView）。
 */
export function useRemarkSaver(
  save: (id: string, value: string) => Promise<void>,
  debounceMs = 600
): { saver: RemarkSaver; states: ReadonlyMap<string, RemarkState> } {
  const saveRef = useRef(save)
  saveRef.current = save

  const [, setVersion] = useState(0)
  const saverRef = useRef<RemarkSaver | null>(null)
  if (saverRef.current === null) {
    saverRef.current = createRemarkSaver({
      save: (id, value) => saveRef.current(id, value),
      debounceMs,
      onChange: () => setVersion((v) => v + 1)
    })
  }
  const saver = saverRef.current

  useEffect(() => () => saver.dispose(), [saver])

  return { saver, states: saver.snapshot() }
}
