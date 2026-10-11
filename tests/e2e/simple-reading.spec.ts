import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'

async function openMaterial(app: LaunchedApp, seedNote = false): Promise<string> {
  const id = await app.page.evaluate(async ({ path, seed }) => {
    const [result] = await window.api.docImport([path], { docType: 'paper' })
    const doc = await window.api.docOpen(result.documentId!)
    if (seed) {
      const { note } = await window.api.anchorCreateWithNote({
        anchor: { documentVersionId: doc.versionId, pageIndex: 0, rects: [[72, 310, 520, 440]] },
        note: { title: '旧的疑问名称', noteType: 'problem', bodyMd: '已有正文' }
      })
      await window.api.noteSave({ id: note.id, title: note.title, noteType: note.noteType,
        bodyMd: note.bodyMd, verifiedStatus: note.verifiedStatus, aliases: ['已有别名', '旧的疑问名称'] })
    }
    return doc.documentId
  }, { path: join(process.cwd(), 'fixtures/text-basic.pdf'), seed: seedNote })
  await app.page.reload()
  await navigateTo(app.page, '文献')
  await app.page.locator('.doc-item').click()
  await expect(app.page.getByTestId('reading-workspace')).toBeVisible()
  return id
}

test('直接记录无需分类，快捷键防重复，失败保留内容且疑问入口仍可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-simple-quick-'))
  const app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const id = await openMaterial(app)
    const { page } = app
    await expect(page.getByLabel('阅读核心问题')).not.toBeVisible()
    await expect(page.getByRole('button', { name: '记下疑问', exact: true })).not.toBeVisible()
    await expect(page.getByRole('button', { name: '记下来', exact: true })).toBeDisabled()
    const quick = page.getByLabel('随手记内容')
    await quick.fill('无需分类就能记下的想法')
    await quick.press('Control+Enter')
    await quick.press('Meta+Enter')
    const note = page.locator('.mnp-item', { hasText: '无需分类就能记下的想法' })
    await expect(note).toBeVisible()
    await expect(note.locator('.tag')).toHaveCount(0)
    await expect(quick).toHaveValue('')
    await expect(quick).toBeFocused()
    const saved = await page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ noteType: 'note', bodyMd: '无需分类就能记下的想法' })

    await page.evaluate(() => window.api.testIpcFail({ channel: 'anchor:createWithNote', error: '模拟记录失败' }))
    await quick.fill('失败后仍可继续编辑的内容')
    await page.getByRole('button', { name: '记下来', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('记录失败，内容已保留')
    await expect(quick).toHaveValue('失败后仍可继续编辑的内容')
    await page.evaluate(() => window.api.testIpcFail({ channel: null }))
    await page.getByRole('button', { name: '记下来', exact: true }).click()
    await expect(page.locator('.mnp-item', { hasText: '失败后仍可继续编辑的内容' })).toBeVisible()
    await expect(quick).toBeFocused()

    await quick.fill('这一步为什么成立？')
    await page.locator('.rw-quick-options > summary').click()
    await page.getByRole('button', { name: '记下疑问', exact: true }).click()
    await expect(page.locator('.rw-notes .rw-question', { hasText: '这一步为什么成立？' })).toBeVisible()
    const after = await page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(after).toHaveLength(3)
    expect(after.find((n) => n.title === '这一步为什么成立？')?.noteType).toBe('problem')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.page.evaluate(() => window.api.testIpcFail({ channel: null })).catch(() => undefined)
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('笔记名称与正文使用同一保存队列，导航失败保留并可重试，旧类型保持', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-simple-rename-'))
  let app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const id = await openMaterial(app, true)
    const { page } = app
    const reference = await page.evaluate((documentId) => window.api.noteCreate({
      documentId, title: '引用旧名称的笔记', bodyMd: '继续查看 [[旧的疑问名称]]。'
    }), id)
    await page.locator('.mnp-item-head', { hasText: '旧的疑问名称' }).click()
    await page.evaluate(() => window.api.testIpcFail({ channel: 'note:save', error: '模拟改名保存失败' }))
    await page.getByLabel('笔记名称').fill('我自由命名的证明线索')
    await page.locator('.mnp-item-open textarea').fill('与标题一起保存的新正文')
    await page.locator('.workspace-primary .nav-item[aria-label="资料"]').click()
    await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
    await expect(page.getByLabel('笔记名称')).toHaveValue('我自由命名的证明线索')
    await expect(page.locator('.mnp-item-open textarea')).toHaveValue('与标题一起保存的新正文')
    await expect(page.locator('.mnp .status-error')).toContainText('模拟改名保存失败')
    await page.evaluate(() => window.api.testIpcFail({ channel: null }))
    await page.locator('.mnp-item-open').getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('.mnp-item-open .status-saved')).toContainText('已保存')
    // 立即编辑并导航，标题和正文都必须被冲刷。
    await page.getByLabel('笔记名称').fill('导航前最后的名字')
    await page.locator('.mnp-item-open textarea').fill('导航前最后的正文')
    await navigateTo(page, '文献')
    const notes = await page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    const renamed = notes.find((note) => note.title === '导航前最后的名字')!
    expect(renamed).toMatchObject({ bodyMd: '导航前最后的正文', noteType: 'problem' })
    expect(renamed.aliases).toEqual(['已有别名', '旧的疑问名称', '我自由命名的证明线索'])
    const links = await page.evaluate(async (noteId) => ({
      backlinks: await window.api.noteBacklinks(noteId),
      index: (await window.api.noteLinkIndex()).find((note) => note.id === noteId)
    }), renamed.id)
    expect(links.backlinks).toEqual(expect.arrayContaining([expect.objectContaining({ fromNoteId: reference.id })]))
    expect(links.index?.aliases).toContain('旧的疑问名称')
    await app.app.close()
    app = await launchApp(dir)
    const restored = await app.page.evaluate((documentId) => window.api.notesForDocument(documentId), id)
    expect(restored.find((note) => note.id === renamed.id)).toMatchObject({ title: '导航前最后的名字', bodyMd: '导航前最后的正文', noteType: 'problem', aliases: renamed.aliases })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.page.evaluate(() => window.api.testIpcFail({ channel: null })).catch(() => undefined)
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('空白栏目收起，名称自由修改，已有内容和依据自动展示且重启保留核对', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-simple-card-'))
  let app = await launchApp(dir)
  try {
    await openMaterial(app, true)
    const { page } = app
    await page.locator('.rw-settings > summary').click()
    await page.getByLabel('阅读核心问题').fill('我想弄懂这个证明')
    await page.locator('.rw-settings > summary').click()
    await expect(page.locator('.rw-settings > summary')).toContainText('我想弄懂这个证明')
    await page.getByRole('tab', { name: '整理', exact: true }).click()
    const findings = page.getByTestId('card-section-findings')
    const method = page.getByTestId('card-section-method')
    const question = page.getByTestId('card-section-question')
    await expect(findings).toBeVisible()
    await expect(method).not.toBeVisible()
    await expect(question).not.toBeVisible()
    await page.getByRole('button', { name: '更多整理栏目', exact: true }).click()
    await expect(method).toBeVisible()
    await method.locator('input[type="text"], input:not([type])').first().fill('我想回头看的推导')
    await method.locator('textarea').pressSequentially('关键一步')
    await expect(method.locator('textarea')).toBeFocused()
    await question.locator('.rw-evidence > summary').click()
    await question.getByRole('checkbox', { name: /依据/ }).check()
    await page.getByRole('button', { name: '收起空白栏目', exact: true }).click()
    await expect(method).toBeVisible()
    await expect(question).toBeVisible()
    await expect(page.getByTestId('card-section-relevance')).not.toBeVisible()
    await findings.locator('.rw-section-title').fill('自己的理解')
    await findings.locator('textarea').fill('这个结论需要边界条件。')
    await findings.locator('.rw-evidence > summary').click()
    await findings.getByRole('checkbox', { name: /依据/ }).check()
    await findings.getByRole('checkbox', { name: /确认核对/ }).check()
    await findings.locator('.rw-section-title').fill('我确认过的结论')
    await expect(findings.getByRole('checkbox', { name: /确认核对/ })).toBeChecked()
    await app.app.close()
    app = await launchApp(dir)
    await expect(app.page.getByTestId('card-section-findings').locator('.rw-section-title')).toHaveValue('我确认过的结论')
    await expect(app.page.getByTestId('card-section-findings').getByRole('checkbox', { name: /确认核对/ })).toBeChecked()
    await expect(app.page.getByTestId('card-section-method').locator('textarea')).toHaveValue('关键一步')
    await expect(app.page.getByTestId('card-section-question')).toBeVisible()
    await expect(app.page.getByTestId('card-section-relevance')).not.toBeVisible()
    await expect(app.page.getByLabel('阅读核心问题')).not.toBeVisible()
    await expect(app.page.locator('.rw-settings > summary')).toContainText('我想弄懂这个证明')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('清空已有栏目准备重写时，栏目与输入焦点保持可见', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-section-rewrite-'))
  const app = await launchApp(dir)
  try {
    const id = await openMaterial(app)
    await navigateTo(app.page, '文献')
    await app.page.evaluate(async (documentId) => {
      const workspace = await window.api.readingWorkspaceGet(documentId)
      workspace.activeTab = 'card'
      workspace.sections.find(section => section.id === 'method')!.body = '要重新写的内容'
      workspace.sections.find(section => section.id === 'evidence')!.title = '要重新起的名字'
      await window.api.readingWorkspaceSave(workspace)
    }, id)
    await app.page.locator('.doc-item').click()
    const method = app.page.getByTestId('card-section-method').locator('textarea')
    await method.click()
    await method.press('ControlOrMeta+A')
    await method.press('Backspace')
    await expect(method).toBeVisible()
    await expect(method).toBeFocused()
    await method.pressSequentially('重新梳理的方法')
    const title = app.page.getByTestId('card-section-evidence').locator('.rw-section-title')
    await title.click()
    await title.press('ControlOrMeta+A')
    await title.press('Backspace')
    await expect(title).toBeVisible()
    await expect(title).toBeFocused()
    await title.pressSequentially('自由改名后的栏目')
    await navigateTo(app.page, '文献')
    const saved = await app.page.evaluate(documentId => window.api.readingWorkspaceGet(documentId), id)
    expect(saved.sections.find(section => section.id === 'method')?.body).toBe('重新梳理的方法')
    expect(saved.sections.find(section => section.id === 'evidence')?.title).toBe('自由改名后的栏目')
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close()
    rmTempDir(dir)
  }
})
