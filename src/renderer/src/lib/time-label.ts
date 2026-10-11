/**
 * 笔记日期展示的唯一实现：本地时区、日历日语义（跨午夜/跨年按自然日判断）。
 * 列表「今天更新」、编辑页「X创建 · Y更新」、悬停完整时间都从这里出，避免各视图口径漂移。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地日期键 YYYY-MM-DD（足迹事件归属与月历都用它） */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parse(iso: string | undefined | null): Date | null {
  if (!iso || typeof iso !== 'string') return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t) : null
}

/** 短日期：10月3日；跨年 2025年12月3日；无效/缺失「时间未知」 */
export function shortDate(iso: string | undefined | null, now = new Date()): string {
  const d = parse(iso)
  if (!d) return '时间未知'
  const sameYear = d.getFullYear() === now.getFullYear()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return sameYear ? md : `${d.getFullYear()}年${md}`
}

/** 完整时间：2026年10月8日 09:05；无效/缺失「时间未知」 */
export function fullStamp(iso: string | undefined | null): string {
  const d = parse(iso)
  if (!d) return '时间未知'
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function dayDiff(a: Date, b: Date): number {
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((a0 - b0) / 86_400_000)
}

/** 「今天 / 昨天 / 10月3日 / 2025年12月3日」；无效/缺失「时间未知」 */
export function dayLabel(iso: string | undefined | null, now = new Date()): string {
  const d = parse(iso)
  if (!d) return '时间未知'
  const diff = dayDiff(d, now)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return shortDate(iso, now)
}

/** 列表用「最近更新」标签：今天更新 / 昨天更新 / 10月3日更新 */
export function updateLabel(iso: string | undefined | null, now = new Date()): string {
  const label = dayLabel(iso, now)
  return label === '时间未知' ? label : `${label}更新`
}

/**
 * 编辑页日期行：同一天合并为「今天新建」，否则「10月3日创建 · 今天更新」。
 * created/updated 任一无效按「时间未知」处理，不伪造。
 */
export function noteDateLine(createdAt: string | undefined | null, updatedAt: string | undefined | null, now = new Date()): string {
  const c = parse(createdAt)
  const u = parse(updatedAt)
  if (c && u && localDateKey(c) === localDateKey(u)) return `${dayLabel(createdAt, now)}新建`
  const created = c ? `${shortDate(createdAt, now)}创建` : '创建时间未知'
  const updated = u ? updateLabel(updatedAt, now) : '更新时间未知'
  return `${created} · ${updated}`
}

/** 编辑页悬停详情：创建/最近更新的完整时间 + 修订次数 */
export function noteDateDetail(createdAt: string | undefined | null, updatedAt: string | undefined | null, revision: number): string {
  return `创建：${fullStamp(createdAt)} · 最近更新：${fullStamp(updatedAt)} · 修订 ${revision} 次`
}
