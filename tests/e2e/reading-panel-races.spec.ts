import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

test('快速切换笔记和页面保留各自草稿，精读卡汇集更新后的正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-panel-races-'))
  const app = await launchApp(dir)
  try {
    const id = await app.page.evaluate(async (path) => {
      const [result] = await window.api.docImport([path], { docType: 'paper' })
      const doc = await window.api.docOpen(result.documentId!)
      for (const title of ['第一个问题', '第二个问题']) {
        await window.api.anchorCreateWithNote({
          anchor: { documentVersionId: doc.versionId, pageIndex: 0, rects: [[72, 310, 520, 440]] },
          note: { title, noteType: 'problem', bodyMd: `${title}原文` }
        })
      }
      return doc.documentId
    }, join(process.cwd(), 'fixtures/text-basic.pdf'))
    const { page } = app
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item').click()
    const first = page.locator('.mnp-item', { hasText: '第一个问题' })
    const second = page.locator('.mnp-item', { hasText: '第二个问题' })
    await first.locator('.mnp-item-head').click()
    await first.locator('textarea').fill('第一个问题的最终理解')
    await second.locator('.mnp-item-head').click()
    await second.locator('textarea').fill('第二个问题的最后输入')
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await expect(page.locator('.mnp-empty')).toBeVisible()
    await page.getByRole('tab', { name: '整理', exact: true }).click()
    const excerpts = page.locator('.rw-card > .rw-details', { has: page.locator('summary', { hasText: '本篇摘录与问题' }) })
    await excerpts.locator('summary').click()
    await expect(excerpts).toContainText('第一个问题的最终理解')
    await expect(excerpts).toContainText('第二个问题的最后输入')
    await page.getByRole('tab', { name: '随手记', exact: true }).click()
    await page.getByRole('tab', { name: '整份', exact: true }).click()
    await expect(second.locator('textarea')).toHaveValue('第二个问题的最后输入')
    await first.locator('.mnp-item-head').click()
    await expect(first.locator('textarea')).toHaveValue('第一个问题的最终理解')
    const saved = await page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(saved.map((note) => note.bodyMd).sort()).toEqual(['第一个问题的最终理解', '第二个问题的最后输入'].sort())
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('HTML 教材随手记关联材料，章节理解卡不能伪造定位或标记核对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-panel-html-'))
  const path = join(dir, 'chapter.html')
  writeFileSync(path, '<!doctype html><meta charset="utf-8"><h1>紧性与弱收敛</h1><p>本章说明紧性的使用条件。</p>')
  const app = await launchApp(dir)
  try {
    const { page } = app
    const id = await page.evaluate(async (file) => (await window.api.docImport([file], { docType: 'book' }))[0].documentId!, path)
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item').click()
    await page.getByLabel('随手记内容').fill('这里还需要序列紧性吗？')
    await page.locator('.rw-quick-options > summary').click()
    await page.getByRole('button', { name: '记下疑问', exact: true }).click()
    await expect(page.locator('.mnp-item', { hasText: '这里还需要序列紧性吗？' })).toBeVisible()
    await page.getByRole('tab', { name: '整理', exact: true }).click()
    const section = page.getByTestId('card-section-findings')
    await section.locator('textarea').fill('紧性结论需要核查拓扑条件。')
    await expect(section).toContainText('待核对')
    await expect(section.getByRole('checkbox')).toHaveCount(0)
    await expect(section.getByRole('button', { name: /回原文/ })).toHaveCount(0)
    await expect(page.locator('.rw-card')).toContainText('尚不能定位段落')
    const notes = await page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(notes[0].anchors).toEqual([])
    expect(notes[0].viaDocumentSource).toBe(true)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('跨页笔记保存错误持续可见，卡片页能返回并重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-panel-error-'))
  const app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const { page } = app
    await page.evaluate(async (path) => {
      const [result] = await window.api.docImport([path], { docType: 'paper' })
      const doc = await window.api.docOpen(result.documentId!)
      await window.api.anchorCreateWithNote({ anchor: { documentVersionId: doc.versionId, pageIndex: 0, rects: [[72, 310, 520, 440]] }, note: { title: '尚未保存的问题', bodyMd: '原来的内容' } })
    }, join(process.cwd(), 'fixtures/text-basic.pdf'))
    await page.reload()
    await navigateTo(page, '文献')
    await page.locator('.doc-item').click()
    await page.locator('.mnp-item-head').click()
    await page.evaluate(() => window.api.testIpcFail({ channel: 'note:save', error: '测试跨页失败' }))
    // .mnp-textarea 会同时命中随手记草稿与精读卡隐藏栏目，必须精确定位到展开的笔记输入框
    await page.getByLabel('编辑笔记：尚未保存的问题').fill('失败时也要保留的输入')
    await expect(page.locator('.mnp .status-error')).toContainText('测试跨页失败')
    await page.locator('.page-input').fill('2')
    await page.locator('.page-input').press('Enter')
    await expect(page.getByRole('button', { name: '重试笔记保存', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '整理', exact: true }).click()
    await expect(page.getByRole('button', { name: '查看保存错误', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '查看保存错误', exact: true }).click()
    await page.evaluate(() => window.api.testIpcFail({ channel: null }))
    await page.getByRole('button', { name: '重试笔记保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试笔记保存', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: '整份', exact: true }).click()
    await expect(page.locator('.mnp .mnp-textarea')).toHaveValue('失败时也要保留的输入')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.page.evaluate(() => window.api.testIpcFail({ channel: null })).catch(() => undefined)
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})
