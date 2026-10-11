import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navigateTo, launchApp, rmTempDir } from './helpers/launch'

// Optional public-paper acceptance fixtures: see docs/verification.md §13.
const source = process.env.MATHWB_REAL_PAPERS_DIR
const papers = [
  { id: '1712.01499', file: 'theory-1712.01499.pdf', title: 'A converse result for Banach space convergence rates in Tikhonov-type convex regularization of ill-posed linear equations',
    question: '第 7 页的核心条件在整个证明链里起什么作用？', conclusion: '记录关键引理的论证步骤；逆函数存在条件仍需复查。' },
  { id: '1902.00151', file: 'experiment-1902.00151.pdf', title: 'A dual Newton based preconditioned proximal point algorithm for exclusive lasso models',
    question: '算法的收敛性假设是什么？', conclusion: '记录算法要点与停止准则；实验设置是否一致仍需核查。' }
]

test('两篇真实论文：候选→第7页疑问→手动精读卡→依据回原页→重启', async () => {
  test.skip(!source || papers.some(paper => !existsSync(join(source, paper.file))), '需提供 MATHWB_REAL_PAPERS_DIR 中的两份公开原文')
  let port = 0
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/query')) {
      const entries = papers.map(paper => `<entry><id>http://arxiv.org/abs/${paper.id}v1</id><title>${paper.title}</title><summary>Real published paper used for local reading acceptance.</summary><published>${new Date().toISOString()}</published><author><name>Original authors</name></author><link title="pdf" href="http://127.0.0.1:${port}/pdf/${paper.id}" type="application/pdf"/></entry>`).join('')
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' }); res.end(`<feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`)
    } else {
      const paper = papers.find(item => req.url === `/pdf/${item.id}`)
      if (!paper) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(readFileSync(join(source!, paper.file)))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'mathwb-real-reading-'))
  // 每次启动都必须带同样的环境：MATHWB_ARXIV_API 既指向测试源，也是主进程允许从
  // 127.0.0.1 下载 PDF 的开关（pdfHostAllowed 防 SSRF），重启后缺失会导致导入被拒。
  const appEnv = { MATHWB_ARXIV_API: `http://127.0.0.1:${port}/api/query` }
  let app = await launchApp(dir, appEnv)
  try {
    await app.page.evaluate(() => window.api.paperFeedCreate({ name: '真实论文验收', categories: 'math.FA', keywords: '' }))
    await navigateTo(app.page, '每日论文')
    await app.page.getByRole('button', { name: /抓取/ }).first().click()
    for (const paper of papers) {
      const { page } = app
      await page.locator('.paper-card', { hasText: paper.title }).getByRole('button', { name: '开始阅读' }).click()
      await expect(page.locator('.page-wrap[data-page-index="0"]')).toBeVisible()
      await page.locator('.page-input').fill('7'); await page.locator('.page-input').press('Enter')
      await expect(page.locator('.page-wrap[data-page-index="0"]')).toHaveAttribute('data-page-index', '6')
      await page.getByLabel('随手记内容').fill(paper.question)
      await page.locator('.rw-quick-options > summary').click()
    await page.getByRole('button', { name: '记下疑问', exact: true }).click()
      await expect(page.locator('.mnp-item', { hasText: paper.question })).toBeVisible()
      await page.getByRole('tab', { name: '整理', exact: true }).click()
      const section = page.getByTestId('card-section-findings')
      await section.locator('textarea').fill(paper.conclusion)
      await section.locator('summary').click()
      await section.getByRole('checkbox', { name: /依据/ }).check()
      await expect(section).toContainText('待核对')
      await page.locator('.page-input').fill('8'); await page.locator('.page-input').press('Enter')
      await section.getByRole('button', { name: /回原文/ }).click()
      await expect(page.locator('.page-input')).toHaveValue('7')
      await page.setViewportSize({ width: 1512, height: 982 })
      // 验收截图落 test-results/（已忽略）：真实论文截图含个人阅读内容，不进仓库
      await page.screenshot({ path: `test-results/reading-real-${paper.id}.png` })
      expect(app.consoleErrors).toEqual([])
      await app.app.close()
      app = await launchApp(dir, appEnv)
      await expect(app.page.locator('.page-input')).toHaveValue('7')
      await expect(app.page.getByTestId('card-section-findings').locator('textarea')).toHaveValue(paper.conclusion)
      await navigateTo(app.page, '每日论文')
    }
  } finally {
    await app.app.close().catch(() => undefined)
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmTempDir(dir)
  }
})
