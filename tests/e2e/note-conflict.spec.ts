// WP-1 / D2 端到端：外部修改的笔记不再被本地旧快照静默覆盖。
//
// 场景（真实应用 + 真实文件）：编辑器打开一条笔记 → 磁盘上的 .md 被外部改写（另一台机器 /
// 同步工具 / 外部编辑器）→ 用户在编辑器继续输入 → 主进程发现磁盘指纹与编辑起点不一致，
// 拒绝写入并给出三个出口。本用例覆盖默认出口（另存为独立笔记）与「以本地覆盖」的归档行为。
import { expect, test } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

/** 建一条笔记、等自动保存完成，返回 { noteId, fileAbs } */
async function createSavedNote(app: Awaited<ReturnType<typeof launchApp>>, userData: string, title: string, body: string): Promise<{ noteId: string; fileAbs: string }> {
  const { page } = app
  await navigateTo(page, '笔记')
  await page.getByRole('button', { name: '＋ 新笔记' }).click()
  await page.locator('.note-title-input').fill(title)
  await page.locator('.note-textarea').fill(body)
  await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
  const noteId = await page.evaluate(async (t) => {
    const notes = await window.api.noteList()
    return notes.find((n) => n.title === t)!.id
  }, title)
  const notesDir = join(userData, 'library', '笔记')
  const fileName = readdirSync(notesDir).find((n) => n.endsWith(`-${noteId.slice(0, 8)}.md`))!
  return { noteId, fileAbs: join(notesDir, fileName) }
}

/** 模拟外部写入：保持 front-matter 不变，只改正文 */
function externalEdit(fileAbs: string, from: string, to: string): void {
  writeFileSync(fileAbs, readFileSync(fileAbs, 'utf8').replace(from, to))
}

test('保存冲突：外部改写后保存被拒；「另存为独立笔记」保留双方内容', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-conflict-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const { fileAbs } = await createSavedNote(app, userData, 'conflict probe', '本地版本 A')

    externalEdit(fileAbs, '本地版本 A', '外部版本 B')
    // 在编辑器继续输入 → 自动保存（800ms 防抖）→ 冲突条出现
    await page.locator('.note-textarea').fill('本地版本 A + 追加')
    await expect(page.locator('.save-conflict')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.save-conflict')).toContainText('检测到外部修改')
    await expect(page.locator('.save-status .status-error')).toContainText('待处理')
    // 磁盘仍是外部版本：本地保存被拒绝，没有覆盖
    expect(readFileSync(fileAbs, 'utf8')).toContain('外部版本 B')

    // 默认出口：另存为独立笔记 → 跳转到副本，两边内容都在
    await page.getByRole('button', { name: '另存为独立笔记' }).click()
    await expect(page.locator('.note-title-input')).toHaveValue(/本地副本/, { timeout: 15000 })
    await expect(page.locator('.note-textarea')).toHaveValue(/追加/)
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    expect(readFileSync(fileAbs, 'utf8')).toContain('外部版本 B')

    // 重启后：原笔记（外部版本）与副本（本地草稿）都在
    await page.reload()
    await navigateTo(page, '笔记')
    await expect(page.locator('.note-item', { hasText: 'conflict probe' }).first()).toBeVisible()
    await expect(page.locator('.note-item', { hasText: '本地副本' })).toBeVisible()
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('保存冲突：「以本地覆盖」先把外部版本另存为独立笔记，再写入本地内容', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-conflict2-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    const { fileAbs } = await createSavedNote(app, userData, 'overwrite probe', '本地版本 A')

    externalEdit(fileAbs, '本地版本 A', '外部版本 B')
    await page.locator('.note-textarea').fill('本地版本 A + 追加')
    await expect(page.locator('.save-conflict')).toBeVisible({ timeout: 15000 })

    page.once('dialog', (d) => void d.accept()) // 确认覆盖（窗口确认框）
    await page.getByRole('button', { name: '以本地覆盖' }).click()
    await expect(page.locator('.save-conflict')).toHaveCount(0, { timeout: 15000 })
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })
    expect(readFileSync(fileAbs, 'utf8')).toContain('本地版本 A + 追加') // 本地内容已落盘

    // 外部版本没有丢：归档为独立笔记（列表可见，可打开）
    await navigateTo(page, '笔记')
    const archived = page.locator('.note-item', { hasText: '（外部修改副本）' })
    await expect(archived).toBeVisible({ timeout: 15000 })
    await archived.click()
    await expect(page.locator('.note-textarea')).toHaveValue(/外部版本 B/)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})