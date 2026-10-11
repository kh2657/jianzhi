// 速记（纯文本捕获）的存储契约。磁盘布局：收件箱/速记/<yyyyMMdd-HHmmss>-<id8>.md
// （YAML front-matter + 正文即捕获内容）。锁定的不变量与笔记同源：
//   1) 先写盘、成功后才提交内存索引——写失败不留幻影；
//   2) 坏文件收进 malformed，不拖垮整库扫描；未知 front-matter 键写回保留（前向兼容）；
//   3) 删除先把文件交给调用方移入废纸篓，失败则速记仍在；
//   4) 未变化的文件不重读（增量扫描）。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { readonly, writable } from './helpers/readonly-dir'

const memoDir = (root: string): string => join(root, '收件箱', '速记')
const memoFiles = (root: string): string[] => {
  try {
    return readdirSync(memoDir(root)).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
}
const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('速记：捕获即落盘', () => {
  it('createMemo 写出规范名 .md（front-matter + 正文原样），reopen 后一致', async () => {
    const t: TestRepo = await makeTestRepo('memo-create-')
    try {
      const text = '用特征代价构造正则项\n$$R(x)=\\psi(x_2-x_1)$$\n含冒号: 与 # 号、[[双链]]'
      const rec = await t.repo.createMemo({ text })
      const files = memoFiles(t.root)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}\.md$/)
      expect(files[0]).toContain(rec.id.slice(0, 8))
      const raw = readFileSync(join(memoDir(t.root), files[0]), 'utf8')
      expect(raw).toContain(`id: ${rec.id}`)
      expect(raw).toContain('inboxStatus: inbox')
      // 未标记待办时不落 todo 键：不给文件凭空加字段（往返无损）
      expect(raw).not.toContain('todo')
      expect(rec.todo).toBe(false)
      expect(rec.inboxStatus).toBe('inbox')
      expect(rec.spaceId).toBe(null)

      const repo2 = await t.reopen()
      const after = repo2.listMemos()
      expect(after).toHaveLength(1)
      expect(after[0].id).toBe(rec.id)
      expect(after[0].text).toBe(text)
    } finally {
      t.dispose()
    }
  }, 60000)

  it('`!` / 全角 `！` 前缀 → todo=true，且标记本身不落正文', async () => {
    const t: TestRepo = await makeTestRepo('memo-todo-')
    try {
      const a = await t.repo.createMemo({ text: '! 周三前看完 2401.12345' })
      const b = await t.repo.createMemo({ text: '！买牛奶' })
      const c = await t.repo.createMemo({ text: '想法：先证凸性' })
      expect([a.text, a.todo]).toEqual(['周三前看完 2401.12345', true])
      expect([b.text, b.todo]).toEqual(['买牛奶', true])
      expect([c.text, c.todo]).toEqual(['想法：先证凸性', false])
      const repo2 = await t.reopen()
      expect(repo2.listMemos().find((m) => m.id === a.id)!.todo).toBe(true)
      expect(repo2.listMemos().find((m) => m.id === c.id)!.todo).toBe(false)
    } finally {
      t.dispose()
    }
  }, 60000)

  it('空内容、只有标记、超长内容一律拒绝且不落文件', async () => {
    const t: TestRepo = await makeTestRepo('memo-invalid-')
    try {
      await expect(t.repo.createMemo({ text: '   ' })).rejects.toThrow('速记内容不能为空')
      await expect(t.repo.createMemo({ text: '!' })).rejects.toThrow('速记内容不能为空')
      await expect(t.repo.createMemo({ text: 'x'.repeat(20001) })).rejects.toThrow('速记过长')
      expect(memoFiles(t.root)).toHaveLength(0)
      expect(t.repo.listMemos()).toHaveLength(0)
    } finally {
      t.dispose()
    }
  }, 60000)

  it('写盘失败：reject，索引里不留幻影；恢复后重试成功', async () => {
    const t: TestRepo = await makeTestRepo('memo-writefail-')
    const dir = memoDir(t.root)
    try {
      mkdirSync(dir, { recursive: true })
      readonly(dir)
      await expect(t.repo.createMemo({ text: '磁盘满了怎么办' })).rejects.toThrow()
      writable(dir)
      expect(t.repo.listMemos()).toHaveLength(0)
      expect(t.library.index.memos.size).toBe(0)
      expect(memoFiles(t.root)).toHaveLength(0)

      const rec = await t.repo.createMemo({ text: '磁盘满了怎么办' })
      expect(rec.text).toBe('磁盘满了怎么办')
      expect(memoFiles(t.root)).toHaveLength(1)
    } finally {
      writable(dir)
      t.dispose()
    }
  }, 60000)
})

describe('速记：列表、保存、删除、转笔记', () => {
  it('listMemos 按 createdAt 倒序，并按处理状态过滤', async () => {
    const t: TestRepo = await makeTestRepo('memo-list-')
    try {
      const a = await t.repo.createMemo({ text: '第一条' })
      await nap(5)
      const b = await t.repo.createMemo({ text: '第二条' })
      expect(t.repo.listMemos().map((m) => m.id)).toEqual([b.id, a.id])
      await t.repo.saveMemo(a.id, { inboxStatus: 'filed' })
      expect(t.repo.listMemos(undefined, 'inbox').map((m) => m.id)).toEqual([b.id])
      expect(t.repo.listMemos(undefined, 'filed').map((m) => m.id)).toEqual([a.id])
      expect(t.repo.listMemos().map((m) => m.id)).toEqual([b.id, a.id])
    } finally {
      t.dispose()
    }
  }, 60000)

  it('saveMemo 改文本/状态/待办后落盘，reopen 仍是新值；取消待办则键消失', async () => {
    const t: TestRepo = await makeTestRepo('memo-save-')
    try {
      const rec = await t.repo.createMemo({ text: '原始想法' })
      const fileOf = (): string => join(memoDir(t.root), memoFiles(t.root)[0])
      await t.repo.saveMemo(rec.id, { text: '改后的想法\n第二行', inboxStatus: 'filed', todo: true })
      expect(readFileSync(fileOf(), 'utf8')).toContain('todo: true')
      expect(readFileSync(fileOf(), 'utf8')).toContain('inboxStatus: filed')
      const repo2 = await t.reopen()
      const after = repo2.listMemos()[0]
      expect(after.text).toBe('改后的想法\n第二行')
      expect(after.inboxStatus).toBe('filed')
      expect(after.todo).toBe(true)
      await repo2.saveMemo(rec.id, { todo: false })
      expect(readFileSync(fileOf(), 'utf8')).not.toContain('todo')
      expect(memoFiles(t.root)).toHaveLength(1)
    } finally {
      t.dispose()
    }
  }, 60000)

  it('deleteMemo：trash 失败时速记仍在；成功才摘索引与文件', async () => {
    const t: TestRepo = await makeTestRepo('memo-delete-')
    try {
      const a = await t.repo.createMemo({ text: '要留下的' })
      const b = await t.repo.createMemo({ text: '要删掉的' })
      await expect(t.repo.deleteMemo(b.id, async () => { throw new Error('废纸篓不可用') })).rejects.toThrow('废纸篓不可用')
      expect(t.repo.listMemos().map((m) => m.id)).toContain(b.id)

      const trashed: string[] = []
      const result = await t.repo.deleteMemo(b.id, async (abs) => { trashed.push(abs); rmSync(abs); return true })
      expect(result.trashed).toBe(true)
      expect(trashed).toHaveLength(1)
      expect(existsSync(trashed[0])).toBe(false)
      expect(t.repo.listMemos().map((m) => m.id)).toEqual([a.id])
      const repo2 = await t.reopen()
      expect(repo2.listMemos().map((m) => m.id)).toEqual([a.id])
    } finally {
      t.dispose()
    }
  }, 60000)

  it('memoToNote：正文原样进笔记、标题取首行（可指定）、速记转为已归档', async () => {
    const t: TestRepo = await makeTestRepo('memo-tonote-')
    try {
      const body = '势函数想法\n\n用特征代价构造正则项。'
      const rec = await t.repo.createMemo({ text: body })
      const note = await t.repo.memoToNote(rec.id)
      expect(note.title).toBe('势函数想法')
      expect(t.repo.getNote(note.id).bodyMd).toBe(body)
      expect(t.repo.listMemos(undefined, 'filed').map((m) => m.id)).toEqual([rec.id])
      expect(t.repo.listMemos(undefined, 'inbox')).toHaveLength(0)

      const rec2 = await t.repo.createMemo({ text: '另一条' })
      const note2 = await t.repo.memoToNote(rec2.id, { title: '自定义标题' })
      expect(note2.title).toBe('自定义标题')
    } finally {
      t.dispose()
    }
  }, 60000)
})

describe('速记：外部文件容错与增量', () => {
  it('坏 front-matter 收进 malformed 不拖垮扫描；未知键写回保留', async () => {
    const t: TestRepo = await makeTestRepo('memo-tolerance-')
    try {
      const dir = memoDir(t.root)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bad-1.md'), '这不是 front-matter\n只有正文')
      const id = '11111111-2222-3333-4444-555555555555'
      writeFileSync(
        join(dir, 'future-2.md'),
        `---\nschema: 1\nid: ${id}\ninboxStatus: inbox\nspaceId: null\ncreatedAt: 2026-10-09T01:00:00.000Z\nupdatedAt: 2026-10-09T01:00:00.000Z\nfuture: 42\n---\n\n来自未来的速记`
      )
      await t.library.scan()
      expect(t.library.index.malformed.some((m) => m.includes('bad-1.md'))).toBe(true)
      expect(t.repo.listMemos().map((m) => m.id)).toEqual([id])
      expect(t.repo.listMemos()[0].text).toBe('来自未来的速记')

      await t.repo.saveMemo(id, { inboxStatus: 'filed' })
      const raw = readFileSync(join(dir, 'future-2.md'), 'utf8')
      expect(raw).toContain('future: 42')
      expect(raw).toContain('inboxStatus: filed')
    } finally {
      t.dispose()
    }
  }, 60000)

  it('外部新增的速记被扫描收进来；未变化时不重读文件', async () => {
    const t: TestRepo = await makeTestRepo('memo-incremental-')
    try {
      const dir = memoDir(t.root)
      mkdirSync(dir, { recursive: true })
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      writeFileSync(
        join(dir, '20261009-010101-aaaaaaaa.md'),
        `---\nschema: 1\nid: ${id}\ninboxStatus: inbox\nspaceId: null\ncreatedAt: 2026-10-09T01:01:01.000Z\nupdatedAt: 2026-10-09T01:01:01.000Z\n---\n\n外部写入的速记`
      )
      await t.library.scan()
      expect(t.repo.listMemos().map((m) => m.id)).toEqual([id])
      expect(t.library.lastScanStats.filesRead).toBe(1)

      await t.library.scan()
      expect(t.library.lastScanStats.filesRead).toBe(0)
      expect(t.repo.listMemos().map((m) => m.id)).toEqual([id])
    } finally {
      t.dispose()
    }
  }, 60000)
})

describe('速记：检索', () => {
  it('search() 命中速记正文（多词 AND），memosTotal 不受返回上限影响', async () => {
    const t: TestRepo = await makeTestRepo('memo-search-')
    try {
      await t.repo.createMemo({ text: '正则化与参数辨识的联系' })
      await t.repo.createMemo({ text: '只提正则化' })
      const one = t.repo.search('正则化')
      expect(one.memosTotal).toBe(2)
      expect(one.memos).toHaveLength(2)
      const both = t.repo.search('正则化 参数辨识')
      expect(both.memosTotal).toBe(1)
      expect(both.memos[0].snippet).toContain('正则化')
      const none = t.repo.search('不存在的词')
      expect(none.memos).toHaveLength(0)
      expect(none.memosTotal).toBe(0)
      // 空查询不炸
      expect(t.repo.search('   ').memosTotal).toBe(0)
    } finally {
      t.dispose()
    }
  }, 60000)
})
