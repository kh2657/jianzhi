import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitArxivId } from '../src/main/storage/repo'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { importDailyFolder, parseDailyManifest } from '../src/main/papers-daily'
import type { ArxivEntry } from '../src/main/papers'

describe('splitArxivId', () => {
  it('拆分基础 ID 与版本；旧式分类 ID 容错', () => {
    expect(splitArxivId('2601.12345v2')).toEqual({ base: '2601.12345', version: 'v2' })
    expect(splitArxivId('2601.12345')).toEqual({ base: '2601.12345', version: null })
    expect(splitArxivId(' math.AG/0309136 ')).toEqual({ base: 'math.AG/0309136', version: null })
  })
})

describe('parseDailyManifest 净化', () => {
  const entry = (over: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1, generatedAt: new Date().toISOString(), source: 't',
    items: [
      { provider: 'arxiv', providerId: '2601.11111', title: 'Good', authors: ['A'], abstract: 'x',
        publishedAt: '2026-10-05T00:00:00Z', ...over }
    ]
  })

  it('合法条目解析；PDF/abs URL 为官方地址', () => {
    const { entries, total } = parseDailyManifest(entry())
    expect(total).toBe(1)
    expect(entries[0].arxivId).toBe('2601.11111v1')
    expect(entries[0].pdfUrl).toBe('https://arxiv.org/pdf/2601.11111v1')
  })

  it('坏 ID / 坏 URL / 缺标题条目被跳过，不影响其他条目', () => {
    const raw = JSON.stringify({
      schemaVersion: 1, generatedAt: 'x', source: 't',
      items: [
        { provider: 'arxiv', providerId: 'bad-id', title: 'bad id' },
        { provider: 'arxiv', providerId: '2601.22222', title: 'ok', url: 'https://evil.example.com/x' },
        { provider: 'arxiv', providerId: '2601.33333', title: '' },
        { provider: 'arxiv', providerId: '2601.44444', title: 'good' }
      ]
    })
    const { entries, total } = parseDailyManifest(raw)
    expect(total).toBe(1)
    expect(entries[0].arxivId).toBe('2601.44444v1')
  })

  it('schemaVersion 不认识时报错；条目数超限报错', () => {
    expect(() => parseDailyManifest('{"schemaVersion":99,"items":[]}')).toThrow(/schemaVersion/)
    const big = JSON.stringify({ schemaVersion: 1, items: Array.from({ length: 201 }, () => ({ provider: 'arxiv', providerId: '2601.00001', title: 'x' })) })
    expect(() => parseDailyManifest(big)).toThrow(/上限/)
  })
})

describe('每日清单导入 + 基础 ID 身份（集成）', () => {
  let root: string
  let folder: string
  let repo: TestRepo['repo']
  const entry = (id: string, title: string): ArxivEntry => ({
    arxivId: id, title, authors: ['A'], abstract: 'abs', primaryCategory: 'math.AG',
    categories: ['math.AG'], publishedAt: new Date().toISOString(),
    pdfUrl: `https://arxiv.org/pdf/${id}`, absUrl: `https://arxiv.org/abs/${id}`
  })

  beforeAll(async () => {
    const t = await makeTestRepo('mathwb-daily-')
    root = t.root
    repo = t.repo
    folder = join(root, 'daily')
    mkdirSync(folder, { recursive: true })
    await repo.paperFeedCreate({ name: '泛函分析', categories: 'math.FA', keywords: '' })
    await repo.paperFeedCreate({ name: '算子代数', categories: 'math.OA', keywords: '' })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('清单导入：坏条目跳过、好条目入库、文件归档 imported/，重复投递幂等', async () => {
    writeFileSync(join(folder, 'day1.json'), JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'mailer',
      items: [
        { provider: 'arxiv', providerId: '2601.10001', title: '论文甲', authors: ['A'], abstract: '', publishedAt: '2026-10-05T00:00:00Z', matchedFeeds: ['泛函分析'] },
        { provider: 'arxiv', providerId: '2601.10002', title: '论文乙', authors: ['B'], abstract: '', publishedAt: '2026-10-05T00:00:00Z', matchedFeeds: ['不存在的订阅'] }
      ]
    }))
    const r1 = await importDailyFolder(repo, folder)
    expect(r1[0].error).toBeUndefined()
    expect(r1[0].imported).toBe(2)
    // 文件已归档
    const { existsSync, readdirSync } = await import('node:fs')
    expect(existsSync(join(folder, 'day1.json'))).toBe(false)
    expect(readdirSync(join(folder, 'imported')).some((f) => f.includes('day1.json'))).toBe(true)
    // 同一文件再次投递（同摘要）：不新增
    writeFileSync(join(folder, 'day1.json'), JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'mailer',
      items: [
        { provider: 'arxiv', providerId: '2601.10001', title: '论文甲', authors: ['A'], abstract: '', publishedAt: '2026-10-05T00:00:00Z', matchedFeeds: ['泛函分析'] },
        { provider: 'arxiv', providerId: '2601.10002', title: '论文乙', authors: ['B'], abstract: '', publishedAt: '2026-10-05T00:00:00Z', matchedFeeds: ['不存在的订阅'] }
      ]
    }))
    const r2 = await importDailyFolder(repo, folder)
    expect(r2[0].imported).toBe(0)
    expect(repo.paperList('new', 30).length).toBe(2)
  })

  it('同基础 ID 多订阅聚合：matches 多对多、feedNames 双来源', async () => {
    await repo.paperItemsUpsert(repo.paperFeedList()[0].id, [entry('2601.20001v1', '双来源论文')])
    await repo.paperItemsUpsert(repo.paperFeedList()[1].id, [entry('2601.20001v2', '双来源论文')])
    const got = repo.paperGetByBaseId('2601.20001')!
    expect(got.version).toBe('v2') // 未处理候选跟随新版本
    expect(got.feedNames.sort()).toEqual(['泛函分析', '算子代数'].sort())
    expect(repo.paperList('new', 30).filter((p) => p.baseId === '2601.20001')).toHaveLength(1) // 一个候选
  })

  it('已导入版本不被新版本替换；状态保留', async () => {
    const src = join(root, 'paper.pdf')
    copyFileSync(join('fixtures', 'text-basic.pdf'), src)
    const imp = await repo.importDocuments([src], { docType: 'paper' })
    await repo.paperMarkImported('2601.20001', imp[0].documentId!)
    expect(repo.paperGetByBaseId('2601.20001')!.status).toBe('imported')
    // 新版本推送：状态与 document_id 不变
    await repo.paperItemsUpsert(repo.paperFeedList()[0].id, [entry('2601.20001v3', '双来源论文')])
    const got = repo.paperGetByBaseId('2601.20001')!
    expect(got.status).toBe('imported')
    expect(got.documentId).toBe(imp[0].documentId)
    writeFileSync(join(folder, 'ignored.json'), 'not json at all')
    const bad = await importDailyFolder(repo, folder)
    expect(bad[0].error).toBeTruthy()
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(folder, 'failed', 'ignored.json'))).toBe(true)
  })
})
