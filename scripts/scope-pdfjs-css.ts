import type { Plugin } from 'vite'

/**
 * 把 pdfjs-dist/web/pdf_viewer.css 的所有选择器收进 `.pdfjs-root` 作用域。
 *
 * 背景：该文件是 PDF.js 整套查看器样式，含 .sidebar/.toolbar/.dialog 等与应用同名的全局类，
 * 直接 import 会按打包顺序覆盖应用自身样式（历史缺陷：打开阅读器后侧栏变白，宽度被改为
 * pdfjs 的 239px）。本应用只渲染 TextLayer，不使用 PDF.js 的 UI 组件，因此不做手工维护的
 * 样式子集，而是对 vendor 文件做机械变换：
 *   - 普通选择器加前缀 `.pdfjs-root `（ReaderView 根元素挂该类）；
 *   - `:root`/`:host` 改写为 `.pdfjs-root`（自定义属性沿子树继承，行为等价）；
 *   - `html`/`body` 页面级选择器的规则整条丢弃（作用域内无对应元素）；
 *   - @media / @supports 内部递归处理；@font-face / @page / @property 等原样保留。
 * 机械变换跟随 pdfjs 版本，升级 pdfjs-dist 无需手工同步样式子集。
 *
 * 回归测试：tests/pdfjs-css-scope.spec.ts（变换正确性）、tests/e2e/p0-css-scope.spec.ts（运行时效果）。
 */
export const PDFJS_SCOPE_CLASS = 'pdfjs-root'

/** 页面级选择器：作用域内不存在对应元素，整条规则丢弃 */
const PAGE_LEVEL = new Set(['html', 'body'])

/** 按顶层逗号拆分选择器列表；:is()/:not()/属性选择器/引号内的逗号不拆 */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(' || ch === '[') {
      depth++
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1)
    } else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
  }
  parts.push(list.slice(start))
  return parts
}

function scopeSelector(selector: string): string | null {
  const s = selector.trim()
  if (!s) return null
  if (s === ':root' || s === ':host') return `.${PDFJS_SCOPE_CLASS}`
  if (PAGE_LEVEL.has(s)) return null
  if (s === '*') return `.${PDFJS_SCOPE_CLASS} *`
  return `.${PDFJS_SCOPE_CLASS} ${s}`
}

const RECURSIVE_AT_RULES = new Set(['@media', '@supports', '@container', '@layer'])

/** 引号感知地找到与 start（'{' 的下标）匹配的 '}'，返回其下标；找不到返回 -1 */
function findClosingBrace(css: string, openBrace: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = openBrace; i < css.length; i++) {
    const ch = css[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 从 i 开始跳过空白与注释，返回下一个非空白/注释字符的下标 */
function skipTrivia(css: string, i: number): number {
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 2
    } else if (/\s/.test(css[i])) {
      i++
    } else {
      break
    }
  }
  return i
}

/** 递归处理一层块结构：所有样式规则的顶层选择器加作用域前缀 */
function walk(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const triviaStart = i
    i = skipTrivia(css, i)
    out += css.slice(triviaStart, i)
    if (i >= css.length) break

    // 读前奏（引号/括号感知），直到顶层 '{' 或 ';'
    const preludeStart = i
    let depth = 0
    let quote: string | null = null
    while (i < css.length) {
      const ch = css[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        i++
        continue
      }
      if (ch === '"' || ch === "'") quote = ch
      else if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
      else if (ch === '{' || (ch === ';' && depth === 0)) break
      i++
    }
    const prelude = css.slice(preludeStart, i)
    if (css[i] !== '{') {
      // @import/@charset 等语句（或末尾残片）原样保留
      out += prelude
      continue
    }

    const openBrace = i
    const closeBrace = findClosingBrace(css, openBrace)
    if (closeBrace === -1) {
      // 不完整的块（截断输入）：原样保留剩余内容
      out += css.slice(preludeStart)
      return out
    }

    const trimmed = prelude.trim()
    const atName = /^@([\w-]+)/.exec(trimmed)?.[1]
    if (atName && RECURSIVE_AT_RULES.has(`@${atName}`)) {
      out += prelude + '{' + walk(css.slice(openBrace + 1, closeBrace)) + '}'
    } else if (atName) {
      // @font-face/@page/@property 等无选择器语义的块原样保留
      out += css.slice(preludeStart, closeBrace + 1)
    } else {
      const scoped = splitSelectorList(trimmed).map(scopeSelector)
      const kept = scoped.filter((s): s is string => s !== null)
      if (kept.length === 0) {
        // 整条规则丢弃（如纯 html/body 页面规则）
      } else {
        out += kept.join(',') + css.slice(openBrace, closeBrace + 1)
      }
    }
    i = closeBrace + 1
  }
  return out
}

export function scopePdfjsCss(css: string): string {
  return walk(css)
}

/** electron-vite renderer 插件：只命中 pdfjs-dist 的 pdf_viewer.css */
export function pdfjsCssScopePlugin(): Plugin {
  return {
    name: 'mathwb:scope-pdfjs-css',
    enforce: 'pre',
    transform(code, id) {
      const path = id.split('?', 1)[0].replace(/\\/g, '/')
      if (!path.endsWith('/web/pdf_viewer.css')) return null
      return { code: scopePdfjsCss(code), map: null }
    }
  }
}
