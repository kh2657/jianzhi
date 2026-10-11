// WP-1 / D4+D5 端到端：坏文件与散装文件不再「静默消失」。
//
// 场景（真实应用 + 预置坏文件）：库目录里放一个坏 entry.json、一个散装 PDF、一条坏笔记 →
// 文献库首屏出现两条提示横幅（可展开看路径）→ 应用不搬移、不改写用户文件；
// entry.json 类仍保持「先备份为 .broken」的既有铁律。
import { expect, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, fixture, launchApp, rmTempDir } from './helpers/launch'

test('库诊断：坏文件与散装文件在文献库可见，且不自动改动用户文件', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-diag-'))
  const lib = join(userData, 'library')
  const inbox = join(lib, '文献库', '待整理')
  const badDir = join(inbox, '坏条目')
  mkdirSync(badDir, { recursive: true })
  writeFileSync(join(badDir, 'entry.json'), '{ 这不是合法 JSON')
  copyFileSync(fixture('text-basic.pdf'), join(inbox, '散装副本.pdf'))

  const app = await launchApp(userData)
  try {
    const { page } = app
    // 启动默认视图是笔记；诊断收纳进「管理」面板（2026-10-09 分流：健康时零打扰）
    await navigateTo(page, '文献')
    const manage = page.locator('.lib-manage')
    await expect(manage).toBeVisible({ timeout: 15000 })
    await expect(manage).toContainText('个文件无法读取')
    await expect(manage).toContainText('未入库')

    // 展开可见路径；entry.json 类保持「先备份为 .broken」
    await manage.locator('summary').click()
    await expect(manage).toContainText('坏条目')
    expect(readFileSync(join(badDir, 'entry.json.broken'), 'utf8')).toBe('{ 这不是合法 JSON')

    // 散装文件原样保留，可跳到所在分区文件夹，也可一键导入
    await expect(manage).toContainText('散装副本.pdf')
    await expect(manage.getByRole('button', { name: '在文件夹中显示' })).toBeVisible()
    const stray = join(inbox, '散装副本.pdf')
    expect(existsSync(stray)).toBe(true)

    // 干净的部分不受影响：坏条目不会产生幻影条目
    await expect(page.locator('.doc-item')).toHaveCount(0)

    // 一键导入：确认后条目进库，原件移入系统废纸篓（可从废纸篓恢复），文件不再留在分区目录
    page.once('dialog', (d) => void d.accept())
    await manage.getByRole('button', { name: '导入', exact: true }).click()
    await expect(page.locator('.doc-item', { hasText: '散装副本' })).toBeVisible({ timeout: 15000 })
    await expect.poll(() => existsSync(stray), { timeout: 15000 }).toBe(false)

    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('库诊断：坏笔记进入提示且 .md 保持原样，修复后恢复', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-e2e-diag2-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    // 先正常建一条笔记（写入库骨架）
    await navigateTo(page, '笔记')
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await page.locator('.note-title-input').fill('diag probe')
    await page.locator('.note-textarea').fill('正文')
    await expect(page.locator('.status-saved')).toBeVisible({ timeout: 15000 })

    // 外部把它写坏（front-matter 无法解析）
    const notesDir = join(userData, 'library', '笔记')
    const fileAbs = join(notesDir, readdirSync(notesDir).find((n) => n.includes('diag-probe'))!)
    const original = readFileSync(fileAbs, 'utf8')
    writeFileSync(fileAbs, '--- 这不是合法 front-matter')

    await page.reload()
    // reload 回到默认笔记视图；坏笔记横幅在文献库首屏
    await navigateTo(page, '文献')
    const badBanner = page.locator('.conflict-banner', { hasText: '个文件无法读取' })
    await expect(badBanner).toBeVisible({ timeout: 15000 })
    await badBanner.locator('summary').click()
    await expect(badBanner).toContainText('diag-probe')
    // .md 是用户文档：不搬移、不改名、不产生 .broken
    expect(readFileSync(fileAbs, 'utf8')).toBe('--- 这不是合法 front-matter')
    expect(existsSync(`${fileAbs}.broken`)).toBe(false)

    // 用户修回原文件 → 刷新后提示消失（不依赖任何自动修复）
    writeFileSync(fileAbs, original)
    await page.reload()
    await navigateTo(page, '文献')
    await expect(page.locator('.conflict-banner', { hasText: '个文件无法读取' })).toHaveCount(0, { timeout: 15000 })
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})