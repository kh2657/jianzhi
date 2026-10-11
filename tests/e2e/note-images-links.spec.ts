import { expect, test, type Locator } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, type LaunchedApp, rmTempDir } from './helpers/launch'

/** 导入材料并进入阅读器（链接注释位于第 1 页） */
async function openLinksDoc(app: LaunchedApp): Promise<void> {
  const path = join(process.cwd(), 'fixtures/links.pdf')
  await app.page.evaluate(async (p) => {
    const [result] = await window.api.docImport([p], { docType: 'paper' })
    return result.documentId
  }, path)
  await app.page.reload()
  await navigateTo(app.page, '文献')
  await app.page.locator('.doc-item').first().click()
  await expect(app.page.getByTestId('reading-workspace')).toBeVisible()
}

async function clickLinkBox(page: LaunchedApp['page'], locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, '链接命中区应有几何位置').not.toBeNull()
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

test('PDF 链接：内跳翻页、外部网址走系统浏览器、摘录模式下不误触', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-links-'))
  const app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const { page } = app
    await openLinksDoc(app)
    const internal = page.locator('.pdf-link-hit[data-pdf-link-kind="internal"]')
    const external = page.locator('.pdf-link-hit[data-pdf-link-kind="external"]')
    await expect(internal).toHaveCount(1)
    await expect(external).toHaveCount(1)
    await expect(internal).toHaveAttribute('data-pdf-link-target', '1')
    await expect(external).toHaveAttribute('data-pdf-link-target', 'https://arxiv.org/')

    const pageInput = page.getByLabel('页码')
    await expect(pageInput).toHaveValue('1')

    // 摘录模式：矩形捕获层覆盖页面，点击链接位置不得触发跳页
    await page.getByRole('tab', { name: '摘录' }).click()
    await clickLinkBox(page, internal)
    await expect(pageInput).toHaveValue('1')
    await page.getByRole('tab', { name: '阅读', exact: true }).click()

    // 外部链接：渲染层不导航，主进程校验后记录（E2E 环境不真开浏览器）
    await clickLinkBox(page, external)
    await expect(pageInput).toHaveValue('1')
    await expect.poll(() => page.evaluate(() => window.api.testLastExternalUrl())).toBe('https://arxiv.org/')

    // 内部链接：点击跳到目标页（注释里 /Dest 指向第 2 页，显示页码 2）
    await clickLinkBox(page, internal)
    await expect(pageInput).toHaveValue('2')

    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})

test('笔记插图：文件选择入库 → 正文 asset: 引用 → 预览真实加载 → 粘贴路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-noteimg-'))
  const app = await launchApp(dir, { MATHWB_E2E: '1' })
  try {
    const { page } = app
    await navigateTo(page, '笔记')
    await page.getByRole('button', { name: '＋ 新笔记' }).click()
    await expect(page.locator('.note-title-input')).toBeVisible()
    const body = page.getByLabel('笔记正文')
    await expect(body).toBeVisible()
    await body.fill('演算过程如下：')

    // 路径一：插图按钮（隐藏 file input），用真实照片夹具
    await page.locator('.note-edit-tools input[type="file"]').setInputFiles(join(process.cwd(), 'fixtures/photo.png'))
    const ta = page.getByLabel('笔记正文')
    await expect(ta).toHaveValue(/演算过程如下：\n!\[\]\(asset:[0-9a-f]{64}\)/)

    const value = await ta.inputValue()
    const match = value.match(/asset:([0-9a-f]{64})/)
    expect(match, '正文应含 asset: 引用').not.toBeNull()
    const assetId = match![1]

    // 落盘：库目录 笔记/附件/<sha256>.png
    expect(existsSync(join(dir, 'library', '笔记', '附件', `${assetId}.png`))).toBe(true)

    // 预览真实加载（防抖渲染后 img naturalWidth > 0）
    const img = page.locator('.note-preview img')
    await expect.poll(
      async () =>
        (await img.count()) === 1
          ? img.evaluate((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0)
          : false,
      { timeout: 15000 }
    ).toBe(true)

    // 服务端可回取（同源 /api/asset）
    const resp = await page.evaluate(async (id) => {
      const r = await fetch(`/api/asset/${id}?variant=display`)
      return { status: r.status, type: r.headers.get('content-type') }
    }, assetId)
    expect(resp.status).toBe(200)
    expect(resp.type).toBe('image/png')

    // 路径二：模拟截图粘贴（ClipboardEvent + DataTransfer），PNG 文件头字节过嗅探
    await page.evaluate(() => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'clip.png', { type: 'image/png' }))
      const ta = document.querySelector('.note-textarea') as HTMLTextAreaElement
      ta.focus()
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect(ta).toHaveValue(/asset:[0-9a-f]{64}[\s\S]*asset:[0-9a-f]{64}/)
    expect(app.consoleErrors).toEqual([])
  } finally {
    await app.app.close().catch(() => undefined)
    rmTempDir(dir)
  }
})
