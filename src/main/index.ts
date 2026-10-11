import { app, BrowserWindow, globalShortcut, screen, shell } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { loadWindowBounds, setWindowBounds, getDailySettings, setDailySettings, getLibraryRoot, defaultLibraryRoot, getPref, setPref } from './settings'
import { importDailyFolder } from './papers-daily'
import { FolderStore } from './storage/folder-store'
import { ImageVariants } from './assets/images'
import { Repo } from './storage/repo'
import { RecognitionQueue } from './metadata/recognize'
import { FulltextIndexer, readMetaForTargets } from './metadata/fulltext'
import { registerIpc } from './ipc'
import { startAppServer } from './server'
import { runSelfTest } from './selftest'
import { initFileLogger, error as logError, warn as logWarn } from './logger'
import { installChineseMenu } from './menu'

const SELF_TEST = process.argv.includes('--self-test')
const USER_DATA_ARG = process.argv.find((a) => a.startsWith('--user-data-dir='))

// 兜底：后台写盘等异步路径的 rejection 不能被静默丢弃。
// 本地优先应用「记日志并继续」优于「静默死掉或弹崩溃框」；不吞掉会掩盖问题的栈信息。
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)))
})

if (USER_DATA_ARG) {
  // 必须在 ready 之前设置（E2E 与自检用它隔离数据目录）
  app.setPath('userData', USER_DATA_ARG.slice('--user-data-dir='.length))
}

const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? null
const APP_VERSION = app.getVersion()

/** 校验并分发 deep link：协议/主机/ID 形状全部白名单，非法输入静默忽略 */
function handleDeepLink(rawUrl: string | undefined): void {
  if (!rawUrl || !mainWindow) return
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'mathworkbench:' || u.hostname !== 'paper') return
    const id = u.searchParams.get('id') ?? ''
    if (!/^[0-9]{4}\.[0-9]{4,5}(v\d+)?$/.test(id)) return
    mainWindow.webContents.send('app:deep-link', { kind: 'paper', baseId: id })
  } catch {
    /* 非法链接忽略 */
  }
}

/** 全局速记快捷键（mac ⌥⌘N / win Ctrl+Alt+N）：应用不在前台也能唤起 */
const QUICK_CAPTURE_ACCELERATOR = 'Alt+CommandOrControl+N'

/** 唤起速记：先把窗口带到前台，再派发事件让渲染层开浮层（全局快捷键专用；应用内入口由渲染层自己开） */
function triggerQuickCapture(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  win.webContents.send('memo:quick-capture')
}

let mainWindow: BrowserWindow | null = null
let server: { port: number; stop(): Promise<void> } | null = null
let libraryStore: FolderStore | null = null
let recognitionQueue: RecognitionQueue | null = null
let fulltextIndexer: FulltextIndexer | null = null
let flushTimer: NodeJS.Timeout | null = null
let flushWaiting = false
// 浏览器扩展导入的连接信息：令牌首次启动生成并落 settings.json（prefs.importToken），
// 端口在生产模式按偏好列表依次尝试（全占用则随机），实际端口写回 prefs.importPort 供 UI 展示
let importToken = ''
const DEFAULT_IMPORT_PORTS = [31415, 31416, 31417]

async function bootstrap(): Promise<void> {
  initFileLogger(app.getPath('userData'))
  installChineseMenu()
  // 库根：用户自选的数据文件夹（settings.libraryRoot）优先；不可用（网盘未挂载等）时回退默认并提示
  let libraryRoot = getLibraryRoot()
  let rootFallback = false
  try {
    mkdirSync(libraryRoot, { recursive: true })
  } catch (err) {
    console.error(`[mathwb] 配置的数据文件夹不可用（${libraryRoot}），回退默认：`, err)
    rootFallback = true
    libraryRoot = defaultLibraryRoot()
    mkdirSync(libraryRoot, { recursive: true })
  }
  const library = new FolderStore(libraryRoot)
  libraryStore = library
  await library.scan()
  library.startWatch()
  const variantsDir = join(libraryRoot, '.cache', 'variants')
  mkdirSync(variantsDir, { recursive: true })
  const repo = new Repo(library, new ImageVariants(variantsDir))
  // 学习足迹：确保 足迹.json 存在（启用日=首次运行本版的当天；不迁移、不补造历史）
  repo.ensureActivity()

  // 识别队列：把「待补全」条目排队走 DOI/arXiv 元数据回填（E2E 保持确定性，不排队）
  if (process.env.MATHWB_E2E !== '1') {
    recognitionQueue = new RecognitionQueue(repo)
    recognitionQueue.enqueueAllPending()
  }

  // 全文索引器（WP-4）：覆盖所有导入路径（都经 importDocuments → onDocumentsImported）；
  // 本地提取、无网络，E2E 下同样启用（用例可断言索引状态）。
  fulltextIndexer = new FulltextIndexer(repo)
  repo.onDocumentsImported((documentId) => fulltextIndexer?.enqueue(documentId))
  void (async () => {
    try {
      // 启动补齐：缺失/引擎过期/文件变化/上次失败的条目重新入队（后台串行，不阻塞启动）
      const metas = await readMetaForTargets(repo.libraryFulltextTargets())
      const queued = fulltextIndexer?.enqueueStale(metas) ?? 0
      if (queued > 0) console.log(`[mathwb] 全文索引补齐 ${queued} 条（后台进行）`)
    } catch (err) {
      logWarn('fulltext', `启动补齐失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })()

  // 库变更（含 iCloud/网盘外部写入）推送渲染层，驱动列表与检索自动刷新
  library.onChange((kinds) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('library:changed', { kinds })
    }
  })

  const rendererDir = DEV_SERVER_URL ? null : join(__dirname, '../renderer')
  if (!DEV_SERVER_URL && !existsSync(join(rendererDir!, 'index.html'))) {
    throw new Error(`未找到渲染产物：${rendererDir}/index.html（请先 npm run build）`)
  }

  const devPort = DEV_SERVER_URL ? Number(process.env.MATHWB_ASSET_PORT ?? 17317) : undefined
  importToken = getPref('importToken') ?? ''
  if (!importToken) {
    importToken = randomUUID()
    setPref('importToken', importToken)
  }
  server = await startAppServer({
    repo,
    rendererDir,
    port: devPort,
    // E2E 用随机端口：偏好端口（31415…）被残留实例占用时，后续用例会连到旧构建的服务造成交叉假失败
    preferredPorts: devPort === undefined && process.env.MATHWB_E2E !== '1' ? DEFAULT_IMPORT_PORTS : undefined,
    importToken,
    versionInfo: { app: APP_VERSION, electron: process.versions.electron, node: process.versions.node },
    // 导入结果推渲染层 toast；元数据不足的条目即时挂识别队列回填（不等下次启动）
    onNotice: (notice) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:notice', notice)
    },
    onNeedsReview: (documentId) => recognitionQueue?.enqueue(documentId)
  })
  setPref('importPort', String(server.port))

  registerIpc(
    repo,
    () => mainWindow,
    APP_VERSION,
    recognitionQueue ?? undefined,
    () => ({ port: server?.port ?? 0, token: importToken }),
    relaunchApp,
    fulltextIndexer ?? undefined
  )

  // 每日论文：仅在用户开启开关时，打开应用当天首次自动扫描本地清单文件夹（不联网）
  void (async () => {
    try {
      const daily = getDailySettings()
      if (!daily.autoCheck) return
      const last = daily.lastCheck ? Date.parse(daily.lastCheck) : 0
      if (Number.isFinite(last) && Date.now() - last < 20 * 3600_000) return
      await importDailyFolder(repo, daily.folder)
      setDailySettings({ lastCheck: new Date().toISOString() })
    } catch (err) {
      console.error('[mathwb] daily import failed:', err)
    }
  })()

  if (DEV_SERVER_URL) {
    console.log(`[mathwb] dev renderer: ${DEV_SERVER_URL}`)
    console.log(`[mathwb] dev /api 已固定端口 ${server.port}（.env MATHWB_ASSET_PORT）`)
  } else {
    console.log(`[mathwb] serving renderer at http://127.0.0.1:${server.port}/`)
  }

  createWindow()

  // 全局速记快捷键。E2E 不注册（多实例并行会互相抢键，且窗口本就不上屏）；
  // 被别的应用占用时只记日志——收件箱里的「写速记」按钮始终是可用入口。
  if (process.env.MATHWB_E2E !== '1' && !globalShortcut.register(QUICK_CAPTURE_ACCELERATOR, triggerQuickCapture)) {
    logWarn('quick-capture', `全局快捷键 ${QUICK_CAPTURE_ACCELERATOR} 注册失败（可能被其它应用占用）`)
  }

  if (rootFallback) {
    void import('electron').then(({ dialog }) => {
      if (!mainWindow) return
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: '配置的数据文件夹当前不可用，本次启动已使用默认位置。',
        detail: `配置位置：${getLibraryRoot()}\n本次使用：${libraryRoot}\n请检查网盘/磁盘挂载后重启应用。`,
        buttons: ['知道了']
      }).catch(() => undefined)
    })
  }

  // deep link（mathworkbench://paper?id=…）：打包版注册；冷启动由 open-url 捕获，热启动由
  // second-instance（Windows 把链接转给已运行实例的 argv）附带，经模块级 handleDeepLink 校验分发。
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient('mathworkbench')
  } else if (process.platform === 'win32') {
    // Windows 开发模式：注册表须指向 electron.exe 并附带应用路径（macOS 开发模式注册无效，跳过）
    app.setAsDefaultProtocolClient('mathworkbench', process.execPath, [resolve(process.argv[1] ?? '.')])
  }
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('mathworkbench://'))
    if (url) handleDeepLink(url)
  })

  // E2E 专用：open-url 在 _electron 下无法派发，注入同一条校验路径（生产不注册）
  if (process.env.MATHWB_E2E === '1') {
    const { ipcMain } = require('electron') as typeof import('electron')
    ipcMain.on('test:deepLink', (_e, url: unknown) => {
      if (typeof url === 'string') handleDeepLink(url)
    })
    // 速记浮层的渲染层路径可测；但只派发事件、不 show/focus（隐身模式下窗口不上屏、不抢焦点是硬约束）
    ipcMain.on('test:quickCapture', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('memo:quick-capture')
    })
  }
}

/**
 * 关窗与重启共用的保存握手：先请渲染层冲刷，成功才执行 action。
 * 失败或超时都保留应用现状并明确告知——`app.exit()` 不触发 `close`，
 * 所以重启绝不能直接调它，否则会绕过这条协议、丢掉尚未落盘的内容。
 */
function requestFlushThen(opts: { action: () => void; timeoutMessage: string; timeoutDetail: string }): void {
  if (!mainWindow) {
    opts.action()
    return
  }
  if (flushWaiting) return
  flushWaiting = true
  const { ipcMain } = require('electron') as typeof import('electron')
  const cleanup = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    flushWaiting = false
    ipcMain.off('app:flushed', onFlushed)
    ipcMain.off('app:flush-failed', onFailed)
  }
  const onFlushed = (e: Electron.IpcMainEvent) => {
    if (e.sender !== mainWindow?.webContents) return
    cleanup()
    opts.action()
  }
  const onFailed = (e: Electron.IpcMainEvent) => {
    if (e.sender === mainWindow?.webContents) cleanup()
  }
  // 超时只提示、不放弃等待：若渲染层随后保存成功（app:flushed），仍会继续执行 action，
  // 避免「保存只是慢于 5 秒 → 模态框 → 应用永远无法正常退出」。
  flushTimer = setTimeout(() => {
    flushTimer = null
    void import('electron').then(({ dialog }) => {
      if (!mainWindow) return
      void dialog
        .showMessageBox(mainWindow, { type: 'warning', message: opts.timeoutMessage, detail: opts.timeoutDetail, buttons: ['留在这里'] })
        .catch(() => undefined)
    })
  }, 5000)
  ipcMain.on('app:flushed', onFlushed)
  ipcMain.on('app:flush-failed', onFailed)
  mainWindow.webContents.send('app:flush')
}

/** 设置里「重启应用」的入口：走与关窗同一套握手，不丢未落盘内容 */
function relaunchApp(): void {
  requestFlushThen({
    action: () => {
      app.relaunch()
      app.exit(0)
    },
    timeoutMessage: '保存尚未完成，已取消重启。',
    timeoutDetail: '请等待保存结束或在页面重试后，再重启应用。'
  })
}

function createWindow(): void {
  const saved = loadWindowBounds()
  const defaults = { width: 1440, height: 900 }
  let bounds: { width: number; height: number; x?: number; y?: number } = defaults
  if (saved && saved.width >= 1080 && saved.height >= 720) {
    // 矫正到当前屏幕工作区内（外接显示器被拔掉等场景）
    const area = screen.getDisplayMatching(saved).workArea
    const width = Math.min(saved.width, area.width)
    const height = Math.min(saved.height, area.height)
    const x = Math.max(area.x, Math.min(saved.x, area.x + area.width - width))
    const y = Math.max(area.y, Math.min(saved.y, area.y + area.height - height))
    bounds = { width, height, x, y }
  }
  // E2E 隐身模式：窗口从不了前台（不打扰使用电脑），backgroundThrottling 关闭
  // 以免后台页面的定时器被节流拖慢测试（这是此前 E2E 抢前台的唯一必要理由）。
  const stealth = process.env.MATHWB_E2E === '1' && process.env.MATHWB_VISIBLE !== '1'
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1080,
    minHeight: 720,
    title: '数学学习工作台',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: !stealth
    }
  })
  if (!stealth) mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Imported HTML may run its own inline interactions, but cannot navigate the
  // application, open windows, or turn its frame into an unrestricted website.
  const contents = mainWindow.webContents
  const appUrl = DEV_SERVER_URL ?? `http://127.0.0.1:${server?.port ?? 0}/`
  const appOrigin = new URL(appUrl).origin
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-frame-navigate', (event) => {
    let target: URL
    try { target = new URL(event.url) } catch { event.preventDefault(); return }
    if (event.isMainFrame) {
      if (target.origin !== appOrigin || target.pathname.startsWith('/api/')) event.preventDefault()
      return
    }
    const initiatedByApp = event.initiator === contents.mainFrame
    const isAsset = target.origin === appOrigin && /^\/api\/asset\/([0-9a-fA-F]{64}|[0-9a-fA-F-]{36})$/.test(target.pathname)
    if (!initiatedByApp || !isAsset) event.preventDefault()
  })

  // 保存成功才关闭；失败或超时保留窗口，避免丢失尚未落库的阅读草稿。
  mainWindow.on('close', (event) => {
    if (!mainWindow) return
    try {
      if (!mainWindow.isMinimized() && !mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
        setWindowBounds(mainWindow.getNormalBounds())
      }
    } catch {
      /* 设置写入失败不影响退出 */
    }
    event.preventDefault()
    requestFlushThen({
      action: () => {
        const win = mainWindow
        mainWindow = null
        win?.destroy()
      },
      timeoutMessage: '保存尚未完成，窗口已保留。',
      timeoutDetail: '请等待保存结束或在页面重试后，再关闭窗口。'
    })
  })

  const url = DEV_SERVER_URL ?? `http://127.0.0.1:${server?.port ?? 0}/`
  void mainWindow.loadURL(url)
}

app.whenReady().then(() => {
  if (SELF_TEST) {
    void runSelfTest()
      .then((r) => {
        console.log('[selftest] ' + JSON.stringify(r, null, 2))
        app.exit(r.ok ? 0 : 1)
      })
      .catch((err) => {
        console.error('[selftest] 运行失败:', err)
        app.exit(2)
      })
    return
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  bootstrap().catch((err) => {
    initFileLogger(app.getPath('userData'))
    logError('bootstrap', err)
    console.error('[mathwb] 启动失败:', err)
    const { dialog } = require('electron') as typeof import('electron')
    dialog.showErrorBox('数学学习工作台：启动失败', String(err instanceof Error ? err.stack ?? err.message : err))
    app.exit(1)
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  // window-all-closed -> quit；此处确保服务与文件监听停掉，避免句柄悬挂
  globalShortcut.unregisterAll()
  libraryStore?.stopWatch()
  recognitionQueue?.stop()
  fulltextIndexer?.stop()
})
