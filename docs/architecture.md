# 架构与关键决策（P0 + 纵向原型）

> **阅读提示（2026-10-08 加注）**：本文 §1–§13 是首版（0.1.0，SQLite 存储）的设计记录，
> **已被 §14 ADR-7「文件即真相」取代**：当前实现是纯文件夹存储（`src/main/storage/folder-store.ts`、
> `folder-index.ts`、`repo.ts`），格式规范以 [docs/存储格式.md](存储格式.md) 为唯一来源。
> 文中提到的 `library.db` / better-sqlite3、FTS5 trigram、`note_revisions` 历史表、chapters/relations
> 表均已不存在（`better-sqlite3` 仅保留在一次性迁移脚本里；修订号只是一个计数器）。
> 需要了解现状请直接读 §14 与 docs/存储格式.md，不要把 §1–§13 当作当前事实。

版本：2026-10-03。对应代码：本仓库首版（0.1.0）。
机器基线：Apple M5 / 16GB / macOS 26.3.2（darwin arm64）。

## 1. 技术栈（已锁定，P0 验证后）

| 组件 | 选型 | 版本（锁定） | 说明 |
| --- | --- | --- | --- |
| 桌面壳 | Electron | 40.10.3 | 见 ADR-3 版本约束 |
| 语言 | TypeScript（strict） | TS 6.x | 三段式 project references（node/web/preload） |
| 构建 | electron-vite 5 + vite 7 | — | dev：vite dev server；prod：out/ 静态产物 |
| UI | React 19 | — | 无额外状态库 |
| PDF | pdfjs-dist | **5.4.624（刻意钉住）** | 见 ADR-2 |
| 存储 | better-sqlite3 13 | — | 预编译（N-API 风格），Node 与 Electron 同一产物可加载，无需 rebuild |
| 公式 | KaTeX | 0.19 | throwOnError:false，非法公式保留原文 |
| Markdown | marked + DOMPurify | — | 数学段先摘出，代码段保护，最后 DOMPurify 兜底 |
| 打包 | electron-builder 26 | — | mac dir+zip，未签名（identity: null），better-sqlite3 asarUnpack |

## 2. 进程与数据边界

```text
┌─ 主进程 ────────────────────────────────────────────────┐
│ SQLite（WAL，user_version 迁移）    资产目录（内容寻址）      │
│  library.db                          assets/<ab>/<cd>/<sha>.<ext> │
│                                      derived/<assetId>.<用途>.jpg │
│ 本地受控服务（仅 127.0.0.1）                              │
│  GET /            out/renderer 静态（生产）                  │
│  GET /api/asset/<uuid>?variant=      资产流（支持 Range）      │
│ IPC（ipcMain.handle，见 src/shared/api.ts 契约）             │
└──────────────────────────────────────────────────────────┘
        ▲ preload（contextBridge，唯一桥）
┌─ 渲染进程 ──────────────────────────────────────────────┐
│ 文库 / 阅读器（canvas+TextLayer+锚点叠加层）/ 笔记 / 收件箱    │
│ nodeIntegration: false，sandbox: false（contextIsolation 开）│
└──────────────────────────────────────────────────────────┘
```

- 数据位置：`<userData>/library/`（`library.db` + `assets/` + `derived/` + `.tmp/`）。
- 原件只读：导入走「暂存复制 → 复制后 SHA-256 复核 → 原子改名」；派生文件（缩略图、HEIC 显示副本）全部在 `derived/`，可随时删除重建。
- 资产寻址按内容（SHA-256），同一字节只有一份原件；数据库行是唯一权威。

## 3. ADR-1：渲染页面用主进程的本地 HTTP 服务，不用 file://

**决策**：生产模式主进程 `http.createServer` 监听 `127.0.0.1` 随机端口，serve `out/renderer` 与 `/api/asset/*`；开发模式只跑 `/api`（vite 把 `/api` 代理到 `.env` 中固定的 `MATHWB_ASSET_PORT`）。

**理由**：
1. `file://` 下 module worker、cmap/字体相对路径、CSP 行为各有一堆特例；HTTP 下全部为常规语义（PDF.js worker 为 ESM module worker）。
2. PDF 按 URL 流式加载，实现 `Range`（206）支持，避免整本读入内存。
3. 资产只能按数据库中的资产 UUID 取用，客户端无法传文件系统路径；静态服务限制在 renderer 目录内（路径穿越拒绝）。

**代价与对策**：本地端口可被同机进程访问 → 仅绑定 127.0.0.1；响应带 CSP；资产路径不可枚举（UUID）。

## 4. ADR-2：pdfjs-dist 钉在 5.4.624

实测 pdfjs-dist v6.3（及 v5.7）使用 `Map.prototype.getOrInsertComputed`（ES2026 upsert），Electron 40 的 V8 尚未提供，`page.render` 直接抛 `TypeError`，页面空白。v5.4.624 无此依赖，在 Electron 40 渲染进程实测正常（E2E 含像素级非空白断言）。
升级 Electron 后可重新评估 v6；`package.json` 版本即为约束记录。

## 5. ADR-3：Electron 钉在 40.10.3

与 pdfjs 约束互为因果：更新 Electron 需同时回归 PDF 渲染路径（`npm run e2e` 的纵向用例即为此守卫）。better-sqlite3 v13 预编译产物在 Node 26 与 Electron 40 下均直接加载（自检与单测双证据），因此 electron-builder 配置 `npmRebuild: false`。

## 6. 坐标契约（计划 §3 的实现）

- 锚点矩形持久化为 PDF 用户空间 `[xMin, yMin, xMax, yMax]`（`anchors.rects_json`）。
- 屏幕↔PDF 只经 PDF.js viewport 变换：`src/shared/coords.ts` 是唯一实现（CSS→`convertToPdfPoint`；PDF→`convertToViewportPoint` 两角点规范化——v6 移除了 `convertToViewportRectangle`，此实现与其等价，v5.4 下两者并存且一致）。
- 不自行处理 CropBox/旋转/UserUnit/Retina；`pageIndex` 为 0 起物理页索引，`pageLabel` 仅展示。
- 验证：纯数学往返（6 组合 × 旋转/裁切/UserUnit）+ 真实夹具（4 类 × 7 组合）+ E2E 端到端几何断言（±3px）。

## 7. 搜索

- FTS5 `trigram` 分词（notes_fts / anchors_fts），≥3 字符走 MATCH（短语引用转义，杜绝语法注入）。
- <3 字符（中文两字词常见）回退限定范围 LIKE 子串查询。
- 别名参与索引；结果含片段；LIMIT 50。P0 探针：208 条数据 FTS ≈ sub-ms。
- 不承诺：全库 PDF 全文、公式语义检索（计划边界）。

## 8. 笔记与修订

- `notes` 为当前态，`note_revisions` 每次正文变化追加一条（source_type: user|agent）。相同正文重复保存不产生新修订。
- 自动保存 800ms 防抖；关闭窗口走「主进程挂起 → 渲染进程冲刷 → IPC 确认 → 销毁」路径，超时 5s 强制退出（未提交部分以最后成功保存为界）。
- 采纳 agent 整理结果的候选修订通道属 P3 范围；当前已支持直接粘贴 Markdown/LaTeX。

## 9. 安全边界（当前实现）

- contextIsolation 开、nodeIntegration 关；渲染进程能力 = `window.api` 白名单 IPC。
- CSP：`script-src 'self'`；`style-src 'unsafe-inline'` 仅为 KaTeX 行内样式所必需（已注释）。
- 外部 Markdown：marked 解析 + DOMPurify（禁 script/iframe/form 等；代码段先摘出避免误伤）；数学内容不作为指令执行。
- 文件导入：主进程执行；扩展名→MIME 白名单；PDF 需 `%PDF-` 头；资产路径解析不可逃出托管目录。
- 首版无任何模型调用、无上传、无 API 密钥。

## 10. 已知边界（P0/原型范围外，见计划）

- 章节树、双向链接/关系图、agent 结构化交换包、备份/恢复、回收站：schema 已就位（chapters/relations/note_chapters），UI 与流程在 P1+。
- 同字节内容重复导入 PDF 提示「已存在」且不建新条目；「明确建另一书目条目」为后续功能。
- 备份一致性快照（SQLite backup API + 资产清单）属 P1。

## 11. ADR-5：PDF 批注墨迹 = 数据库覆盖层，绝不改写 PDF 原件

**决策**（2026-10-04，v3 迁移）：手写批注（笔/荧光笔）存储在 `page_annotations` 表（每文档版本×页一行，笔画数组 JSON），渲染为页面上的透明 canvas 覆盖层。**永不写入或改写 PDF 文件本身**——这是「原件不可变」承诺的直接延伸。

- 笔画坐标与锚点同一契约：PDF 用户空间点列（`InkStroke {k, c, w, pts}`），缩放/旋转/裁切由 PDF.js viewport 正逆变换处理；换 viewport 显示时重算 CSS 位置。
- 保存策略：整页笔画替换式 upsert（`UNIQUE(version, page)`），500ms 防抖；翻页/关窗时冲刷未保存页。写入前统一净化（颜色/线宽/点数/笔画数上限），损坏 JSON 容错返回空。
- 橡皮为笔画级删除（点到线段距离命中），撤销栈在会话内存（⌘Z），清空可撤销。
- 代价：墨迹不进 PDF 文件，第三方阅读器看不到。若未来需要「带批注导出 PDF」，用 pdf-lib 把笔画画进新文件（副本），不动原件。

## 12. 学习区（spaces）与文档信息

- 学习区 = 顶层资料范围（课程/论文专题），单选归属（`space_id` 列），文档/笔记/照片各自归属；切换学习区过滤所有列表与搜索。归属变更不影响来源链接。
- 文档另有两个独立维度：**材料类型**（书/论文/其他，可筛选）与 **媒体类型**（PDF/HTML，决定阅读器）。
- 文库行内操作收敛为「⋯」信息弹窗：改名、改类型、移动学习区一次完成（草稿态，保存才生效）。

## 13. ADR-6：arXiv 每日论文 = 应用内订阅抓取，替代「脚本 → 邮箱」管道

**决策**（2026-10-04，v4 迁移）：用户此前用自建脚本每天从 arXiv 抓论文发到自己邮箱。应用内实现「每日论文」页替代整条管道：订阅（分类 + 关键词）→ 点「抓取」时调 arXiv Atom API → 条目列表（标题/作者/摘要/分类，按日期分组）→ 人工挑选「导入文库」或「忽略」。

- **网络边界**：只有用户点击「抓取」「导入」「arXiv 页面」时才发起网络请求（export.arxiv.org / arxiv.org）；无后台轮询、无隐式上传。API 端点可用 `MATHWB_ARXIV_API` 覆盖（仅测试/E2E 用本地 mock）。
- **去重与状态**：条目按 `arxiv_id` 全局唯一；状态机 new → imported（只能由导入操作设置）/ skipped；重复抓取不重置已有条目状态。
- **导入走既有管道**：下载 PDF（主机白名单 arxiv.org + 测试模式本地，防 SSRF；`%PDF-` 头校验）→ `importDocuments`（内容寻址托管、SHA-256 去重）→ 预填真实标题/作者/备注 `arXiv:<id>` → 归入当前学习区、类型=论文。
- **解析**：fast-xml-parser 解析 Atom（isArray 白名单），标题/摘要空白清洗，缺 pdf link 时兜底官方 URL；解析为纯函数，样本单测 + 自检离线覆盖。
- 多订阅顺序抓取，间隔 3 秒（arXiv 礼貌策略）；每次抓取上限默认 50（≤200）。

## 14. ADR-7：存储 v2 = 纯文件夹 + 内存索引，移除 SQLite

**决策**（2026-10-07）：存储层从 better-sqlite3（WAL）整体切换为「纯文件夹 + 内存索引」，格式规范见 `docs/存储格式.md`。这是对 §2「数据库行是唯一权威」的**取代**：此后**用户可见的文件即真相**，索引（内存 + .cache/ 快照）只是加速结构，随时可从文件夹全量重建。

**动机**：
1. 数据目录经目录联接落在 iCloud Drive（Win ⇄ Mac 双机同步）后，WAL 数据库是唯一不能安全同步的东西——程序运行期间它是多文件活体，文件级同步会损坏它。纯文件夹方案下，同步冲突的最坏结果从「数据库打不开」降为「单文件冲突副本」（程序可检测并报告）。
2. 用户直接可读：一篇文献一个文件夹、明文命名 PDF、markdown 笔记，iPad/任何设备可直接使用。
3. 移除 better-sqlite3 原生模块，Windows 构建链简化。

**代价与对策**：
- FTS5 trigram 检索 → 内存扫描式子串检索（个人量级毫秒级，中文子串天然支持）；PDF 全文检索按需读 `derived/fulltext.txt`。
- 事务性 → 原子写（临时文件 + rename）+ 单写者纪律（同时刻只允许一台机器运行程序写库，冲突副本检测兜底）。
- 修订历史（note_revisions）不迁移，`revision` 仅保留计数器（见 存储格式.md §4）。
- 旧库迁移：一次性脚本 `npm run migrate` 读旧 library.db 生成新结构（better-sqlite3 降为 devDep，仅迁移脚本使用）。
- 渲染层与 IPC 契约不变（DocumentRecord/AnchorRecord 等 transport 类型原样保留），阅读器/笔记/收件箱零改动。

**验证**：storage-kernel 单测（扫描/重建/原子写/监听）；既有 ~140 单测 + 40 E2E 在新 Repo 上全量回归；selftest 重新定义（存储假设已变）。

## 15. 检索范围决策（2026-10-09 确认，已实施）

用户已确认：文献按标题与主题找，知识按笔记正文找，原文在打开后查。以下行为已实施（PR #4「检索范围三阶段」），验收断言见 `tests/wp4-fulltext.spec.ts`、`tests/search*.spec.ts` 与 `tests/e2e/search-ux.spec.ts`。

- 文献库普通自由词只匹配 `entry.json` 的 `title` 与 `tags`，关键词复用标签；摘要、备注、作者、文件名和 PDF 正文不参与自由词匹配。作者、年份、期刊、分区、学习区、收藏及 DOI/arXiv 字段条件保留原有语义。旧 `全文:` / `fulltext:` 条件明确提示不再支持，不能静默忽略或继续扫描全库。
- 笔记检索匹配标题、别名和正文；按笔记归并命中，展示块/段落摘要并定位。多词 AND 可跨同一笔记的不同块，引号短语不跨字段边界。当前笔记查找采用最新草稿，支持逐处导航；查找和跳转不修改自评、修订号、更新时间或足迹。
- 当前 PDF 查找沿用阅读器，只查当前打开文档。全局搜索按文献、笔记等现有类型分组；文献组与笔记组遵循相同边界，现有摘录与速记搜索保留，不新增 PDF 全文组。
- 保留 ADR-7 的文件存储与既有内存索引；复用缓存、解析和知识块导航，缓存失效覆盖保存、外部重扫、删除与切库。普通文献查询全链路不得逐条读取或 stat 全库派生全文。
- 原“内存热层 + SQLite 全文冷层”提案撤回。本次不引入数据库运行时依赖、OCR、向量检索或新存储格式；不删除已有派生文件、全文提取器与诊断。后台提取生命周期后续单独评估。
- 文献搜索排序、笔记命中定位及废止全文语法属于行为变更，执行者需更新用户说明与回归断言。必要的笔记定位接口扩展先写影响分析，共享区/内核改动留给人工审核；交付遵守项目全量门禁。性能目标仅为待测目标，不作为已验证结论。
