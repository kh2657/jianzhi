import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { localDateKey } from '../src/main/storage/activity'

const today = localDateKey(new Date())
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

function footprintPath(root: string): string {
  return join(root, '足迹.json')
}

/** 直写足迹文件（模拟历史日期/跨月数据）；之后需 repo.ensureActivity() 重新加载 */
function seedEvents(root: string, events: Array<Record<string, unknown>>, startedAt = '2026-01-01T00:00:00.000Z'): void {
  writeFileSync(footprintPath(root), JSON.stringify({ schema: 2, startedAt, events }, null, 2))
}

function panel(repo: TestRepo['repo'], range: 'week' | 'month', opts: { month?: string; date?: string; spaceId?: string | null } = {}) {
  return repo.activityPanel({ range, date: today, month: opts.month ?? today.slice(0, 7), spaceId: opts.spaceId })
}

let t: TestRepo

beforeAll(async () => {
  t = await makeTestRepo('mathwb-activity-')
  t.repo.ensureActivity()
})

afterAll(() => t?.dispose())

describe('学习足迹：记录口径', () => {
  it('空白占位不计数；首次非空正文=新建且同日不重复计修改', async () => {
    const note = await t.repo.createNote({ title: '足迹一' })
    expect(existsSync(footprintPath(t.root))).toBe(true)
    let p = await panel(t.repo, 'week')
    expect(p.summary).toMatchObject({ activeDays: 0, created: 0, updated: 0 })

    await t.repo.saveNote({ id: note.id, title: '足迹一', noteType: 'note', bodyMd: '第一段正文', aliases: [], verifiedStatus: 'unchecked' })
    p = await panel(t.repo, 'week')
    expect(p.summary.created).toBe(1)
    expect(p.summary.updated).toBe(0) // 当天新建不重复计修改
    expect(p.monthDays).toEqual([today])
    const dayPanel = await panel(t.repo, 'week', { date: today })
    expect(dayPanel.items).toHaveLength(1)
    expect(dayPanel.items[0]).toMatchObject({ kind: 'note', created: true, title: '足迹一', deleted: false })

    // 同一篇笔记连续自动保存：同日多次修改合并为一条，不虚增
    await t.repo.saveNote({ id: note.id, title: '足迹一', noteType: 'note', bodyMd: '第一段正文改', aliases: [], verifiedStatus: 'unchecked' })
    await t.repo.saveNote({ id: note.id, title: '足迹一', noteType: 'note', bodyMd: '第一段正文改改', aliases: [], verifiedStatus: 'unchecked' })
    p = await panel(t.repo, 'week')
    expect(p.summary.created).toBe(1)
    expect(p.summary.updated).toBe(0) // 仍被「当天/范围内新建」吸收
    expect((await panel(t.repo, 'week', { date: today })).items).toHaveLength(1)
  })

  it('零变化重复合存：updatedAt 不刷新、无事件；改名/改分类不计', async () => {
    const note = await t.repo.createNote({ title: '足迹二', bodyMd: '有内容' }) // 带正文直接建=新建
    expect((await panel(t.repo, 'week')).summary.created).toBe(2) // 足迹一 + 足迹二

    const before = (await t.repo.getNote(note.id)).updatedAt
    const r = await t.repo.saveNote({ id: note.id, title: '足迹二', noteType: 'note', bodyMd: '有内容', aliases: [], verifiedStatus: 'unchecked' })
    expect(r.savedAt).toBe(before)
    expect((await t.repo.getNote(note.id)).updatedAt).toBe(before)
    expect((await panel(t.repo, 'week')).summary.created).toBe(2)

    // 改名 + 改分类：updatedAt 刷新但不产生足迹事件
    await t.repo.saveNote({ id: note.id, title: '足迹二改名', noteType: 'concept', bodyMd: '有内容', aliases: [], verifiedStatus: 'unchecked' })
    const p = await panel(t.repo, 'week')
    expect(p.summary.created).toBe(2)
    expect(p.summary.updated).toBe(0)
    // 列表条目标题按索引实时解析（改名后仍正确）
    expect((await panel(t.repo, 'week', { date: today })).items.find((i) => i.noteId === note.id)?.title).toBe('足迹二改名')
  })

  it('清空正文再写不重复计新建（counted 防抖）', async () => {
    const note = await t.repo.createNote({ title: '足迹三' })
    await t.repo.saveNote({ id: note.id, title: '足迹三', noteType: 'note', bodyMd: '内容', aliases: [], verifiedStatus: 'unchecked' })
    await t.repo.saveNote({ id: note.id, title: '足迹三', noteType: 'note', bodyMd: '', aliases: [], verifiedStatus: 'unchecked' })
    await t.repo.saveNote({ id: note.id, title: '足迹三', noteType: 'note', bodyMd: '重写内容', aliases: [], verifiedStatus: 'unchecked' })
    await flush()
    const created = JSON.parse(readFileSync(footprintPath(t.root), 'utf8')).events.filter(
      (e: { kind: string; noteId?: string }) => e.kind === 'note-created' && e.noteId === note.id
    )
    expect(created).toHaveLength(1)
    expect((await panel(t.repo, 'week')).summary.created).toBe(3)
  })

  it('摘录计数与「摘录+伴随笔记」合并叙述；同一材料多条摘录合并', async () => {
    const userDir = join(t.root, 'user-files')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(userDir, { recursive: true })
    const user = join(userDir, 'anchor-doc.pdf')
    writeFileSync(user, Buffer.from('%PDF-1.4\nactivity-test\n'))
    const [doc] = await t.repo.importDocuments([user])
    const versionId = doc.versionId!
    await t.repo.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [[10, 10, 60, 30]] })
    await t.repo.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [[10, 40, 60, 60]] })
    let p = await panel(t.repo, 'week', { date: today })
    const anchorItem = p.items.find((i) => i.kind === 'anchors')
    expect(anchorItem).toMatchObject({ kind: 'anchors', anchorCount: 2, deleted: false })
    expect(anchorItem?.mediaType).toBe('application/pdf')

    // 摘录 + 伴随建笔记：合并为一条「新建」叙述（groupId），不是两条
    await t.repo.createAnchorWithNote({
      anchor: { documentVersionId: versionId, pageIndex: 0, rects: [[10, 70, 60, 90]] },
      note: { title: '随手记一', bodyMd: '这一页的想法' }
    })
    p = await panel(t.repo, 'week', { date: today })
    // 随手记一：合并为一条「新建」叙述（groupId），不是「新建+摘录」两条
    const noteItems = p.items.filter((i) => i.kind === 'note' && i.title === '随手记一')
    expect(noteItems).toHaveLength(1)
    expect(noteItems[0]).toMatchObject({ created: true, anchorCount: 1 })
    expect(noteItems[0].fromDocumentTitle).toBeTruthy()
    // 独立摘录仍按材料合并为一条 count=2；分组摘录不再单独出现
    const anchorItems = p.items.filter((i) => i.kind === 'anchors')
    expect(anchorItems).toHaveLength(1)
    expect(anchorItems[0]).toMatchObject({ anchorCount: 2 })
  })

  it('保存失败不产生事件；不存在笔记的保存抛错', async () => {
    await expect(t.repo.saveNote({ id: 'nonexistent', title: 'x', noteType: 'note', bodyMd: 'x', aliases: [], verifiedStatus: 'unchecked' })).rejects.toThrow()
    await flush()
    const events = JSON.parse(readFileSync(footprintPath(t.root), 'utf8')).events
    expect(events.filter((e: { noteId?: string }) => e.noteId === 'nonexistent')).toHaveLength(0)
  })

  it('外部直接改写笔记文件、重复扫描不产生事件', async () => {
    const before = JSON.parse(readFileSync(footprintPath(t.root), 'utf8')).events.length
    const note = await t.repo.createNote({ title: '外部改写', bodyMd: '初始' })
    await flush()
    const afterCreate = JSON.parse(readFileSync(footprintPath(t.root), 'utf8')).events.length
    expect(afterCreate).toBe(before + 1) // 只有本机新建那条

    // 绕过 Repo 直接改文件（模拟另一台设备同步进来），随后重扫
    const notesDir = join(t.root, '笔记')
    const { readdirSync } = await import('node:fs')
    const file = readdirSync(notesDir).find((f) => f.includes('外部改写'))
    expect(file).toBeTruthy()
    writeFileSync(join(notesDir, file!), readFileSync(join(notesDir, file!), 'utf8').replace('初始', '外部改动'))
    await t.library.rescanNow()
    expect((await t.repo.listNotes()).find((n) => n.id === note.id)).toBeTruthy()
    expect(JSON.parse(readFileSync(footprintPath(t.root), 'utf8')).events.length).toBe(afterCreate)
  })
})

describe('学习足迹：查询口径与历史边界', () => {
  it('周/月去重：范围内同笔记多日修改按 noteId 去重；新建吸收其修改；跨月不计入本周', async () => {
    const t2 = await makeTestRepo('mathwb-activity2-')
    try {
      const now = new Date()
      const keyOf = (d: Date): string => localDateKey(d)
      const yesterday = keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
      // fixture 日期与「今天几号」无关，否则月初/月中会漂移：上月 8 日必然在本月与本周之外
      //（本周起点最早只回溯 6 天），上月 15 日供历史直查且不与 note-c 同日
      const prevMonth8 = keyOf(new Date(now.getFullYear(), now.getMonth() - 1, 8))
      const prevMonth15 = keyOf(new Date(now.getFullYear(), now.getMonth() - 1, 15))
      const mk = (id: string, kind: string, date: string): Record<string, unknown> => ({
        id: `${id}-${kind}-${date}`, kind, at: `${date}T10:00:00.000Z`, date, noteId: id, title: `n-${id}`, spaceId: null
      })
      seedEvents(t2.root, [
        mk('note-a', 'note-created', today), // 新建放今天：今天必然落在周/月范围内，不受周一/月初影响
        mk('note-a', 'note-updated', today),
        mk('note-b', 'note-updated', yesterday), // 多日去重：昨天是否落在周/月内不影响按 noteId 去重后的计数
        mk('note-b', 'note-updated', today),
        mk('note-c', 'note-updated', prevMonth8),
        mk('note-d', 'note-created', prevMonth15)
      ])
      t2.repo.ensureActivity()
      const week = t2.repo.activityPanel({ range: 'week', date: today })
      expect(week.summary.created).toBe(1) // note-a（今天新建）；note-b 无新建事件
      expect(week.summary.updated).toBe(1) // note-a 的今日修改被新建吸收 → 只剩 note-b（两日去重一条）
      expect(week.items.find((i) => i.noteId === 'note-b')?.title).toBe('n-note-b')
      const month = t2.repo.activityPanel({ range: 'month', date: today })
      expect(month.summary.created).toBe(1)
      expect(month.summary.updated).toBe(1) // note-c 在上月，不计入本月
      // 历史直查：按月/日取上月活动（items 是 date 当日明细，只含 note-d）
      const lastMonthPanel = t2.repo.activityPanel({ range: 'month', month: prevMonth15.slice(0, 7), date: prevMonth15 })
      expect(lastMonthPanel.items).toHaveLength(1)
      expect(lastMonthPanel.items[0]).toMatchObject({ noteId: 'note-d', created: true })
      // 已删除对象：索引无 note-a → 明确标记，不产生可跳转条目
      expect(week.items.find((i) => i.noteId === 'note-a')?.deleted).toBe(true)
    } finally {
      t2.dispose()
    }
  })

  it('历史月份口径：anchor 让摘要与对象统计跟随指定月份，而不是今天', async () => {
    const t4 = await makeTestRepo('mathwb-activity4-')
    try {
      const now = new Date()
      const keyOf = (d: Date): string => localDateKey(d)
      const prev15 = keyOf(new Date(now.getFullYear(), now.getMonth() - 1, 15))
      const prev16 = keyOf(new Date(now.getFullYear(), now.getMonth() - 1, 16))
      seedEvents(t4.root, [
        { id: 'p1', kind: 'note-created', at: `${prev15}T10:00:00.000Z`, date: prev15, noteId: 'note-p', title: 'n-p', spaceId: null },
        { id: 'p2', kind: 'note-updated', at: `${prev16}T10:00:00.000Z`, date: prev16, noteId: 'note-q', title: 'n-q', spaceId: null },
        { id: 'p3', kind: 'reader-session', at: `${prev16}T11:00:00.000Z`, date: prev16, documentId: 'doc-1', title: '材料一', seconds: 600, pages: 5, spaceId: null }
      ])
      t4.repo.ensureActivity()
      // anchor 指向上月：摘要与对象统计都是上月口径
      const panel = t4.repo.activityPanel({ range: 'month', month: prev15.slice(0, 7), anchor: prev15 })
      expect(panel.rangeStart).toBe(`${prev15.slice(0, 7)}-01`)
      expect(panel.summary.created).toBe(1)
      expect(panel.summary.updated).toBe(1)
      expect(panel.summary.readMinutes).toBe(10)
      expect(panel.summary.readPages).toBe(5)
      expect(panel.objects.find((o) => o.id === 'note-p')?.created).toBe(true)
      expect(panel.objects.find((o) => o.id === 'doc-1')?.reads).toBe(1)
      // 缺省 anchor=今天：同一批事件不落入本月摘要
      const current = t4.repo.activityPanel({ range: 'month', month: prev15.slice(0, 7) })
      expect(current.summary.created).toBe(0)
      expect(current.summary.updated).toBe(0)
      // anchor 也支持周口径：上月 15 日落在其所在周范围内
      const weekAnchor = t4.repo.activityPanel({ range: 'week', anchor: prev15 })
      expect(weekAnchor.rangeStart <= prev15 && weekAnchor.rangeEnd >= prev15).toBe(true)
      expect(weekAnchor.summary.created).toBe(1)
    } finally {
      t4.dispose()
    }
  })

  it('学习区按事件时快照过滤：移动笔记不改写过去足迹', async () => {
    const t3 = await makeTestRepo('mathwb-activity3-')
    try {
      const space = await t3.repo.createSpace({ name: '随机分析', kind: 'research' })
      seedEvents(t3.root, [{ id: 'e1', kind: 'note-created', at: `${today}T09:00:00.000Z`, date: today, noteId: 'note-x', title: '旧文', spaceId: space.id }])
      t3.repo.ensureActivity()
      const inSpace = t3.repo.activityPanel({ range: 'week', date: today, spaceId: space.id })
      expect(inSpace.summary.created).toBe(1)
      const allSpaces = t3.repo.activityPanel({ range: 'week', date: today, spaceId: undefined })
      expect(allSpaces.summary.created).toBe(1)
      const unfiled = t3.repo.activityPanel({ range: 'week', date: today, spaceId: null })
      expect(unfiled.summary.created).toBe(0)
    } finally {
      t3.dispose()
    }
  })

  it('阅读会话按会话聚合；太短的会话不计；对象级统计与热力图有权重', async () => {
    const t6 = await makeTestRepo('mathwb-activity6-')
    try {
      const userDir = join(t6.root, 'user-files')
      mkdirSync(userDir, { recursive: true })
      const user = join(userDir, 'read-doc.pdf')
      writeFileSync(user, Buffer.from('%PDF-1.4\nread-session\n'))
      const [doc] = await t6.repo.importDocuments([user])
      // 打开又关掉（5 秒、没翻页）不算学习：连足迹文件都不该出现
      t6.repo.recordReaderSession({ documentId: doc.documentId!, pages: 0, seconds: 5 })
      await flush()
      const eventsOf = (): Array<Record<string, unknown>> => {
        try {
          return JSON.parse(readFileSync(footprintPath(t6.root), 'utf8')).events
        } catch {
          return []
        }
      }
      expect(eventsOf().filter((e) => e.kind === 'reader-session')).toHaveLength(0)

      t6.repo.recordReaderSession({ documentId: doc.documentId!, pages: 4, seconds: 600 })
      t6.repo.recordReaderSession({ documentId: doc.documentId!, pages: 2, seconds: 300 })
      await flush()
      expect(eventsOf().filter((e) => e.kind === 'reader-session')).toHaveLength(2)
      const p = t6.repo.activityPanel({ range: 'week', date: today })
      expect(p.summary.readMinutes).toBe(15)
      expect(p.summary.readPages).toBe(6)
      const read = p.items.find((i) => i.kind === 'read')
      expect(read).toMatchObject({ reads: 2, pages: 6, seconds: 900 })
      const obj = p.objects.find((o) => o.kind === 'document')
      expect(obj).toMatchObject({ reads: 2, readMinutes: 15, pages: 6, deleted: false })
      expect(p.heat.find((h) => h.date === today)!.weight).toBeGreaterThan(0)
      // 不存在的文档：静默忽略，不产生事件
      t6.repo.recordReaderSession({ documentId: 'no-such-doc', pages: 3, seconds: 120 })
      await flush()
      expect(eventsOf().filter((e) => e.kind === 'reader-session')).toHaveLength(2)
    } finally {
      t6.dispose()
    }
  })

  it('墨迹与知识块自评计入；自评状态不变不重复计', async () => {
    const t7 = await makeTestRepo('mathwb-activity7-')
    try {
      const body = '## 块\n<!-- block:b1 -->\n\n内容'
      const note = await t7.repo.createNote({ title: '自评笔记', bodyMd: body })
      const save = (learning: Parameters<typeof t7.repo.saveNote>[0]['learning']): Promise<unknown> =>
        t7.repo.saveNote({ id: note.id, title: '自评笔记', noteType: 'note', bodyMd: body, aliases: [], verifiedStatus: 'unchecked', learning })
      await save({ activeId: 'b1', records: { b1: { status: 'question', fingerprint: 'f1' } } })
      await save({ activeId: 'b1', records: { b1: { status: 'question', fingerprint: 'f1' } } })
      await save({ activeId: 'b1', records: { b1: { status: 'understood', fingerprint: 'f1' } } })
      await flush()
      const events = JSON.parse(readFileSync(footprintPath(t7.root), 'utf8')).events.filter((e: { kind: string }) => e.kind === 'block-reviewed')
      expect(events).toHaveLength(2)
      const p = t7.repo.activityPanel({ range: 'week', date: today })
      expect(p.summary.reviews).toBe(2)
      expect(p.items.find((i) => i.kind === 'review')).toMatchObject({ questions: 1, understands: 1 })
      expect(p.objects.find((o) => o.kind === 'note')).toMatchObject({ questions: 1, understands: 1 })
    } finally {
      t7.dispose()
    }
  })

  it('schema 2 旧文件宽容读取：旧事件不丢，写回升级为 3', async () => {
    const t8 = await makeTestRepo('mathwb-activity8-')
    try {
      seedEvents(t8.root, [{ id: 'old-1', kind: 'note-created', at: `${today}T08:00:00.000Z`, date: today, noteId: 'note-old', title: '旧事件', spaceId: null }])
      t8.repo.ensureActivity()
      const p = t8.repo.activityPanel({ range: 'week', date: today })
      expect(p.summary.created).toBe(1)
      expect(p.items[0]).toMatchObject({ noteId: 'note-old', created: true })
      await t8.repo.createNote({ title: '触发写回', bodyMd: 'x' })
      await flush()
      const fm = JSON.parse(readFileSync(footprintPath(t8.root), 'utf8'))
      expect(fm.schema).toBe(3)
      expect(fm.events.some((e: { id: string }) => e.id === 'old-1')).toBe(true)
    } finally {
      t8.dispose()
    }
  })

  it('ensure 启用日：旧库首次运行为当下，不补造历史', async () => {
    const t4 = await makeTestRepo('mathwb-activity4-')
    try {
      expect(existsSync(footprintPath(t4.root))).toBe(false)
      t4.repo.ensureActivity()
      const fm = JSON.parse(readFileSync(footprintPath(t4.root), 'utf8'))
      expect(fm.schema).toBe(3)
      expect(fm.events).toEqual([])
      expect(Date.parse(fm.startedAt)).not.toBeNaN()
      // 幂等：再次 ensure 不重置 startedAt
      t4.repo.ensureActivity()
      const again = JSON.parse(readFileSync(footprintPath(t4.root), 'utf8'))
      expect(again.startedAt).toBe(fm.startedAt)
      // 损坏文件：备份为 .broken 并重建，不抛出
      writeFileSync(footprintPath(t4.root), '{broken json')
      const t5 = await makeTestRepo('mathwb-activity5-')
      try {
        writeFileSync(footprintPath(t5.root), '{broken json')
        expect(() => t5.repo.ensureActivity()).not.toThrow()
        expect(existsSync(`${footprintPath(t5.root)}.broken`)).toBe(true)
        expect(t5.repo.activityPanel({ range: 'week', date: today }).items).toEqual([])
      } finally {
        t5.dispose()
      }
    } finally {
      t4.dispose()
    }
  })
})
