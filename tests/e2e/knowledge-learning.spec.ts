import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir, layoutAudit } from './helpers/launch'
import { contentFingerprint, parseKnowledgeNote } from '../../src/renderer/src/lib/knowledge-blocks'

test('知识块学习：展开、自测、基础跳转、状态持久与内容变更失效', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-learning-'))
  let app = await launchApp(userData)
  const content = '范围：先看势函数。\n\n## 势函数\n<!-- block:potential -->\n\n用特征代价构造正则项。\n\n### 例子\n\n$$R(x)=\\psi(x_2-x_1)$$\n\n### 自测\n\n为什么需要控制曲率？\n\n### 参考解释\n\n曲率影响整个目标。\n\n## 曲率\n<!-- block:curvature -->\n\n依赖 [[凸性基础]]。\n\n### 条件与边界\n\n凸性本身不保证解存在。'
  try {
    const ids = await app.page.evaluate(async body => {
      const foundation = await window.api.noteCreate({title:'凸性基础',bodyMd:'## 凸\n\n局部极小点是全局极小点。'})
      const note = await window.api.noteCreate({title:'势函数学习',bodyMd:body})
      return {note:note.id,foundation:foundation.id}
    },content)
    await navigateTo(app.page, '笔记')
    await app.page.locator('.note-item', {hasText:'势函数学习'}).click()
    await app.page.locator('.note-mode-switch').getByRole('button',{name:'学习',exact:true}).click()
    await expect(app.page.locator('.learning-node')).toHaveCount(2)
    await expect(app.page.getByText('为什么需要控制曲率？',{exact:true})).toBeVisible()
    await expect(app.page.getByText('曲率影响整个目标。',{exact:true})).not.toBeVisible()
    await app.page.locator('.learning-panel summary',{hasText:'例子'}).click()
    await expect(app.page.locator('.learning-block .katex')).toBeVisible()
    await expect(app.page.locator('.katex-error')).toHaveCount(0)
    await app.page.getByRole('button',{name:'我已理解',exact:true}).click()
    await expect(app.page.getByText('已理解 1 / 2', {exact:false})).toBeVisible()
    await expect(app.page.getByText('学习记录已保存',{exact:true})).toBeVisible()
    // WP-8：自评状态存在**笔记文件**（front-matter 的 learning 字段）——跨设备随库同步；
    // 且自评不算内容编辑（正文与修订号不受影响），旧的机器本地 pref 不再写入
    const original = await app.page.evaluate(id => window.api.noteGet(id),ids.note)
    expect(original.note.bodyMd).toBe(content)
    expect(original.note.revisionNo).toBe(1)
    expect(Object.keys(original.note.learning?.records ?? {})).toEqual(['potential'])
    const notesDir = join(userData, 'library', '笔记')
    const noteFile = readdirSync(notesDir).find((n) => n.includes(ids.note.slice(0, 8)))!
    expect(readFileSync(join(notesDir, noteFile), 'utf8')).toContain('learning:')
    expect(readFileSync(join(userData,'settings.json'),'utf8')).not.toContain(`mathwb-learning:${ids.note}`)
    await app.page.getByRole('button',{name:'下一块',exact:true}).click()
    await app.page.getByRole('button',{name:'仍有疑问',exact:true}).click()
    await expect(app.page.locator('.learning-node-active')).toContainText('有疑问')
    await app.page.locator('.learning-block a.wikilink').click()
    await expect(app.page.locator('.note-title-input')).toHaveValue('凸性基础')
    await navigateTo(app.page, '笔记')
    await app.page.locator('.note-item',{hasText:'势函数学习'}).click()
    await expect(app.page.locator('.learning-block h2')).toHaveText('曲率')
    await expect(app.page.locator('.learning-node-active')).toContainText('有疑问')
    expect(await layoutAudit(app.page,'knowledge-learning')).toEqual([])
    await app.app.close()
    app = await launchApp(userData)
    await navigateTo(app.page, '笔记')
    await app.page.locator('.note-item',{hasText:'势函数学习'}).click()
    await expect(app.page.locator('.learning-node-active')).toContainText('有疑问')
    await app.page.getByRole('button',{name:'编辑',exact:true}).click()
    await app.page.locator('.note-textarea').fill(content.replace('依赖 [[凸性基础]]。','新增条件，依赖 [[凸性基础]]。'))
    await expect(app.page.locator('.status-saved')).toBeVisible()
    await app.page.locator('.note-mode-switch').getByRole('button',{name:'学习',exact:true}).click()
    await expect(app.page.locator('.learning-node-active')).toContainText('待学习')
    expect(app.consoleErrors).toEqual([])
  } finally { await app.app.close().catch(()=>undefined); rmTempDir(userData) }
})

test('七块学习记录分别保存，重启后完整恢复', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-learning-many-'))
  let app = await launchApp(userData)
  try {
    const body = Array.from({length:7}, (_,i) => `## 问题 ${i+1}\n<!-- block:question-${i+1} -->\n\n逐块理解。`).join('\n\n')
    const note = await app.page.evaluate(bodyMd => window.api.noteCreate({title:'七块学习',bodyMd}),body)
    await navigateTo(app.page, '笔记')
    await app.page.locator('.note-item',{hasText:'七块学习'}).click()
    await app.page.locator('.note-mode-switch').getByRole('button',{name:'学习',exact:true}).click()
    const positions = await app.page.evaluate(() => ({
      bodyBottom: document.querySelector('.note-editor-body')!.getBoundingClientRect().bottom,
      // 「正文之后」的第一块内容（更多信息）；编辑器脚注行已随界面重构移除
      footTop: document.querySelector('.note-info')!.getBoundingClientRect().top
    }))
    expect(positions.footTop).toBeGreaterThanOrEqual(positions.bodyBottom)
    for (let i=0;i<7;i++) {
      await app.page.locator('.learning-node').nth(i).click()
      await app.page.getByRole('button',{name:'我已理解',exact:true}).click()
    }
    await expect(app.page.getByText('学习记录已保存',{exact:true})).toBeVisible()
    await expect(app.page.getByText('已理解 7 / 7',{exact:false})).toBeVisible()
    const full = await app.page.evaluate(id => window.api.noteGet(id), note.id)
    const records = Object.entries(full.note.learning?.records ?? {})
    expect(records).toHaveLength(7)
    expect(records.every(([, r]) => r.status === 'understood' && typeof r.fingerprint === 'string')).toBe(true)
    await app.app.close()
    app = await launchApp(userData)
    await navigateTo(app.page, '笔记')
    await app.page.locator('.note-item',{hasText:'七块学习'}).click()
    await expect(app.page.getByText('已理解 7 / 7',{exact:false})).toBeVisible()
    await expect(app.page.locator('.learning-block h2')).toHaveText('问题 7')
    expect(app.consoleErrors).toEqual([])
  } finally { await app.app.close().catch(()=>undefined); rmTempDir(userData) }
})

test('旧版机器本地自评记录：首次打开时迁入笔记文件', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-learning-migrate-'))
  const body = '## 势函数\n<!-- block:potential -->\n\n用特征代价构造正则项。'
  let app = await launchApp(userData)
  try {
    const note = await app.page.evaluate(b => window.api.noteCreate({ title: '迁移学习', bodyMd: b }), body)
    await app.app.close()

    // 模拟升级前的遗留状态：机器本地 settings.json 里的 pref 记录
    const block = parseKnowledgeNote(body).blocks[0]
    const settingsPath = join(userData, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { prefs?: Record<string, string> }
    settings.prefs = {
      ...(settings.prefs ?? {}),
      [`mathwb-learning:${note.id}`]: block.id,
      [`mathwb-learning:${note.id}:${contentFingerprint(block.id)}`]: JSON.stringify({ status: 'understood', fingerprint: block.fingerprint })
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

    app = await launchApp(userData)
    await navigateTo(app.page, '笔记')
    await app.page.locator('.note-item', { hasText: '迁移学习' }).click()
    await app.page.locator('.note-mode-switch').getByRole('button', { name: '学习', exact: true }).click()
    // 迁移后：标记可见，且已写进笔记文件
    await expect(app.page.getByText('已理解 1 / 1', { exact: false })).toBeVisible({ timeout: 15000 })
    const notesDir = join(userData, 'library', '笔记')
    const file = readdirSync(notesDir).find(n => n.includes(note.id.slice(0, 8)))!
    await expect.poll(() => readFileSync(join(notesDir, file), 'utf8').includes('learning:'), { timeout: 15000 }).toBe(true)
    expect(app.consoleErrors).toEqual([])
  } finally { await app.app.close().catch(() => undefined); rmTempDir(userData) }
})
