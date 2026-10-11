// 选项页：服务地址 + 令牌。保存进 chrome.storage.local（只存本机）。
const $ = (id) => document.getElementById(id)

async function load() {
  const s = await chrome.storage.local.get({ serverUrl: 'http://127.0.0.1:31415', token: '' })
  $('serverUrl').value = s.serverUrl
  $('token').value = s.token
}

function showStatus(ok, text) {
  const el = $('status')
  el.className = ok ? 'ok' : 'bad'
  el.textContent = text
}

async function currentForm() {
  return { serverUrl: $('serverUrl').value.trim() || 'http://127.0.0.1:31415', token: $('token').value.trim() }
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set(await currentForm())
  showStatus(true, '已保存')
})

$('test').addEventListener('click', async () => {
  const { serverUrl, token } = await currentForm()
  let base = serverUrl
  try { base = new URL(serverUrl).origin } catch { return showStatus(false, '服务地址格式不正确') }
  try {
    const res = await fetch(`${base}/api/import/ping`, { headers: { 'X-MWB-Token': token }, signal: AbortSignal.timeout(3000) })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.ok) showStatus(true, `连接成功：${data.name || '数学学习工作台'} v${data.app ?? '?'}`)
    else if (res.status === 401) showStatus(false, '服务可达，但令牌不匹配：请到工作台「文献库 → 浏览器导入」复制令牌')
    else showStatus(false, `服务可达，但响应异常（HTTP ${res.status}）`)
  } catch {
    showStatus(false, `连不上 ${base}：请确认工作台已启动（若端口不同，请改成弹窗里显示的端口）`)
  }
})

void load()
