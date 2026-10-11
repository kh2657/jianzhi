// 学习日历的纯逻辑：周一起始的月历网格与日期状态判定。
// 不依赖 DOM / IPC / React——跨年、闰年、启用前、未来日期这些边界都在这里收口并单测。

export interface CalendarDay {
  /** 本地日期键 YYYY-MM-DD */
  date: string
  /** 日历上显示的「几号」 */
  day: number
  /** 是否属于当前展示月份（前后补位为 false） */
  inMonth: boolean
  /** 晚于今天：不可选、无记录 */
  future: boolean
  /** 早于足迹启用日：无记录可看，不可选 */
  beforeStart: boolean
  /** 当月有学习记录（统一小标记，不分类型深浅） */
  hasRecord: boolean
  isToday: boolean
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function dateKey(y: number, m0: number, d: number): string {
  return `${y}-${pad2(m0 + 1)}-${pad2(d)}`
}

/** 「YYYY 年 M 月」展示文案 */
export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return `${y} 年 ${m} 月`
}

/** 月键平移（跨年安全）：'2026-01' -1 → '2025-12' */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

export function firstDayKeyOfMonth(monthKey: string): string {
  return `${monthKey}-01`
}

/**
 * 周一起始的 6×7 = 42 格月历网格（前后补位保证整周）。
 * startedDay：足迹启用日（本地日期键），早于它的日期无记录可看。
 */
export function buildMonthGrid(
  monthKey: string,
  opts: { today: string; startedDay: string; recordDays: Iterable<string> }
): CalendarDay[] {
  const records = opts.recordDays instanceof Set ? opts.recordDays : new Set(opts.recordDays)
  const [y, m] = monthKey.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const startOffset = (first.getDay() + 6) % 7 // 周一=0
  const cells: CalendarDay[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m - 1, 1 - startOffset + i)
    const key = dateKey(d.getFullYear(), d.getMonth(), d.getDate())
    cells.push({
      date: key,
      day: d.getDate(),
      inMonth: d.getMonth() === m - 1 && d.getFullYear() === y,
      future: key > opts.today,
      beforeStart: key < opts.startedDay,
      hasRecord: records.has(key),
      isToday: key === opts.today
    })
  }
  return cells
}

/** 把期望选中日钳制到可选区间 [startedDay, today]；区间非法时返回 today */
export function clampSelectable(key: string, today: string, startedDay: string): string {
  if (key > today) return today
  if (key < startedDay) return startedDay < today ? startedDay : today
  return key
}
