// 速记（纯文本捕获）端到端（收件箱视图已删除后的新落点）：
//  ① 全局快捷键的派发路径能唤起浮层（E2E 不注册系统级快捷键，走同一条主进程事件）；
//  ② 默认 Enter → 直接存为草稿笔记（标题取首行、正文原样）并打开编辑器；
//  ③ `!` 前缀 → 待办速记（落盘 收件箱/速记/<时间戳>-<id8>.md，标记不进正文），在「待办」可见；
//  ④ Esc 丢：一个字都不落盘；⑤ ⌘K 能搜到笔记与速记；⑥ 重启后都在；
//  ⑦ 分诊（待办内）：转成笔记（正文原样、标题取首行、速记转已归档）/ 删除（文件离开速记目录）。
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir, layoutAudit } from './helpers/launch'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const memoDirOf = (userData: string): string => join(userData, 'library', '收件箱', '速记')
const memoFiles = (userData: string): string[] => {
  try {
    return readdirSync(memoDirOf(userData)).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
}
/** 重挂载待办视图（视图不订阅库变更，靠重新挂载取最新列表） */
async function remountTodos(page: import('@playwright/test').Page): Promise<void> {
  await navigateTo(page, '文献')
  await navigateTo(page, '待办')
}

test('速记：唤起 → 捕获 → 草稿笔记 / 待办 → ⌘K 可搜 → 重启仍在', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-memo-'))
  mkdirSync(join(userData, 'library'), { recursive: true })
  let app = await launchApp(userData)
  try {
    const { page } = app
    // 竞态对冲：launchApp 只等 window.api 就绪，而浮层靠 React effect 注册的 onQuickCapture 收事件
    // （主进程 send 是 fire-and-forget，effect 没挂上就永久丢失）。先等首屏渲染 + 两帧再派发。
    await expect(page.locator('.workspace-primary .nav-item[aria-label="资料"]')).toBeVisible()
    await page.evaluate(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      window.api.testQuickCapture()
    })
    await expect(page.locator('.quick-capture')).toBeVisible()
    const area = page.locator('[aria-label="速记内容"]')
    await expect(area).toBeFocused({ timeout: 5000 })
    await area.fill('用特征代价构造正则项')
    await page.keyboard.press('Enter')
    // 默认落点：草稿笔记，保存后直接打开编辑器
    await expect(page.getByText('已存为草稿笔记', { exact: true })).toBeVisible()
    await expect(page.locator('.note-title-input')).toHaveValue('用特征代价构造正则项')
    await expect(page.locator('.note-textarea')).toContainText('用特征代价构造正则项')
    expect(memoFiles(userData)).toHaveLength(0)

    // `!` 前缀 → 待办速记，标记本身不进正文；落盘 收件箱/速记/
    await remountTodos(page)
    await page.getByRole('button', { name: '写速记', exact: true }).click()
    await page.locator('[aria-label="速记内容"]').fill('! 周三前看完 2401.12345')
    await page.keyboard.press('Enter')
    await expect(page.getByText('已记为待办，见「待办」', { exact: true })).toBeVisible()
    // 待办不订阅库变更：重挂载取最新列表
    await remountTodos(page)
    await expect(page.locator('.todo-row', { hasText: '周三前看完 2401.12345' }).locator('.todo-check')).toBeVisible()
    const files = memoFiles(userData)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{8}-\d{6}-[0-9a-f]{8}\.md$/)
    const raw = readFileSync(join(memoDirOf(userData), files[0]), 'utf8')
    expect(raw).toContain('todo: true')
    expect(raw).not.toContain('!')
    expect(raw).toContain('周三前看完 2401.12345')

    // Esc 取消：一个字都不该落盘
    await page.getByRole('button', { name: '写速记', exact: true }).click()
    await page.locator('[aria-label="速记内容"]').fill('这条不该被保存')
    await page.keyboard.press('Escape')
    await expect(page.locator('.quick-capture')).toHaveCount(0)
    expect(memoFiles(userData)).toHaveLength(1)

    // ⌘K 全局搜索：命中草稿笔记正文，也命中待办速记
    await page.keyboard.press(`${mod}+k`)
    const palette = page.locator('.cmdk')
    await expect(palette).toBeVisible({ timeout: 15000 })
    await palette.locator('input').fill('特征代价')
    await expect(palette.locator('.cmdk-item-label', { hasText: '特征代价' }).first()).toBeVisible({ timeout: 20000 })
    await palette.locator('input').fill('周三前看完')
    await expect(palette.getByText('速记', { exact: true })).toBeVisible({ timeout: 20000 })
    await page.keyboard.press('Escape')

    expect(await layoutAudit(page, 'quick-capture')).toEqual([])

    await app.app.close()
    app = await launchApp(userData)
    // 重启后：草稿笔记仍在，待办速记仍在
    await navigateTo(app.page, '笔记')
    await expect(app.page.locator('.note-item', { hasText: '用特征代价构造正则项' })).toBeVisible()
    await navigateTo(app.page, '待办')
    await expect(app.page.locator('.todo-row', { hasText: '周三前看完' }).locator('.todo-check')).toBeVisible()
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

/** 预置一个「待补全」条目（直接写库文件，启动即被扫描；避免走导入 IPC） */
function seedReviewEntry(userData: string): void {
  const dir = join(userData, 'library', '文献库', '待整理', '待补全条目')
  mkdirSync(dir, { recursive: true })
  const sha = createHash('sha256').update('review-entry').digest('hex')
  writeFileSync(join(dir, 'entry.json'), JSON.stringify({
    schema: 2, id: '11111111-1111-4111-8111-111111111111', docType: 'paper',
    title: '待补全条目', authors: [], year: null, venue: null, doi: null, arxivId: null,
    abstract: null, tags: [], spaceId: null, status: 'needs-review', note: '',
    files: [{ sha256: sha, name: `${sha}.pdf`, mediaType: 'application/pdf', byteSize: 10, pageCount: 1, fingerprint: null, importedAt: '2026-10-09T00:00:00.000Z' }],
    readingState: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z'
  }, null, 2))
}

test('待办面板：聚合速记/有疑问/待补全队列，完成速记待办即出队', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-todos-'))
  seedReviewEntry(userData)
  const app = await launchApp(userData)
  try {
    const { page } = app
    await page.evaluate(async () => {
      await window.api.memoCreate({ text: '! 周三前看完收敛性证明' })
      await window.api.memoCreate({ text: '一条普通速记，还没整理' })
      const note = await window.api.noteCreate({ title: '势函数学习', bodyMd: '## 势函数\n<!-- block:potential -->\n\n正文。' })
      const full = await window.api.noteGet(note.id)
      await window.api.noteSave({
        id: note.id, title: full.note.title, noteType: full.note.noteType, bodyMd: full.note.bodyMd,
        aliases: full.note.aliases, verifiedStatus: full.note.verifiedStatus, baseHash: full.baseHash,
        learning: { activeId: 'potential', records: { potential: { status: 'question', fingerprint: 'fp-1' } } }
      })
    })
    await navigateTo(page, '待办')
    await expect(page.locator('.todo-row', { hasText: '周三前看完收敛性证明' })).toBeVisible()
    await expect(page.locator('.todo-row', { hasText: '一条普通速记' })).toBeVisible()
    await expect(page.locator('.todo-row', { hasText: '势函数学习' })).toBeVisible()
    await expect(page.locator('.todo-row', { hasText: '待补全条目' })).toBeVisible()
    // 待办速办带勾选框；普通速记没有（完成 = 归档，只对待办有意义）
    await expect(page.locator('.todo-row', { hasText: '周三前看完收敛性证明' }).locator('.todo-check')).toBeVisible()
    await expect(page.locator('.todo-row', { hasText: '一条普通速记' }).locator('.todo-check')).toHaveCount(0)

    // 完成速记待办 → 出队（速记归档，内容保留）
    await page.locator('.todo-row', { hasText: '周三前看完收敛性证明' }).locator('.todo-check').click()
    await expect(page.getByText('已完成，速记移入已归档', { exact: true })).toBeVisible()
    await expect(page.locator('.todo-row', { hasText: '周三前看完收敛性证明' })).toHaveCount(0)

    // 有疑问的知识块 → 跳到那篇笔记
    await page.locator('.todo-row', { hasText: '势函数学习' }).locator('.todo-label').click()
    await expect(page.locator('.note-title-input')).toHaveValue('势函数学习')

    // 待补全 → 文献并带上「待补全」筛选
    await navigateTo(page, '待办')
    await page.locator('.todo-row', { hasText: '待补全条目' }).locator('.todo-label').click()
    await expect(page.locator('.chip', { hasText: '待补全' }).first()).toHaveAttribute('aria-pressed', 'true')

    expect(await layoutAudit(page, 'todos')).toEqual([])
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})

test('速记分诊（待办内）：转成笔记 / 删除', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'mathwb-memo-triage-'))
  const app = await launchApp(userData)
  try {
    const { page } = app
    await navigateTo(page, '待办')
    // 两条速记走真实 IPC 建好（不经浮层，本用例聚焦分诊动作）
    await page.evaluate(async () => {
      await window.api.memoCreate({ text: '势函数想法\n\n用特征代价构造正则项。' })
      await window.api.memoCreate({ text: '随手一条，待会儿删掉' })
    })
    await remountTodos(page)
    const rows = page.locator('.todo-row')
    await expect(rows).toHaveCount(2)

    const row = page.locator('.todo-row', { hasText: '势函数想法' })
    await row.getByRole('button', { name: '转成笔记' }).click()
    await expect(page.getByText('已转成笔记', { exact: false })).toBeVisible()
    // 转走的速记标记为已归档 → 从待办消失
    await expect(rows).toHaveCount(1)

    // 笔记真的建出来了：标题取首行、正文原样
    await navigateTo(page, '笔记')
    await expect(page.locator('.note-item', { hasText: '势函数想法' })).toBeVisible()
    await page.locator('.note-item', { hasText: '势函数想法' }).click()
    await expect(page.locator('.note-textarea')).toContainText('用特征代价构造正则项')

    // 删除（文件离开速记目录、进系统废纸篓）
    await navigateTo(page, '待办')
    const doomed = page.locator('.todo-row', { hasText: '随手一条' })
    const before = memoFiles(userData).length
    await doomed.getByRole('button', { name: '删除' }).click()
    await expect(page.getByText('已删除', { exact: false })).toBeVisible()
    await expect(page.locator('.todo-row')).toHaveCount(0)
    expect(memoFiles(userData).length).toBe(before - 1)

    expect(await layoutAudit(page, 'quick-capture-triage')).toEqual([])
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(userData)
  }
})
