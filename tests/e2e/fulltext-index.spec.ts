// WP-4 端到端：全文索引与导入路径解耦后，导入即建立索引（全页），扫描版标「无可提取文本」，
// 且「全文:」检索确实走新索引（修复前只有识别队列处理过的条目、且只索引前 5 页）。
import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, fixture, launchApp, rmTempDir } from './helpers/launch'

/** 在临时库的 文献库/ 下找某个条目的目录（按 entry.json 里的 title 匹配） */
function entryDirByTitle(userData: string, title: string): string | null {
  const root = join(userData, 'library', '文献库')
  for (const section of readdirSync(root, { withFileTypes: true })) {
    if (!section.isDirectory()) continue
    for (const item of readdirSync(join(root, section.name), { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const entryFile = join(root, section.name, item.name, 'entry.json')
      if (!existsSync(entryFile)) continue
      try {
        const meta = JSON.parse(readFileSync(entryFile, 'utf8')) as { title?: string }
        if (meta.title === title) return join(root, section.name, item.name)
      } catch { /* 跳过坏文件 */ }
    }
  }
  return null
}

test('全文索引：导入即建立（含页数信息），扫描版标为无可提取文本', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-ft-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 启动默认视图是笔记；检索与条目信息断言都在文献库视图
    await navigateTo(page, '文献')
    // 文本型 PDF：导入即入队索引（不再依赖识别队列 / needs-review 状态）
    await page.evaluate(async (path) => {
      await window.api.docImport([path], { docType: 'book' })
    }, fixture('text-basic.pdf'))

    await expect.poll(() => {
      const dir = entryDirByTitle(userData, 'text-basic')
      if (!dir) return 'no-entry'
      const ft = join(dir, 'derived', 'fulltext.txt')
      const meta = join(dir, 'derived', 'fulltext.meta.json')
      if (!existsSync(ft) || !existsSync(meta)) return 'indexing'
      return JSON.parse(readFileSync(meta, 'utf8')).status as string
    }, { timeout: 30000 }).toBe('ready')

    const dir = entryDirByTitle(userData, 'text-basic')!
    expect(readFileSync(join(dir, 'derived', 'fulltext.txt'), 'utf8')).toContain('THEOREM')
    const meta = JSON.parse(readFileSync(join(dir, 'derived', 'fulltext.meta.json'), 'utf8')) as { pages: number; pageCount: number | null }
    expect(meta.pageCount).toBe(3) // 全部页都被提取（上限之内）

    // 扫描版：标 empty 并给出原因（不伪装成已索引）
    await page.evaluate(async (path) => {
      await window.api.docImport([path], { docType: 'book' })
    }, fixture('scanned.pdf'))
    await expect.poll(() => {
      const d = entryDirByTitle(userData, 'scanned')
      if (!d) return 'no-entry'
      const m = join(d, 'derived', 'fulltext.meta.json')
      if (!existsSync(m)) return 'indexing'
      return JSON.parse(readFileSync(m, 'utf8')).status as string
    }, { timeout: 30000 }).toBe('empty')

    // 检索范围（2026-10-09，architecture §15）：正文不参与文献检索——
    // THEOREM 只在正文 → 自由词不命中；全文: 已废止并被明确拒绝（UI 显示错误提示）
    const libSearch = page.getByLabel('检索文献')
    await libSearch.fill('THEOREM')
    await expect(page.getByText('没有匹配的文献', { exact: false })).toBeVisible({ timeout: 15000 })
    await libSearch.fill('全文:THEOREM')
    await expect(page.getByText('标题和关键词搜索', { exact: false })).toBeVisible({ timeout: 15000 })

    // 条目信息弹窗显示索引状态（清空检索，让两条都在列表里）
    await libSearch.fill('')
    await expect(page.locator('.material-row', { hasText: 'scanned' })).toBeVisible({ timeout: 15000 })
    await page.locator('.material-row', { hasText: 'scanned' }).locator('.doc-info-btn').click()
    const dialog = page.locator('[role=dialog][aria-label=文献信息]')
    await expect(dialog).toContainText('全文索引：无可提取文本', { timeout: 15000 })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})