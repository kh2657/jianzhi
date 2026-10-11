import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApiUrl, buildSearchQuery, parseArxivAtom, pdfHostAllowed } from '../src/main/papers'

const SAMPLE = () => readFileSync(join('tests/fixtures/arxiv-sample.atom'), 'utf8')

describe('arXiv 查询构建（纯函数）', () => {
  it('分类 + 关键词 → AND 组合，各自 OR', () => {
    expect(buildSearchQuery({ categories: 'math.AG, math.NT', keywords: 'moduli space, Calabi-Yau' })).toBe(
      '(cat:math.AG OR cat:math.NT) AND (all:"moduli space" OR all:"Calabi-Yau")'
    )
  })

  it('仅分类 / 仅关键词', () => {
    expect(buildSearchQuery({ categories: 'math.AG', keywords: '' })).toBe('(cat:math.AG)')
    expect(buildSearchQuery({ categories: '', keywords: 'k理论' })).toBe('(all:"k理论")')
  })

  it('API URL 编码与上限钳制', () => {
    const url = new URL(buildApiUrl({ categories: 'math.AG', keywords: 'moduli', maxResults: 999 }))
    expect(url.searchParams.get('max_results')).toBe('200')
    expect(url.searchParams.get('sortBy')).toBe('submittedDate')
    expect(url.searchParams.get('search_query')).toContain('cat:math.AG')
    expect(() => buildApiUrl({ categories: '', keywords: '', maxResults: 50 })).toThrow('订阅条件为空')
  })
})

describe('arXiv Atom 解析（真实结构样本）', () => {
  const entries = () => parseArxivAtom(SAMPLE())

  it('解析出全部条目与核心字段', () => {
    const list = entries()
    expect(list).toHaveLength(2)
    expect(list[0].arxivId).toBe('2510.01234v1')
    expect(list[0].title).toBe('Moduli Spaces of Stable Sheaves on K3 Surfaces')
    expect(list[0].authors).toEqual(['Alice Author', 'Bob Collaborator'])
    expect(list[0].abstract).toContain('smoothness criterion')
    expect(list[0].primaryCategory).toBe('math.AG')
    expect(list[0].categories).toEqual(['math.AG', 'math.NT'])
    expect(list[0].pdfUrl).toBe('http://arxiv.org/pdf/2510.01234v1')
    expect(list[0].absUrl).toBe('https://arxiv.org/abs/2510.01234v1')
  })

  it('缺 pdf link 时兜底构造官方 URL', () => {
    const list = entries()
    expect(list[1].pdfUrl).toBe('https://arxiv.org/pdf/2510.00567v2')
    expect(list[1].authors).toEqual(['Carol Chen'])
  })

  it('畸形输入容错', () => {
    expect(parseArxivAtom('not xml at all')).toEqual([])
    expect(parseArxivAtom('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toEqual([])
    expect(
      parseArxivAtom('<feed><entry><id>no-abs-segment</id><title>t</title></entry></feed>')
    ).toEqual([])
  })
})

describe('下载主机白名单（防 SSRF）', () => {
  it('arxiv.org 及子域 https 放行', () => {
    expect(pdfHostAllowed(new URL('https://arxiv.org/pdf/2510.01234v1'))).toBe(true)
    expect(pdfHostAllowed(new URL('https://export.arxiv.org/pdf/2510.01234v1'))).toBe(true)
  })

  it('内网与任意主机拒绝', () => {
    expect(pdfHostAllowed(new URL('https://evil.example.com/paper.pdf'))).toBe(false)
    expect(pdfHostAllowed(new URL('https://127.0.0.1:8080/paper.pdf'))).toBe(false)
    expect(pdfHostAllowed(new URL('file:///etc/passwd'))).toBe(false)
    expect(pdfHostAllowed(new URL('ftp://arxiv.org/x.pdf'))).toBe(false)
  })

  it('测试模式（设置 MATHWB_ARXIV_API）允许本地 mock', () => {
    process.env.MATHWB_ARXIV_API = 'http://127.0.0.1:19999/api/query'
    expect(pdfHostAllowed(new URL('http://127.0.0.1:19999/paper.pdf'))).toBe(true)
    delete process.env.MATHWB_ARXIV_API
    expect(pdfHostAllowed(new URL('http://127.0.0.1:19999/paper.pdf'))).toBe(false)
  })
})
