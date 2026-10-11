import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect } from '@playwright/test'

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  consoleErrors: Array<{ phase: string; text: string }>
  setPhase(phase: string): void
}

/** Navigate through the compact three-group shell, then its contextual tab.
 * Keeping this in one helper lets product navigation labels evolve without
 * scattering knowledge of the primary/context split across every E2E spec.
 */
export async function navigateTo(page: Page, label: string): Promise<void> {
  const group: Record<string, string> = {
    '笔记': '学习', '研究问题': '学习', 'Idea': '学习',
    '待办': '计划', '学习足迹': '计划',
    '文献': '资料', '每日论文': '资料'
  }
  const primary = group[label]
  if (!primary) throw new Error(`未知紧凑导航标签：${label}`)
  await page.locator(`.workspace-primary .nav-item[aria-label="${primary}"]`).click()
  await page.locator(`.workspace-tabs .nav-item[aria-label="${label}"]`).click()
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 删除临时库目录。Windows 下 Electron 子进程（crashpad 等）句柄释放有延迟，
 * 紧跟 close() 的 rmSync 偶发 EPERM——短暂重试即可；末次失败放弃（临时目录由系统回收）。
 */
export function rmTempDir(dir: string, attempts = 4): void {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      if (i === attempts - 1) return
      sleepSync(400)
    }
  }
}

/**
 * 关窗守卫：应用在「保存失败/超时」时会**保留窗口**（弹模态而不是关掉），
 * 因此那些故意注入保存失败的用例会让 close() 一直等下去，把整个 worker 拖到拆卸超时
 * （Playwright 报「Worker teardown timeout」并让整套以非零码退出——测试其实全过了）。
 * 正常 close 超过 20s 视为挂起，强杀进程树放行——此时断言已全部通过，数据已冲刷。
 */
function guardAppClose(app: ElectronApplication, timeoutMs = 20_000): void {
  const origClose = app.close.bind(app)
  let settled = false
  app.close = async () => {
    if (settled) return
    settled = true
    const pid = app.process()?.pid
    const result = await Promise.race([
      origClose().then(() => 'closed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
    ])
    if (result === 'timeout' && pid) {
      try {
        // 兜底必须跨平台：早先只调 taskkill（Windows 专有），macOS 上被 catch 吞掉、进程漏着不退出
        if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
        else process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  }
}

/**
 * 强杀使用该 userData 目录的残留应用进程。
 *
 * 重启类用例专用：`app.relaunch()` 起的新实例不受 Playwright 句柄管理，原句柄的 close()
 * 碰不到它——只要那条路径被走到（比如断言前冲刷意外成功），就会留下一个孤儿进程占着端口与内存。
 */
export function killStrayApps(userDataDir: string): void {
  const r = spawnSync('pgrep', ['-f', userDataDir], { encoding: 'utf8' })
  if (r.status !== 0) return
  for (const line of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      process.kill(Number(line), 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

/** 启动真实应用（生产模式：主进程本地服务 + 打包后的渲染产物），并挂控制台门禁收集 */
export async function launchApp(  userDataDir: string,
  env: Record<string, string> = {},
  opts: { visible?: boolean } = {}
): Promise<LaunchedApp> {
  mkdirSync(userDataDir, { recursive: true })
  // MATHWB_E2E_ARGS：额外 Chromium 开关（空格分隔）。默认不带，本地行为不变；
  // 供容器/受限沙箱补 --no-sandbox、--disable-gpu 一类开关（GitHub Actions 无显示环境同理）。
  const extraArgs = (process.env.MATHWB_E2E_ARGS ?? '').split(/\s+/).filter(Boolean)
  const app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), `--user-data-dir=${userDataDir}`, ...extraArgs],
    // E2E 启动一律带 MATHWB_E2E=1：主进程据此启用随机端口（避免偏好端口被残留实例占用）并启用测试缝隙
    // visible=true 供「视觉样式断言」类用例：隐藏窗口里 computed style 会解析为透明占位，不可靠
    env: { ...process.env, MATHWB_E2E: '1', ...(opts.visible ? { MATHWB_VISIBLE: '1' } : {}), ...env } as NodeJS.ProcessEnv
  })
  const page = await app.firstWindow()
  let phase = 'startup'
  const consoleErrors: Array<{ phase: string; text: string }> = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ phase, text: m.text() })
  })
  page.on('pageerror', (e) => consoleErrors.push({ phase, text: `pageerror: ${e.message}` }))

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as { api?: unknown }).api)), { timeout: 20000 })
    .toBe(true)

  // 等 React 挂载（app-shell 出现）：preload 的 api 先于渲染层挂载就绪——此前只等 api，
  // 渲染包变大后「launchApp 返回即 evaluate/断言 DOM」的用例会撞上空页面（2026-10-09 修复）
  await expect
    .poll(() => page.evaluate(() => Boolean(document.querySelector('.app-shell'))), { timeout: 20000 })
    .toBe(true)

  // 隐身模式（默认）：主进程从不出窗、关闭后台节流；Playwright 驱动接管窗口时会自行 show()，
  // 这里在主进程上下文再统一 hide()——测试全程不上屏、不抢焦点。
  // visible 模式（视觉样式断言用）跳过隐藏：隐藏窗口里 computed style 会解析成透明占位。
  if (!opts.visible) {
    await app
      .evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().forEach((w) => w.hide())
      })
      .catch(() => undefined)
  }

  // 仅校验页面仍由本地受控服务加载（而非 file://）
  const url = page.url()
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    throw new Error(`渲染页面不是本地服务：${url}`)
  }

  guardAppClose(app)

  return { app, page, consoleErrors, setPhase: (p: string) => (phase = p) }
}

/** 布局审计（机器可读，不依赖视觉）：横向溢出 / 零尺寸可交互元素 */
export async function layoutAudit(page: Page, label: string): Promise<string[]> {
  return page.evaluate((l) => {
    const issues: string[] = []
    const doc = document.scrollingElement ?? document.documentElement
    if (doc.scrollWidth > window.innerWidth + 1) {
      issues.push(`[${l}] body 横向溢出 scrollWidth=${doc.scrollWidth} > innerWidth=${window.innerWidth}`)
    }
    const buttons = Array.from(document.querySelectorAll('button'))
    for (const b of buttons) {
      if (b.offsetParent === null) continue // 不可见（隐藏模态等）不检查
      const r = b.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) {
        issues.push(`[${l}] 零尺寸按钮: "${(b.textContent || '').trim().slice(0, 24)}"`)
      }
    }
    return issues
  }, label)
}

export const fixture = (name: string): string => join(process.cwd(), 'fixtures', name)
