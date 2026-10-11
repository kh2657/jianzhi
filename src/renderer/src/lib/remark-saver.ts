/**
 * 收件箱照片「一句话备注」的保存状态机（框架无关，便于单元测试）。
 *
 * 修复的历史缺陷（2026-10-04 改造计划 P0-3）：备注输入只做防抖延迟保存，没有保存状态、
 * 失败不可见，切页/关窗也不冲刷，输入内容可能静默丢失。
 * 状态与笔记编辑器（NoteEditor）的 SaveStatus 对齐：dirty → saving → saved / error，
 * 视图复用同一套 status-dirty / status-saving / status-error 样式。
 *
 * 关键语义：
 *   - edit：标记 dirty 并防抖保存；保存期间继续输入会以最新值补一轮（不丢字）；
 *   - flush / flushAll：立即冲刷并等待落库，失败 reject（App.navigate 据此提示
 *     「未能保存，已保留当前页面」，主进程关窗冲刷协议 app:flush 复用同一条路径）；
 *   - syncServer：列表刷新时与服务器对齐，有未保存内容的卡片不覆盖用户输入。
 */

export type RemarkStatus = 'saved' | 'dirty' | 'saving' | 'error'

export interface RemarkState {
  /** 本地当前值（含未保存编辑） */
  value: string
  /** 最近一次确认落库的值；null 表示尚未与服务器对齐（此时任何编辑都视为待保存） */
  savedValue: string | null
  status: RemarkStatus
  error: string | null
}

export interface RemarkSaverOptions {
  save(id: string, value: string): Promise<void>
  /** 编辑防抖毫秒数；冲刷不受防抖限制 */
  debounceMs?: number
  describeError?: (err: unknown) => string
  /** 任意状态变化后回调（React 侧驱动重渲染） */
  onChange?: () => void
}

export interface RemarkSaver {
  get(id: string): RemarkState | null
  snapshot(): Map<string, RemarkState>
  /** 记录本地编辑（标记 dirty 并防抖保存） */
  edit(id: string, value: string): void
  /** 列表刷新时与服务器值对齐；不覆盖有未保存内容的卡片 */
  syncServer(id: string, serverValue: string): void
  /** 条目从列表消失时清理 */
  remove(id: string): void
  /** 失败后手动重试（绕过防抖） */
  retry(id: string): void
  /** 立即冲刷单条；失败 reject，错误信息可读 */
  flush(id: string): Promise<void>
  /** 冲刷全部待保存条目；任一失败 reject */
  flushAll(): Promise<void>
  /** 停止一切定时器与后续保存（视图卸载时调用；冲刷在卸载前完成） */
  dispose(): void
}

const defaultDescribeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface Entry {
  value: string
  savedValue: string | null
  status: RemarkStatus
  error: string | null
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  current: Promise<void> | null
  /** 保存进行中又发生了编辑：本轮结束后补跑一轮 */
  rerun: boolean
}

export function createRemarkSaver(options: RemarkSaverOptions): RemarkSaver {
  const debounceMs = options.debounceMs ?? 600
  const describeError = options.describeError ?? defaultDescribeError
  const onChange = options.onChange

  const entries = new Map<string, Entry>()
  let disposed = false

  const emit = () => onChange?.()

  const ensure = (id: string): Entry => {
    let e = entries.get(id)
    if (!e) {
      e = { value: '', savedValue: null, status: 'saved', error: null, timer: null, running: false, current: null, rerun: false }
      entries.set(id, e)
    }
    return e
  }

  const clearTimer = (e: Entry) => {
    if (e.timer) {
      clearTimeout(e.timer)
      e.timer = null
    }
  }

  const snapshotOf = (e: Entry): RemarkState => ({ value: e.value, savedValue: e.savedValue, status: e.status, error: e.error })

  /** 立即执行一轮保存循环：直到「值已落库」或「出错」为止 */
  const runNow = (id: string): Promise<void> => {
    const e = ensure(id)
    if (disposed) return Promise.resolve()
    if (e.running) return e.current ?? Promise.resolve()
    e.running = true
    const cycle = (async () => {
      while (true) {
        clearTimer(e)
        if (e.savedValue !== null && e.value === e.savedValue) {
          e.status = 'saved'
          break
        }
        e.status = 'saving'
        emit()
        const snapshot = e.value
        try {
          await options.save(id, snapshot)
          e.savedValue = snapshot
          e.status = 'saved'
          e.error = null
          if (e.value === snapshot) break
          // 保存期间又有编辑：立即以最新值继续（冲刷语义）
        } catch (err) {
          e.status = 'error'
          e.error = describeError(err)
          break
        }
      }
    })()
    e.current = cycle
    void cycle
      .then(() => emit())
      .finally(() => {
        e.running = false
        e.current = null
        if (e.rerun && !disposed) {
          e.rerun = false
          void runNow(id)
        }
      })
    return cycle
  }

  const schedule = (id: string, e: Entry) => {
    clearTimer(e)
    e.timer = setTimeout(() => {
      e.timer = null
      void runNow(id)
    }, debounceMs)
  }

  return {
    get: (id) => {
      const e = entries.get(id)
      return e ? snapshotOf(e) : null
    },

    snapshot: () => {
      const map = new Map<string, RemarkState>()
      for (const [id, e] of entries) map.set(id, snapshotOf(e))
      return map
    },

    edit(id, value) {
      if (disposed) return
      const e = ensure(id)
      e.value = value
      e.error = null
      if (e.savedValue !== null && value === e.savedValue) {
        // 改回与服务器一致的值：无需保存
        clearTimer(e)
        if (!e.running) e.status = 'saved'
      } else {
        e.status = 'dirty'
        // 打字持续推迟保存（schedule 内部先清旧定时器）；保存进行中则由本轮循环收尾
        if (!e.running) schedule(id, e)
      }
      emit()
    },

    syncServer(id, serverValue) {
      const e = entries.get(id)
      if (!e) {
        entries.set(id, {
          value: serverValue,
          savedValue: serverValue,
          status: 'saved',
          error: null,
          timer: null,
          running: false,
          current: null,
          rerun: false
        })
        emit()
        return
      }
      const clean = e.savedValue !== null && e.value === e.savedValue
      if (clean && !e.running) {
        // 无未保存内容：跟随服务器（可能被其他入口修改过）
        e.value = serverValue
        e.savedValue = serverValue
        e.status = 'saved'
        e.error = null
        emit()
      }
      // 有未保存内容（dirty/saving/error）：保留本地值，等下一轮保存
    },

    remove(id) {
      const e = entries.get(id)
      if (e) clearTimer(e)
      entries.delete(id)
    },

    retry(id) {
      if (disposed) return
      void runNow(id)
    },

    async flush(id) {
      const e = entries.get(id)
      if (!e || disposed) return
      clearTimer(e)
      if (e.running) {
        await e.current
      } else if (e.status === 'dirty' || e.status === 'error' || e.savedValue === null) {
        await runNow(id)
      }
      if (e.status === 'error') throw new Error(e.error ?? '备注保存失败')
    },

    async flushAll() {
      const ids = [...entries.keys()]
      const results = await Promise.allSettled(ids.map((id) => this.flush(id)))
      const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (firstError) throw firstError.reason
    },

    dispose() {
      disposed = true
      for (const e of entries.values()) clearTimer(e)
    }
  }
}
