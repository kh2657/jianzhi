import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDFJS_SCOPE_CLASS, scopePdfjsCss, splitSelectorList } from '../scripts/scope-pdfjs-css'

describe('splitSelectorList（顶层逗号拆分）', () => {
  it('普通顶层逗号拆分', () => {
    expect(splitSelectorList('.a, .b ,\n.c')).toEqual(['.a', ' .b ', '\n.c'])
  })

  it(':is()/:not()/属性选择器内的逗号不拆', () => {
    const list = ':is(.dialog .mainContainer) button:not(:is(.toggle-button,.closeButton)),[data-x="a,b"]'
    expect(splitSelectorList(list)).toEqual([
      ':is(.dialog .mainContainer) button:not(:is(.toggle-button,.closeButton))',
      '[data-x="a,b"]'
    ])
  })

  it('引号内的逗号与转义不拆', () => {
    expect(splitSelectorList('[title="a,b"],[t=\'c,d\']')).toEqual(['[title="a,b"]', "[t='c,d']"])
  })
})

describe('scopePdfjsCss（选择器作用域变换）', () => {
  it('普通选择器加前缀，主体原样保留', () => {
    expect(scopePdfjsCss('.textLayer{position:absolute;inset:0}')).toBe(
      `.${PDFJS_SCOPE_CLASS} .textLayer{position:absolute;inset:0}`
    )
  })

  it(':root 改写为作用域类（自定义属性沿子树继承）', () => {
    expect(scopePdfjsCss(':root{--x:1}')).toBe(`.${PDFJS_SCOPE_CLASS}{--x:1}`)
  })

  it('html/body 页面级规则整条丢弃', () => {
    expect(scopePdfjsCss('body{margin:0}')).toBe('')
    expect(scopePdfjsCss('html{font-size:16px}.textLayer{opacity:1}')).toBe(
      `.${PDFJS_SCOPE_CLASS} .textLayer{opacity:1}`
    )
  })

  it('选择器列表：部分命中时只保留存活选择器；全丢弃时删整条', () => {
    expect(scopePdfjsCss('body,.textLayer{color:red}')).toBe(`.${PDFJS_SCOPE_CLASS} .textLayer{color:red}`)
    expect(scopePdfjsCss('html,body{margin:0}')).toBe('')
  })

  it('@media/@supports 递归处理，嵌套 :root 同样改写', () => {
    const out = scopePdfjsCss('@media screen and (forced-colors: active){:root{--o:2}.textLayer{color:x}}')
    expect(out).toBe(`@media screen and (forced-colors: active){.${PDFJS_SCOPE_CLASS}{--o:2}.${PDFJS_SCOPE_CLASS} .textLayer{color:x}}`)
  })

  it('@font-face/@page 等无选择器语义的块原样保留', () => {
    const css = '@font-face{font-family:x;src:url(a.woff2)}@page{margin:1cm}'
    expect(scopePdfjsCss(css)).toBe(css)
  })

  it('值中的 data URL（含分号/花括号/引号）不被截断', () => {
    const url = `url("data:image/svg+xml,<svg style='fill:rgba(0,0,255,.13);{x}'/>{y}")`
    const css = `:root{--icon:${url}}`
    expect(scopePdfjsCss(css)).toBe(`.${PDFJS_SCOPE_CLASS}{--icon:${url}}`)
  })

  it('值中的花括号不影响块匹配（引号感知）', () => {
    const css = `.a{content:"}{ not a brace end"}`
    expect(scopePdfjsCss(css)).toBe(`.${PDFJS_SCOPE_CLASS} .a{content:"}{ not a brace end"}`)
  })
})

describe('scopePdfjsCss（真实 pdf_viewer.css 全量断言）', () => {
  const src = readFileSync(resolve(__dirname, '../node_modules/pdfjs-dist/web/pdf_viewer.css'), 'utf8')
  const out = scopePdfjsCss(src)

  it('没有任何未加作用域的同名全局规则残留（.sidebar/.toolbar/.dialog/.textLayer）', () => {
    for (const cls of ['sidebar', 'toolbar', 'dialog', 'textLayer', 'annotationLayer']) {
      // 负向环视：`.cls{` 只有紧跟在 `.pdfjs-root ` 之后才合法
      const bare = new RegExp(`(?<!\\.${PDFJS_SCOPE_CLASS} )\\.${cls}\\s*\\{`)
      expect(bare.test(out), `发现未作用域化的 .${cls} 规则`).toBe(false)
      // 输入中存在顶层 .cls{ 规则时，输出必须是作用域化形式（类名清单仅取自真实 vendor 文件）
      if (new RegExp(`^\\.${cls}\\s*\\{`, 'm').test(src)) {
        expect(out).toContain(`.${PDFJS_SCOPE_CLASS} .${cls}{`)
      }
    }
  })

  it(':root 已全部改写为作用域类', () => {
    expect(/(^|[}\s;]):root\s*\{/.test(out)).toBe(false)
  })

  it('html/body 页面级规则不存在', () => {
    expect(/(^|[}\s;])(html|body)[\s,{:]/.test(out)).toBe(false)
  })

  it('花括号数量与输入一致（结构无损）', () => {
    const count = (s: string, ch: string) => s.split(ch).length - 1
    expect(count(out, '{')).toBe(count(src, '{'))
    expect(count(out, '}')).toBe(count(src, '}'))
  })

  it('文本层关键样式保留在作用域内（划选摘录依赖）', () => {
    const block = /\.pdfjs-root \.textLayer\{[^}]*\}/.exec(out)?.[0] ?? ''
    expect(block).toContain('position:absolute')
    expect(block).toContain('transform-origin:0 0')
  })

  it('带分号/引号的 data URL 变量完整保留', () => {
    const m = /--xfa-unfocused-field-background:(url\("data:image\/svg\+xml[^"]*"\));/.exec(src)?.[1]
    expect(m, '输入中应存在该 data URL').toBeTruthy()
    expect(out).toContain(m!)
  })
})
