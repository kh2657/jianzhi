// 浏览器扩展导入：payload 校验（纯函数）+ 落库行为（真实 Repo）+ 本地 HTTP 层（令牌/来源/提交）。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { parseBrowserImportPayload, importFromBrowser } from '../src/main/browser-import'
import { startAppServer } from '../src/main/server'

const PDF_BYTES = Buffer.from('%PDF-1.4\n%minimal-test-pdf\n')

const repos: TestRepo[] = []
afterEach(async () => {
  while (repos.length) repos.pop()?.dispose()
  vi.restoreAllMocks()
})
afterAll(async () => {
  while (repos.length) repos.pop()?.dispose()
})

async function newRepo(): Promise<TestRepo> {
  const t = await makeTestRepo('mathwb-webimport-')
  repos.push(t)
  return t
}

function pdfPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '弱辨识条件下的 Heston 校准',
    authors: ['张三', 'Li Si'],
    year: 2024,
    venue: 'arXiv',
    doi: '10.1080/example.2024',
    arxivId: '2401.12345',
    sourceUrl: 'https://arxiv.org/abs/2401.12345',
    pdfBase64: PDF_BYTES.toString('base64'),
    ...overrides
  }
}

describe('parseBrowserImportPayload：宽容输入、严格输出', () => {
  it('完整 payload：字段归一（作者字符串拆分、年份转数字、DOI 去前缀）', () => {
    const r = parseBrowserImportPayload({
      title: '  A   Study ',
      authors: '张三; Li Si',
      year: '2024',
      doi: 'https://doi.org/10.1080/abc.2024',
      venue: 'Journal',
      abstract: '摘要',
      tags: ['a', 'b'],
      pdfBase64: PDF_BYTES.toString('base64'),
      filename: 'a paper.pdf'
    })
    if ('error' in r) throw new Error(r.error)
    expect(r.payload.title).toBe('A Study')
    expect(r.payload.authors).toEqual(['张三', 'Li Si'])
    expect(r.payload.year).toBe(2024)
    expect(r.payload.doi).toBe('10.1080/abc.2024')
    expect(r.payload.pdf?.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(r.payload.suggestedName).toBe('a paper.pdf')
  })

  it('缺标题时回退文件名再去扩展名；来源页为 arXiv 时兜底提取 arxivId', () => {
    const r = parseBrowserImportPayload({
      filename: 'Some-Paper-v2.pdf',
      sourceUrl: 'https://arxiv.org/pdf/2401.12345v2'
    })
    if ('error' in r) throw new Error(r.error)
    expect(r.payload.title).toBe('Some-Paper-v2')
    expect(r.payload.arxivId).toBe('2401.12345')
    expect(r.payload.pdf).toBeNull()
  })

  it('非 PDF 字节、缺失本地文件、非法来源 URL 均报用户可读错误', () => {
    const notPdf = parseBrowserImportPayload({ pdfBase64: Buffer.from('hello').toString('base64') })
    expect('error' in notPdf && notPdf.error).toMatch(/不是有效的 PDF/)
    const missing = parseBrowserImportPayload({ localPath: 'Z:/不存在的目录/x.pdf' })
    expect('error' in missing && missing.error).toMatch(/本地文件不存在/)
    const bad = parseBrowserImportPayload({ title: 'x', sourceUrl: 'javascript:alert(1)' })
    if ('error' in bad) throw new Error(bad.error)
    expect(bad.payload.sourceUrl).toBeNull()
  })
})

describe('importFromBrowser：与既有导入管线同路落库', () => {
  it('带 PDF：进「待整理」，写入书目，note 记录来源页', async () => {
    const { repo } = await newRepo()
    const result = await importFromBrowser(repo, pdfPayload())
    expect(result.ok).toBe(true)
    expect(result.duplicate).toBe(false)
    const res = await repo.librarySearch({ q: 'doi:10.1080/example.2024' })
    expect(res.total).toBe(1)
    const meta = res.hits[0].entry
    expect(meta.title).toBe('弱辨识条件下的 Heston 校准')
    expect(meta.authors).toEqual(['张三', 'Li Si'])
    expect(meta.year).toBe(2024)
    expect(meta.arxivId).toBe('2401.12345')
    expect(meta.status).toBe('ok')
    expect(meta.files).toHaveLength(1)
    expect(meta.note).toBe('浏览器导入：https://arxiv.org/abs/2401.12345')
    expect(res.hits[0].section).toBe('待整理')
  })

  it('查重：同 DOI 已在库则报重复且不建新条目（不同 PDF 字节也一样）', async () => {
    const { repo } = await newRepo()
    await importFromBrowser(repo, pdfPayload())
    const again = await importFromBrowser(repo, pdfPayload({ pdfBase64: Buffer.from('%PDF-1.4\nother-bytes\n').toString('base64'), title: '另一个名字' }))
    expect(again.ok).toBe(true)
    expect(again.duplicate).toBe(true)
    const res = await repo.librarySearch({ q: '' })
    expect(res.total).toBe(1)
  })

  it('仅有标题：保持待补全并触发识别回调', async () => {
    const { repo } = await newRepo()
    const recognize = vi.fn()
    const result = await importFromBrowser(repo, { title: '某篇只有标题的论文', pdfBase64: PDF_BYTES.toString('base64') }, { recognize })
    expect(result.ok).toBe(true)
    expect(result.needsReview).toBe(true)
    expect(recognize).toHaveBeenCalledWith(result.documentId)
    const res = await repo.librarySearch({ q: '' })
    expect(res.hits[0].entry.status).toBe('needs-review')
  })

  it('纯书目（无 PDF）：建无文件条目，之后可拖入原文', async () => {
    const { repo } = await newRepo()
    const result = await importFromBrowser(repo, { title: '某网页论文', authors: ['A'], sourceUrl: 'https://example.com/paper' })
    expect(result.ok).toBe(true)
    const res = await repo.librarySearch({ q: '' })
    expect(res.hits[0].entry.files).toHaveLength(0)
    expect(res.hits[0].entry.status).toBe('ok')
  })

  it('localPath 模式：扩展下载兜底的文件复制入库', async () => {
    const { repo } = await newRepo()
    const dir = mkdtempSync(join(tmpdir(), 'mathwb-webimport-file-'))
    try {
      const p = join(dir, 'downloaded.pdf')
      writeFileSync(p, PDF_BYTES)
      const result = await importFromBrowser(repo, { title: '下载兜底的论文', localPath: p })
      expect(result.ok).toBe(true)
      const res = await repo.librarySearch({ q: '' })
      expect(res.hits[0].entry.files).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('本地 HTTP 层：/api/import/ping 与 /api/import', () => {
  it('令牌校验：无令牌 401，正确令牌 ping 通；普通网页 Origin 被 403 拒绝', async () => {
    const t = await newRepo()
    const server = await startAppServer({ repo: t.repo, rendererDir: null, versionInfo: { app: 'test' }, importToken: 'secret-token' })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const bad = await fetch(`${base}/api/import/ping`)
      expect(bad.status).toBe(401)
      const wrong = await fetch(`${base}/api/import/ping`, { headers: { 'X-MWB-Token': 'nope' } })
      expect(wrong.status).toBe(401)
      const evil = await fetch(`${base}/api/import/ping`, { headers: { 'X-MWB-Token': 'secret-token', Origin: 'https://evil.example' } })
      expect(evil.status).toBe(403)
      const ok = await fetch(`${base}/api/import/ping`, { headers: { 'X-MWB-Token': 'secret-token' } })
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { ok: boolean }).ok).toBe(true)
    } finally {
      await server.stop()
    }
  })

  it('POST /api/import：成功落库 + onNotice 通知；非 JSON 内容类型 415；坏 JSON 400', async () => {
    const t = await newRepo()
    const notices: Array<{ message: string; kind: string }> = []
    const server = await startAppServer({
      repo: t.repo,
      rendererDir: null,
      versionInfo: { app: 'test' },
      importToken: 'secret-token',
      onNotice: (n) => notices.push(n)
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const headers = { 'Content-Type': 'application/json', 'X-MWB-Token': 'secret-token' }

      const wrongType = await fetch(`${base}/api/import`, { method: 'POST', headers: { 'X-MWB-Token': 'secret-token' }, body: 'x=1' })
      expect(wrongType.status).toBe(415)

      const badJson = await fetch(`${base}/api/import`, { method: 'POST', headers, body: '{oops' })
      expect(badJson.status).toBe(400)

      const res = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify(pdfPayload()) })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; documentId?: string }
      expect(body.ok).toBe(true)
      expect(notices.some((n) => n.kind === 'success')).toBe(true)

      const again = await fetch(`${base}/api/import`, { method: 'POST', headers, body: JSON.stringify(pdfPayload()) })
      const againBody = (await again.json()) as { ok: boolean; duplicate?: boolean }
      expect(againBody.duplicate).toBe(true)
      expect(notices.some((n) => n.kind === 'info')).toBe(true)

      const found = await t.repo.librarySearch({ q: '' })
      expect(found.total).toBe(1)
    } finally {
      await server.stop()
    }
  })
})
