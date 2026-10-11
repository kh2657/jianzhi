import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { parseNoteMarkdown, serializeNoteMarkdown } from '../src/main/storage/folder-index'

let t: TestRepo

beforeAll(async () => {
  t = await makeTestRepo('mathwb-fwd-')
})

afterAll(() => {
  t?.dispose()
})

/**
 * 前向兼容（P1-4）：用户双机跑新旧版本时，旧版本保存不得剥掉新版本写入的未知字段。
 * 模拟方式：磁盘文件里写入「未来版本」的未知键 → 本版本扫描/编辑/写回 → 未知键仍在。
 */
describe('entry.json 未知字段前向兼容', () => {
  it('外部写入的未来字段在编辑写回后保留', async () => {
    const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
    const entryId = imp.documentId!
    const dirAbs = t.library.index.entries.get(entryId)!.dirAbs

    // 「未来版本 v2.1」在 entry.json 写入本版本不认识的字段
    const raw = JSON.parse(readFileSync(join(dirAbs, 'entry.json'), 'utf8'))
    raw.futureField = { aiSummary: '……', embedding: [1, 2, 3] }
    raw.anotherFuture = 'vNext'
    writeFileSync(join(dirAbs, 'entry.json'), JSON.stringify(raw, null, 2))
    await t.library.rescanNow()

    // 本版本正常编辑（改名触发完整写回）
    await t.repo.updateDocument(entryId, { title: '弱辨识性研究（本版本编辑）' })

    // 未知字段仍在磁盘上（改名后文件夹路径从索引重取）
    const after = JSON.parse(readFileSync(join(t.library.index.entries.get(entryId)!.dirAbs, 'entry.json'), 'utf8'))
    expect(after.futureField).toEqual({ aiSummary: '……', embedding: [1, 2, 3] })
    expect(after.anotherFuture).toBe('vNext')
    // 已知字段正常
    expect(after.title).toBe('弱辨识性研究（本版本编辑）')
    expect(after.schema).toBe(2)
  })

  it('重启（重新扫描）后未知字段仍随写回保留', async () => {
    const [imp] = await t.repo.importDocuments(['fixtures/scanned.pdf'], { docType: 'paper' })
    const entryId = imp.documentId!
    const dirAbs = t.library.index.entries.get(entryId)!.dirAbs
    const raw = JSON.parse(readFileSync(join(dirAbs, 'entry.json'), 'utf8'))
    raw.kindOfDay = 'future-metadata'
    writeFileSync(join(dirAbs, 'entry.json'), JSON.stringify(raw))

    const repo2 = await t.reopen()
    await repo2.updateEntryMeta(entryId, { tags: ['标'], status: 'ok' })
    const after = JSON.parse(readFileSync(join(dirAbs, 'entry.json'), 'utf8'))
    expect(after.kindOfDay).toBe('future-metadata')
    expect(after.tags).toEqual(['标'])
  })
})

describe('笔记 front-matter 未知字段前向兼容', () => {
  it('serialize→parse→serialize 往返保留未知键，已知键以当前为准', () => {
    const base = {
      schema: 2 as const,
      id: '33333333-3333-4333-8333-333333333333',
      noteType: 'concept' as const,
      title: '弱收敛',
      aliases: [] as string[],
      verifiedStatus: 'unchecked' as const,
      spaceId: null,
      revision: 1,
      sources: [],
      createdAt: '2026-10-07T00:00:00.000Z',
      updatedAt: '2026-10-07T00:00:00.000Z'
    }
    const withFuture = serializeNoteMarkdown(base, '正文', { aiHint: 'future-note-data', priority: 5 })
    const parsed = parseNoteMarkdown(withFuture)!
    expect(parsed.extra).toEqual({ aiHint: 'future-note-data', priority: 5 })
    // 本版本编辑后写回：未知键仍在，已知键更新
    parsed.fm.revision = 2
    const rewritten = serializeNoteMarkdown(parsed.fm, parsed.bodyMd, parsed.extra)
    const reparsed = parseNoteMarkdown(rewritten)!
    expect(reparsed.extra).toEqual({ aiHint: 'future-note-data', priority: 5 })
    expect(reparsed.fm.revision).toBe(2)
  })

  it('真实仓库：外部给笔记 md 加未知 front-matter 键 → 保存笔记 → 键保留', async () => {
    const note = await t.repo.createNote({ title: '前向兼容笔记', bodyMd: '内容' })
    const fileAbs = t.library.index.notes.get(note.id)!.fileAbs
    const text = readFileSync(fileAbs, 'utf8')
    writeFileSync(fileAbs, text.replace(/^---\n/, '---\nfutureNoteKey: 来自未来版本\n'))
    await t.library.rescanNow()

    await t.repo.saveNote({
      id: note.id,
      title: '前向兼容笔记',
      noteType: 'note',
      bodyMd: '更新后的内容',
      aliases: [],
      verifiedStatus: 'unchecked'
    })
    const after = readFileSync(fileAbs, 'utf8')
    expect(after).toContain('futureNoteKey: 来自未来版本')
    expect(after).toContain('更新后的内容')
  })
})
