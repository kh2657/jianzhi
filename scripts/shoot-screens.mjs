import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Visual QA uses an isolated library. --built checks the current npm run build;
// default retains the packaged-app check used by npm run shots.
const isMac = process.platform === 'darwin'
const appPath = isMac
  ? join(process.cwd(), 'dist/mac-arm64/数学学习工作台.app/Contents/MacOS/数学学习工作台')
  : join(process.cwd(), 'dist/win-unpacked/数学学习工作台.exe')
const SHOTS_DIR = join(tmpdir(), 'mathwb-shots')
mkdirSync(SHOTS_DIR, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'mathwb-shots-'))
const built = process.argv.includes('--built')
const app = await electron.launch(built
  ? { args: ['out/main/index.js', `--user-data-dir=${userData}`] }
  : { executablePath: appPath, args: [`--user-data-dir=${userData}`] })
const errors = []
const checks = []
const audit = async (page, theme, width, view) => {
  checks.push(await page.evaluate(({ theme, width, view }) => ({
    theme, width, view,
    overflow: document.documentElement.scrollWidth > innerWidth,
    invisibleButtons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && b.getBoundingClientRect().width < 1).length
  }), { theme, width, view }))
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForSelector('.view-head')
  await expect(page.locator('.empty-title')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(SHOTS_DIR, 'v5-empty.png') })
  await page.evaluate(async (root) => {
    const space = await window.api.spaceCreate({ name: '非线性反问题', kind: 'research' })
    const examples = [
      ['text-basic.pdf', '非线性反问题：稳定性与正则化', 'paper'],
      ['scanned.pdf', '随机分析 · 阅读笔记与推导', 'book'],
      ['rotated-90.pdf', '条件分布与弱辨识方向的研究记录', 'paper']
    ]
    for (const [file, title, docType] of examples) {
      const [result] = await window.api.docImport([`${root}/fixtures/${file}`])
      if (!result?.documentId) throw new Error(`Fixture import failed: ${file}`)
      await window.api.libraryEntryUpdate(result.documentId, { title, docType, spaceId: space.id, status: 'ok' })
    }
    await window.api.noteCreate({ title: '稳定性与正则化', noteType: 'note', bodyMd: '# 从观测到未知量\n\n给定观测 $y^\\delta$，考虑非线性算子 $F$ 的逆问题。\n\n$$\\min_x \\|F(x)-y^\\delta\\|^2+\\alpha\\|x-x_0\\|^2$$\n\n## 阅读中的问题\n\n局部稳定性需要哪些条件？正则化参数如何影响误差？' })
    localStorage.setItem('mathwb-theme', 'light')
  }, process.cwd().replaceAll('\\', '/'))
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('mathwb-theme', t), theme)
    await page.reload()
    for (const [width, height] of [[1080, 720], [1440, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height })
      await page.getByRole('button', { name: '文献', exact: true }).click()
      await expect(page.locator('.doc-item')).toHaveCount(3)
      await audit(page, theme, width, 'library')
      await page.screenshot({ path: join(SHOTS_DIR, `v5-${theme}-${width}-library.png`) })
      await page.locator('.doc-item', { hasText: '非线性反问题：' }).click()
      await page.waitForFunction(() => Number(document.querySelector('.page-wrap')?.getAttribute('data-render-seq') ?? 0) >= 1)
      await expect(page.locator('.reading-workspace')).toBeVisible()
      await expect(page.locator('.mnp').getByText('加载中…', { exact: true })).toHaveCount(0)
      await audit(page, theme, width, 'reader')
      await page.screenshot({ path: join(SHOTS_DIR, `v5-${theme}-${width}-reader.png`) })
      await page.getByRole('button', { name: '笔记', exact: true }).click()
      await page.locator('.note-item').first().click()
      await expect(page.locator('.note-textarea')).toBeVisible()
      await expect(page.locator('.katex').first()).toBeVisible()
      await page.screenshot({ path: join(SHOTS_DIR, `v5-${theme}-${width}-note.png`) })
      await audit(page, theme, width, 'note')
    }
  }
  // 待办：速记（含待办/未整理）+ 有疑问知识块队列 + 浮层捕获的视觉验收（收件箱已删，速记的家在待办）
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(async () => {
    await window.api.memoCreate({ text: '用特征代价构造正则项，控制曲率与解的存在性。' })
    await window.api.memoCreate({ text: '! 周三前看完 2401.12345 的收敛性证明' })
    await window.api.memoCreate({ text: '把势函数的想法整理成笔记，链到 [[凸性基础]]。' })
    // 待办面板的「有疑问知识块」队列：一篇带 question 自评的笔记
    const note = await window.api.noteCreate({ title: '稳定性与正则化 · 学习', bodyMd: '## 正则化\n<!-- block:reg -->\n\n为什么需要控制曲率？' })
    const full = await window.api.noteGet(note.id)
    await window.api.noteSave({
      id: note.id, title: full.note.title, noteType: full.note.noteType, bodyMd: full.note.bodyMd,
      aliases: full.note.aliases, verifiedStatus: full.note.verifiedStatus, baseHash: full.baseHash,
      learning: { activeId: 'reg', records: { reg: { status: 'question', fingerprint: 'fp' } } }
    })
  })
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => localStorage.setItem('mathwb-theme', t), theme)
    await page.reload()
    await page.getByRole('button', { name: '待办', exact: true }).click()
    // 3 条速记 + 1 篇有疑问笔记
    await expect(page.locator('.todo-row')).toHaveCount(4)
    await audit(page, theme, 1440, 'todos')
    await page.screenshot({ path: join(SHOTS_DIR, `v5-${theme}-1440-todos.png`) })
    await page.getByRole('button', { name: '写速记', exact: true }).click()
    await expect(page.locator('.quick-capture')).toBeVisible()
    await page.locator('[aria-label="速记内容"]').fill('刚想到：把辨识问题写成极小化')
    await audit(page, theme, 1440, 'quick-capture')
    await page.screenshot({ path: join(SHOTS_DIR, `v5-${theme}-1440-quick-capture.png`) })
    await page.keyboard.press('Escape')
    await expect(page.locator('.quick-capture')).toHaveCount(0)
  }
  await page.getByRole('button', { name: '命令面板', exact: true }).click()
  await expect(page.locator('[cmdk-input]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('[cmdk-input]')).toHaveCount(0)
  await page.getByRole('button', { name: '切换主题', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  // 外壳侧栏已整体退出（筛选收敛）：任何视图都没有 .sidebar 与折叠开关
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(page.getByLabel('折叠或展开侧栏')).toHaveCount(0)
  const result = { shotsDir: SHOTS_DIR, fixtureLibrary: userData, checks, errors }
  writeFileSync(join(SHOTS_DIR, 'v5-audit.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (errors.length || checks.some((c) => c.overflow || c.invisibleButtons)) process.exitCode = 1
} finally {
  await app.close()
}
