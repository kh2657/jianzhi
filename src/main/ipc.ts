import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Repo } from './storage/repo'
import type { MathApi } from '@shared/api'
import { isSectionColor, type PdfRect } from '@shared/types'
import { refreshFeeds, importPaper, openAbsExternal } from './papers'
import { importDailyFolder } from './papers-daily'
import { getDailySettings, setDailySettings, revealFolder, getPref, setPref, getLibraryRoot, defaultLibraryRoot, isCustomLibraryRoot, setLibraryRoot, clearLibraryRoot } from './settings'
import type { RecognitionQueue } from './metadata/recognize'
import { readMetaForTargets, type FulltextIndexer } from './metadata/fulltext'
import { info as logInfo, warn as logWarn, error as logError } from './logger'
import { importZoteroLibrary } from './metadata/zotero-import'
import { externalOpenableUrl } from './url-guard'

/** 渲染进程的唯一能力入口。所有处理器只接收/返回可序列化数据，不传文件系统路径语义。 */
export function registerIpc(
  repo: Repo,
  getWindow: () => BrowserWindow | null,
  appVersion: string,
  recognitionQueue?: RecognitionQueue,
  importInfo?: () => { port: number; token: string },
  relaunch?: () => void,
  fulltextIndexer?: FulltextIndexer
): void {
  // E2E 故障注入表：仅当 MATHWB_E2E=1 时 test:ipcFail 通道存在，否则恒为空、零开销
  const failingChannels = new Map<string, string>()
  // IPC 输入来自渲染进程（可信的自有代码），但仍以 any 收包后在各处理器内自行校验
  const h = (channel: string, fn: (input: any) => unknown) => {
    ipcMain.handle(channel, (event, input) => {
      // Imported HTML runs in sandboxed child frames and must never gain the desktop API.
      if (event.senderFrame !== event.sender.mainFrame) throw new Error('子页面不能访问应用接口')
      const injected = failingChannels.get(channel)
      if (injected) throw new Error(injected)
      return fn(input)
    })
  }

  if (process.env.MATHWB_E2E === '1') {
    // 测试缝隙：注入/清除指定通道的故障。{ channel, error } 设置；{ channel: null } 全部清除
    h('test:ipcFail', (input: { channel: string | null; error?: string }) => {
      if (input.channel === null) failingChannels.clear()
      else failingChannels.set(input.channel, input.error ?? '模拟 IPC 故障')
      return { ok: true as const }
    })
    h('test:lastExternalUrl', () => lastExternalUrl)
  }

  /** 最近一次请求打开的外部链接（E2E 断言用；生产环境无消费者） */
  let lastExternalUrl: string | null = null

  h('app:version', () => appVersion)
  // 界面「关于」用它显示当前装的是哪一版：本地更新（install:mac）之后，这是确认新版是否生效的唯一入口
  h('app:versionInfo', () => ({
    app: appVersion,
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? ''
  }))

  // UI 偏好（键值白名单式校验：键长与值长受限，防滥用）
  h('pref:get', (key) => (typeof key === 'string' && key.length <= 64 ? getPref(key) : null))
  h('pref:set', (p) => {
    const input = p as { key?: unknown; value?: unknown }
    if (typeof input?.key !== 'string' || input.key.length === 0 || input.key.length > 64) throw new Error('非法偏好键')
    if (typeof input?.value !== 'string' || input.value.length > 256) throw new Error('非法偏好值')
    setPref(input.key, input.value)
  })

  // 渲染层诊断日志落地（长度受限；不参与业务逻辑）
  ipcMain.on('app:renderer-log', (_e, input: { level?: string; scope?: string; message?: string }) => {
    const scope = typeof input?.scope === 'string' ? input.scope.slice(0, 40) : 'renderer'
    const message = typeof input?.message === 'string' ? input.message.slice(0, 2000) : '(empty)'
    if (input?.level === 'error') logError(scope, new Error(message))
    else if (input?.level === 'warn') logWarn(scope, message)
    else logInfo(scope, message)
  })

  const openDocuments = () => {
    const win = getWindow()
    const r = win
      ? dialog.showOpenDialogSync(win, {
          title: '导入 PDF / HTML',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '学习资料（PDF / HTML）', extensions: ['pdf', 'html', 'htm'] }]
        })
      : null
    return r ?? null
  }
  h('dlg:openPdf', openDocuments)
  h('dlg:openDocuments', openDocuments)

  h('dlg:openImages', () => {
    const win = getWindow()
    const r = win
      ? dialog.showOpenDialogSync(win, {
          title: '导入照片（演草纸等）',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'webp'] }]
        })
      : null
    return r ?? null
  })

  h('space:list', () => repo.listSpaces())
  h('space:create', p => repo.createSpace(p))
  h('space:update', p => repo.updateSpace(asId(p.id), p.patch))
  h('space:assign', p => repo.assignSpace(p.entity, asId(p.id), p.spaceId))
  h('doc:import', async (p) => {
    const results = await repo.importDocuments(asPaths(Array.isArray(p) ? p : p.paths), Array.isArray(p) ? undefined : p.options)
    for (const r of results) {
      if (r.ok) logInfo('import', `${r.duplicate ? 'duplicate' : 'created'} ${r.documentId ?? ''}`)
      else logError('import', new Error(`${r.error ?? '导入失败'} (${(r.path ?? '').split(/[\/]/).pop() ?? ''})`))
    }
    // 新建条目进入识别队列（DOI/arXiv → 元数据回填）；E2E 与自检不排队保持确定性
    if (recognitionQueue) {
      for (const r of results) {
        if (r.ok && !r.duplicate && r.documentId) recognitionQueue.enqueue(r.documentId)
      }
    }
    return results
  })
  h('doc:list', (spaceId) => repo.listDocuments(spaceId))
  h('doc:readHtml', id => repo.readHtml(asId(id)))
  h('doc:update', p => repo.updateDocument(asId(p.id), p.patch))
  h('doc:open', (documentId) => repo.openDocument(asId(documentId)))
  h('doc:meta', (p) => {
    const input = p as { versionId: string; pageCount?: number; fingerprint?: string }
    repo.setVersionMeta(input.versionId, { pageCount: input.pageCount, fingerprint: input.fingerprint })
  })

  h('anchor:create', (p) => {
    const input = p as {
      documentVersionId: string
      pageIndex: number
      pageLabel?: string | null
      rects: PdfRect[]
      quote?: string | null
    }
    return repo.createAnchor(input)
  })
  h('anchor:get', (anchorId) => repo.getAnchorWithContext(asId(anchorId)))
  h('anchor:listPage', (p) => {
    const input = p as { versionId: string; pageIndex: number }
    return repo.listPageAnchors(input.versionId, input.pageIndex)
  })

  h('ink:get', (p) => {
    const input = p as { versionId: string; pageIndex: number }
    return repo.inkGet(asId(input.versionId), input.pageIndex)
  })
  h('ink:save', (p) => {
    const input = p as { versionId: string; pageIndex: number; strokes: unknown }
    repo.saveInk(asId(input.versionId), input.pageIndex, input.strokes)
  })

  h('note:create', (p) => {
    const input = p as Parameters<MathApi['noteCreate']>[0]
    return repo.createNote(input)
  })
  h('note:get', (noteId) => repo.getNoteFull(asId(noteId)))
  h('note:save', (p) => {
    const input = p as Parameters<MathApi['noteSave']>[0]
    return repo.saveNote(input)
  })
  h('note:saveAsCopy', (p) => {
    const input = p as Parameters<MathApi['noteSaveAsCopy']>[0]
    return repo.noteSaveAsCopy(input)
  })
  h('notes:list', p => repo.listNotes(typeof p === 'string' ? p : p?.query, typeof p === 'object' && p ? p.spaceId : undefined))
  // 学习足迹：range/month/date 白名单校验，非法形状按缺省处理
  // 阅读会话：渲染层在导航冲刷/卸载时汇总上报（按会话一条，不每页写盘）
  h('activity:recordSession', (p) => {
    const input = p as { documentId?: unknown; pages?: unknown; seconds?: unknown }
    if (typeof input?.documentId !== 'string' || input.documentId.length === 0) throw new Error('非法文档 ID')
    repo.recordReaderSession({
      documentId: input.documentId,
      pages: typeof input.pages === 'number' && Number.isFinite(input.pages) ? input.pages : 0,
      seconds: typeof input.seconds === 'number' && Number.isFinite(input.seconds) ? input.seconds : 0
    })
  })
  h('activity:panel', (p) => {
    const input = (p ?? {}) as { range?: unknown; month?: unknown; date?: unknown; anchor?: unknown; spaceId?: unknown }
    const range = input.range === 'month' ? 'month' as const : 'week' as const
    return repo.activityPanel({
      range,
      month: typeof input.month === 'string' ? input.month : undefined,
      date: typeof input.date === 'string' ? input.date : undefined,
      anchor: typeof input.anchor === 'string' ? input.anchor : undefined,
      spaceId: typeof input.spaceId === 'string' || input.spaceId === null ? input.spaceId : undefined
    })
  })
  h('note:attachAnchor', (p) => {
    const input = p as { noteId: string; anchorId: string }
    return repo.attachAnchor(input.noteId, input.anchorId)
  })
  h('note:attachCapture', (p) => {
    const input = p as { noteId: string; captureId: string }
    return repo.attachCapture(input.noteId, input.captureId)
  })
  h('note:backlinks', (noteId) => repo.noteBacklinks(asId(noteId)))
  h('note:linkIndex', () => repo.noteLinkIndex())
  // 研究问题聚合：只读推导，枢纽笔记不存在时如实抛错（渲染层走 LoadError 重试）
  h('question:aggregate', (noteId) => repo.questionAggregate(asId(noteId)))
  h('note:imageAdd', (p) => {
    const input = p as { data: Uint8Array; fileName?: string }
    const data = input?.data
    if (!data || !(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('图片内容为空或格式不正确')
    return repo.addNoteImage({ data, fileName: typeof input.fileName === 'string' ? input.fileName : undefined })
  })
  h('notes:forDocument', (p) => repo.listNotesForDocument(asId(p.documentId), p?.opts))
  h('anchor:createWithNote', (p) => repo.createAnchorWithNote(p))

  // 外部链接：只放行 http/https（url-guard）；E2E 模式只记录不真开浏览器
  h('app:openExternal', (p) => {
    const url = externalOpenableUrl((p as { url?: unknown })?.url ?? p)
    if (!url) throw new Error('不允许打开的链接地址')
    lastExternalUrl = url
    if (process.env.MATHWB_E2E === '1') return { ok: true as const }
    return (async () => {
      const { shell } = await import('electron')
      await shell.openExternal(url)
    })()
  })

  h('capture:import', (p) => {
    const input = p as { paths: string[]; context?: string; spaceId?: string | null }
    return repo.importCaptures(asPaths(input.paths), input.context, input.spaceId)
  })
  h('capture:list', (p) => {
    const input = (p ?? {}) as { spaceId?: string | null; inboxStatus?: unknown }
    const inboxStatus = input.inboxStatus === 'inbox' || input.inboxStatus === 'filed' ? input.inboxStatus : undefined
    return repo.listCaptures(input.spaceId, inboxStatus)
  })
  h('capture:save', (p) => {
    const input = p as { id: string; context?: string; inboxStatus?: 'inbox' | 'filed' }
    repo.saveCapture(input.id, { context: input.context, inboxStatus: input.inboxStatus })
  })

  // 速记（纯文本捕获）：与照片同在收件箱，两类分开存取
  h('memo:create', (p) => {
    const input = p as { text?: unknown; spaceId?: string | null }
    if (typeof input?.text !== 'string') throw new Error('速记内容不正确')
    return repo.createMemo({ text: input.text, spaceId: input.spaceId })
  })
  h('memo:list', (p) => {
    const input = (p ?? {}) as { spaceId?: string | null; inboxStatus?: unknown }
    const inboxStatus = input.inboxStatus === 'inbox' || input.inboxStatus === 'filed' ? input.inboxStatus : undefined
    return repo.listMemos(input.spaceId, inboxStatus)
  })
  h('memo:save', (p) => {
    const input = p as { id: string; text?: string; inboxStatus?: 'inbox' | 'filed'; spaceId?: string | null; todo?: boolean }
    return repo.saveMemo(asId(input.id), {
      text: input.text,
      inboxStatus: input.inboxStatus,
      spaceId: input.spaceId,
      todo: input.todo
    })
  })
  h('memo:delete', async (id) => {
    // 先移入系统废纸篓（可恢复），成功后 Repo 才摘除索引——处置失败时速记仍在。
    // 无桌面环境（Linux CI 等）trashItem 会失败：退回直接删除并如实回报 trashed=false，别让用户删不掉。
    const { shell } = await import('electron')
    return repo.deleteMemo(asId(id), async (abs) => {
      try {
        await shell.trashItem(abs)
        return true
      } catch (err) {
        logWarn('memo', `速记移入废纸篓失败，改为直接删除：${err instanceof Error ? err.message : String(err)}`)
        rmSync(abs, { force: true })
        return false
      }
    })
  })
  h('memo:toNote', (p) => {
    const input = (p ?? {}) as { id: string; title?: string; spaceId?: string | null }
    return repo.memoToNote(asId(input.id), { title: input.title, spaceId: input.spaceId })
  })

  h('search', p => repo.search(typeof p === 'string' ? p : p?.q ?? '', typeof p === 'object' && p ? p.spaceId : undefined))

  h('library:search', (p) => repo.librarySearch(p ?? { q: '' }))
  h('library:sections', () => repo.librarySections())
  h('library:conflicts', () => repo.libraryConflicts())
  h('library:diagnostics', () => repo.libraryDiagnostics())
  h('library:entryGet', (id) => repo.libraryEntryGet(asId(id)))
  h('library:importUnfiled', async (p) => {
    const fileRel = String((p as { fileRel?: unknown })?.fileRel ?? '')
    const { result, absPath } = await repo.importUnfiled(fileRel)
    // 导入成功后把原文件移入系统废纸篓（可恢复）：避免库目录里留下重复副本。
    // 移入失败只记日志，不影响导入结果本身。
    if (result.ok && !result.duplicate) {
      try {
        const { shell } = await import('electron')
        await shell.trashItem(absPath)
        return { ...result, trashed: true }
      } catch (err) {
        logWarn('import', `散装文件移入废纸篓失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { ...result, trashed: false }
  })
  // 全文索引（WP-4）：手动重建（把缺失/过期/失败的条目重新入队）与单条目状态查询
  h('library:fulltextRebuild', async () => {
    if (!fulltextIndexer) throw new Error('全文索引器未接线')
    const metas = await readMetaForTargets(repo.libraryFulltextTargets())
    return { queued: fulltextIndexer.enqueueStale(metas) }
  })
  h('library:fulltextStatus', (id) => repo.fulltextStatusOf(asId(id)))
  h('library:updateEntry', (p) => repo.libraryEntryUpdate(asId(p.id), p.patch))
  h('library:move', (p) => repo.moveEntryToSection(asId(p.id), String(p.section)))
  h('library:sectionCreate', (p) => repo.sectionCreate(String((p as { name?: unknown })?.name ?? '')))
  h('library:sectionRename', (p) => {
    const input = (p ?? {}) as { oldName?: unknown; newName?: unknown }
    return repo.sectionRename(String(input.oldName ?? ''), String(input.newName ?? ''))
  })
  h('library:sectionDelete', (p) => repo.sectionDelete(String((p as { name?: unknown })?.name ?? '')))
  h('library:sectionColor', (p) => {
    const input = (p ?? {}) as { name?: unknown; color?: unknown }
    // 颜色只接受白名单 id 或 null（清除）；其余一律拒绝，避免脏值写进 分区.json
    const color = input.color === null || input.color === undefined ? null : input.color
    if (color !== null && !isSectionColor(color)) throw new Error('不支持的颜色')
    return repo.sectionColorSet(String(input.name ?? ''), color)
  })
  h('library:reveal', async (p) => {
    const dir = repo.libraryEntryDir(asId(p.id))
    if (!dir) throw new Error('条目不存在')
    const { shell } = await import('electron')
    await shell.openPath(dir)
  })
  h('library:revealSection', async (p) => {
    const dir = repo.librarySectionDir(String((p as { name?: unknown })?.name ?? ''))
    if (!dir) throw new Error('分区不存在')
    const { shell } = await import('electron')
    await shell.openPath(dir)
  })

  h('dlg:openJson', () => {
    const win = getWindow()
    const r = win
      ? dialog.showOpenDialogSync(win, {
          title: '选择 Zotero 导出的 CSL-JSON',
          properties: ['openFile'],
          filters: [{ name: 'CSL JSON', extensions: ['json'] }]
        })
      : null
    return r?.[0] ?? null
  })
  h('dlg:openDirectory', () => {
    const win = getWindow()
    const r = win
      ? dialog.showOpenDialogSync(win, { title: '选择附件目录（含以条目键命名的文件夹）', properties: ['openDirectory'] })
      : null
    return r?.[0] ?? null
  })

  // ---------- 数据文件夹（库根） ----------
  // 库根在启动时固化进 FolderStore/Repo/服务，运行中不可换；此处只做选择+校验+写设置，重启后生效。
  h('settings:libraryInfo', () => ({
    root: getLibraryRoot(),
    defaultRoot: defaultLibraryRoot(),
    isCustom: isCustomLibraryRoot()
  }))
  h('settings:chooseLibraryRoot', () => {
    const win = getWindow()
    if (!win) throw new Error('窗口不可用')
    const picked = dialog.showOpenDialogSync(win, {
      title: '选择数据文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (!picked || !picked[0]) return { ok: false as const, reason: 'cancelled' as const }
    const dir = picked[0]
    // 空文件夹=新库（启动时自动建骨架）；含任一库标记=已有库；其余非空目录拒绝，防止误指普通目录
    const markers = ['文献库', '笔记', '收件箱', '学习区.json', 'papers.json']
    let empty = false
    try { empty = readdirSync(dir).length === 0 } catch { throw new Error('无法读取该文件夹') }
    const isLibrary = markers.some((m) => existsSync(join(dir, m)))
    if (!empty && !isLibrary) return { ok: false as const, reason: 'not-library' as const, path: dir }
    setLibraryRoot(dir)
    return { ok: true as const, path: dir }
  })
  h('settings:resetLibraryRoot', () => {
    clearLibraryRoot()
    return { ok: true as const }
  })
  // 重启必须走主进程的保存握手（app.exit 不触发 close，直接调会丢掉未落盘内容）。
  // 握手是异步的：冲刷成功才重启，失败或超时保留应用并弹提示。
  h('app:relaunch', () => {
    if (!relaunch) throw new Error('重启入口未接线')
    relaunch()
  })
  h('zotero:import', async (p) => importZoteroLibrary(repo, String(p.jsonPath), p.storageDir ? String(p.storageDir) : null))
  h('reading:save', (p) => {
    const input = p as { documentId: string; pageIndex: number; scale: number; rotation: number }
    repo.saveReadingState(input)
  })
  h('reading:workspaceGet', documentId => repo.readingWorkspaceGet(asId(documentId)))
  h('reading:workspaceSave', input => repo.readingWorkspaceSave(input))
  h('reading:lastDocument', () => repo.readingLastDocument())
  // 阅读器「查找」：主进程用已索引的全文按页统计命中（扫描版/未建索引 → indexed=false）
  h('reader:find', (p) => {
    const input = (p ?? {}) as { versionId?: unknown; query?: unknown }
    return repo.findInDocument(asId(String(input.versionId ?? '')), String(input.query ?? ''))
  })

  h('paper:feedList', () => repo.paperFeedList())
  h('paper:feedCreate', (p) => repo.paperFeedCreate(p))
  h('paper:feedUpdate', (p) => repo.paperFeedUpdate(asId(p.id), p.patch))
  h('paper:feedDelete', (id) => repo.paperFeedDelete(asId(id)))
  h('paper:refresh', (feedId) => refreshFeeds(repo, typeof feedId === 'string' && feedId ? feedId : undefined))
  h('paper:list', (p) => repo.paperList(p?.status ?? 'new', typeof p?.days === 'number' ? p.days : 7))
  h('paper:import', async (p) => importPaper(repo, String(p.arxivId), typeof p?.spaceId === 'string' ? p.spaceId : null))
  h('paper:setStatus', (p) => repo.paperSetStatus(String(p.arxivId), p.status))
  h('paper:openAbs', (arxivId) => openAbsExternal(String(arxivId)))
  h('paper:importDaily', () => importDailyFolder(repo, getDailySettings().folder))
  h('paper:dailySettings', () => getDailySettings())
  h('paper:setDailySettings', (p) => setDailySettings(p ?? {}))
  h('paper:revealFolder', () => revealFolder())

  // ---------- 浏览器扩展导入 ----------
  // 连接信息（端口/令牌）给「文献库 → 浏览器导入」弹窗展示；打开扩展文件夹降低安装门槛
  h('import:info', () => importInfo?.() ?? { port: 0, token: '' })
  h('import:openExtensionDir', async () => {
    const dir = app.isPackaged ? join(process.resourcesPath, 'extension') : resolve(__dirname, '../../extension')
    if (!existsSync(dir)) throw new Error(`未找到扩展文件夹：${dir}（请确认完整安装）`)
    const { shell } = await import('electron')
    await shell.openPath(dir)
    return dir
  })
}

function asPaths(p: unknown): string[] {
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

function asId(v: unknown): string {
  // v2 存储：文档版本/资产 ID 为 64 位 sha256；其余实体仍为 UUID
  if (typeof v !== 'string' || !(/^[0-9a-fA-F-]{36}$/.test(v) || /^[0-9a-fA-F]{64}$/.test(v))) throw new Error('非法 ID')
  return v
}
