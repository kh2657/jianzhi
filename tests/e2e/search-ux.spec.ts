// WP-3 端到端：检索可信 ——
//  ① 260 条库可完整浏览（首屏 200 + 「加载更多」补足）；
//  ② 笔记多词 AND（两词不相邻也命中）；
//  ③ 命中理由（哪个字段 + 上下文）在结果行可见。
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

const iso = (d: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + d * 1000).toISOString()

/** 预置 N 个条目（直接写库文件，启动即被扫描；避免 260 次导入 IPC） */
function seedEntries(userData: string, n: number, extra?: (dir: string, index: number) => void): void {
  const inbox = join(userData, 'library', '文献库', '待整理')
  for (let d = 0; d < n; d++) {
    const name = `P${String(d).padStart(3, '0')}`
    const dir = join(inbox, name)
    mkdirSync(dir, { recursive: true })
    const sha = createHash('sha256').update(String(d)).digest('hex')
    const meta = {
      schema: 2, id: `00000000-0000-4000-8000-${String(d).padStart(12, '0')}`, docType: 'paper',
      title: `批量条目 ${d}`, authors: [`作者${d % 3}`], year: null, venue: null, doi: null, arxivId: null,
      abstract: d === 7 ? '这篇讨论正则化方法的稳定性与参数辨识性。' : null,
      // 2026-10-09 范围：自由词只搜标题/标签——「参数辨识性」放标签里供命中理由断言
      tags: d === 7 ? ['参数辨识性'] : [], spaceId: null, status: 'ok', note: '',
      files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: iso(d) }],
      readingState: null, createdAt: iso(d), updatedAt: iso(d)
    }
    writeFileSync(join(dir, 'entry.json'), JSON.stringify(meta, null, 2))
    extra?.(dir, d)
  }
}

test('文献库：260 条可完整浏览（首批 200 + 加载更多补足）', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-search-'))
  seedEntries(userData, 260)
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 启动默认视图是笔记；文献库列表断言在文献视图
    await navigateTo(page, '文献')
    // 首屏：200 行 + 计数与「加载更多」
    await expect(page.locator('.material-row')).toHaveCount(200, { timeout: 30000 })
    await expect(page.locator('.list-more button')).toContainText('已显示 200 / 共 260')
    await page.locator('.list-more button').click()
    await expect(page.locator('.material-row')).toHaveCount(260, { timeout: 15000 })
    await expect(page.locator('.list-more')).toHaveCount(0) // 已完整
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('⌘K 全局搜索：一个入口同时搜文献 / 笔记，可直接跳转', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-search3-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    // 真实 PDF（给标签命中用）+ 一条命中同一关键词的笔记。
    // 2026-10-09 范围（architecture §15）：文献组只搜标题/标签，PDF 正文不再参与
    await page.evaluate(async (path: string) => {
      const [imp] = await window.api.docImport([path], { docType: 'book' })
      await window.api.libraryEntryUpdate(imp.documentId!, { tags: ['THEOREM'] })
      await window.api.noteCreate({ title: 'THEOREM 笔记', bodyMd: '关于 THEOREM 的记录。' })
    }, join(process.cwd(), 'fixtures', 'text-basic.pdf'))
    await page.reload()
    // 等库视图就绪（重载后立刻按键可能早于监听挂载，按键会被丢掉）
    await navigateTo(page, '文献')
    await expect(page.locator('.doc-item', { hasText: 'text-basic' })).toBeVisible({ timeout: 20000 })

    await page.keyboard.press(`${mod}+k`)
    const palette = page.locator('.cmdk')
    await expect(palette).toBeVisible({ timeout: 15000 })
    await palette.locator('input').fill('THEOREM')
    // 内容结果分组：文献（标签命中）与笔记
    await expect(palette.getByText('文献', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(palette.locator('.cmdk-item-label', { hasText: 'THEOREM 笔记' })).toBeVisible({ timeout: 15000 })
    const libItem = palette.locator('.cmdk-item-label', { hasText: 'text-basic' })
    await expect(libItem).toBeVisible()
    await expect(palette.locator('.cmdk-item-hint', { hasText: '标签' })).toBeVisible()

    // 点文献结果 → 直接打开阅读器
    await libItem.click()
    await expect(page.getByLabel('随手记内容')).toBeVisible({ timeout: 20000 })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('检索：多词 AND 与命中理由在界面上可见', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-search2-'))
  seedEntries(userData, 12) // 其中「批量条目 7」的摘要含「正则化 / 参数辨识性」
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 两条笔记：一条正文里两词不相邻；一条只含一个词
    await page.evaluate(async () => {
      await window.api.noteCreate({ title: '参数辨识笔记', bodyMd: '本文讨论正则化方法；附录给出参数辨识性的证明。' })
      await window.api.noteCreate({ title: '只谈正则化', bodyMd: '这篇只谈正则化。' })
    })
    await page.reload()
    await navigateTo(page, '笔记')
    const search = page.getByLabel('搜索笔记')
    await search.fill('正则化 参数辨识')
    await expect(page.locator('.note-item', { hasText: '参数辨识笔记' })).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.note-item', { hasText: '只谈正则化' })).toHaveCount(0)

    // 命中理由：文献库里搜标签词 → 行内出现「标签」标签与上下文（2026-10-09 范围：标题/标签）
    await navigateTo(page, '文献')
    const libSearch = page.getByLabel('检索文献')
    await libSearch.fill('参数辨识性')
    const row = page.locator('.material-row', { hasText: '批量条目 7' })
    await expect(row.locator('.doc-snippet .tag')).toHaveText('标签', { timeout: 15000 })
    await expect(row.locator('.doc-snippet-text')).toContainText('参数辨识性')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

// 2026-10-09（architecture §15）：笔记检索按知识块分组，点击块命中定位到对应小节；⌘F 笔记内查找
test('笔记检索分组与块定位：块命中行可点，打开后到达对应小节；⌘F 笔记内查找', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-search4-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.evaluate(async () => {
      await window.api.noteCreate({
        title: '紧性笔记',
        bodyMd: '引言：先回忆紧性的动机。\n\n## 紧性条件\n利用紧性条件提取收敛子列。\n\n## 参数敏感方向\n弱辨识方向可能导致参数不稳定。'
      })
      await window.api.noteCreate({ title: '只谈正则化', bodyMd: '这篇只谈正则化。' })
    })
    await page.reload()
    await navigateTo(page, '笔记')
    const search = page.getByLabel('搜索笔记')
    await search.fill('紧性 弱辨识')
    // 分组行：同笔记一条结果 + 块命中摘要（含命中位置标题）
    const hitCard = page.locator('.note-hit', { hasText: '紧性笔记' })
    await expect(hitCard).toBeVisible({ timeout: 15000 })
    await expect(hitCard.locator('.note-hit-block', { hasText: '参数敏感方向' })).toBeVisible()
    await expect(hitCard.locator('.note-hit-block', { hasText: '紧性条件' })).toBeVisible()
    await expect(page.locator('.note-item', { hasText: '只谈正则化' })).toHaveCount(0)

    // 点击块命中 → 打开笔记并定位到对应小节（h2 在视口内）
    await hitCard.locator('.note-hit-block', { hasText: '参数敏感方向' }).click()
    await expect(page.getByLabel('笔记正文')).toBeVisible({ timeout: 20000 })
    const targetHeading = page.locator('.note-preview h2', { hasText: '参数敏感方向' })
    await expect(targetHeading).toBeVisible({ timeout: 15000 })
    await expect(targetHeading).toBeInViewport({ timeout: 15000 })

    // ⌘F 笔记内查找：命中计数 + Enter 下一处（只读定位，不改笔记）
    await page.keyboard.press(`${mod}+f`)
    const findBar = page.locator('.note-find')
    await expect(findBar).toBeVisible({ timeout: 15000 })
    await findBar.locator('input').fill('紧性')
    await expect(findBar.locator('.find-count')).toContainText('个匹配', { timeout: 15000 })
    await findBar.getByLabel('下一个匹配').click()
    await expect(findBar.locator('.find-count')).toContainText('2 /', { timeout: 15000 })
    await findBar.getByLabel('关闭查找').click()
    await expect(findBar).toHaveCount(0)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})