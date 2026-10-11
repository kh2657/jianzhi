import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * IPC 通道名的漂移守卫。
 *
 * 现状：通道名在 preload（`ipcRenderer.invoke/on/send/off`）与主进程（`h(...)`）**各写一遍**，
 * 共约 78 个通道、两侧 156 处裸字符串。两侧的类型都是 string，TypeScript 抓不到拼写错误——
 * 某次只改一边，运行时才会以「handler 不存在」的形式炸出来。
 *
 * 与其把 156 处调用点全部重构成常量（触碰整个 IPC 骨架、收益只是防漂移），
 * 这里用一条测试把「两侧必须一致」钉住：成本低，且覆盖了真正的失效模式。
 */
function channelsIn(file: string, pattern: RegExp): Set<string> {
  const source = readFileSync(join(process.cwd(), file), 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[2]
    if (name) found.add(name)
  }
  return found
}

/** 渲染层发起的调用：ipcRenderer.invoke('x') / .on('x') / .send('x') / .off('x') */
const PRELOAD = channelsIn('src/preload/index.ts', /ipcRenderer\.(?:invoke|on|send|off)\(\s*'([^']+)'/g)

/** 主进程注册的处理器：h('x', ...) 走 invoke；ipcMain.on('x', ...) 是单向上报 */
const MAIN_IPC = channelsIn('src/main/ipc.ts', /\bh\(\s*'([^']+)'|ipcMain\.(?:on|off)\(\s*'([^']+)'/g)

/** 主进程直接监听/推送的通道（不经 h()）：ipcMain.on('x') / webContents.send('x') */
const MAIN_INDEX = channelsIn('src/main/index.ts', /ipcMain\.(?:on|off)\(\s*'([^']+)'|webContents\.send\(\s*'([^']+)'/g)

describe('IPC 通道契约', () => {
  it('preload 里出现的通道，主进程都有对应处理器（或显式在主进程侧处理）', () => {
    const handled = new Set([...MAIN_IPC, ...MAIN_INDEX])
    const missing = [...PRELOAD].filter((c) => !handled.has(c)).sort()
    expect(missing).toEqual([])
  })

  it('主进程注册的处理器，preload 都有出口（否则渲染层永远调不到）', () => {
    // 主进程内部通道（应用级事件，由主进程自己收发，不经 preload）
    const mainOnly = new Set(['app:flush', 'app:flushed', 'app:flush-failed'])
    const missing = [...MAIN_IPC].filter((c) => !PRELOAD.has(c) && !mainOnly.has(c)).sort()
    expect(missing).toEqual([])
  })

  it('通道名数量与两侧覆盖情况（防解析失效导致空集合蒙混过关）', () => {
    expect(PRELOAD.size).toBeGreaterThan(60)
    expect(MAIN_IPC.size).toBeGreaterThan(60)
    // 三个主进程内部通道由 index.ts 收发
    for (const c of ['app:flush', 'app:flushed', 'app:flush-failed']) expect(MAIN_INDEX.has(c)).toBe(true)
  })
})
