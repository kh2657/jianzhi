// WP-6 性能探针（非门禁，打印数字）：增量扫描 vs 冷启动全量，以及「保存后重扫」的真实代价。
// 对照基线（WP-0 全量扫描，本机 APFS）：300 条 46ms / 1500 条 190ms / 3000 条 415ms。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FolderStore } from '../src/main/storage/folder-store'
import { atomicWriteJson } from '../src/main/storage/fsutil'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

const iso = (d: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + d * 1000).toISOString()

async function buildLibrary(t: TestRepo, count: number): Promise<void> {
  for (let d = 0; d < count; d++) {
    const dir = join(t.root, '文献库', '待整理', `P${String(d).padStart(4, '0')}`)
    mkdirSync(dir, { recursive: true })
    const sha = createHash('sha256').update(String(d)).digest('hex')
    await atomicWriteJson(join(dir, 'entry.json'), {
      schema: 2, id: `00000000-0000-4000-8000-${String(d).padStart(12, '0')}`, docType: 'paper',
      title: `标题 ${d}`, authors: [`作者${d % 3}`], year: null, venue: null, doi: null, arxivId: null,
      abstract: null, tags: [`标签${d % 2}`], spaceId: null, status: 'ok', note: '',
      files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: iso(d) }],
      readingState: null, createdAt: iso(d), updatedAt: iso(d)
    })
    const derived = join(dir, 'derived')
    mkdirSync(derived, { recursive: true })
    writeFileSync(join(derived, 'fulltext.txt'), `entry ${d} `.repeat(400))
  }
}

describe('扫描性能（增量 vs 全量）', () => {
  it('各量级的冷启动 / 空转重扫 / 单条保存后重扫', async () => {
    const rows: string[] = []
    for (const count of [300, 1500, 3000]) {
      const t: TestRepo = await makeTestRepo(`wp6-perf${count}-`)
      try {
        await buildLibrary(t, count)

        const t0 = performance.now()
        const store = new FolderStore(t.root)
        await store.scan()
        const coldMs = performance.now() - t0
        const coldReads = store.lastScanStats.filesRead

        const t1 = performance.now()
        await store.scan()
        const warmMs = performance.now() - t1
        const warmReads = store.lastScanStats.filesRead

        // 改一条笔记 + 改一个条目（模拟一次保存）→ 重扫
        const noteFile = join(t.root, '笔记', 'perf-note.md')
        mkdirSync(join(t.root, '笔记'), { recursive: true })
        writeFileSync(noteFile, '---\nschema: 2\nid: 22222222-2222-4222-8222-222222222222\nnoteType: note\ntitle: 性能笔记\naliases: []\nverifiedStatus: unchecked\nspaceId: null\nrevision: 1\nsources: []\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\n正文')
        await store.scan()
        const firstNoteReads = store.lastScanStats.filesRead
        const t2 = performance.now()
        await store.scan()
        const idleMs = performance.now() - t2
        const idleReads = store.lastScanStats.filesRead

        rows.push(
          `${count} 条目：冷启动 ${coldMs.toFixed(0)}ms(${coldReads} 次读盘) · 空转重扫 ${warmMs.toFixed(0)}ms(${warmReads} 次) · ` +
          `新增一条笔记后 ${idleMs.toFixed(0)}ms(${idleReads} 次) · 首次计入该笔记时 ${firstNoteReads} 次`
        )
        expect(store.lastScanStats.filesRead).toBe(0) // 空转重扫必须零读盘
        store.stopWatch()
      } finally { t.dispose() }
    }
    console.log('[wp6-perf]\n' + rows.join('\n'))
  }, 300000)
})