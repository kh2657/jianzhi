// 极简文件日志（main 进程专用，无依赖）：
// - 写 <userData>/logs/main-YYYYMMDD.log，按天分文件，保留最近 7 天
// - 同步 append（低频写入；崩溃前最后一条日志不丢）
// - 只记录事件与错误元数据；禁止记录文档正文/笔记内容/密钥（本项目无密钥）
// - 渲染进程错误经 ipc 主进程代写（renderer 无法直接写 userData 之外的文件不受影响，统一走 main）
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const RETAIN_DAYS = 7
let logsDir: string | null = null
let lastCleanupDay = ''

function ensureDir(root: string): string {
  if (logsDir) return logsDir
  logsDir = join(root, 'logs')
  mkdirSync(logsDir, { recursive: true })
  return logsDir
}

function todayStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 脱敏（纯路径字段用）：保留根与最后两段，中间折叠为 … */
export function redactPath(p: string): string {
  if (typeof p !== 'string') return String(p)
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return p
  const isWinDrive = /^[a-zA-Z]:$/.test(parts[0])
  const root = isWinDrive ? parts[0] + '\\' : '/'
  return root + '…\\' + parts.slice(-2).join('\\')
}

/** 脱敏（自由文本用）：只折叠用户目录段（Users/<name>、home/<name>），其余原样 */
export function redactUserDirs(text: string): string {
  if (typeof text !== 'string') return String(text)
  return text.replace(/([\\/])(?:Users|home)([\\/])([^\\/]+)/g, '$1$2$3…')
}

function cleanupOld(dir: string): void {
  const today = todayStamp()
  if (lastCleanupDay === today) return
  lastCleanupDay = today
  try {
    const cutoff = Date.now() - RETAIN_DAYS * 86400_000
    for (const name of readdirSync(dir)) {
      const m = /^main-(\d{8})\.log$/.exec(name)
      if (!m) continue
      const p = join(dir, name)
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

function line(level: 'INFO' | 'WARN' | 'ERROR', scope: string, message: string): void {
  if (!logsDir) return
  const ts = new Date().toISOString()
  try {
    appendFileSync(join(logsDir, `main-${todayStamp()}.log`), `${ts} ${level} [${scope}] ${message}\n`)
  } catch {
    /* 磁盘满/权限：日志失败绝不影响应用 */
  }
}

/** 初始化（app ready 后调用；重复调用以最新目录为准） */
export function initFileLogger(userDataDir: string): void {
  logsDir = join(userDataDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  cleanupOld(logsDir)
  info('logger', `start app=${process.env.npm_package_version ?? ''} electron=${process.versions.electron} platform=${process.platform} arch=${process.arch}`)
}

export function info(scope: string, message: string): void {
  line('INFO', scope, message)
}

export function warn(scope: string, message: string): void {
  line('WARN', scope, message)
}

/** 错误：附 stack（若有）；错误 message 可能内插路径，统一脱敏 */
export function error(scope: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}${err.stack ? ` :: ${err.stack.split('\n').slice(1, 3).join(' | ')}` : ''}` : String(err)
  line('ERROR', scope, redactUserDirs(message))
}

/** 日志目录（诊断指引用） */
export function logsDirPath(): string | null {
  return logsDir
}

export function logsEnabled(): boolean {
  return logsDir !== null && existsSync(logsDir)
}
