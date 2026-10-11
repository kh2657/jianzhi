import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicWriteFile, atomicWriteJson, sanitizeName, slugFor } from '../src/main/storage/fsutil'
import {
  DIR_CAPTURES,
  DIR_ENTRIES,
  DIR_NOTES,
  FILE_ANCHORS,
  FILE_ENTRY,
  SECTION_INBOX,
  parseNoteMarkdown,
  serializeNoteMarkdown,
  type NoteFrontMatter
} from '../src/main/storage/folder-index'
import { FolderStore } from '../src/main/storage/folder-store'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mathwb-kernel-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

function makeEntryMeta(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: 2,
    id: '11111111-1111-4111-8111-111111111111',
    docType: 'paper',
    title: 'Attention Is All You Need',
    authors: ['Vaswani'],
    year: 2017,
    venue: 'NeurIPS',
    doi: null,
    arxivId: null,
    abstract: null,
    tags: ['transformer'],
    spaceId: null,
    status: 'ok',
    note: null,
    files: [
      {
        sha256: 'a'.repeat(64),
        name: 'attention.pdf',
        mediaType: 'application/pdf',
        byteSize: 123,
        pageCount: null,
        fingerprint: null,
        importedAt: '2026-10-07T00:00:00.000Z'
      }
    ],
    readingState: null,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    ...overrides
  }
}

function writeEntry(section: string, dirName: string, meta: unknown, anchors: unknown = []): string {
  const dir = join(root, DIR_ENTRIES, section, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, FILE_ENTRY), JSON.stringify(meta))
  writeFileSync(join(dir, FILE_ANCHORS), JSON.stringify(anchors))
  return dir
}

describe('存储内核：扫描与索引', () => {
  it('空库扫描创建骨架目录', async () => {
    const store = new FolderStore(root)
    await store.scan()
    expect(existsSync(join(root, DIR_ENTRIES, SECTION_INBOX))).toBe(true)
    expect(existsSync(join(root, DIR_NOTES))).toBe(true)
    expect(existsSync(join(root, DIR_CAPTURES))).toBe(true)
    expect(store.index.entries.size).toBe(0)
    expect(store.index.spaces).toEqual([])
  })

  it('entry.json 被索引：分区名、sha 映射、锚点', async () => {
    const store = new FolderStore(root)
    writeEntry(SECTION_INBOX, 'Attention-2017', makeEntryMeta(), [
      { id: 'anchor-1', fileSha: 'a'.repeat(64), pageIndex: 0, pageLabel: null, rects: [[1, 2, 3, 4]], quote: '引文', createdAt: '2026-10-07T00:00:00.000Z' }
    ])
    await store.scan()
    const entry = store.index.entries.get('11111111-1111-4111-8111-111111111111')
    expect(entry).toBeDefined()
    expect(entry!.section).toBe(SECTION_INBOX)
    expect(entry!.anchors).toHaveLength(1)
    expect(store.index.shaToEntryFile.get('a'.repeat(64))?.entryId).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('重命名条目文件夹/换分区后身份不变（铁律 1）', async () => {
    const store = new FolderStore(root)
    const dir = writeEntry(SECTION_INBOX, '旧名', makeEntryMeta())
    await store.scan()
    const id = '11111111-1111-4111-8111-111111111111'
    expect(store.index.entries.get(id)?.dirRel).toContain('旧名')

    const newDir = join(root, DIR_ENTRIES, '随机分析', '新名')
    mkdirSync(join(root, DIR_ENTRIES, '随机分析'), { recursive: true })
    renameDir(dir, newDir)
    await store.scan()
    const moved = store.index.entries.get(id)
    expect(moved).toBeDefined()
    expect(moved!.section).toBe('随机分析')
    expect(moved!.meta.title).toBe('Attention Is All You Need')
  })

  it('坏 entry.json 记入 malformed 不拖垮扫描', async () => {
    const store = new FolderStore(root)
    const badDir = join(root, DIR_ENTRIES, SECTION_INBOX, '坏条目')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, FILE_ENTRY), '{ 不是 json')
    writeEntry(SECTION_INBOX, '好条目', makeEntryMeta())
    await store.scan()
    expect(store.index.entries.size).toBe(1)
    expect(store.index.malformed.some((m) => m.includes('坏条目'))).toBe(true)
  })

  it('分区根的散装 PDF 记为 unfiled', async () => {
    const store = new FolderStore(root)
    mkdirSync(join(root, DIR_ENTRIES, '随机分析'), { recursive: true })
    writeFileSync(join(root, DIR_ENTRIES, '随机分析', '散装论文.pdf'), '%PDF-1.4 fake')
    await store.scan()
    expect(store.index.unfiled).toHaveLength(1)
    expect(store.index.unfiled[0].fileName).toBe('散装论文.pdf')
  })
})

describe('存储内核：笔记编解码', () => {
  const fm: NoteFrontMatter = {
    schema: 2,
    id: '22222222-2222-4222-8222-222222222222',
    noteType: 'concept',
    title: '弱辨识性',
    aliases: ['weak identifiability'],
    verifiedStatus: 'unchecked',
    spaceId: null,
    revision: 3,
    sources: [{ kind: 'anchor', id: 'anchor-1', documentId: '11111111-1111-4111-8111-111111111111' }],
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z'
  }

  it('front-matter 往返无损，正文含 --- 不受干扰', () => {
    const body = '第一行\n\n---\n\n正文里的分隔线\n$$E=mc^2$$'
    const text = serializeNoteMarkdown(fm, body)
    const parsed = parseNoteMarkdown(text)!
    expect(parsed.fm).toEqual(fm)
    expect(parsed.bodyMd).toBe(body)
  })

  it('无 front-matter 的文件返回 null', () => {
    expect(parseNoteMarkdown('就是普通文本')).toBeNull()
  })

  it('非法 noteType 回退 note', () => {
    const parsed = parseNoteMarkdown(serializeNoteMarkdown({ ...fm, noteType: 'bogus' as never }, '正文'))!
    expect(parsed.fm.noteType).toBe('note')
  })
})

describe('存储内核：原子写', () => {
  it('覆盖写成功且不留临时文件', async () => {
    const file = join(root, 'sub', 'data.json')
    await atomicWriteJson(file, { v: 1 })
    await atomicWriteJson(file, { v: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 2 })
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(join(root, 'sub')).filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('原子写文本', async () => {
    const file = join(root, 'note.md')
    await atomicWriteFile(file, '内容')
    expect(readFileSync(file, 'utf8')).toBe('内容')
  })
})

describe('存储内核：冲突检测与名字净化', () => {
  it('iCloud 冲突副本命名被识别', async () => {
    const store = new FolderStore(root)
    writeEntry(SECTION_INBOX, '正常条目', makeEntryMeta())
    mkdirSync(join(root, DIR_NOTES), { recursive: true })
    writeFileSync(join(root, DIR_NOTES, '笔记 (冲突的副本 2026-10-07).md'), 'x')
    await store.scan()
    expect(store.index.conflicts).toHaveLength(1)
    expect(store.index.conflicts[0].pattern).toBe('冲突')
  })

  it('以 conflict 为题的学术文献不误报', async () => {
    const store = new FolderStore(root)
    writeEntry(SECTION_INBOX, 'Conflict and Controversy', makeEntryMeta({ title: 'Conflict and Controversy' }))
    await store.scan()
    expect(store.index.conflicts).toHaveLength(0)
  })

  it('名字净化替换非法字符', () => {
    expect(sanitizeName('a/b:c*d?"<>|')).toBe('a b c d')
    expect(sanitizeName('   ')).toBe('未命名')
    expect(slugFor('弱辨识性 研究')).toBe('弱辨识性-研究')
  })

  it('名字净化去掉首尾点：纯点名字会指向父目录（路径穿越），末尾点在 Windows 上会被静默丢弃', () => {
    // `..`/`.`/`...` 若原样保留，join(库根,'文献库',name) 会落到库根甚至上一级
    expect(sanitizeName('..')).toBe('未命名')
    expect(sanitizeName('.')).toBe('未命名')
    expect(sanitizeName('...')).toBe('未命名')
    expect(sanitizeName(' .. ')).toBe('未命名')
    // 末尾点：Windows 建目录时被丢弃，内存名与磁盘名会不一致
    expect(sanitizeName('a.')).toBe('a')
    expect(sanitizeName('a. ')).toBe('a')
    // 开头点：扫描器把它当隐藏目录跳过，分区栏里会看不见
    expect(sanitizeName('.隐藏')).toBe('隐藏')
    // 中间的点（版本号、章节号）必须保留
    expect(sanitizeName('3.1 节')).toBe('3.1 节')
    expect(sanitizeName('v1.2.3')).toBe('v1.2.3')
  })
})

describe('存储内核：变化事件', () => {
  it('watch 模式下外部写入触发 change 事件', async () => {
    const store = new FolderStore(root)
    await store.scan()
    const kindsSeen: string[][] = []
    store.onChange((kinds) => kindsSeen.push(kinds))
    store.startWatch()
    try {
      writeEntry(SECTION_INBOX, '外部新增', makeEntryMeta())
      await vi.waitFor(
        () => {
          expect(kindsSeen.some((k) => k.includes('entries'))).toBe(true)
        },
        // 15s：全量并行（40+ worker）时 fs.watch 事件 + 300ms 防抖扫描会被负载拖后，
        // 5s 窗口曾在基线复跑中抖动失败（隔离复跑 3/3 通过）。这里放宽的是等待上限，
        // 断言的仍是「外部写入最终必须进索引并发事件」这条语义。
        { timeout: 15000, interval: 100 }
      )
    } finally {
      store.stopWatch()
    }
  })

  it('无变化的重扫不发事件', async () => {
    const store = new FolderStore(root)
    writeEntry(SECTION_INBOX, '稳定条目', makeEntryMeta())
    await store.scan()
    const kindsSeen: string[][] = []
    store.onChange((kinds) => kindsSeen.push(kinds))
    await store.scan()
    await store.scan()
    expect(kindsSeen).toHaveLength(0)
  })
})

function renameDir(from: string, to: string): void {
  // Windows 上 fs.renameSync 跨目录同盘移动即可
  renameSync(from, to)
}
