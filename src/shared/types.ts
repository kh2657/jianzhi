// 实体与传输类型：主进程、渲染进程、测试共用。
// 约定：id 一律为 UUID 字符串；时间一律为 ISO 8601 本地写入的 UTC 字符串。

export type NoteType =
  | 'concept'
  | 'theorem'
  | 'proof'
  | 'example'
  | 'counterexample'
  | 'problem'
  | 'note'

export type SpaceScope = string | null | undefined
export interface StudySpace { id: string; name: string; kind: 'course' | 'research'; createdAt: string }

export type DocType = 'book' | 'paper' | 'other'
export type VerifiedStatus = 'unchecked' | 'checked'
export type InboxStatus = 'inbox' | 'filed'

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  concept: '概念',
  theorem: '定理',
  proof: '证明',
  example: '例子',
  counterexample: '反例',
  problem: '问题',
  note: '笔记'
}

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  book: '书',
  paper: '论文',
  other: '其他'
}

export interface AssetRecord {
  id: string
  sha256: string
  mediaType: string
  byteSize: number
  relPath: string
  originalName: string
  createdAt: string
}

export interface DocumentRecord {
  spaceId: string | null
  id: string
  docType: DocType
  title: string
  authors: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface DocumentVersionRecord {
  id: string
  documentId: string
  assetId: string
  fingerprint: string | null
  pageCount: number | null
  importedAt: string
}

/** PDF 用户空间矩形：[xMin, yMin, xMax, yMax]，未应用显示旋转、未乘 UserUnit */
export type PdfRect = [number, number, number, number]

export interface AnchorRecord {
  id: string
  documentVersionId: string
  pageIndex: number
  pageLabel: string | null
  rects: PdfRect[]
  quote: string | null
  createdAt: string
}

export interface CaptureRecord {
  spaceId: string | null
  id: string
  assetId: string
  context: string | null
  inboxStatus: InboxStatus
  createdAt: string
}

/** 收件箱速记：零仪式的纯文本捕获（磁盘：收件箱/速记/<时间戳>-<id8>.md） */
export interface MemoRecord {
  id: string
  text: string
  inboxStatus: InboxStatus
  spaceId: string | null
  /** 待办：以 `!` 开头捕获或事后标记；待办面板据此聚合 */
  todo: boolean
  createdAt: string
  updatedAt: string
}

/** 知识块自评（随笔记文件保存：跨设备随库同步；内容指纹变化后旧标记自动失效） */
export interface NoteLearningRecord {
  status: 'understood' | 'question'
  fingerprint: string
}

export interface NoteLearningState {
  /** 当前块 ID（「继续上次学习」） */
  activeId?: string
  records: Record<string, NoteLearningRecord>
}

export interface NoteRecord {
  spaceId: string | null
  id: string
  noteType: NoteType
  title: string
  aliases: string[]
  bodyMd: string
  verifiedStatus: VerifiedStatus
  revisionNo: number
  createdAt: string
  updatedAt: string
  /** 知识块自评状态（存在笔记 front-matter 里；无标记为 null）。自评不是内容编辑：不动修订号与 updatedAt */
  learning: NoteLearningState | null
}

export interface DocumentSummary {
  mediaType: string
  spaceId: string | null
  id: string
  docType: DocType
  title: string
  pageCount: number | null
  versionCount: number
  lastReadPageIndex: number | null
  updatedAt: string
}

export interface OpenDocumentResult {
  spaceId: string | null
  mediaType: string
  documentId: string
  versionId: string
  assetId: string
  url: string
  title: string
  docType: DocType
  pageCount: number | null
  fingerprint: string | null
  readingState: { pageIndex: number; scale: number; rotation: number } | null
}

export interface ImportResult {
  ok: boolean
  path: string
  documentId?: string
  versionId?: string
  /** 同一资产（SHA-256 相同）已存在于库中 */
  duplicate?: boolean
  error?: string
}

export interface CaptureImportResult {
  ok: boolean
  path: string
  captureId?: string
  duplicate?: boolean
  error?: string
}

export interface NoteSummary {
  spaceId: string | null
  id: string
  noteType: NoteType
  title: string
  updatedAt: string
  anchorCount: number
  captureCount: number
  /** 学习自评里标「有疑问」的知识块数（待办面板的队列来源之一） */
  questionCount: number
  /** 是否源自文献（sources 含 anchor/document）——笔记区据此把「读文献时记的」与「自己的知识笔记」分开（2026-10-09 分流） */
  fromDoc: boolean
}

// ---------- 学习足迹（库根/足迹.json；从启用日起记录，不补造历史） ----------

/** 当日活动列表条目：同一笔记的多次保存合并为一条；摘录按材料合并 */
export interface ActivityDayItem {
  /** 稳定分组键（渲染层列表 key） */
  key: string
  kind: 'note' | 'anchors' | 'read' | 'ink' | 'review'
  /** note：true=新建，false=修改 */
  created: boolean
  noteId?: string
  documentId?: string
  /** 存活对象取索引实时标题（改名后仍正确）；已删除用事件时标题快照 */
  title: string
  deleted: boolean
  /** note：伴随摘录条数；anchors：当日该材料摘录条数 */
  anchorCount: number
  /** note 来自摘录时的材料标题（「随手记」路径） */
  fromDocumentTitle?: string
  /** 存活材料的媒体类型（跳转区分 PDF/HTML）；已删除为空 */
  mediaType?: string
  /** read：会话次数 / 去重页数 / 累计秒；ink：笔画数；review：两种自评的块数 */
  reads?: number
  pages?: number
  seconds?: number
  strokes?: number
  questions?: number
  understands?: number
  at: string
}

/** 对象级统计（足迹面板「这段时间你在哪些对象上花了功夫」） */
export interface ActivityObjectStat {
  kind: 'document' | 'note'
  id: string
  title: string
  deleted: boolean
  /** 存活材料的媒体类型（跳转区分 PDF/HTML）；已删除或笔记为空 */
  mediaType?: string
  /** 阅读会话次数 / 累计分钟 / 去重页数 */
  reads: number
  readMinutes: number
  pages: number
  /** 手写批注笔画数 */
  inkStrokes: number
  /** 摘录条数 */
  anchors: number
  /** 正文修改次数；created=范围内新建 */
  updates: number
  created: boolean
  /** 知识块自评：有疑问 / 已理解 的块数 */
  questions: number
  understands: number
  lastAt: string
}

export interface ActivityPanelData {
  /** 启用日（ISO）：足迹只承诺记录此之后 */
  startedAt: string
  /** 最近一次活动落盘是否成功；false 时面板提示「活动记录暂不可用」 */
  healthy: boolean
  /** 摘要范围（本地日期 YYYY-MM-DD）：本周=周一起，本月=自然月；按 anchor 计算（缺省=今天） */
  rangeStart: string
  rangeEnd: string
  summary: {
    activeDays: number
    created: number
    updated: number
    /** 范围内阅读累计分钟 / 去重页数合计 / 知识块自评次数 */
    readMinutes: number
    readPages: number
    reviews: number
  }
  /** 月历当前月与其中有活动的日期（本地日期） */
  month: string
  monthDays: string[]
  /** 热力图：最近 119 天（17 周）每天权重，只用于格子深浅 */
  heat: Array<{ date: string; weight: number }>
  /** 对象级统计（按投入排序，最多 12 条） */
  objects: ActivityObjectStat[]
  /** input.date 当天的活动列表 */
  items: ActivityDayItem[]
}

export interface NoteAnchorView extends AnchorRecord {
  documentId: string
  documentTitle: string
}

export interface NoteCaptureView extends CaptureRecord {
  originalName: string
  mediaType: string
}

/** 失效来源：来源对象已被删除（笔记里仍保留引用，但无法回跳） */
export interface NoteMissingSource {
  kind: 'anchor' | 'capture' | 'document'
  id: string
}

export interface NoteFull {
  documents: Array<{ documentId: string; title: string; mediaType: string }>
  note: NoteRecord
  anchors: NoteAnchorView[]
  captures: NoteCaptureView[]
  /** 解析不到的来源（锚点/照片/材料被删除）——显式列出，避免「来源无声消失」 */
  missingSources: NoteMissingSource[]
  /** 磁盘原文的内容指纹：编辑器把它随保存原样带回，用于检测外部修改（冲突保护） */
  baseHash: string
}

/** 笔记保存的冲突载荷：保存被拒绝时返回磁盘当前版本（供 UI 呈现与三选处理） */
export interface NoteSaveConflictInfo {
  title: string
  noteType: NoteType
  bodyMd: string
  aliases: string[]
  verifiedStatus: VerifiedStatus
  updatedAt: string
  revisionNo: number
  /** 磁盘版本的内容指纹（「载入磁盘版本」后以此为新的编辑起点） */
  baseHash: string
  /** 外部版本连 front-matter 都无法解析：bodyMd 为原始文本，供兜底保留 */
  parseFailed: boolean
}

/** 笔记保存结果：conflict=true 表示**未写入任何内容**，disk 为磁盘现状 */
export interface NoteSaveResponse {
  conflict: boolean
  disk?: NoteSaveConflictInfo
  /** 非冲突 = 本次保存后的状态；冲突 = 磁盘当前状态（未保存） */
  revisionNo: number
  savedAt: string
  /** 当前磁盘内容指纹：保存成功后为最新值，冲突时为磁盘版本指纹 */
  baseHash: string
  /** force 覆盖时，被另存为独立笔记的外部版本 id（双方内容都不丢） */
  archivedNoteId?: string
}

/** 库诊断（只读暴露）：坏文件与散装文件，让「静默消失」变成可见 */
export interface LibraryDiagnostics {
  /** 扫描中无法解析/缺文件的相对路径（含原因后缀） */
  malformed: string[]
  /** 直接放进分区目录、尚未入库的散装文件 */
  unfiled: Array<{ fileRel: string; fileName: string; byteSize: number }>
  /** 全文索引覆盖（pdfTotal = 库内 PDF 数；indexed = 已有 fulltext.txt 的（含扫描版 empty）） */
  fulltext: { pdfTotal: number; indexed: number }
}

/** 全文索引状态（派生数据，存 derived/fulltext.meta.json；经 IPC 暴露给条目信息弹窗） */
export type FulltextStatus = 'ready' | 'empty' | 'error'

export interface FulltextIndexStatus {
  status: FulltextStatus
  /** 提取引擎版本：实现升级后据此触发重建 */
  engine: number
  /** 绑定的原件 sha256（与当前文件不一致 → 索引过期） */
  fileSha: string
  pageCount: number | null
  pages: number
  chars: number
  /** 是否因页数/字符上限被截断（UI 可说明「前 N 页」） */
  truncated: boolean
  /** 每页起始字符偏移（升序）：供阅读器「查找」与全文命中定位页码；旧索引可能缺失 */
  pageStarts?: number[]
  indexedAt: string
  /** status=error 时的原因（用户可见诊断） */
  reason?: string | null
}

export interface PageAnchorView extends AnchorRecord {
  noteIds: string[]
  noteTitles: string[]
}

/** 批注墨迹：k=笔种类，c=颜色(#rrggbb)，w=线宽(PDF 用户空间单位)，pts=PDF 用户空间点列 */
export type InkKind = 'pen' | 'highlight'
export interface InkStroke {
  k: InkKind
  c: string
  w: number
  pts: Array<[number, number]>
}

/** arXiv 论文订阅（每日抓取条件） */
export interface PaperFeed {
  id: string
  name: string
  /** 逗号分隔的 arXiv 分类，如 "math.AG,math.NT" */
  categories: string
  /** 自由关键词（arXiv all: 检索），空=仅按分类 */
  keywords: string
  maxResults: number
  createdAt: string
}

export type PaperStatus = 'new' | 'imported' | 'skipped'

export interface PaperItem {
  id: string
  /** 不带 vN 的 arXiv 基础 ID（作品身份） */
  baseId: string
  version: string | null
  /** 当前候选版本的完整 ID（base + version） */
  arxivId: string
  title: string
  authors: string[]
  abstract: string
  primaryCategory: string | null
  publishedAt: string
  pdfUrl: string
  absUrl: string
  status: PaperStatus
  documentId: string | null
  fetchedAt: string
  /** 全部来源（订阅名 / 邮件清单匹配的订阅名），多对多 */
  feedNames: string[]
  /** 来源订阅 ID（papers.json 磁盘字段；transport 冗余，渲染层不依赖） */
  feedIds?: string[]
}

export interface PaperRefreshResult {
  feedId: string
  feedName: string
  fetched: number
  newItems: number
  error?: string
}

/** 每日论文清单（邮件脚本输出的版本化 JSON；字段长度/数量在导入端强制限制） */
export interface DailyPapersManifest {
  schemaVersion: 1
  generatedAt: string
  source: string
  items: Array<{
    provider: 'arxiv'
    providerId: string
    version?: string
    title: string
    authors: string[]
    abstract: string
    publishedAt: string
    url?: string
    matchedFeeds?: string[]
  }>
}

export interface DailyImportResult {
  ok: boolean
  file: string
  imported: number
  skipped: number
  error?: string
}

/** 材料工作台右栏笔记视图：一份材料（PDF/HTML）的全部关联笔记，含定位锚点 */
export interface MaterialNoteView {
  id: string
  title: string
  noteType: NoteType
  bodyMd: string
  aliases: string[]
  verifiedStatus: VerifiedStatus
  revisionNo: number
  updatedAt: string
  /** 指向本材料的锚点（HTML 材料级笔记为空数组） */
  anchors: Array<{ anchorId: string; pageIndex: number; rects: PdfRect[] }>
  /** 是否为整份材料级关联（note_document_sources） */
  viaDocumentSource: boolean
  /** 磁盘原文内容指纹：面板默认带上它保存，外部修改时保存会被拒绝（见 NoteSaveResponse） */
  baseHash: string
}

/** 阅读工作空间的专注/对照状态（随阅读记录持久化；设计提案 2026-10-10 §3.1） */
export interface ReaderSplitState {
  mode: 'focus' | 'split'
  /** 材料列宽百分比；可拖范围 40–70，双击复位 60 */
  ratio: number
}

/** 阅读现场与读后精读卡；复用既有笔记、PDF 锚点，不以填满栏目判定完成。 */
export interface ReadingWorkspace {
  documentId: string
  coreQuestion: string
  phase: 'reading' | 'paused' | 'reviewing' | 'complete'
  activeTab: 'notes' | 'card'
  notesScope: 'page' | 'all'
  expandedNoteId: string | null
  quickDraft: string
  resolvedNoteIds: string[]
  /** 专注/对照布局（v7 阶段 2 新增，可选：旧记录省略时按默认专注 + 60:40） */
  readerSplit?: ReaderSplitState
  sections: Array<{
    id: 'question' | 'method' | 'findings' | 'evidence' | 'relevance'
    /** 自由栏目名称；旧记录省略时由阅读面板显示默认名称。 */
    title?: string
    body: string
    anchorIds: string[]
    checked: boolean
  }>
  updatedAt: string | null
}

/** 反向链接：哪篇笔记的正文 [[链接]] 指向本笔记 */
export interface BacklinkView {
  fromNoteId: string
  fromTitle: string
  fromNoteType: NoteType
  snippet: string
}

/** 笔记链接索引（编辑器渲染/输入辅助用，轻量表） */
export interface NoteLinkIndexEntry {
  id: string
  title: string
  aliases: string[]
}

/**
 * 研究问题聚合（只读）：以一篇问题笔记为枢纽，实时汇总与它相连的笔记、文献与知识块状态。
 * 不落任何新存储——全部从双链、笔记 front-matter 的 sources 与 learning 自评推导。
 */
export interface QuestionAggregate {
  /** 枢纽笔记（聚合的中心，不出现在 notes 里） */
  hub: { id: string; title: string }
  /** 相关笔记：link 标明关系方向（in=对方链入本问题，out=本问题链出去，both=双向） */
  notes: Array<{
    id: string
    title: string
    questionCount: number
    understoodCount: number
    updatedAt: string
    link: 'in' | 'out' | 'both'
  }>
  /** 相关文献（枢纽与相关笔记的 sources 汇总，按文献去重并合计摘录数） */
  documents: Array<{ id: string; title: string; anchorCount: number; mediaType?: string }>
  /** 枢纽 + 相关笔记的知识块自评合计 */
  blocks: { total: number; understood: number; question: number }
}

/** 笔记命中的知识块（同一笔记归为一条结果；块序号供渲染层滚动定位） */
export interface SearchNoteBlockHit {
  /** 「## 二级标题」文本；引言/无标题块为 null（定位正文开头） */
  heading: string | null
  /** 块序号（splitNoteBlocks 顺序，主/渲染两侧同一规则） */
  blockIndex: number
  /** 块内命中上下文片段 */
  snippet: string
}

export interface SearchNoteHit {
  id: string
  title: string
  noteType: NoteType
  snippet: string
  /** 最近更新（搜索行展示用；浏览列表另有 NoteSummary） */
  updatedAt?: string
  /** 命中的知识块摘要（最多 3 条，按文档顺序） */
  blockHits?: SearchNoteBlockHit[]
  /** 命中块总数（blockHits 是其截断） */
  blockHitCount?: number
  /** 是否源自文献（与 NoteSummary.fromDoc 同口径；笔记区据此分流） */
  fromDoc?: boolean
}

export interface SearchAnchorHit {
  anchorId: string
  documentId: string
  documentTitle: string
  pageIndex: number
  quote: string | null
}

export interface SearchMemoHit {
  id: string
  /** 命中处上下文（定位不到命中位置时取正文开头） */
  snippet: string
  todo: boolean
  createdAt: string
}

export interface SearchResponse {
  notes: SearchNoteHit[]
  anchors: SearchAnchorHit[]
  memos: SearchMemoHit[]
  /** 命中总数（不受返回条数上限影响）：UI 据此提示「只显示了前 N 条」 */
  notesTotal: number
  anchorsTotal: number
  memosTotal: number
  tookMs: number
  mode: 'fts' | 'like'
}

// ---------- 文献库（存储格式 v2，见 docs/存储格式.md） ----------

/** entry.json 内的单个原件文件；sha256 同时作为传输层的 versionId / assetId */
export interface EntryFile {
  sha256: string
  name: string
  mediaType: string
  byteSize: number
  pageCount: number | null
  fingerprint: string | null
  importedAt: string
  /** 仅文献库检索传输层标记：声明存在但盘上找不到（同步盘改名/丢失）；不会写回 entry.json */
  missing?: boolean
}

/** 文献条目元数据：entry.json 的磁盘 schema，也是文献库视图的传输类型 */
export interface EntryMeta {
  schema: 2
  id: string
  docType: DocType
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  arxivId: string | null
  abstract: string | null
  tags: string[]
  /** 学习区归属（双轨制：分区=文件夹位置管归类，学习区=任务 scope） */
  spaceId: string | null
  status: 'ok' | 'needs-review'
  note: string | null
  /** 收藏标记（仅 true 时写入 entry.json） */
  starred?: boolean
  files: EntryFile[]
  readingState: { pageIndex: number; scale: number; rotation: number; lastReadAt?: string } | null
  createdAt: string
  updatedAt: string
}

export type LibraryFacetKind = 'year' | 'author' | 'venue' | 'tag' | 'section'

/**
 * 分区颜色标签（类似 Finder 标签）：纯粹是分区目录的显示属性，不影响归类与身份。
 * 取值是稳定的语义色 id，具体色值由渲染层主题映射——主题切换 / 未来调色不必迁移数据。
 */
export const SECTION_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const
export type SectionColor = (typeof SECTION_COLORS)[number]

export function isSectionColor(value: unknown): value is SectionColor {
  return typeof value === 'string' && (SECTION_COLORS as readonly string[]).includes(value)
}

/** 分区条目（左侧分区栏）：目录列举 + 计数聚合 + 颜色标签 */
export interface LibrarySection {
  name: string
  count: number
  needsReview: number
  /** 未设色为 null（库根 分区.json 缺键或键被清理） */
  color: SectionColor | null
}

/** 文献库检索：原始查询串（自由词 + 字段:值）与结构化过滤（分面点击）叠加 */
/** 文献库排序方式（默认「最近更新」） */
export type LibrarySort = 'updated' | 'created' | 'title' | 'author' | 'year'

export interface LibrarySearchQuery {
  q: string
  filters?: Partial<Record<LibraryFacetKind, string[]>>
  spaceId?: SpaceScope
  status?: 'ok' | 'needs-review' | 'all'
  /** 仅看收藏 */
  starred?: boolean
  sort?: LibrarySort
  /** 分页起点（用于「加载更多」；默认 0）。排序发生在分页之前，同一查询下页间一致 */
  offset?: number
}

export interface LibraryFacetCount {
  value: string
  count: number
}

/** 命中理由：哪个字段、哪个词、上下文片段（结果行直接展示，避免「命中但不知从哪来」） */
export interface LibraryMatchInfo {
  field: string
  term: string
  snippet: string
  /** 历史字段：全文命中页码已随检索范围调整废止（architecture §15），保留仅为接口形状兼容 */
  page?: number | null
}

/** 阅读器「查找」结果（按页统计；indexed=false 表示本文档没有可搜索的文本层） */
export interface ReaderFindResult {
  indexed: boolean
  total: number
  pages: Array<{ pageIndex: number; count: number }>
}

export interface LibrarySearchHit {
  entry: EntryMeta
  /** 所在分区（= 文献库/<分区>/ 目录名） */
  section: string
  /** 命中理由（仅在有自由词时计算；字段检索命中为 null） */
  match: LibraryMatchInfo | null
}

export interface LibrarySearchResponse {
  hits: LibrarySearchHit[]
  facets: Record<LibraryFacetKind, LibraryFacetCount[]>
  total: number
  /** 全库收藏总数（导航计数，不受筛选影响） */
  starredCount: number
  /**
   * 恒为 0（architecture §15：全文已退出普通检索，「未建全文」提示移除；字段保留仅为接口形状兼容）。
   * 全文索引覆盖情况移步库诊断（libraryDiagnostics.fulltext）。
   */
  unindexed: number
  tookMs: number
}

/** 网盘同步冲突副本（iCloud「冲突」/Dropbox「conflict」等命名模式）检测结果 */
export interface LibraryConflict {
  path: string
  kind: 'file' | 'folder'
  pattern: string
  detectedAt: string
}

/** Zotero CSL-JSON 导入结果汇总（total=识别成功的条目，skipped=无法识别的行） */
export interface ZoteroImportResult {
  total: number
  skipped: number
  created: number
  duplicated: number
  failed: number
  errors: string[]
}
