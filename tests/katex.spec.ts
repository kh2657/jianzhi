// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { renderMarkdown } from '../src/renderer/src/md'

describe('KaTeX 公式渲染', () => {
  it('合法公式渲染为 katex 输出', () => {
    const html = katex.renderToString('\\frac{d}{dx}e^x = e^x', { throwOnError: false })
    expect(html).toContain('katex')
  })

  it('非法公式不抛异常且保留原文（throwOnError:false）', () => {
    const html = katex.renderToString('\\frac{', { throwOnError: false })
    expect(html).toContain('katex-error')
    expect(html).toContain('\\frac{')
  })
})

describe('Markdown 管线（安全 + 数学 + 代码保护）', () => {
  it('行内与独立公式均渲染', () => {
    const html = renderMarkdown('行内 $x^2$ 与独立 $$\\int_a^b f(x)\\,dx$$ 结束')
    expect((html.match(/katex/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(html).toContain('katex-display')
  })

  it('代码块中的 $ 不被当作公式', () => {
    const html = renderMarkdown('```\ncost = $5 and $6\n```')
    expect(html).toContain('$5 and $6')
    expect(html).not.toContain('katex')
  })

  it('原始 HTML 主动内容被移除（script/iframe/onerror）', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('href="javascript:')
  })

  it('非法 LaTeX 原文保留', () => {
    const html = renderMarkdown('错误公式 $\\frac{$ 继续')
    expect(html).toContain('katex-error')
    expect(html).toContain('\\frac{')
  })

  it('常用 Markdown 结构保留', () => {
    const html = renderMarkdown('# 标题\n\n- 项目 A\n- 项目 B\n\n**加粗** 与 `code`')
    expect(html).toContain('<h1')
    expect(html).toContain('<li')
    expect(html).toContain('<strong')
    expect(html).toContain('<code')
  })
})
