// 主进程持久配置（settings.json，位于 userData 根）。窗口边界、每日论文设置共用一份文件。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { error as logError } from './logger'

export interface DailySettings {
  folder: string
  autoCheck: boolean
  lastCheck: string | null
}

interface AppSettings {
  bounds?: { x: number; y: number; width: number; height: number }
  daily?: { autoCheck?: boolean; lastCheck?: string | null; folder?: string }
  prefs?: Record<string, string>
  libraryRoot?: string
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readAll(): AppSettings {
  const path = settingsPath()
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // 读不动（占用/权限）：当作空配置继续跑，但必须留痕——静默失败会让用户以为设置丢了
    logError('settings', err instanceof Error ? err : new Error(String(err)))
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as AppSettings
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是对象')
    return parsed
  } catch (err) {
    // 解析失败 = 文件损坏（崩溃截断 / 手工改坏）。旧实现一律返回 {}，于是 libraryRoot 被静默丢弃、
    // 库回退到 <userData>/library，用户看到「库空了」，甚至在默认位置又建一个新库。
    // 现在把坏文件备份为 .broken 并大声记日志，至少让问题可诊断、可人工恢复。
    logError('settings', err instanceof Error ? err : new Error(String(err)))
    try { renameSync(path, `${path}.broken`) } catch { /* 备份失败也不阻断启动 */ }
    return {}
  }
}

/**
 * 原子覆写：同目录临时文件 → rename。settings.json 是「数据文件夹」的唯一指针，
 * 直接 writeFileSync 一旦被崩溃/同步盘截断，整份配置（含 libraryRoot）就没了。
 * 注意这里用同步原语：调用点（窗口 resize、偏好写入）本身是同步 API，且文件极小。
 */
function writeAll(s: AppSettings): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = settingsPath()
  const tmp = join(dir, `.settings-${process.pid}-${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, path)
}

export function defaultDailyFolder(): string {
  return join(app.getPath('documents'), '数学学习工作台-论文清单')
}

export function getDailySettings(): DailySettings {
  const s = readAll()
  return {
    folder: s.daily?.folder ?? defaultDailyFolder(),
    autoCheck: s.daily?.autoCheck ?? false,
    lastCheck: s.daily?.lastCheck ?? null
  }
}

export function setDailySettings(patch: { autoCheck?: boolean; lastCheck?: string; folder?: string }): void {
  const s = readAll()
  let folder = s.daily?.folder
  if (patch.folder !== undefined) {
    // 绝对路径校验（用户/测试自定义清单目录；跨平台：POSIX 以 / 开头，Windows 盘符 X:\ 或 X:/）
    const isAbsolute = typeof patch.folder === 'string' && (patch.folder.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(patch.folder))
    if (!isAbsolute) throw new Error('清单文件夹必须是绝对路径')
    folder = patch.folder
  }
  s.daily = {
    folder,
    autoCheck: patch.autoCheck ?? s.daily?.autoCheck ?? false,
    lastCheck: patch.lastCheck ?? s.daily?.lastCheck ?? null
  }
  writeAll(s)
}

export function setWindowBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  const s = readAll()
  s.bounds = bounds
  writeAll(s)
}

export function loadWindowBounds(): { x: number; y: number; width: number; height: number } | undefined {
  return readAll().bounds
}

export function revealFolder(): void {
  const folder = getDailySettings().folder
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
  // shell.openPath 打开文件夹本体；revealInFinder 语义由 openPath 实现
  void import('electron').then(({ shell }) => shell.openPath(folder))
}

// ---------- UI 偏好（少量字符串键值；localStorage 按源隔离、本地服务端口随机，跨会话不可靠，故走此文件） ----------

export function getPref(key: string): string | null {
  return readAll().prefs?.[key] ?? null
}

export function setPref(key: string, value: string): void {
  const s = readAll()
  s.prefs = { ...(s.prefs ?? {}), [key]: value }
  writeAll(s)
}

// ---------- 数据文件夹（库根） ----------

export function defaultLibraryRoot(): string {
  return join(app.getPath('userData'), 'library')
}

const isAbsolutePath = (p: unknown): p is string =>
  typeof p === 'string' && (p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p))

/** 当前库根：用户自选（settings.libraryRoot）优先，否则 <userData>/library */
export function getLibraryRoot(): string {
  const root = readAll().libraryRoot
  return isAbsolutePath(root) ? root : defaultLibraryRoot()
}

export function isCustomLibraryRoot(): boolean {
  return isAbsolutePath(readAll().libraryRoot)
}

export function setLibraryRoot(root: string): void {
  // 绝对路径校验同 daily.folder（跨平台：POSIX 以 / 开头，Windows 盘符）
  if (!isAbsolutePath(root)) throw new Error('数据文件夹必须是绝对路径')
  const s = readAll()
  s.libraryRoot = root
  writeAll(s)
}

export function clearLibraryRoot(): void {
  const s = readAll()
  delete s.libraryRoot
  writeAll(s)
}
