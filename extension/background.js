// 数学学习工作台浏览器扩展：抓取当前页书目元数据 + PDF，POST 到工作台的本地导入服务。
// 隐私边界：所有流量只发往本机 127.0.0.1（候选端口 31415-31417），无任何上传。
// 策略：① 元数据优先读页面的 Highwire/DC citation 标签（Zotero 同款思路）；
//       ② PDF 优先在浏览器内直接抓（带登录态，付费墙内可用）；失败则用 downloads 落盘后传本机路径兜底；
//       ③ 找不到 PDF 的普通网页只导入书目信息（工作台建无文件条目）。

const DEFAULTS = { serverUrl: 'http://127.0.0.1:31415', token: '' }
const FALLBACK_PORTS = [31415, 31416, 31417]
const PDF_FETCH_TIMEOUT = 120_000
const DOWNLOAD_TIMEOUT = 180_000

// ---------- 设置与服务发现 ----------

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS)
  let origin = DEFAULTS.serverUrl
  try { origin = new URL(s.serverUrl || DEFAULTS.serverUrl).origin } catch { /* 非法输入回退默认 */ }
  return { origin, token: s.token || '' }
}

async function tokenHeaders(token) {
  return { 'X-MWB-Token': token }
}

/** 依次探测候选端口，返回响应 ping 的服务根地址；全部不通返回 null */
async function findServer(token) {
  const { origin } = await getSettings()
  const candidates = [origin, ...FALLBACK_PORTS.map((p) => `http://127.0.0.1:${p}`)]
  const seen = new Set()
  for (const base of candidates) {
    if (seen.has(base)) continue
    seen.add(base)
    try {
      const res = await fetch(`${base}/api/import/ping`, { headers: await tokenHeaders(token), signal: AbortSignal.timeout(2500) })
      if (res.ok && (await res.json()).ok) return base
    } catch { /* 下一个候选 */ }
  }
  return null
}

// ---------- 页面元数据抓取（注入页面执行，必须自包含） ----------

function collectPageMetadata() {
  const metas = {}
  for (const m of document.querySelectorAll('meta')) {
    const key = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase()
    const content = m.getAttribute('content')
    if (!key || !content) continue
    ;(metas[key] = metas[key] || []).push(content.trim())
  }
  const all = (k) => metas[k] || []
  const one = (k) => all(k)[0] || null
  const cite = (k) => all(`citation_${k}`)
  const abs = (u) => { try { return new URL(u, location.href).href } catch { return null } }
  const arxivMatch = location.pathname.match(/\/(?:abs|pdf)\/([^\s/?#]+)/)
  const pdfUrl =
    cite('pdf_url')[0] ||
    (document.querySelector('link[type="application/pdf"]') || {}).href ||
    (/(^|\.)arxiv\.org$/.test(location.hostname) && arxivMatch ? `https://arxiv.org/pdf/${arxivMatch[1]}` : null)
  return {
    title: cite('title')[0] || one('og:title') || one('dc.title') || document.title || '',
    authors: cite('author').length ? cite('author') : all('dc.creator'),
    doi: cite('doi')[0] || null,
    arxivId: cite('arxiv_id')[0] || null,
    venue: cite('journal_title')[0] || null,
    year: cite('publication_date')[0] || cite('date')[0] || cite('year')[0],
    abstract: cite('abstract')[0] || one('description') || null,
    pdfUrl: pdfUrl ? abs(pdfUrl) : null,
    sourceUrl: location.href
  }
}

function extractArxivId(url) {
  const m = /arxiv\.org\/(?:abs|pdf|format)\/([0-9]{4}\.[0-9]{4,5})(v[0-9]+)?/i.exec(url || '')
  return m ? m[1] : null
}

function parseYear(v) {
  const m = /(\d{4})/.exec(String(v || ''))
  return m ? Number(m[1]) : null
}

function cleanTitle(t) {
  return String(t || '').replace(/\.pdf$/i, '').trim()
}

// ---------- PDF 抓取 ----------

function bytesToBase64(bytes) {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
  return btoa(bin)
}

async function fetchPdfBase64(url) {
  const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`下载 PDF 失败：HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.length < 5 || String.fromCharCode.apply(null, buf.subarray(0, 5)) !== '%PDF-') throw new Error('链接内容不是 PDF 文件')
  return bytesToBase64(buf)
}

/** 付费墙等浏览器内抓不到的场景：走浏览器下载器（带会话）落盘，再把本机路径交给工作台复制入库 */
function downloadToLocal(url) {
  return new Promise((resolve) => {
    let downloadId = null
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      chrome.downloads.onChanged.removeListener(onChanged)
      resolve(v)
    }
    const onChanged = async (delta) => {
      if (delta.id !== downloadId || !delta.state) return
      if (delta.state.current === 'complete') {
        try {
          const [item] = await chrome.downloads.search({ id: downloadId })
          done(item?.filename || null)
        } catch { done(null) }
      } else if (delta.state.current === 'interrupted') {
        done(null)
      }
    }
    const timer = setTimeout(() => done(null), DOWNLOAD_TIMEOUT)
    chrome.downloads.onChanged.addListener(onChanged)
    try {
      chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' }, (id) => {
        if (id === undefined) done(null)
        else downloadId = id
      })
    } catch { done(null) }
  })
}

// ---------- 提交 ----------

async function postImport(base, token, payload) {
  const res = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await tokenHeaders(token)) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `工作台返回 ${res.status}`)
  return data
}

async function captureTab(tab, linkUrl) {
  const { token } = await getSettings()
  const base = await findServer(token)
  if (!base) {
    throw new Error('连不上工作台：请确认工作台已启动，并在扩展选项里核对服务地址与令牌')
  }

  const url = linkUrl || tab.url || ''
  const isPdfUrl = /\.pdf($|[?#])/i.test(url) || /arxiv\.org\/pdf\//i.test(url)
  let meta = {
    title: cleanTitle(tab.title),
    authors: [],
    doi: null,
    arxivId: extractArxivId(url),
    venue: null,
    year: null,
    abstract: null,
    pdfUrl: isPdfUrl ? url : null,
    sourceUrl: url
  }

  // 网页：注入脚本读 citation 元标签（arXiv/多数出版商都有）；受限页面抓不到就用标签页标题顶上
  if (!isPdfUrl && tab.id != null) {
    try {
      const [injected] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageMetadata })
      const m = injected && injected.result
      if (m) {
        meta = {
          title: m.title || meta.title,
          authors: Array.isArray(m.authors) ? m.authors : [],
          doi: m.doi || null,
          arxivId: m.arxivId || meta.arxivId,
          venue: m.venue || null,
          year: parseYear(m.year),
          abstract: m.abstract || null,
          pdfUrl: m.pdfUrl || null,
          sourceUrl: m.sourceUrl || url
        }
      }
    } catch { /* chrome:// 等受限页 */ }
  }
  if (linkUrl) meta.sourceUrl = meta.sourceUrl || tab.url

  if (meta.pdfUrl) {
    try {
      const pdfBase64 = await fetchPdfBase64(meta.pdfUrl)
      return await postImport(base, token, { ...meta, pdfBase64 })
    } catch (err) {
      if (!/^https?:/i.test(meta.pdfUrl)) throw err
      const localPath = await downloadToLocal(meta.pdfUrl)
      if (!localPath) throw err
      return await postImport(base, token, { ...meta, localPath })
    }
  }
  return await postImport(base, token, meta)
}

// ---------- 反馈与入口 ----------

async function report(tabId, ok, duplicate, message) {
  try {
    await chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '✗' })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#1a7f37' : '#c62828' })
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined)
    }, ok ? 4000 : 8000)
  } catch { /* 标签页可能已关闭 */ }
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/128.png',
      title: ok ? (duplicate ? '已在文献库中' : '已导入工作台') : '导入失败',
      message,
      priority: 1
    })
  } catch { /* 通知不可用不影响导入 */ }
}

async function safeCapture(tab, linkUrl) {
  if (!tab || !tab.id) return
  try {
    const result = await captureTab(tab, linkUrl)
    const title = (result && result.title) || '文献'
    await report(tab.id, true, Boolean(result && result.duplicate), result && result.duplicate ? `「${title}」已在文献库中` : `「${title}」已进入文献库「待整理」`)
  } catch (err) {
    await report(tab.id, false, false, err instanceof Error ? err.message : String(err))
  }
}

chrome.action.onClicked.addListener((tab) => {
  void safeCapture(tab, null)
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'mwb-import-page', title: '导入此页面到数学学习工作台', contexts: ['page'] })
    chrome.contextMenus.create({ id: 'mwb-import-link', title: '导入此链接的文献到数学学习工作台', contexts: ['link'] })
  })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return
  void safeCapture(tab, info.linkUrl || info.pageUrl || null)
})
