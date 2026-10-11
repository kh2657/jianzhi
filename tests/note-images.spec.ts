// @vitest-environment jsdom
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/renderer/src/md'
import { externalOpenableUrl } from '../src/main/url-guard'
import { extImageKind, sniffImageKind } from '../src/main/assets/library'
import { makeTestRepo, type TestRepo } from './helpers/folder-repo'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

// ---------- markdown：asset: 引用展开 ----------

describe('renderMarkdown 笔记插图（asset: 引用）', () => {
  it('图片引用展开为 /api/asset（variant=display），hash 归一化小写', () => {
    const SHA_UPPER = 'ABCDEF' + '0123456789'.repeat(5) + 'ABCDEFAB' // 64 位含大写
    const html = renderMarkdown(`看这里\n\n![](asset:${SHA_UPPER})`)
    expect(html).toContain(`<img src="/api/asset/${SHA_UPPER.toLowerCase()}?variant=display"`)
  })

  it('带 alt 与空格的语法同样展开', () => {
    const html = renderMarkdown(`![演算]( asset:${SHA_A} )`)
    expect(html).toContain(`src="/api/asset/${SHA_A}?variant=display"`)
    expect(html).toContain('alt="演算"')
  })

  it('代码段内的 asset: 语法保持原样（不误展开）', () => {
    const src = '示例：`![](asset:' + SHA_A + ')`'
    const html = renderMarkdown(src)
    expect(html).toContain(`![](asset:${SHA_A})`)
    expect(html).not.toContain('/api/asset/')
  })

  it('非 64 位十六进制的引用不展开（防误伤普通文本）', () => {
    const html = renderMarkdown(`![](asset:${SHA_A.slice(0, 63)}) ![](asset:zz${'1'.repeat(60)})`)
    expect(html).not.toContain('/api/asset/')
  })

  it('与双链、公式共存互不干扰', () => {
    const html = renderMarkdown(`[[弱辨识性]] 与 $x^2$ 以及 ![](asset:${SHA_B})`)
    expect(html).toContain('class="wikilink"')
    expect(html).toContain('katex')
    expect(html).toContain(`/api/asset/${SHA_B}?variant=display`)
  })
})

// ---------- 图片类型识别 ----------

describe('sniffImageKind / extImageKind', () => {
  it('PNG/JPEG/GIF/WEBP/BMP/TIFF 按文件头识别', () => {
    expect(sniffImageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ ext: '.png', mediaType: 'image/png' })
    expect(sniffImageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ext: '.jpg', mediaType: 'image/jpeg' })
    expect(sniffImageKind(new TextEncoder().encode('GIF89a....'))).toEqual({ ext: '.gif', mediaType: 'image/gif' })
    expect(sniffImageKind(new TextEncoder().encode('RIFF1234WEBPVP8 '))).toEqual({ ext: '.webp', mediaType: 'image/webp' })
    expect(sniffImageKind(new TextEncoder().encode('BM....'))).toEqual({ ext: '.bmp', mediaType: 'image/bmp' })
    expect(sniffImageKind(new TextEncoder().encode('II*\u0000..'))).toEqual({ ext: '.tiff', mediaType: 'image/tiff' })
  })

  it('HEIC（ISO-BMFF ftyp）按 brand 识别', () => {
    const bytes = new Uint8Array(24)
    bytes.set([0, 0, 0, 0x18], 0)
    bytes.set(new TextEncoder().encode('ftypheic'), 4)
    expect(sniffImageKind(bytes)).toEqual({ ext: '.heic', mediaType: 'image/heic' })
  })

  it('未知内容返回 null，扩展名兜底 HEIC', () => {
    expect(sniffImageKind(new TextEncoder().encode('hello world'))).toBeNull()
    expect(extImageKind('草稿.heic')).toEqual({ ext: '.heic', mediaType: 'image/heic' })
    expect(extImageKind('document.pdf')).toBeNull()
  })
})

// ---------- 外部链接守卫 ----------

describe('externalOpenableUrl', () => {
  it('放行 http/https 并归一化', () => {
    expect(externalOpenableUrl('https://arxiv.org/abs/1234')).toBe('https://arxiv.org/abs/1234')
    expect(externalOpenableUrl('http://example.com/a b?x=1')).toContain('/a%20b')
  })

  it('拒绝危险协议与非法输入', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'mathworkbench://paper?id=x', 'data:text/html,<script>', 'ftp://x.com', '', 'not a url', 123, null, undefined]) {
      expect(externalOpenableUrl(bad as unknown as string)).toBeNull()
    }
  })
})

// ---------- 存储：addNoteImage → 扫描索引 → 资产服务 ----------

/** 最小「PNG」字节（带真实文件头即可过嗅探；服务层不解码） */
const fakePng = (body: number[]): Uint8Array =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body])

describe('笔记附件存储（笔记/附件/<sha256>.<ext>）', () => {
  it('addNoteImage 落盘为内容寻址文件，/api 解析可回读', async () => {
    const t: TestRepo = await makeTestRepo('mathwb-noteimg-')
    try {
      const bytes = fakePng([1, 2, 3, 4])
      const r = await t.repo.addNoteImage({ data: bytes, fileName: 'clip.png' })
      expect(r.mediaType).toBe('image/png')
      expect(r.byteSize).toBe(bytes.byteLength)
      const rel = join('笔记', '附件', `${r.assetId}.png`)
      expect(existsSync(join(t.root, rel))).toBe(true)
      const serving = await t.repo.resolveServingFile(r.assetId, 'original')
      expect(serving.absPath.endsWith(rel)).toBe(true)
      expect(serving.mediaType).toBe('image/png')
    } finally {
      t.dispose()
    }
  })

  it('同一张图重复插入幂等（不重复占空间）', async () => {
    const t: TestRepo = await makeTestRepo('mathwb-noteimg-dup-')
    try {
      const bytes = fakePng([9, 9, 9])
      const r1 = await t.repo.addNoteImage({ data: bytes })
      const r2 = await t.repo.addNoteImage({ data: bytes })
      expect(r1.assetId).toBe(r2.assetId)
      expect(existsSync(join(t.root, '笔记', '附件', `${r1.assetId}.png`))).toBe(true)
    } finally {
      t.dispose()
    }
  })

  it('重启（全量重扫）后附件仍在索引中可用', async () => {
    const t: TestRepo = await makeTestRepo('mathwb-noteimg-reopen-')
    try {
      const r = await t.repo.addNoteImage({ data: fakePng([7, 7]) })
      const repo2 = await t.reopen()
      const serving = await repo2.resolveServingFile(r.assetId, 'original')
      expect(serving.mediaType).toBe('image/png')
    } finally {
      t.dispose()
    }
  })

  it('扫描器对附件目录宽容：合法 sha 文件入索引，杂名文件静默跳过', async () => {
    const t: TestRepo = await makeTestRepo('mathwb-noteimg-junk-')
    try {
      const bytes = fakePng([5])
      const { createHash } = await import('node:crypto')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const dir = join(t.root, '笔记', '附件')
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${sha}.png`), bytes)
      writeFileSync(join(dir, '截图 2026.png'), bytes) // 非 sha 名
      writeFileSync(join(dir, `${'z'.repeat(64)}.png`), bytes) // 非法 sha 名
      const repo2 = await t.reopen()
      expect(t.library.index.malformed).toEqual([])
      await expect(repo2.resolveServingFile(sha, 'original')).resolves.toMatchObject({ mediaType: 'image/png' })
      await expect(repo2.resolveServingFile('z'.repeat(64), 'original')).rejects.toThrow(/未知资产/)
    } finally {
      t.dispose()
    }
  })

  it('嗅探不出且扩展名不认识的字节被拒绝，HEIC 靠扩展名兜底', async () => {
    const t: TestRepo = await makeTestRepo('mathwb-noteimg-reject-')
    try {
      await expect(t.repo.addNoteImage({ data: new TextEncoder().encode('not an image at all') })).rejects.toThrow(/不支持的图片格式/)
      const r = await t.repo.addNoteImage({ data: new TextEncoder().encode('ftyp-ish heif bytes'), fileName: 'photo.heic' })
      expect(r.mediaType).toBe('image/heic')
      expect(existsSync(join(t.root, '笔记', '附件', `${r.assetId}.heic`))).toBe(true)
    } finally {
      t.dispose()
    }
  })
})
