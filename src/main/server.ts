import { createReadStream, existsSync, statSync, type Stats } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Repo } from './storage/repo'
import { importFromBrowser } from './browser-import'

// 本地受控服务（仅绑定 127.0.0.1）：
// - 生产模式：serve out/renderer 静态文件（避免 file:// 下 worker/CSP 的一堆特例）
// - 开发模式：只提供 /api（渲染页面由 vite dev server 提供，vite 把 /api 代理到这里）
// - 资产只按数据库中的资产 ID 提供，客户端无法传文件系统路径。
//
// CSP 说明：style-src 含 'unsafe-inline' 仅因 KaTeX 的公式输出使用行内 style 属性；
// script-src 'self' 禁止一切注入脚本；原始 Markdown 的 HTML 在渲染层另行经 DOMPurify 处理。

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"

export const HTML_ASSET_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.map': 'application/json'
}

export interface AppServer {
  port: number
  stop(): Promise<void>
}

/** /api/import 请求体上限（base64 后的 PDF + JSON 元数据） */
const IMPORT_BODY_MAX_BYTES = 180 * 1024 * 1024

export interface ImportNotice {
  message: string
  kind: 'success' | 'error' | 'info'
}

export async function startAppServer(opts: {
  repo: Repo
  rendererDir: string | null
  port?: number
  /** 生产模式端口偏好：依次尝试，全被占用则回落随机端口（E2E/开发用 port 固定） */
  preferredPorts?: number[]
  versionInfo: Record<string, string>
  /** 浏览器导入令牌；未配置则 /api/import 关闭 */
  importToken?: string
  /** 导入结果推送渲染层（toast 提示） */
  onNotice?: (notice: ImportNotice) => void
  /** 元数据不足保持「待补全」的条目：调用方挂识别队列即时回填 */
  onNeedsReview?: (documentId: string) => void
}): Promise<AppServer> {
  const { repo, rendererDir, versionInfo } = opts

  const server: Server = createServer((req, res) => {
    handleRequest(req, res, {
      repo,
      rendererDir,
      versionInfo,
      importToken: opts.importToken,
      onNotice: opts.onNotice,
      onNeedsReview: opts.onNeedsReview
    }).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    })
  })

  const ports = opts.port !== undefined ? [opts.port] : (opts.preferredPorts ?? []).concat(0)
  const port = await listenOnFirstPort(server, ports)

  return {
    port,
    stop: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise())
        server.closeAllConnections?.()
      })
  }
}

/** 依次尝试端口列表（末项必须是 0=随机端口），全部占用才报错 */
function listenOnFirstPort(server: Server, ports: number[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const attempt = (i: number): void => {
      const port = ports[i]
      const onError = (err: Error): void => {
        server.removeAllListeners('listening')
        if (i + 1 < ports.length) attempt(i + 1)
        else reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        const addr = server.address()
        if (addr && typeof addr === 'object') resolvePromise(addr.port)
        else reject(new Error('无法获得监听端口'))
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }
    attempt(0)
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    repo: Repo
    rendererDir: string | null
    versionInfo: Record<string, string>
    importToken?: string
    onNotice?: (notice: ImportNotice) => void
    onNeedsReview?: (documentId: string) => void
  }
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')

  if (url.pathname === '/api/health' || url.pathname === '/api/version') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, ...ctx.versionInfo }))
    return
  }

  // 浏览器扩展导入（令牌 + 来源校验；见 docs/浏览器导入.md）。普通网页的跨站请求拿不到令牌，
  // 且 Origin 为普通网页时直接拒绝——双保险拦掉恶意页面把任意内容塞进文献库。
  if (url.pathname === '/api/import' || url.pathname === '/api/import/ping') {
    await handleImportApi(req, res, url.pathname, ctx)
    return
  }

  // v2 资产 ID = 文件 sha256（64 位十六进制）；保留 36 位 UUID 兼容旧产物缓存
  const assetMatch = url.pathname.match(/^\/api\/asset\/([0-9a-fA-F]{64}|[0-9a-fA-F-]{36})$/)
  if (assetMatch) {
    await serveAsset(req, res, ctx.repo, assetMatch[1], (url.searchParams.get('variant') ?? 'original') as 'original' | 'display' | 'thumb')
    return
  }

  if (ctx.rendererDir && req.method === 'GET') {
    serveStatic(res, ctx.rendererDir, url.pathname)
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'not found' }))
}

/** 浏览器扩展导入 API：ping 探活 + POST /api/import 落库。仅扩展来源（或无 Origin 的本机脚本）放行。 */
async function handleImportApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: { repo: Repo; versionInfo: Record<string, string>; importToken?: string; onNotice?: (notice: ImportNotice) => void; onNeedsReview?: (documentId: string) => void }
): Promise<void> {
  const origin = req.headers.origin

  // 预检：只对扩展来源放行（扩展有 host_permissions 时通常不触发，此处兼容 Firefox 等）
  if (req.method === 'OPTIONS') {
    if (origin && isExtensionOrigin(origin)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, X-MWB-Token',
        'Access-Control-Max-Age': '600'
      })
    } else {
      res.writeHead(204)
    }
    res.end()
    return
  }

  // 普通网页（http/https）发起的请求一律拒绝：防止恶意页面构造请求塞内容进文献库
  if (origin && !isExtensionOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '浏览器导入只接受来自工作台浏览器扩展的请求' }))
    return
  }

  if (!ctx.importToken) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '浏览器导入未配置令牌，请重启工作台' }))
    return
  }
  if (!tokenMatches(req.headers['x-mwb-token'], ctx.importToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '令牌不匹配：请到工作台「文献库 → 浏览器导入」核对令牌' }))
    return
  }

  if (pathname === '/api/import/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, name: '数学学习工作台', ...ctx.versionInfo }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '请用 POST 提交导入内容' }))
    return
  }
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.includes('application/json')) {
    res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '请求体必须是 application/json' }))
    return
  }

  let raw = ''
  let bytes = 0
  const tooLarge = await new Promise<boolean>((resolvePromise) => {
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > IMPORT_BODY_MAX_BYTES) {
        resolvePromise(true)
        req.destroy()
        return
      }
      raw += chunk.toString('utf8')
    })
    req.on('end', () => resolvePromise(false))
    req.on('error', () => resolvePromise(false))
  })
  if (tooLarge) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '请求体超过大小上限' }))
    return
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
    return
  }

  const result = await importFromBrowser(ctx.repo, body)
  if (result.ok) {
    if (result.needsReview && result.documentId) ctx.onNeedsReview?.(result.documentId)
    ctx.onNotice?.({
      message: result.duplicate ? `已在文献库中：${result.title ?? '无题'}` : `浏览器导入成功：${result.title ?? '无题'}（落入「待整理」）`,
      kind: result.duplicate ? 'info' : 'success'
    })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
  } else {
    ctx.onNotice?.({ message: `浏览器导入失败：${result.error ?? '未知错误'}`, kind: 'error' })
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
  }
}

function isExtensionOrigin(origin: string): boolean {
  return /^chrome-extension:\/\//i.test(origin) || /^moz-extension:\/\//i.test(origin)
}

/** 令牌比较：哈希后定长比较（防时序侧信道；本地攻击面小，属廉价加固） */
function tokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !presented) return false
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  assetId: string,
  variant: 'original' | 'display' | 'thumb'
): Promise<void> {
  const file = await repo.resolveServingFile(assetId, variant)
  if (!existsSync(file.absPath)) throw new Error(`资产文件缺失：${assetId} (${variant})`)
  const stats = statSync(file.absPath)
  if (file.mediaType === 'text/html') res.setHeader('Content-Security-Policy', HTML_ASSET_CSP)
  res.setHeader('Content-Type', file.mediaType === 'text/html' ? 'text/html; charset=utf-8' : file.mediaType)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'private, max-age=86400')

  const range = req.headers.range
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/)
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start: number
      let end: number
      if (m[1] !== '') {
        start = parseInt(m[1], 10)
        end = m[2] !== '' ? Math.min(parseInt(m[2], 10), stats.size - 1) : stats.size - 1
      } else {
        const suffix = parseInt(m[2], 10)
        start = Math.max(0, stats.size - suffix)
        end = stats.size - 1
      }
      if (start <= end && start < stats.size) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Content-Length': end - start + 1
        })
        pump(file.absPath, res, start, end)
        return
      }
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` })
      res.end()
      return
    }
  }
  res.writeHead(200, { 'Content-Length': stats.size })
  if (stats.size === 0) res.end()
  else pump(file.absPath, res, 0, stats.size - 1)
}

function pump(absPath: string, res: ServerResponse, start: number, end: number): void {
  const stream = createReadStream(absPath, { start, end })
  stream.on('error', (err) => res.destroy(err))
  stream.pipe(res)
}

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'
  const abs = normalize(resolve(root, `.${sep}${rel}`))
  if (!abs.startsWith(normalize(root) + sep) && abs !== normalize(root)) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  let target = abs
  let stats: Stats | null = existsSync(target) ? statSync(target) : null
  if (stats?.isDirectory()) {
    target = join(target, 'index.html')
    stats = existsSync(target) ? statSync(target) : null
  }
  if (!stats) {
    // SPA 兜底与无扩展名路径：回落 index.html
    const index = join(root, 'index.html')
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': STATIC_MIME['.html'] })
      createReadStream(index).pipe(res)
      return
    }
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mime = STATIC_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stats.size })
  createReadStream(target).pipe(res)
}
