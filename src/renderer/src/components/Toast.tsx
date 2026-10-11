import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

export type ToastKind = 'info' | 'success' | 'error'

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

interface ToastApi {
  push(message: string, kind?: ToastKind): void
}

const ToastCtx = createContext<ToastApi>({ push: () => undefined })

export function useToast(): ToastApi {
  return useContext(ToastCtx)
}

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId.current++
    setItems((prev) => [...prev, { id, message, kind }])
    // 错误驻留更久（读得完），且可手动关闭
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 10000 : 3500)
  }, [])

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  // context value 必须稳定：push 已 useCallback，但直接写 value={{ push }} 会让每次 items 变化
  // （每条 toast 弹出与自动消失）都产生新对象，凡把 toast 放进 effect 依赖的消费者全部重跑——
  // 论文列表的「加载失败」提示曾因此触发重新拉取，形成循环。
  const value = useMemo(() => ({ push }), [push])

  const hasError = items.some((t) => t.kind === 'error')

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {/* 错误需要打断式播报（assertive），普通提示是礼貌级别 */}
      <div className="toast-stack" role={hasError ? 'alert' : 'status'} aria-live={hasError ? 'assertive' : 'polite'}>
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" aria-label="关闭提示" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
