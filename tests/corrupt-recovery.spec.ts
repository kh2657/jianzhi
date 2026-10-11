import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { DIR_ENTRIES, FILE_ANCHORS, FILE_ENTRY, FILE_WORKSPACE, SECTION_INBOX } from '../src/main/storage/folder-index'

/**
 * 坏文件的处置：用户创作内容（锚点 / 墨迹 / 精读卡 / 条目元数据）解析失败时，
 * 必须先把坏文件备份为 `.broken` 再回退默认值。
 *
 * 只回退默认值是不够的——这些文件都按「整份替换」写回，坏文件被当成空内容后，
 * 用户下一次操作就会覆盖它，原内容永久消失。settings / 足迹 / 分区 一直有这个备份，
 * 这几类反而没有，正是数据丢失的来源。
 */
let t: TestRepo
let repo: TestRepo['repo']

beforeAll(async () => {
  t = await makeTestRepo('mathwb-corrupt-')
  repo = t.repo
})

afterAll(() => {
  t?.dispose()
})

/**
 * 造一份材料，返回它在磁盘上的条目目录与版本 id。
 * 必须用**不同**的夹具：导入按内容 sha256 去重，同一份 PDF 第二次导入会返回既有条目。
 */
async function makeEntry(name: string, fixture: string): Promise<{ dir: string; versionId: string; documentId: string }> {
  const src = join(t.root, `${name}.pdf`)
  copyFileSync(join('fixtures', fixture), src)
  const [result] = await repo.importDocuments([src])
  const documentId = result.documentId!
  return { dir: entryDirOf(documentId), versionId: result.versionId!, documentId }
}

/** 按 entry.json 里的 id 定位条目目录（不依赖目录命名规则） */
function entryDirOf(documentId: string): string {
  const inbox = join(t.root, DIR_ENTRIES, SECTION_INBOX)
  for (const dirent of readdirSync(inbox, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const dir = join(inbox, dirent.name)
    const entryFile = join(dir, FILE_ENTRY)
    if (!existsSync(entryFile)) continue
    const meta = JSON.parse(readFileSync(entryFile, 'utf8')) as { id?: string }
    if (meta.id === documentId) return dir
  }
  throw new Error(`找不到条目目录：${documentId}`)
}

const CORRUPT = '{ 这不是合法 JSON'

describe('锚点文件损坏', () => {
  it('备份为 .broken、按空处理，且后续写入不会吞掉坏文件', async () => {
    const { dir, versionId } = await makeEntry('anchor', 'text-basic.pdf')
    await repo.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [[10, 10, 60, 30]] })
    expect(repo.listPageAnchors(versionId, 0)).toHaveLength(1)

    // 模拟同步工具把文件写坏（截断/乱码）
    writeFileSync(join(dir, FILE_ANCHORS), CORRUPT)

    // 重扫：坏文件进 .broken，内存里按「没有锚点」处理
    const reopened = await t.reopen()
    expect(existsSync(join(dir, `${FILE_ANCHORS}.broken`))).toBe(true)
    expect(readFileSync(join(dir, `${FILE_ANCHORS}.broken`), 'utf8')).toBe(CORRUPT)
    expect(reopened.listPageAnchors(versionId, 0)).toHaveLength(0)

    // 用户接着画一条新摘录：anchors.json 被重写，但坏文件仍在 .broken 里可查
    await reopened.createAnchor({ documentVersionId: versionId, pageIndex: 0, rects: [[20, 20, 80, 40]] })
    expect(readFileSync(join(dir, `${FILE_ANCHORS}.broken`), 'utf8')).toBe(CORRUPT)
    expect(reopened.listPageAnchors(versionId, 0)).toHaveLength(1)
  })
})

describe('墨迹文件损坏', () => {
  it('备份为 .broken 并返回空笔画', async () => {
    const { dir, versionId } = await makeEntry('ink', 'cropped.pdf')
    await repo.saveInk(versionId, 0, [{ k: 'pen', c: '#000000', w: 2, pts: [[1, 2], [3, 4]] }])
    expect(repo.inkGet(versionId, 0)).toHaveLength(1)

    const inkFile = join(dir, 'ink', versionId.slice(0, 8), 'p0.json')
    writeFileSync(inkFile, CORRUPT)

    expect(repo.inkGet(versionId, 0)).toHaveLength(0)
    expect(readFileSync(`${inkFile}.broken`, 'utf8')).toBe(CORRUPT)

    // 再写一笔：坏文件不会被静默覆盖掉
    await repo.saveInk(versionId, 0, [{ k: 'pen', c: '#000000', w: 2, pts: [[5, 6], [7, 8]] }])
    expect(readFileSync(`${inkFile}.broken`, 'utf8')).toBe(CORRUPT)
    expect(repo.inkGet(versionId, 0)).toHaveLength(1)
  })
})

describe('精读卡文件损坏', () => {
  it('备份为 .broken 并返回空现场', async () => {
    const { dir, documentId } = await makeEntry('workspace', 'links.pdf')
    const saved = repo.readingWorkspaceGet(documentId)
    await repo.readingWorkspaceSave({ ...saved, coreQuestion: '这个方法为什么成立？' })
    expect(repo.readingWorkspaceGet(documentId).coreQuestion).toBe('这个方法为什么成立？')

    writeFileSync(join(dir, FILE_WORKSPACE), CORRUPT)

    const after = repo.readingWorkspaceGet(documentId)
    expect(after.coreQuestion).toBe('')
    expect(after.sections).toHaveLength(5)
    expect(readFileSync(join(dir, `${FILE_WORKSPACE}.broken`), 'utf8')).toBe(CORRUPT)
  })
})

describe('条目元数据损坏', () => {
  it('备份为 .broken（条目因此从索引消失，但文件本身可人工恢复）', async () => {
    const { dir } = await makeEntry('entry', 'rotated-90.pdf')
    writeFileSync(join(dir, FILE_ENTRY), CORRUPT)
    await t.reopen()
    expect(existsSync(join(dir, `${FILE_ENTRY}.broken`))).toBe(true)
    expect(readFileSync(join(dir, `${FILE_ENTRY}.broken`), 'utf8')).toBe(CORRUPT)
  })
})

describe('正常路径不产生 .broken', () => {
  it('文件不存在时静默按空处理', async () => {
    const { dir, versionId } = await makeEntry('clean', 'scanned.pdf')
    expect(repo.inkGet(versionId, 3)).toEqual([])
    expect(existsSync(join(dir, 'ink'))).toBe(false)
    expect(existsSync(join(dir, `${FILE_ANCHORS}.broken`))).toBe(false)
    expect(existsSync(join(dir, `${FILE_WORKSPACE}.broken`))).toBe(false)
  })
})
