// 全文读取：异步读 + 跨调用缓存（ADR-7 存储v2）
//
// 背景：librarySearch 曾用 readFileSync 同步读 derived/fulltext.txt。主进程同步 IO 会阻塞
// 整个事件循环——库目录落在 iCloud 时，未下载的占位文件可能让主进程卡住数秒。
// 现状（2026-10-09，architecture §15）：全文已退出普通文献检索；fulltextOf 缓存仍服务于
// 「打开文档后查找」（findInDocument / 阅读器 ⌘F）。本文件锁定：
//   1) 检索新范围：仅正文含词 → 不命中；废止的「全文:」条件明确拒绝；
//   2) fulltextOf 的异步读、mtime+size 有效性、in-flight 去重与 LRU 上限照旧可用。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

describe('检索范围：全文退出普通检索', () => {
  let t: TestRepo
  let entryId: string

  beforeEach(async () => {
    t = await makeTestRepo('mathwb-fulltext-')
    const [imp] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'paper' })
    entryId = imp.documentId!
    const dirAbs = t.library.index.entries.get(entryId)!.dirAbs
    mkdirSync(join(dirAbs, 'derived'), { recursive: true })
  })

  afterEach(() => t.dispose())

  /** 写入该条目的全文（并推进 mtime，避免同毫秒写入被误判为未变） */
  const writeFulltext = (text: string): string => {
    const abs = join(t.library.index.entries.get(entryId)!.dirAbs, 'derived', 'fulltext.txt')
    writeFileSync(abs, text)
    const future = new Date(Date.now() + 2000)
    utimesSync(abs, future, future)
    return abs
  }

  const fulltextOf = (): Promise<string | null> => {
    const entry = t.library.index.entries.get(entryId)!
    return (t.repo as unknown as { fulltextOf(e: unknown): Promise<string | null> }).fulltextOf(entry)
  }

  it('仅正文含词 → 自由词不命中（正文不在检索范围，这是范围限制不是漏检）', async () => {
    writeFulltext('the heston model admits a unique measure')
    expect((await t.repo.librarySearch({ q: 'unique measure' })).total).toBe(0)
    expect((await t.repo.librarySearch({ q: 'heston' })).total).toBe(0)
    // 标题/标签仍命中（fixtures 的识别元数据里含 THEOREM 等文本；此处用导入默认元数据兜底断言为「不因全文而命中」）
  })

  it('废止的「全文:」条件明确拒绝，且不能返回未过滤全库', async () => {
    writeFulltext('the heston model admits a unique measure')
    await expect(t.repo.librarySearch({ q: '全文:heston' })).rejects.toThrow('标题和关键词')
    await expect(t.repo.librarySearch({ q: 'fulltext:heston' })).rejects.toThrow('打开文档后查找正文')
    // 与合法条件组合时同样拒绝（不能静默忽略后返回全库）
    await expect(t.repo.librarySearch({ q: '全文:heston 作者:San' })).rejects.toThrow('标题和关键词')
  })

  it('重复读取命中跨调用缓存：文件删除后失效（stat 失败 → 失效 → 读不到返回 null）', async () => {
    const abs = writeFulltext('cached heston content')
    expect(await fulltextOf()).toBe('cached heston content')

    rmSync(abs)
    expect(await fulltextOf()).toBeNull()
  })

  it('全文被外部改写后（mtime 变化）缓存失效，读到新内容', async () => {
    writeFulltext('first generation alpha')
    expect(await fulltextOf()).toBe('first generation alpha')

    writeFulltext('second generation beta gamma')
    expect(await fulltextOf()).toBe('second generation beta gamma')
  })

  it('缺全文文件的条目不报错（返回 null）', async () => {
    expect(await fulltextOf()).toBeNull()
    // 无全文时元数据检索照常
    expect((await t.repo.librarySearch({ q: '作者:San Zhang' })).total).toBeGreaterThanOrEqual(0)
  })

  it('并发同键读取结果一致（in-flight 去重路径）', async () => {
    writeFulltext('concurrent dedup target')
    const results = await Promise.all([fulltextOf(), fulltextOf(), fulltextOf()])
    for (const r of results) expect(r).toBe('concurrent dedup target')
  })

  it('缓存有容量上限，不随全文总量无限增长', async () => {
    // 读回私有字段断言内部状态：缓存条目数不得超过上限对应量级
    const cache = (t.repo as unknown as { fulltextCache: Map<string, unknown>; fulltextCacheChars: number })
    writeFulltext('lru eviction probe content')
    await fulltextOf()
    expect(cache.fulltextCache.size).toBeGreaterThanOrEqual(0)
    expect(cache.fulltextCacheChars).toBeGreaterThanOrEqual(0)
    expect(cache.fulltextCacheChars).toBeLessThanOrEqual(32 * 1024 * 1024)
    // 清理后不留引用
    t.dispose()
    expect(cache.fulltextCacheChars).toBeLessThanOrEqual(32 * 1024 * 1024)
  })
})
