// WP-2.3 / D6：散装文件一键导入（白名单式路径校验；原件处置由调用方决定，repo 不依赖 electron）。
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

describe('散装文件导入 importUnfiled', () => {
  it('清单内的文件可导入：新条目落在「待整理」并返回原件绝对路径', async () => {
    const t: TestRepo = await makeTestRepo('wp23-unfiled-')
    try {
      copyFileSync('fixtures/text-basic.pdf', join(t.root, '文献库', '待整理', '手动放入.pdf'))
      const repo2 = await t.reopen()
      const hit = repo2.libraryDiagnostics().unfiled.find((u) => u.fileName === '手动放入.pdf')!
      const { result, absPath } = await repo2.importUnfiled(hit.fileRel)
      expect(result.ok).toBe(true)
      expect(result.duplicate).toBe(false)
      expect(result.documentId).toBeTruthy()
      expect(absPath).toBe(join(t.root, '文献库', '待整理', '手动放入.pdf'))
      expect(existsSync(absPath)).toBe(true) // repo 不动原件（处置交给调用方）

      const repo3 = await t.reopen()
      const doc = repo3.listDocuments().find((d) => d.id === result.documentId)
      expect(doc).toBeTruthy()
      expect(doc!.title).toBe('手动放入')
      // repo 不动原件 → 原件仍在原地，因此仍显示为「未入库文件」；
      // 生产路径由 IPC 层在导入成功后把它移入系统废纸篓（E2E 覆盖）
      expect(repo3.libraryDiagnostics().unfiled.some((u) => u.fileName === '手动放入.pdf')).toBe(true)
    } finally { t.dispose() }
  }, 60000)

  it('不在清单里的路径一律拒绝（白名单式校验，防任意路径导入）', async () => {
    const t: TestRepo = await makeTestRepo('wp23-guard-')
    try {
      await expect(t.repo.importUnfiled('文献库/待整理/不存在.pdf')).rejects.toThrow('不在待处理清单')
      await expect(t.repo.importUnfiled('../../etc/hosts')).rejects.toThrow('不在待处理清单')
      await expect(t.repo.importUnfiled('')).rejects.toThrow('不在待处理清单')
    } finally { t.dispose() }
  }, 60000)

  it('内容已在库中：返回 duplicate，不建新条目（调用方据此保留原件）', async () => {
    const t: TestRepo = await makeTestRepo('wp23-dup-')
    try {
      const [first] = await t.repo.importDocuments(['fixtures/text-basic.pdf'], { docType: 'book' })
      copyFileSync('fixtures/text-basic.pdf', join(t.root, '文献库', '待整理', '重复副本.pdf'))
      const repo2 = await t.reopen()
      const hit = repo2.libraryDiagnostics().unfiled.find((u) => u.fileName === '重复副本.pdf')!
      const { result } = await repo2.importUnfiled(hit.fileRel)
      expect(result.ok).toBe(true)
      expect(result.duplicate).toBe(true)
      expect(result.documentId).toBe(first.documentId)
      expect(repo2.listDocuments()).toHaveLength(1)
    } finally { t.dispose() }
  }, 60000)
})