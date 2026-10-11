/**
 * 列表/搜索类异步数据加载的统一状态机（框架无关，便于单元测试）。
 *
 * 修复的历史缺陷（2026-10-04 改造计划 P0-2）：NotesView / NotePicker / InboxView 的加载
 * effect 都没有 catch/finally，IPC 一次拒绝就会永久停留在「加载中/搜索中」。
 * 视图层请用 `useAsyncData`（lib/use-async-data.ts）接入；本文件只承载可测的状态逻辑：
 *   - 最新请求获胜：连发请求时只有最后一次的结果会落地，过期响应直接丢弃；
 *   - 失败可恢复：error 态保留可读信息，reload 立即重发；
 *   - dispose 后不再落地任何结果（防卸载后 setState）。
 * 状态变化通过 options.onChange 通知（React 侧用它驱动 setState）。
 */

export interface LoaderState<T> {
  phase: 'idle' | 'debouncing' | 'loading' | 'success' | 'error'
  /** 最近一次成功的数据；出错时为 null（不展示可能误导的旧数据） */
  data: T | null
  error: string | null
}

export interface DebouncedLoaderOptions<T> {
  /** 请求防抖毫秒数；0 表示立即执行 */
  debounceMs?: number
  /** 错误信息提取；默认取 Error.message / String(err) */
  describeError?: (err: unknown) => string
  /** 每次状态变化回调（同步触发） */
  onChange?: (state: LoaderState<T>) => void
}

export interface DebouncedLoader<T> {
  get(): LoaderState<T>
  /** 防抖调度一次加载（连续调用只保留最后一次） */
  request(): void
  /** 立即加载（绕过防抖）；本轮落定后 resolve，失败不 reject（错误在状态里） */
  reload(): Promise<void>
  dispose(): void
}

const defaultDescribeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createDebouncedLoader<T>(load: () => Promise<T>, options: DebouncedLoaderOptions<T> = {}): DebouncedLoader<T> {
  const debounceMs = options.debounceMs ?? 0
  const describeError = options.describeError ?? defaultDescribeError
  const onChange = options.onChange

  let state: LoaderState<T> = { phase: 'idle', data: null, error: null }
  let token = 0 // 最新请求获胜的令牌：完成时 token 不等于 current 的都是过期响应
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiters: Array<() => void> = [] // 等待「当前这轮加载落定」的调用方
  let disposed = false

  const setState = (next: LoaderState<T>) => {
    state = next
    onChange?.(next)
  }

  const settleWaiters = () => {
    const waiting = waiters
    waiters = []
    for (const fn of waiting) fn()
  }

  const run = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    token++
    const current = token
    setState({ phase: 'loading', data: null, error: null })
    try {
      // load() 同步抛出（如参数校验、桥接层错误）不会进入 promise 链，
      // 必须就地接住，否则 phase 永久停留在 loading
      return Promise.resolve(load())
        .then((data) => {
          if (!disposed && current === token) setState({ phase: 'success', data, error: null })
        })
        .catch((err) => {
          if (!disposed && current === token) setState({ phase: 'error', data: null, error: describeError(err) })
        })
        .finally(() => {
          if (current === token) settleWaiters()
        })
    } catch (err) {
      // 与 .finally 分支同一守卫：只有仍是「本轮请求」才结算等待者，
      // 否则会被更新一轮 reload() 抢占时提前 resolve 新 waiter
      if (!disposed && current === token) setState({ phase: 'error', data: null, error: describeError(err) })
      if (current === token) settleWaiters()
      return Promise.resolve()
    }
  }

  return {
    get: () => state,

    request() {
      if (disposed) return
      if (debounceMs <= 0) {
        void run()
        return
      }
      if (timer) clearTimeout(timer)
      setState({ phase: 'debouncing', data: state.data, error: null })
      timer = setTimeout(() => {
        timer = null
        void run()
      }, debounceMs)
    },

    reload() {
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
        void run()
      })
    },

    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      token++
      settleWaiters()
    }
  }
}
