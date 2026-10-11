import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncedLoader, type LoaderState } from '../src/renderer/src/lib/async-loader'

/** 可控的 deferred promise：手动决定 resolve/reject 时机 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createDebouncedLoader', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('防抖期间连续 request 只执行最后一次', async () => {
    let calls = 0
    const loader = createDebouncedLoader(async () => ++calls, { debounceMs: 250 })
    loader.request()
    loader.request()
    loader.request()
    expect(loader.get().phase).toBe('debouncing')
    await vi.advanceTimersByTimeAsync(250)
    expect(calls).toBe(1)
    expect(loader.get()).toMatchObject<Partial<LoaderState<number>>>({ phase: 'success', data: 1, error: null })
  })

  it('debounceMs=0 立即执行', async () => {
    const loader = createDebouncedLoader(async () => 'v')
    loader.request()
    expect(loader.get().phase).toBe('loading')
    await vi.advanceTimersByTimeAsync(0)
    expect(loader.get()).toMatchObject({ phase: 'success', data: 'v' })
  })

  it('最新请求获胜：慢的旧响应被丢弃，不覆盖新结果', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const loader = createDebouncedLoader(load)
    const p1 = loader.reload()
    const p2 = loader.reload() // 第一轮还在途时发起第二轮
    first.resolve('旧响应')
    second.resolve('新响应')
    await Promise.all([p1, p2])
    expect(loader.get()).toMatchObject({ phase: 'success', data: '新响应' })
  })

  it('过期响应的错误同样丢弃：新一轮出错后旧轮成功不覆盖', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const loader = createDebouncedLoader(load)
    const p1 = loader.reload()
    const p2 = loader.reload()
    second.reject(new Error('新一轮失败'))
    first.resolve('旧响应成功')
    await Promise.all([p1, p2])
    expect(loader.get()).toMatchObject({ phase: 'error', data: null, error: '新一轮失败' })
  })

  it('失败进入 error 态（可读信息、data 清空），reload 成功后恢复', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('IPC 拒绝')).mockResolvedValueOnce(['n1'])
    const loader = createDebouncedLoader(load)
    await loader.reload()
    expect(loader.get()).toMatchObject({ phase: 'error', data: null, error: 'IPC 拒绝' })
    await loader.reload()
    expect(loader.get()).toMatchObject({ phase: 'success', data: ['n1'], error: null })
  })

  it('reload 在本轮落定后 resolve（无论成败）', async () => {
    const d = deferred<string>()
    const loader = createDebouncedLoader(() => d.promise)
    let settled = false
    void loader.reload().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    d.resolve('ok')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  })

  it('dispose 后：防抖中的请求不执行，在途响应不落地', async () => {
    const d = deferred<string>()
    const load = vi.fn().mockReturnValue(d.promise)
    const loader = createDebouncedLoader(load, { debounceMs: 100 })
    loader.request()
    loader.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).not.toHaveBeenCalled()

    const loader2 = createDebouncedLoader(() => d.promise)
    const p = loader2.reload()
    loader2.dispose()
    d.resolve('迟到')
    await p
    // dispose 后状态冻结：迟到的响应不再落地（phase 保持 dispose 时的 loading）
    expect(loader2.get().phase).toBe('loading')
  })

  it('onChange 收到每次状态变化（React 接线用）', async () => {
    const states: Array<LoaderState<string>['phase']> = []
    const loader = createDebouncedLoader(async () => 'x', {
      debounceMs: 50,
      onChange: (s) => states.push(s.phase)
    })
    loader.request()
    await vi.advanceTimersByTimeAsync(50)
    expect(states).toEqual(['debouncing', 'loading', 'success'])
  })
})
