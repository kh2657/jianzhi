import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemarkSaver, type RemarkSaver } from '../src/renderer/src/lib/remark-saver'

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 值记录型 save：返回 [调用参数列表, 手动控制第 n 次调用] */
function recordingSave() {
  const calls: Array<{ id: string; value: string }> = []
  const gates: Array<ReturnType<typeof deferred>> = []
  const save = vi.fn((id: string, value: string) => {
    calls.push({ id, value })
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  })
  return { save, calls, gates }
}

describe('createRemarkSaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function makeSaver(save: ReturnType<typeof recordingSave>['save'], debounceMs = 600): RemarkSaver {
    return createRemarkSaver({ save, debounceMs })
  }

  it('edit 后按防抖保存，状态走 dirty → saving → saved', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', '演草 A')
    expect(saver.get('c1')?.status).toBe('dirty')
    await vi.advanceTimersByTimeAsync(599)
    expect(rec.save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(saver.get('c1')?.status).toBe('saving')
    rec.gates[0].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls).toEqual([{ id: 'c1', value: '演草 A' }])
    expect(saver.get('c1')).toMatchObject({ status: 'saved', savedValue: '演草 A' })
  })

  it('连续输入只保存最后一次', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', 'a')
    await vi.advanceTimersByTimeAsync(300)
    saver.edit('c1', 'ab')
    await vi.advanceTimersByTimeAsync(300)
    saver.edit('c1', 'abc')
    await vi.advanceTimersByTimeAsync(600)
    rec.gates[0].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls).toEqual([{ id: 'c1', value: 'abc' }])
    expect(saver.get('c1')?.status).toBe('saved')
  })

  it('保存进行中继续输入：以最新值补一轮，不丢字', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', '第一版')
    await vi.advanceTimersByTimeAsync(600)
    expect(rec.calls.length).toBe(1)
    saver.edit('c1', '第一版补充') // 第一轮还在途
    rec.gates[0].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls.length).toBe(2)
    expect(rec.calls[1]).toEqual({ id: 'c1', value: '第一版补充' })
    rec.gates[1].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(saver.get('c1')).toMatchObject({ status: 'saved', savedValue: '第一版补充', value: '第一版补充' })
  })

  it('失败进入 error 且保留待保存值；flush 时会重试并可再次失败 reject', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', '内容')
    await vi.advanceTimersByTimeAsync(600)
    rec.gates[0].reject(new Error('磁盘已满'))
    await vi.advanceTimersByTimeAsync(0)
    expect(saver.get('c1')).toMatchObject({ status: 'error', error: '磁盘已满', value: '内容' })
    // flush（如关窗冲刷）会再尝试一次；仍失败则把错误抛给导航层
    const flushing = saver.flush('c1')
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls.length).toBe(2)
    rec.gates[1].reject(new Error('磁盘已满'))
    await expect(flushing).rejects.toThrow('磁盘已满')
    expect(saver.get('c1')).toMatchObject({ status: 'error', value: '内容' })
  })

  it('retry 绕过防抖立即重试，成功后恢复 saved', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', '内容')
    await vi.advanceTimersByTimeAsync(600)
    rec.gates[0].reject(new Error('失败'))
    await vi.advanceTimersByTimeAsync(0)
    await saver.retry('c1') // 绕过防抖
    expect(rec.calls.length).toBe(2)
    rec.gates[1].resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(saver.get('c1')?.status).toBe('saved')
  })

  it('flush 绕过防抖立即保存并等待落库', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', '立即保存')
    let flushed = false
    const p = saver.flush('c1').then(() => {
      flushed = true
    })
    expect(rec.calls.length).toBe(1) // 没等 600ms 防抖
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toBe(false)
    rec.gates[0].resolve()
    await p
    expect(flushed).toBe(true)
    expect(saver.get('c1')?.status).toBe('saved')
  })

  it('flushAll 保存全部待保存条目；任一失败则整体 reject', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.syncServer('c2', '')
    saver.edit('c1', '一')
    saver.edit('c2', '二')
    const all = saver.flushAll()
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls.map((c) => c.value).sort()).toEqual(['一', '二'])
    rec.gates.forEach((g) => g.resolve())
    await all
    expect(saver.get('c1')?.status).toBe('saved')
    expect(saver.get('c2')?.status).toBe('saved')

    // 失败路径：其一成功、其一失败 → flushAll 拒绝
    const rec2 = recordingSave()
    const saver2 = makeSaver(rec2.save)
    saver2.syncServer('a', '')
    saver2.syncServer('b', '')
    saver2.edit('a', 'ok')
    saver2.edit('b', 'boom')
    const failing = saver2.flushAll()
    await vi.advanceTimersByTimeAsync(0)
    rec2.gates.forEach((g, i) => (i === 0 ? g.resolve() : g.reject(new Error('b 失败'))))
    await expect(failing).rejects.toThrow('b 失败')
    expect(saver2.get('a')?.status).toBe('saved')
    expect(saver2.get('b')?.status).toBe('error')
  })

  it('edit 改回与服务器一致的值：不再发起保存', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '服务器值')
    saver.edit('c1', '改动')
    saver.edit('c1', '服务器值')
    await vi.advanceTimersByTimeAsync(600)
    expect(rec.save).not.toHaveBeenCalled()
    expect(saver.get('c1')?.status).toBe('saved')
  })

  it('syncServer：无本地状态时采纳服务器值；有未保存内容时不覆盖', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    // 新条目
    saver.syncServer('c1', '服务器值')
    expect(saver.get('c1')).toMatchObject({ value: '服务器值', savedValue: '服务器值', status: 'saved' })
    // dirty 条目不被覆盖
    saver.edit('c2', '本地草稿')
    saver.syncServer('c2', '')
    expect(saver.get('c2')?.value).toBe('本地草稿')
    // saved 条目跟随服务器更新
    saver.syncServer('c1', '服务器新值')
    expect(saver.get('c1')?.value).toBe('服务器新值')
  })

  it('dispose 后不再触发保存', async () => {
    const rec = recordingSave()
    const saver = makeSaver(rec.save)
    saver.syncServer('c1', '')
    saver.edit('c1', 'x')
    saver.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(rec.save).not.toHaveBeenCalled()
  })
})
