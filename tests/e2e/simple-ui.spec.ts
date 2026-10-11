import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, fixture, launchApp, layoutAudit, rmTempDir } from './helpers/launch'

test('材料搜索、笔记先写后命名、旧分类按需筛选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-simple-ui-'))
  const launched = await launchApp(dir)
  try {
    const { page } = launched
    const networkErrors: string[] = []
    // 只统计真实失败：导航/重载会取消在途请求，Chromium 记为 net::ERR_ABORTED，
    // 那是「取消」不是「加载失败」——算进来会让这条门禁在并行负载下随机变红
    page.on('requestfailed', request => {
      const reason = request.failure()?.errorText ?? ''
      if (reason.includes('ERR_ABORTED')) return
      networkErrors.push(`${reason} ${request.url()}`)
    })
    page.on('response', response => { if (response.status() >= 400) networkErrors.push(`${response.status()} ${response.url()}`) })
    await page.evaluate(async (path) => {
      const [doc] = await window.api.docImport([path])
      await window.api.docUpdate(doc.documentId!, { title: '泛函分析 · 第一章' })
      await window.api.noteCreate({ title: '定理 1：紧性', noteType: 'theorem', bodyMd: '已有笔记内容' })
    }, fixture('text-basic.pdf'))
    await page.reload()
    await navigateTo(page, '文献')
    await page.getByLabel('检索文献').fill('泛函')
    await expect(page.locator('.doc-item')).toHaveCount(1)
    await page.getByLabel('检索文献').fill('没有这份材料')
    await expect(page.locator('.doc-item')).toHaveCount(0)
    await expect(page.locator('.empty-title')).toHaveText('没有匹配的文献') // P3 改版文案
    await page.getByLabel('检索文献').fill('')
    await expect(page.locator('.doc-item')).toHaveCount(1)
    await navigateTo(page, '笔记')
    // 笔记类型筛选已收敛为视图内标签行
    const typeTabs = page.locator('.filter-tabs[aria-label=\"笔记类型\"]')
    await expect(typeTabs).toBeVisible()
    await expect(page.locator('.note-item .tag')).toHaveCount(0)
    await typeTabs.locator('.chip', { hasText: '定理' }).click()
    await expect(page.locator('.note-item', { hasText: '定理 1：紧性' })).toBeVisible()
    await typeTabs.locator('.chip', { hasText: '全部' }).click()
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await expect(page.getByRole('main').getByLabel('笔记类型')).toBeHidden()
    await page.getByLabel('笔记正文').fill('先把想法记下来，不用先选类型。')
    await page.getByLabel('笔记标题').fill('我自己的推论名字')
    await navigateTo(page, '笔记')
    await expect(page.locator('.note-item', { hasText: '我自己的推论名字' })).toBeVisible()
    const stored = await page.evaluate(async () => {
      const notes = await window.api.noteList()
      return window.api.noteGet(notes.find(note => note.title === '我自己的推论名字')!.id)
    })
    expect(stored.note.bodyMd).toBe('先把想法记下来，不用先选类型。')
    expect(stored.note.noteType).toBe('note')
    const legacy = await page.evaluate(async () => (await window.api.noteList()).find(note => note.title === '定理 1：紧性'))
    expect(legacy?.noteType).toBe('theorem')
    expect(launched.consoleErrors).toEqual([])
    expect(networkErrors).toEqual([])
  } finally {
    await launched.app.close()
    rmTempDir(dir)
  }
})

test('主界面、阅读与编辑在五种桌面宽度下可操作且无溢出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-simple-layout-'))
  const launched = await launchApp(dir)
  try {
    const { page } = launched
    await page.evaluate(async (path) => {
      const space = await window.api.spaceCreate({ name: '泛函分析', kind: 'course' })
      const [doc] = await window.api.docImport([path], { spaceId: space.id })
      await window.api.docUpdate(doc.documentId!, { title: '泛函分析 · 阅读与思考' })
      await window.api.noteCreate({ title: '读完这一页，我想到了什么', bodyMd: '先写下自己的理解，再回到原文核对。\n\n支持数学公式：$f(x)$。' })
    }, fixture('text-basic.pdf'))
    await page.reload()
    for (const size of [{ width: 1080, height: 720 }, { width: 1366, height: 768 }, { width: 1512, height: 982 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
      await page.setViewportSize(size)
      await navigateTo(page, '文献')
      await expect(page.locator('.workspace-tabs .nav-item[aria-label=\"文献\"]')).toHaveAttribute('aria-current', 'page')
      await expect(page.locator('.doc-item')).toBeVisible()
      expect(await layoutAudit(page, `library ${size.width}`)).toEqual([])
      if (size.width === 1512) await page.screenshot({ animations: 'disabled', path: 'docs/screenshots/simple-library-1512.png' })
      await page.locator('.doc-item').click()
      await expect(page.getByLabel('随手记内容')).toBeVisible()
      await expect(page.locator('.mnp-empty')).toBeVisible()
      await expect.poll(async () => Number(await page.locator('.page-wrap[data-page-index="0"]').getAttribute('data-render-seq'))).toBeGreaterThan(0)
      const geometry = await page.evaluate(() => {
        const source = document.querySelector('.page-scroll')!.getBoundingClientRect()
        const side = document.querySelector('.reader-side')!.getBoundingClientRect()
        return { sourceWidth: source.width, overlap: source.right > side.left + 1, sideOverflow: document.querySelector('.reader-side')!.scrollWidth > side.width + 1 }
      })
      expect(geometry.sourceWidth).toBeGreaterThan(300)
      expect(geometry.overlap).toBe(false)
      expect(geometry.sideOverflow).toBe(false)
      expect(await layoutAudit(page, `reader ${size.width}`)).toEqual([])
      if (size.width === 1512) await page.screenshot({ animations: 'disabled', path: 'docs/screenshots/simple-reader-1512.png' })
      await navigateTo(page, '笔记')
      await page.locator('.note-item').click()
      await expect(page.getByLabel('笔记正文')).toBeVisible()
      await expect(page.locator('.note-preview .katex')).toBeVisible()
      expect(await layoutAudit(page, `editor ${size.width}`)).toEqual([])
      if (size.width === 1512) await page.screenshot({ animations: 'disabled', path: 'docs/screenshots/simple-note-1512.png' })
    }
    expect(launched.consoleErrors).toEqual([])
  } finally {
    await launched.app.close()
    rmTempDir(dir)
  }
})
