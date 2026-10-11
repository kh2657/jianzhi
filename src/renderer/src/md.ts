import { marked } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'

// Markdown + LaTeX 渲染管线：
// 1) 把行内代码/围栏代码段摘出，避免代码里的 $ 被当作公式
// 2) 摘出数学段（$$…$$、$…$、\(…\)、\[…\]）占位
// 3) marked 解析 Markdown
// 4) 数学占位替换为 KaTeX 输出（throwOnError:false：非法公式显示原文并标红，不丢内容）
// 5) DOMPurify 兜底清洗（外部粘贴的 Markdown 中的主动内容在此全部禁用）

interface MathSeg {
  tex: string
  display: boolean
}

interface WikiSeg {
  target: string
  display: string
}

export function renderMarkdown(src: string): string {
  const mathSegs: MathSeg[] = []
  const stash = (tex: string, display: boolean): string => `\u0000MATH${mathSegs.push({ tex, display }) - 1}\u0000`

  // 代码段（围栏与行内反引号）先保护
  const codeStash: string[] = []
  const protectCode = (code: string): string => `\u0000CODE${codeStash.push(code) - 1}\u0000`
  let work = src.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => protectCode(m))

  // 双链 [[目标]] / [[目标|显示]]：摘出占位，marked 后还原为内部链接（点击由编辑器代理）
  const wikiSegs: WikiSeg[] = []
  work = work.replace(/\[\[([^\[\]]+)\]\]/g, (_m, inner: string) => {
    const bar = inner.indexOf('|')
    const target = (bar === -1 ? inner : inner.slice(0, bar)).trim()
    const display = (bar === -1 ? inner.trim() : inner.slice(bar + 1).trim()) || target
    if (!target) return _m
    const idx = wikiSegs.push({ target, display }) - 1
    return `\u0000WIKI${idx}\u0000`
  })

  // 笔记插图 ![](asset:<sha256>) → 本地受控服务地址。
  // variant=display：png/jpg 等浏览器可直接显示的格式服务端原样返回，heic/tiff 自动转 jpg。
  work = work.replace(
    /(!\[[^\]\n]*\]\(\s*)asset:([0-9a-fA-F]{64})(\s*\))/g,
    (_m, pre: string, id: string, post: string) => `${pre}/api/asset/${id.toLowerCase()}?variant=display${post}`
  )

  // 数学段：显示式优先（$$、\[ \]），再行内（$、\( \)）
  work = work
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(tex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => stash(tex, true))
    .replace(/\$([^$\n]+?)\$/g, (_m, tex: string) => stash(tex, false))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => stash(tex, false))

  // 代码占位还原（避免 marked 处理其中的数学符号）
  work = work.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeStash[Number(i)])

  let html = marked.parse(work, { async: false, gfm: true, breaks: false }) as string

  html = html.replace(/\u0000MATH(\d+)\u0000/g, (_m, i: string) => {
    const seg = mathSegs[Number(i)]
    try {
      return katex.renderToString(seg.tex, {
        displayMode: seg.display,
        throwOnError: false,
        output: 'html',
        strict: 'ignore',
        trust: false
      })
    } catch {
      // throwOnError:false 下一般不会抛；兜底显示原始 TeX
      return `<code class="math-fallback">${escapeHtml(seg.tex)}</code>`
    }
  })

  html = html.replace(/\u0000WIKI(\d+)\u0000/g, (_m, i: string) => {
    const w = wikiSegs[Number(i)]
    return `<a class="wikilink" data-wikilink="${escapeAttr(w.target)}">${escapeHtml(w.display)}</a>`
  })

  // 说明：style 属性必须保留——KaTeX 公式输出依赖行内样式定位（CSP 已限制 script-src 'self'）。
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['srcset', 'formaction']
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
