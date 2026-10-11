// WP-1 / D4+D5：库诊断——坏文件与散装文件对用户可见（只读暴露，不自动修复用户文件）。
//
// 修复前的缺陷（复现见 WP-0 报告 A5/A6）：malformed 列表只存在于内存、无任何 UI 出口，
// 坏笔记/坏条目从列表静默消失；分区目录里的散装 PDF 被收集却无处可看。
// 本文件锁定契约：
//   - diagnostics 暴露 malformed 相对路径与 unfiled 清单；
//   - 笔记 .md 损坏**不搬移、不改写**（它是用户文档，应用不会覆盖它），修复后重扫即恢复；
//   - entry.json 等整份替换式 JSON 仍保持「先备份为 .broken 再回退」的既有铁律。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

describe('库诊断（只读暴露）', () => {
  it('坏笔记：进入 diagnostics.malformed；文件字节不变、不产生 .broken；修复即恢复', async () => {
    const t: TestRepo = await makeTestRepo('wp1-diag-')
    try {
      const n = await t.repo.createNote({ title: '会消失的笔记', bodyMd: '正文' })
      const fileAbs = t.library.index.notes.get(n.id)!.fileAbs
      const original = readFileSync(fileAbs, 'utf8')
      writeFileSync(fileAbs, '--- 这不是合法 front-matter')

      const repo2 = await t.reopen()
      const d = repo2.libraryDiagnostics()
      expect(d.malformed.some((p) => p.includes('会消失的笔记'))).toBe(true)
      expect(readFileSync(fileAbs, 'utf8')).toBe('--- 这不是合法 front-matter') // 不搬移、不改写
      expect(existsSync(`${fileAbs}.broken`)).toBe(false)

      // 用户修回原文件 → 重扫即恢复（不依赖任何自动修复）
      writeFileSync(fileAbs, original)
      const repo3 = await t.reopen()
      expect(repo3.listNotes().some((x) => x.id === n.id)).toBe(true)
      expect(repo3.libraryDiagnostics().malformed.some((p) => p.includes('会消失的笔记'))).toBe(false)
    } finally { t.dispose() }
  }, 60000)

  it('坏 entry.json：进入 malformed 且原件被备份为 .broken（既有行为不回退）', async () => {
    const t: TestRepo = await makeTestRepo('wp1-diag-entry-')
    try {
      const dir = join(t.root, '文献库', '待整理', '坏条目')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'entry.json'), '{ 这不是合法 JSON')

      const repo2 = await t.reopen()
      const d = repo2.libraryDiagnostics()
      expect(d.malformed.some((p) => p.includes('entry.json'))).toBe(true)
      expect(existsSync(join(dir, 'entry.json.broken'))).toBe(true)
      expect(readFileSync(join(dir, 'entry.json.broken'), 'utf8')).toBe('{ 这不是合法 JSON')
    } finally { t.dispose() }
  }, 60000)

  it('散装 PDF：进入 diagnostics.unfiled（含相对路径与字节数），且不产生幻影条目', async () => {
    const t: TestRepo = await makeTestRepo('wp1-diag-unfiled-')
    try {
      copyFileSync('fixtures/text-basic.pdf', join(t.root, '文献库', '待整理', '手动放入.pdf'))
      const repo2 = await t.reopen()
      const d = repo2.libraryDiagnostics()
      const hit = d.unfiled.find((u) => u.fileName === '手动放入.pdf')
      expect(hit).toBeTruthy()
      expect(hit!.byteSize).toBeGreaterThan(0)
      expect(hit!.fileRel).toContain('文献库')
      expect(repo2.listDocuments()).toHaveLength(0)
    } finally { t.dispose() }
  }, 60000)

  it('干净库：diagnostics 两个清单都为空（避免横幅常驻噪声）', async () => {
    const t: TestRepo = await makeTestRepo('wp1-diag-clean-')
    try {
      await t.repo.createNote({ title: '正常笔记', bodyMd: '正文' })
      const d = t.repo.libraryDiagnostics()
      expect(d.malformed).toEqual([])
      expect(d.unfiled).toEqual([])
    } finally { t.dispose() }
  }, 60000)
})