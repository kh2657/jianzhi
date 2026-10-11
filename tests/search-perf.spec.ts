// 检索性能基准（2026-10-09 阶段 3，architecture §15）：
//   固定 1,000 条文献 + 1,000 篇笔记（每篇约 5KB），≥30 次固定查询，输出冷/热 P50/P95。
//   断言：热查询（建库后重复执行）P95 ≤ 100ms（查询发出至结果到达，不含输入防抖）。
//   这是门禁不是摆设——性能回归会让 CI 变红。冷查询只记录不设阈值（首次含扫描/缓存预热）。
import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import type { Repo } from '../src/main/storage/repo'
import { atomicWriteJson } from '../src/main/storage/fsutil'

const NOTE_COUNT = 1000
const ENTRY_COUNT = 1000
const NOTE_TARGET_CHARS = 5000

/** 约 5KB 的笔记正文：8 个知识块，散布目标词与填充文本 */
function noteBody(i: number): string {
  const filler = '本段展开推导与例子，记录思路与反例，方便回忆上下文与定位。'.repeat(18)
  const blocks = ['紧性条件', '收敛子列', '弱辨识方向', '参数敏感方向', '正则化强度', '存在性证明', '唯一性讨论', '数值稳定']
    .map((h, k) => `## ${h} ${i}\n第 ${k} 块：${filler}\n结论：第 ${i} 篇笔记的 ${h} 讨论完毕。`)
  return `引言：这是第 ${i} 篇学习笔记，用于检索性能基准。\n\n${blocks.join('\n\n')}`
}

let bench: { t: TestRepo; repo: Repo; noteChars: number } | null = null
async function bigBench(): Promise<{ t: TestRepo; repo: Repo; noteChars: number }> {
  if (bench) return bench
  const t = await makeTestRepo('mathwb-perf-')
  let noteChars = 0
  for (let i = 0; i < NOTE_COUNT; i++) {
    const body = noteBody(i)
    noteChars += body.length
    await t.repo.createNote({ title: `基准笔记 ${i}`, bodyMd: body, spaceId: null })
  }
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  for (let d = 0; d < ENTRY_COUNT; d++) {
    const dir = join(t.root, '文献库', '待整理', `B${String(d).padStart(4, '0')}`)
    mkdirSync(dir, { recursive: true })
    const sha = createHash('sha256').update(String(d)).digest('hex')
    const iso = new Date(base + d * 1000).toISOString()
    await atomicWriteJson(join(dir, 'entry.json'), {
      schema: 2,
      id: `10000000-0000-4000-8000-${String(d).padStart(12, '0')}`,
      docType: 'paper',
      title: d % 4 === 0 ? `Heston 校准研究 ${d}` : `批量文献 ${d}`,
      authors: [`作者${d % 7}`],
      year: d % 10 === 0 ? 2020 + (d % 5) : null,
      venue: d % 3 === 0 ? 'Annals' : null,
      doi: null,
      arxivId: null,
      abstract: null,
      tags: [`标签${d % 5}`],
      spaceId: null,
      status: 'ok',
      note: '',
      files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: iso }],
      readingState: null,
      createdAt: iso,
      updatedAt: iso
    })
  }
  bench = { t, repo: await t.reopen(), noteChars }
  return bench
}
afterAll(() => {
  bench?.t.dispose()
  bench = null
})

/** P50/P95（最近邻秩统计：小样本足够看量级） */
function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

const LIB_QUERIES = ['Heston 校准', '标签3', '', '作者:作者3'] as const
const NOTE_QUERIES = ['收敛子列 唯一性', '紧性'] as const
const ROUNDS = 9 // (4 + 2) × 9 = 54 次固定查询 ≥ 30

describe('检索性能基准（1000 文献 + 1000 笔记）', () => {
  it('热查询 P95 ≤ 100ms；冷/热分位数输出供报告', async () => {
    const { repo, noteChars } = await bigBench()

    const suite = async (name: string, run: () => unknown | Promise<unknown>): Promise<void> => {
      const cold = await timed(run) // 冷：建库后第一次
      const hot: number[] = []
      for (let r = 1; r < ROUNDS; r++) hot.push(await timed(run))
      const p50 = percentile(hot, 0.5)
      const p95 = percentile(hot, 0.95)
      console.log(`[search-perf] ${name} · 冷 ${cold.toFixed(2)}ms · 热 P50 ${p50.toFixed(2)}ms / P95 ${p95.toFixed(2)}ms（n=${hot.length}）`)
      expect(p95).toBeLessThanOrEqual(100)
    }

    for (const q of LIB_QUERIES) await suite(`librarySearch "${q || '（空）'}"`, () => repo.librarySearch({ q }))
    for (const q of NOTE_QUERIES) await suite(`search "${q}"`, () => repo.search(q))
    console.log(`[search-perf] 语料：${ENTRY_COUNT} 条文献 + ${NOTE_COUNT} 篇笔记，笔记正文合计 ${noteChars} 字符（约 ${(noteChars / 1024 / 1024).toFixed(1)}MB）`)
  }, 600000)
})

async function timed(run: () => unknown | Promise<unknown>): Promise<number> {
  const t0 = performance.now()
  await run()
  return performance.now() - t0
}
