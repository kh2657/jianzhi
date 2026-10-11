import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 存储内核的文件系统原语。铁律见 docs/存储格式.md §0：
 * 原子写（同目录临时文件 + rename 覆盖）、名字净化、目录遍历。
 */

const WINDOWS_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 文件/目录名净化：非法字符替换为空格、压缩空白、去掉首尾点与空白、限长 120。空结果回退「未命名」。
 *
 * 为什么必须去掉首尾点：
 *  1) `.` / `..` / `...` 这类纯点名字在拼路径时会指向父目录 —— `join(库根,'文献库','..')` 就是库根，
 *     条目会被建/移到分区体系之外（路径穿越）；
 *  2) Windows 会静默丢掉目录名末尾的「.」，`a.` 落盘成 `a`，内存名与磁盘名从此不一致；
 *  3) 以点开头的名字会被扫描器当作隐藏目录跳过（分区栏里看不见）。
 */
export function sanitizeName(input: string, maxLen = 120): string {
  const cleaned = (input ?? '')
    .replace(WINDOWS_FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, maxLen)
    .replace(/[.\s]+$/, '')
  return cleaned.length > 0 ? cleaned : '未命名'
}

/** 笔记文件名前缀：标题净化 + 空白转连字符，限长 60 */
export function slugFor(input: string, maxLen = 60): string {
  return sanitizeName(input, maxLen).replace(/\s+/g, '-')
}

/**
 * 落盘文件名净化：超长只截主干、**保留扩展名**。
 * 直接 sanitizeName 会把长名截到丢扩展名（…xxx.pd），文件从此不被识别为 PDF/HTML。
 */
export function sanitizeFileName(input: string, maxLen = 120): string {
  const cleaned = sanitizeName(input, maxLen)
  if (cleaned.length <= maxLen) return cleaned
  const dot = input.lastIndexOf('.')
  const ext = dot > 0 ? input.slice(dot).toLowerCase() : ''
  if (!/^\.[a-z0-9]{1,7}$/.test(ext)) return cleaned
  const stem = sanitizeName(input.slice(0, dot), maxLen - ext.length)
  return stem + ext
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 原子覆盖写：同目录临时文件 → rename。Node 的 rename 在 Windows 上使用
 * MOVEFILE_REPLACE_EXISTING，可覆盖既有文件；目标被占用（杀软/同步盘瞬时扫描）
 * 时短暂重试后放弃。临时文件带 .tmp 后缀，扫描器一律忽略。
 */
export async function atomicWriteFile(absPath: string, data: string | Uint8Array): Promise<void> {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = join(dirname(absPath), `.${randomUUID()}.tmp`)
  writeFileSync(tmp, data)
  try {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(tmp, absPath)
        return
      } catch (err) {
        lastErr = err
        await sleep(60 * (attempt + 1))
      }
    }
    throw lastErr
  } finally {
    rmSync(tmp, { force: true })
  }
}

export function atomicWriteJson(absPath: string, value: unknown): Promise<void> {
  return atomicWriteFile(absPath, `${JSON.stringify(value, null, 2)}\n`)
}

/** 同步版（仅用于启动期一次性小文件，如 足迹.json 初始化；调用方需容忍阻塞数毫秒） */
export function atomicWriteJsonSync(absPath: string, value: unknown): void {
  mkdirSync(dirname(absPath), { recursive: true })
  const tmp = join(dirname(absPath), `.${randomUUID()}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, absPath)
}

/**
 * 坏文件改名成 `<名>.broken`，返回是否成功。
 * rename 在 POSIX/Windows 都覆盖既有目标，所以反复损坏只保留最近一份，与 settings/足迹/分区 的既有做法一致。
 */
function backupCorrupt(absPath: string): boolean {
  try {
    renameSync(absPath, `${absPath}.broken`)
    return true
  } catch {
    return false
  }
}

function corruptMessage(absPath: string, err: unknown, backed: boolean): string {
  const why = err instanceof Error ? err.message : String(err)
  return `${absPath} 解析失败${backed ? `，已备份为 ${basename(absPath)}.broken` : '（备份失败）'}：${why}`
}

/**
 * 读取 JSON 文件，损坏时先备份再回退默认值。
 *
 * 为什么不能只回退默认值：这些文件都是**整份替换式**写入的，坏文件若被当成空内容，
 * 用户下一次操作就会用新内容把它覆盖掉，原内容永久消失。settings / 足迹 / 分区
 * 一直有这个备份，而用户真正创作的锚点、墨迹、精读卡反而没有——这个不对称正是数据丢失的来源。
 */
export function readJsonSafeSync<T>(absPath: string, fallback: T, onCorrupt?: (message: string) => void): T {
  let raw: string
  try {
    raw = readFileSync(absPath, 'utf8')
  } catch {
    return fallback // 不存在 = 还没有内容，属正常路径
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    onCorrupt?.(corruptMessage(absPath, err, backupCorrupt(absPath)))
    return fallback
  }
}

/** readJsonSafeSync 的异步版（扫描器走这条，避免大库扫描时阻塞事件循环） */
export async function readJsonSafeAsync<T>(absPath: string, fallback: T, onCorrupt?: (message: string) => void): Promise<T> {
  let raw: string
  try {
    raw = await readFile(absPath, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    onCorrupt?.(corruptMessage(absPath, err, backupCorrupt(absPath)))
    return fallback
  }
}

/**
 * 文本内容指纹（sha1 hex）。笔记冲突检测专用：磁盘原文与写入内容用同一算法，
 * 保证「渲染层拿到的 baseHash」与「保存前对磁盘现读现算的指纹」可比。
 */
export function sha1OfText(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

export function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  return new Promise<string>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
    stream.on('error', reject)
  })
}
