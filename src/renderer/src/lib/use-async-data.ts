import { useEffect, useRef, useState, type DependencyList } from 'react'
import { createDebouncedLoader, type DebouncedLoader } from './async-loader'

export interface AsyncData<T> {
  data: T | null
  /** 首次加载 / 防抖等待 / 重新加载中 */
  loading: boolean
  error: string | null
  /** 出错后立即重发 */
  retry(): void
  /** 绕过防抖立即刷新（导入、关联等操作后同步列表用）；完成或失败后 resolve */
  reload(): Promise<void>
}

/**
 * 列表/搜索数据的 React 接入：loading / error / retry 统一收敛，杜绝「一次 IPC 拒绝就永久
 * 停留在加载中」的缺陷（P0-2）。load 每次渲染经 ref 更新，执行时取最新闭包，query/scope 不会
 * 过期；deps 变化触发防抖请求，卸载时 dispose（不再落地任何响应）。
 */
export function useAsyncData<T>(
  load: () => Promise<T>,
  deps: DependencyList,
  options: { debounceMs?: number } = {}
): AsyncData<T> {
  const loadRef = useRef(load)
  loadRef.current = load

  const [, setVersion] = useState(0)
  const loaderRef = useRef<DebouncedLoader<T> | null>(null)
  if (loaderRef.current === null) {
    loaderRef.current = createDebouncedLoader<T>(() => loadRef.current(), {
      debounceMs: options.debounceMs ?? 0,
      onChange: () => setVersion((v) => v + 1)
    })
  }
  const loader = loaderRef.current

  useEffect(() => {
    loader.request()
    // deps 由调用方声明（query/scope 等）；load 本体经 ref 取最新，无需列入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => () => loader.dispose(), [loader])

  const state = loader.get()
  return {
    data: state.data,
    loading: state.phase === 'idle' || state.phase === 'debouncing' || state.phase === 'loading',
    error: state.error,
    retry: () => void loader.reload(),
    reload: () => loader.reload()
  }
}
