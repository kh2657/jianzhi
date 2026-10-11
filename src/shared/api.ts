import type {
  AnchorRecord,
  DocType,
  StudySpace,
  SpaceScope,
  CaptureImportResult,
  CaptureRecord,
  InboxStatus,
  MemoRecord,
  DocumentSummary,
  ImportResult,
  NoteFull,
  NoteLearningState,
  NoteRecord,
  NoteSaveResponse,
  NoteSummary,
  OpenDocumentResult,
  PageAnchorView,
  PaperFeed,
  PaperItem,
  PaperRefreshResult,
  PaperStatus,
  BacklinkView,
  DailyImportResult,
  ActivityPanelData,
  MaterialNoteView,
  ReadingWorkspace,
  NoteLinkIndexEntry,
  PdfRect,
  QuestionAggregate,
  SearchResponse,
  InkStroke,
  LibrarySearchQuery,
  LibrarySearchResponse,
  LibrarySearchHit,
  LibraryConflict,
  LibraryDiagnostics,
  FulltextIndexStatus,
  ReaderFindResult,
  LibrarySection,
  SectionColor,
  ZoteroImportResult
} from './types'

/** preload 通过 contextBridge 暴露的 API 契约（渲染进程只能通过它访问系统能力） */
export interface MathApi {
  appVersion(): Promise<string>
  appVersionInfo(): Promise<{ app: string; electron: string; node: string }>
  /** UI 偏好（本地服务端口随机，localStorage 跨会话不可靠；此处落 settings.json） */
  prefGet(key: string): Promise<string | null>
  prefSet(key: string, value: string): Promise<void>

  // 数据文件夹（库根；运行中不可换，写设置后重启生效）
  settingsLibraryInfo(): Promise<{ root: string; defaultRoot: string; isCustom: boolean }>
  settingsChooseLibraryRoot(): Promise<{ ok: true; path: string } | { ok: false; reason: 'cancelled' | 'not-library'; path?: string }>
  settingsResetLibraryRoot(): Promise<{ ok: true }>
  appRelaunch(): Promise<void>

  // 浏览器扩展导入（本地 HTTP 服务：127.0.0.1 + 令牌）
  importInfo(): Promise<{ port: number; token: string }>
  /** 在系统文件管理器中打开扩展文件夹（打包版 resources/extension；开发模式仓库 extension/） */
  importOpenExtensionDir(): Promise<string>

  spaceList(): Promise<StudySpace[]>
  spaceCreate(input: { name: string; kind: StudySpace['kind'] }): Promise<StudySpace>
  spaceUpdate(id: string, patch: { name: string; kind: StudySpace['kind'] }): Promise<StudySpace>
  assignSpace(entity: 'document' | 'note' | 'capture', id: string, spaceId: string | null): Promise<void>

  // 文件选择对话框（主进程）
  dialogOpenDocuments(): Promise<string[] | null>
  dialogOpenPdf(): Promise<string[] | null>
  dialogOpenImages(): Promise<string[] | null>

  // 文档
  docImport(paths: string[], options?: { spaceId?: string | null; docType?: DocType }): Promise<ImportResult[]>
  docList(spaceId?: SpaceScope): Promise<DocumentSummary[]>
  docOpen(documentId: string): Promise<OpenDocumentResult>
  docReadHtml(documentId: string): Promise<string>
  docUpdate(id: string, patch: { title?: string; docType?: DocType }): Promise<void>
  docSetMeta(versionId: string, meta: { pageCount?: number; fingerprint?: string }): Promise<void>

  // 锚点
  anchorCreate(input: {
    documentVersionId: string
    pageIndex: number
    pageLabel?: string | null
    rects: PdfRect[]
    quote?: string | null
  }): Promise<AnchorRecord>
  anchorGet(anchorId: string): Promise<AnchorRecord & { documentId: string; documentTitle: string }>
  anchorListPage(versionId: string, pageIndex: number): Promise<PageAnchorView[]>

  // 批注墨迹（整页笔画替换式保存；坐标为 PDF 用户空间）
  inkGet(versionId: string, pageIndex: number): Promise<InkStroke[]>
  inkSave(versionId: string, pageIndex: number, strokes: InkStroke[]): Promise<void>

  // arXiv 每日论文
  paperFeedList(): Promise<PaperFeed[]>
  paperFeedCreate(input: { name: string; categories: string; keywords: string; maxResults?: number }): Promise<PaperFeed>
  paperFeedUpdate(id: string, patch: { name?: string; categories?: string; keywords?: string; maxResults?: number }): Promise<void>
  paperFeedDelete(id: string): Promise<void>
  paperRefresh(feedId?: string): Promise<PaperRefreshResult[]>
  paperList(status: PaperStatus | 'all', days?: number): Promise<PaperItem[]>
  paperImport(arxivId: string, spaceId?: string | null): Promise<{ ok: boolean; documentId?: string; duplicate?: boolean; error?: string }>
  paperSetStatus(arxivId: string, status: PaperStatus): Promise<void>
  paperOpenAbs(arxivId: string): Promise<void>
  /** 每日清单：扫描导入文件夹（可配置）；返回每个文件的结果 */
  paperImportDaily(): Promise<DailyImportResult[]>
  paperDailySettings(): Promise<{ folder: string; autoCheck: boolean; lastCheck: string | null }>
  paperSetDailySettings(patch: { autoCheck?: boolean; folder?: string }): Promise<void>
  paperRevealFolder(): Promise<void>

  // 笔记
  noteCreate(input: { title: string; noteType?: NoteRecord['noteType']; bodyMd?: string; anchorId?: string; documentId?: string; spaceId?: string | null }): Promise<NoteRecord>
  noteGet(noteId: string): Promise<NoteFull>
  noteSave(input: {
    id: string
    title: string
    noteType: NoteRecord['noteType']
    bodyMd: string
    aliases: string[]
    verifiedStatus: NoteRecord['verifiedStatus']
    /** 编辑起点（getNoteFull / 上次保存返回值）的磁盘指纹；缺失 = 旧调用，保持后写覆盖 */
    baseHash?: string
    /** 用户在冲突界面上明确选择「以本地覆盖」：写前先把磁盘版本另存为独立笔记 */
    force?: boolean
    /** 知识块自评（WP-8）：undefined = 不改动；null = 清空。自评不算内容变化（不动修订号/最近更新） */
    learning?: NoteLearningState | null
  }): Promise<NoteSaveResponse>
  /** 本地草稿另存为独立笔记（冲突处理出口之一）：来源引用随副本保留，原笔记不动 */
  noteSaveAsCopy(input: {
    sourceId: string
    title: string
    noteType: NoteRecord['noteType']
    bodyMd: string
    aliases: string[]
    verifiedStatus: NoteRecord['verifiedStatus']
  }): Promise<NoteRecord>
  noteList(query?: string, spaceId?: SpaceScope): Promise<NoteSummary[]>
  /** 学习足迹面板：摘要 + 月历有记录日期 + 当日活动列表；spaceId 缺省=全部学习区；anchor=历史回看口径锚点（缺省=今天） */
  activityPanel(input: { range: 'week' | 'month'; month?: string; date?: string; anchor?: string; spaceId?: string | null }): Promise<ActivityPanelData>
  /** 阅读会话上报（ReaderView 在导航冲刷/卸载时汇总一条）；旁路统计，失败不影响阅读 */
  activityRecordSession(input: { documentId: string; pages: number; seconds: number }): Promise<void>
  noteAttachAnchor(noteId: string, anchorId: string): Promise<{ ok: boolean; already: boolean }>
  noteAttachCapture(noteId: string, captureId: string): Promise<{ ok: boolean; already: boolean }>
  noteBacklinks(noteId: string): Promise<BacklinkView[]>
  noteLinkIndex(): Promise<NoteLinkIndexEntry[]>
  /** 研究问题聚合（只读）：以一篇问题笔记为枢纽，汇总相关笔记 / 相关文献 / 知识块状态 */
  questionAggregate(noteId: string): Promise<QuestionAggregate>
  /** 笔记插图：图片字节落盘为内容寻址附件，返回 assetId（markdown 里写作 ![](asset:<id>)） */
  noteImageAdd(data: Uint8Array, fileName?: string): Promise<{ assetId: string; mediaType: string; byteSize: number }>
  /** 用系统浏览器打开外部链接（仅 http/https；主进程二次校验） */
  appOpenExternal(url: string): Promise<void>
  /** 材料工作台：这份材料的全部关联笔记（可选按页过滤）；锚点+建笔记为一次事务 */
  notesForDocument(documentId: string, opts?: { pageIndex?: number }): Promise<MaterialNoteView[]>
  anchorCreateWithNote(input: {
    anchor: {
      documentVersionId: string
      pageIndex: number
      pageLabel?: string | null
      rects: PdfRect[]
      quote?: string | null
    }
    note: { title: string; noteType?: NoteRecord['noteType']; bodyMd?: string; spaceId?: string | null }
  }): Promise<{ anchor: AnchorRecord; note: NoteRecord }>

  // 收件箱（演草纸照片等）
  captureImport(paths: string[], context?: string, spaceId?: SpaceScope): Promise<CaptureImportResult[]>
  captureList(filter?: { spaceId?: SpaceScope; inboxStatus?: CaptureRecord['inboxStatus'] }): Promise<
    Array<CaptureRecord & { originalName: string; mediaType: string; thumbUrl: string; displayUrl: string }>
  >
  captureSave(id: string, patch: { context?: string; inboxStatus?: CaptureRecord['inboxStatus'] }): Promise<void>

  // 收件箱速记（纯文本捕获：全局快捷键唤起，落到 收件箱/速记/*.md）
  memoCreate(input: { text: string; spaceId?: SpaceScope }): Promise<MemoRecord>
  memoList(filter?: { spaceId?: SpaceScope; inboxStatus?: InboxStatus }): Promise<MemoRecord[]>
  memoSave(id: string, patch: { text?: string; inboxStatus?: InboxStatus; spaceId?: SpaceScope; todo?: boolean }): Promise<void>
  /** 删除速记：文件移入系统废纸篓（可恢复），成功后才摘除索引；trashed=false 表示废纸篓不可用、已直接删除 */
  memoDelete(id: string): Promise<{ trashed: boolean }>
  /** 速记转笔记：正文原样成为笔记正文，标题取首行；速记随后标记已归档 */
  memoToNote(id: string, input?: { title?: string; spaceId?: SpaceScope }): Promise<NoteRecord>

  // 搜索
  search(q: string, spaceId?: SpaceScope): Promise<SearchResponse>

  // 文献库（存储格式 v2）
  librarySearch(query: LibrarySearchQuery): Promise<LibrarySearchResponse>
  librarySections(): Promise<LibrarySection[]>
  libraryConflicts(): Promise<LibraryConflict[]>
  /** 区目录里的散装文件与扫描中的坏文件（只读暴露，用于横幅提示；不自动修复） */
  libraryDiagnostics(): Promise<LibraryDiagnostics>
  /** 按稳定 id 直取条目（绕开检索返回上限；条目信息弹窗用，避免大库误报「不存在」） */
  libraryEntryGet(id: string): Promise<LibrarySearchHit | null>
  /** 导入分区目录里的散装文件；成功后原件移入系统废纸篓（trashed=true 表示已移入） */
  libraryImportUnfiled(fileRel: string): Promise<ImportResult & { trashed: boolean }>
  /** 重建全文索引：把缺失/过期/失败的条目重新入队，返回入队条数（后台串行执行） */
  libraryFulltextRebuild(): Promise<{ queued: number }>
  /** 单个条目的全文索引状态（派生数据；未建立返回 null） */
  libraryFulltextStatus(id: string): Promise<FulltextIndexStatus | null>
  libraryEntryUpdate(id: string, patch: {
    title?: string
    docType?: DocType
    authors?: string[]
    year?: number | null
    venue?: string | null
    doi?: string | null
    arxivId?: string | null
    abstract?: string | null
    tags?: string[]
    note?: string | null
    spaceId?: string | null
    status?: 'ok' | 'needs-review'
    starred?: boolean
  }): Promise<void>
  libraryEntryMove(id: string, section: string): Promise<void>
  /** 分区管理：新建 / 重命名（条目随目录走）/ 删除（条目移回「待整理」） */
  librarySectionCreate(name: string): Promise<void>
  librarySectionRename(oldName: string, newName: string): Promise<void>
  librarySectionDelete(name: string): Promise<void>
  /** 分区颜色标签（null 清除）；只改显示属性，不动目录 */
  librarySectionColor(name: string, color: SectionColor | null): Promise<void>
  /** 在系统文件管理器中显示条目文件夹（iCloud 同步目录） */
  libraryReveal(id: string): Promise<void>
  /** 在系统文件管理器中显示分区目录 */
  librarySectionReveal(name: string): Promise<void>

  // Zotero 导入（CSL-JSON + 可选附件目录）
  dialogOpenJsonFile(): Promise<string | null>
  dialogOpenDirectory(): Promise<string | null>
  zoteroImport(jsonPath: string, storageDir: string | null): Promise<ZoteroImportResult>

  // 阅读位置
  readingSave(input: { documentId: string; pageIndex: number; scale: number; rotation: number }): Promise<void>
  readingWorkspaceGet(documentId: string): Promise<ReadingWorkspace>
  readingWorkspaceSave(input: ReadingWorkspace): Promise<void>
  readingLastDocument(): Promise<string | null>
  /** 阅读器「查找」：主进程用已索引的全文按页统计命中（indexed=false = 无文本层/未建索引） */
  readerFind(versionId: string, query: string): Promise<ReaderFindResult>

  // 关闭前冲刷保存（根部一次性订阅；返回 off 供将来需要时使用）
  onFlushRequest(cb: () => Promise<void>): () => void
  notifyFlushed(): void

  /** 库变更推送（含 iCloud/网盘外部写入、其他窗口改动）；kinds 为发生变化的实体域；返回取消订阅 */
  onLibraryChanged(cb: (payload: { kinds: string[] }) => void): () => void

  /** 主进程主动通知（当前仅浏览器导入结果）；返回取消订阅 */
  onNotice(cb: (payload: { message: string; kind: 'success' | 'error' | 'info' }) => void): () => void

  /** 主进程请求唤起速记浮层（全局快捷键 ⌥⌘N / Ctrl+Alt+N）；返回取消订阅 */
  onQuickCapture(cb: () => void): () => void

  /** 渲染层诊断日志转发到主进程日志文件（fire-and-forget；只用于不可恢复错误与关键事件） */
  logToMain(level: 'info' | 'warn' | 'error', scope: string, message: string): void

  // 测试缝隙：仅在 MATHWB_E2E=1 的运行里由主进程注册该通道；生产环境调用会直接 reject
  testIpcFail(input: { channel: string | null; error?: string }): Promise<{ ok: true }>
  /** 仅 E2E：最近一次 appOpenExternal 请求的 URL；生产环境调用会直接 reject */
  testLastExternalUrl(): Promise<string | null>

  /** deep link（mathworkbench://paper?id=…）经主进程校验后转发；返回取消订阅 */
  onDeepLink(cb: (payload: { kind: 'paper'; baseId: string }) => void): () => void

  /** 仅 E2E：注入一个 URL 走与 open-url 相同的校验分发路径；生产环境无监听器，静默无效 */
  testDeepLink(url: string): void
  /** 仅 E2E：走全局快捷键的同一条派发路径（不 show/focus 窗口） */
  testQuickCapture(): void
}

export function assetUrl(assetId: string, variant: 'original' | 'display' | 'thumb' = 'original'): string {
  return `/api/asset/${assetId}?variant=${variant}`
}
