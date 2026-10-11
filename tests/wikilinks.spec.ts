import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseWikiLinks } from '../src/main/storage/repo'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

let t: TestRepo
let repo: TestRepo['repo']

beforeAll(async () => {
  t = await makeTestRepo('mathwb-wikilinks-')
  repo = t.repo
})

afterAll(() => {
  t?.dispose()
})

describe('[[链接]] 解析（纯函数）', () => {
  it('基本形态：目标、别名显示、混合', () => {
    const links = parseWikiLinks('见 [[拉格朗日中值定理]] 与 [[MVT|中值定理的别称]]。')
    expect(links).toHaveLength(2)
    expect(links[0]).toMatchObject({ target: '拉格朗日中值定理', display: '拉格朗日中值定理' })
    expect(links[1]).toMatchObject({ target: 'MVT', display: '中值定理的别称' })
  })

  it('代码块与行内代码中的 [[ 不解析', () => {
    const body = '```\n[[not-a-link]]\n```\n真实链接 [[yes]]，行内 `[[nope]]` 结束。'
    const links = parseWikiLinks(body)
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('yes')
  })

  it('空目标与畸形输入安全', () => {
    expect(parseWikiLinks('[[]] [[|x]] [[ ]]')).toEqual([])
    expect(parseWikiLinks('没有链接 [x] [[未闭合')).toEqual([])
  })
})

describe('双链反链（v2：扫描式即时解析，无存储边）', () => {
  let noteA = ''
  let noteB = ''
  let noteC = ''

  it('建立笔记；反链按标题与别名解析', async () => {
    const a = await repo.createNote({ title: '中值定理', noteType: 'theorem', bodyMd: '定理陈述。' })
    noteA = a.id
    await repo.saveNote({ id: noteA, title: '中值定理', noteType: 'theorem', bodyMd: '定理陈述。', aliases: ['MVT', 'Lagrange'], verifiedStatus: 'unchecked' })
    const b = await repo.createNote({ title: '证明尝试', bodyMd: '用到了 [[中值定理]] 与 [[MVT]]（别名链接）。' })
    noteB = b.id
    const c = await repo.createNote({ title: '反例收集', bodyMd: '[[不存在的话题]] 未解析；[[证明尝试]] 指向 B。' })
    noteC = c.id

    // B → A：标题与别名指向同一目标，来源笔记只出现一次
    const backsA = repo.noteBacklinks(noteA)
    expect(backsA.map((x) => x.fromNoteId)).toEqual([noteB])
    // C → B（A 的链接未解析不算）
    const backsB = repo.noteBacklinks(noteB)
    expect(backsB.map((x) => x.fromNoteId)).toEqual([noteC])
  })

  it('正文移除链接后反链消失', async () => {
    await repo.saveNote({ id: noteB, title: '证明尝试', noteType: 'note', bodyMd: '不引用任何东西了。', aliases: [], verifiedStatus: 'unchecked' })
    expect(repo.noteBacklinks(noteA).some((x) => x.fromNoteId === noteB)).toBe(false)
  })

  it('反链：标题与别名都命中，含上下文片段，排除自身', async () => {
    await repo.saveNote({ id: noteB, title: '证明尝试', noteType: 'proof', bodyMd: '证明的核心是 [[MVT]]，再结合连续性。', aliases: [], verifiedStatus: 'unchecked' })
    await repo.saveNote({ id: noteC, title: '反例收集', noteType: 'note', bodyMd: '参见 [[中值定理]] 的反例条件。', aliases: [], verifiedStatus: 'unchecked' })
    const backs = repo.noteBacklinks(noteA)
    expect(backs).toHaveLength(2)
    const byFrom = new Map(backs.map((x) => [x.fromNoteId, x]))
    expect(byFrom.get(noteB)?.snippet).toContain('[[MVT]]')
    expect(byFrom.get(noteC)?.fromNoteType).toBe('note')
    // 自链不算反链
    await repo.saveNote({ id: noteA, title: '中值定理', noteType: 'theorem', bodyMd: '自指 [[中值定理]] 不算。', aliases: ['MVT', 'Lagrange'], verifiedStatus: 'unchecked' })
    const backs2 = repo.noteBacklinks(noteA)
    expect(backs2.every((x) => x.fromNoteId !== noteA)).toBe(true)
  })

  it('链接索引包含标题与别名', () => {
    const idx = repo.noteLinkIndex()
    const a = idx.find((e) => e.id === noteA)!
    expect(a.aliases).toContain('Lagrange')
    expect(a.aliases).toContain('MVT')
  })

  it('重启（重新扫描）后反链持久', async () => {
    const repo2 = await t.reopen()
    const backs = repo2.noteBacklinks(noteA)
    expect(backs).toHaveLength(2) // B（经别名 MVT）与 C（经标题）
  })
})

describe('改名不断链：旧标题并入 aliases', () => {
  it('改标题后，指向旧标题的 [[链接]] 仍能解析', async () => {
    const target = await repo.createNote({ title: '旧标题', noteType: 'concept', bodyMd: '正文。' })
    const source = await repo.createNote({ title: '引用者', bodyMd: '见 [[旧标题]]。' })

    // 改名前：反链成立
    expect(repo.noteBacklinks(target.id).map((x) => x.fromNoteId)).toEqual([source.id])

    // 改名（编辑器会把当前 aliases 原样回传）
    const full = repo.getNoteFull(target.id)
    await repo.saveNote({
      id: target.id,
      title: '新标题',
      noteType: 'concept',
      bodyMd: full.note.bodyMd,
      aliases: full.note.aliases,
      verifiedStatus: full.note.verifiedStatus
    })

    // 旧标题进了 aliases，链接不断
    const after = repo.getNoteFull(target.id)
    expect(after.note.title).toBe('新标题')
    expect(after.note.aliases).toContain('旧标题')
    expect(repo.noteBacklinks(target.id).map((x) => x.fromNoteId)).toEqual([source.id])

    // 新标题同样可解析
    await repo.saveNote({
      id: source.id,
      title: '引用者',
      noteType: 'note',
      bodyMd: '见 [[新标题]]。',
      aliases: [],
      verifiedStatus: 'unchecked'
    })
    expect(repo.noteBacklinks(target.id).map((x) => x.fromNoteId)).toEqual([source.id])
  })

  it('重启后别名仍持久，链接继续可解析', async () => {
    const repo2 = await t.reopen()
    const target = repo2.listNotes().find((n) => n.title === '新标题')!
    expect(repo2.getNoteFull(target.id).note.aliases).toContain('旧标题')
  })

  it('标题没变时不重复追加别名', async () => {
    const note = await repo.createNote({ title: '稳定标题', noteType: 'concept', bodyMd: 'x' })
    const full = repo.getNoteFull(note.id)
    await repo.saveNote({ id: note.id, title: '稳定标题', noteType: 'concept', bodyMd: 'y', aliases: [], verifiedStatus: full.note.verifiedStatus })
    expect(repo.getNoteFull(note.id).note.aliases).toEqual([])
  })
})
