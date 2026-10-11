import { describe, expect, it } from 'vitest'
import { buildMonthGrid, clampSelectable, firstDayKeyOfMonth, monthLabel, shiftMonthKey } from '../src/renderer/src/lib/learning-calendar'

const START = '2026-09-15' // 启用日
const TODAY = '2026-10-11'

describe('学习日历网格', () => {
  it('周一起始：2026-10（1 日周四）首格补位到 9-28，共 42 格', () => {
    const grid = buildMonthGrid('2026-10', { today: TODAY, startedDay: START, recordDays: ['2026-10-11'] })
    expect(grid).toHaveLength(42)
    expect(grid[0].date).toBe('2026-09-28')
    expect(grid[0].inMonth).toBe(false)
    const oct1 = grid.find((c) => c.date === '2026-10-01')!
    expect(oct1.inMonth).toBe(true)
    expect(grid[41].date).toBe('2026-11-08')
  })

  it('跨年：1 月首格落在上一年，12 月尾格落在下一年', () => {
    const jan = buildMonthGrid('2026-01', { today: TODAY, startedDay: START, recordDays: [] })
    expect(jan[0].date).toBe('2025-12-29')
    const dec = buildMonthGrid('2026-12', { today: TODAY, startedDay: START, recordDays: [] })
    // 2026-12-01 是周二 → 首格 11-30，42 格收在 2027-01-10
    expect(dec[0].date).toBe('2026-11-30')
    expect(dec[41].date).toBe('2027-01-10')
  })

  it('闰年：2028-02 有 29 日；平年 2026-02 只有 28 日', () => {
    const leap = buildMonthGrid('2028-02', { today: '2028-03-01', startedDay: '2028-01-01', recordDays: [] })
    expect(leap.some((c) => c.date === '2028-02-29' && c.inMonth)).toBe(true)
    const plain = buildMonthGrid('2026-02', { today: TODAY, startedDay: START, recordDays: [] })
    expect(plain.some((c) => c.date === '2026-02-29')).toBe(false)
    expect(plain.filter((c) => c.date.startsWith('2026-02'))).toHaveLength(28)
  })

  it('状态判定：今天/未来/启用前/有记录互不混淆', () => {
    const grid = buildMonthGrid('2026-10', {
      today: TODAY,
      startedDay: START,
      recordDays: ['2026-10-05', '2026-10-11', '2026-10-12']
    })
    const today = grid.find((c) => c.date === TODAY)!
    expect(today.isToday).toBe(true)
    expect(today.future).toBe(false)
    expect(today.hasRecord).toBe(true)
    const future = grid.find((c) => c.date === '2026-10-12')!
    expect(future.future).toBe(true)
    expect(future.hasRecord).toBe(true) // 数据在，但由界面禁用（不显示标记）
    const sep = buildMonthGrid('2026-09', { today: TODAY, startedDay: START, recordDays: [] })
    const before = sep.find((c) => c.date === '2026-09-14')!
    expect(before.beforeStart).toBe(true)
    const afterStart = sep.find((c) => c.date === '2026-09-20')!
    expect(afterStart.beforeStart).toBe(false)
    expect(afterStart.future).toBe(false)
  })

  it('月键平移与钳制：跨年、启用前、未来', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12')
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01')
    expect(firstDayKeyOfMonth('2026-10')).toBe('2026-10-01')
    expect(monthLabel('2026-10')).toBe('2026 年 10 月')
    expect(clampSelectable('2026-12-01', TODAY, START)).toBe(TODAY)
    expect(clampSelectable('2026-09-01', TODAY, START)).toBe(START)
    expect(clampSelectable('2026-10-05', TODAY, START)).toBe('2026-10-05')
    expect(clampSelectable('2025-01-01', TODAY, '2030-01-01')).toBe(TODAY) // 启用日在未来的退化情形
  })
})
