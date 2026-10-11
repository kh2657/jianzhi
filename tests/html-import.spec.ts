import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_HTML_BYTES } from '../src/main/assets/library'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'
import { startAppServer } from '../src/main/server'

let root: string
let t: TestRepo
let repo: TestRepo['repo']
const html = '<!doctype html><html><meta charset="utf-8"><style>p{color:red}</style><p>泛函 $L^2$</p><script>window.test=1</script></html>'
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mathwb-html-'))
  t = await makeTestRepo('mathwb-html-')
  repo = t.repo
})
afterEach(() => t.dispose())
function file(name: string, body = html) { const path = join(root, name); writeFileSync(path, body); return path }

describe('HTML 原件与笔记来源', () => {
  it('接受 html / htm 并保持原始字节，重复导入复用，读取接口仅按文档 ID', async () => {
    const path = file('泛函.HTML')
    const [first] = await repo.importDocuments([path])
    expect(first.ok).toBe(true)
    const document = repo.openDocument(first.documentId!)
    expect(document.mediaType).toBe('text/html')
    expect(repo.listDocuments()[0].mediaType).toBe('text/html')
    const served = await repo.resolveServingFile(document.assetId, 'original')
    expect(readFileSync(served.absPath)).toEqual(readFileSync(path))
    rmSync(path)
    expect(await repo.readHtml(first.documentId!)).toBe(html)
    const [duplicate] = await repo.importDocuments([file('副本.htm')])
    expect(duplicate).toMatchObject({ duplicate: true, documentId: first.documentId })
    expect(repo.listDocuments()).toHaveLength(1)
    await expect(repo.readHtml('/etc/passwd')).rejects.toThrow('不存在')
  })

  it('拒绝过大的 HTML，PDF 原校验仍有效', async () => {
    const [oversized] = await repo.importDocuments([file('large.html', 'x'.repeat(MAX_HTML_BYTES + 1))])
    expect(oversized).toMatchObject({ ok: false })
    expect(oversized.error).toContain('10 MB')
    expect(repo.listDocuments()).toHaveLength(0)
    const [fake] = await repo.importDocuments([file('fake.pdf')])
    expect(fake.error).toContain('不是 PDF')
    const [pdf] = await repo.importDocuments(['fixtures/text-basic.pdf'])
    await expect(repo.readHtml(pdf.documentId!)).rejects.toThrow('不是 HTML')
  })

  it('HTML 笔记关联整个文档并继承学习区，重启后保留', async () => {
    const space = await repo.createSpace({ name: '泛函', kind: 'course' })
    const [doc] = await repo.importDocuments([file('教材.html')], { spaceId: space.id })
    const note = await repo.createNote({ title: '弱收敛', documentId: doc.documentId })
    expect(note.spaceId).toBe(space.id)
    expect(repo.getNoteFull(note.id).documents).toEqual([{ documentId: doc.documentId, title: '教材', mediaType: 'text/html' }])
    expect(repo.getNoteFull(note.id).anchors).toEqual([])
    const repo2 = await t.reopen()
    expect(repo2.getNoteFull(note.id).documents[0].documentId).toBe(doc.documentId)
    await expect(repo2.readHtml(doc.documentId!)).resolves.toBe(html)
  })

  it('HTML 原件响应有独立 sandbox CSP，不允许同源、网络、表单或外部脚本', async () => {
    const [doc] = await repo.importDocuments([file('interactive.html')])
    const opened = repo.openDocument(doc.documentId!)
    const server = await startAppServer({ repo, rendererDir: null, versionInfo: {} })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${opened.url}`)
      expect(response.status).toBe(200)
      const csp = response.headers.get('content-security-policy')!
      expect(csp).toContain('sandbox allow-scripts;')
      expect(csp).not.toContain('allow-same-origin')
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain("script-src 'unsafe-inline'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).not.toContain('frame-ancestors')
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toBe(html)
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`)
      expect(health.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    } finally { await server.stop() }
  })
})
