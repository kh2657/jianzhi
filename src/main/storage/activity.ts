// 学习足迹活动记录（库根/足迹.json）。事件只在 Repo 写路径产生（单写者）：
// 外部同步、索引重建、fs.watch 都不经过这里，天然不会把非本机行为计成学习活动。
// 原子写（临时文件 + rename）与全库约定一致；写入失败不抛给保存流程——
// 事件保留在内存、标记 unhealthy，下次写入自动重试（统计与正文保存状态分开）。
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson, atomicWriteJsonSync } from './fsutil'
import { info as logInfo, error as logError } from '../logger'

export type ActivityKind =
  | 'note-created'
  | 'note-updated'
  | 'anchor-added'
  | 'reader-session'
  | 'ink-saved'
  | 'block-reviewed'

export interface ActivityEvent {
  id: string
  /** 已知取值见 ActivityKind；未知值原样保留并写回（前向兼容：新旧版本混跑不丢事件） */
  kind: string
  /** ISO 绝对时间 */
  at: string
  /** 事件发生时的本地日期（YYYY-MM-DD）；跨时区后历史归属不漂移 */
  date: string
  noteId?: string
  documentId?: string
  /** 事件时的标题快照（对象删除后展示用；存活对象以索引实时标题为准） */
  title?: string
  /** 事件发生时的学习区快照；移动笔记不改写过去的足迹 */
  spaceId?: string | null
  /** 摘录 + 伴随建笔记的合并叙述键 */
  groupId?: string
  /** reader-session：本次会话翻到的去重页数 */
  pages?: number
  /** reader-session：会话时长（秒） */
  seconds?: number
  /** ink-saved：该页笔画数与页码 */
  strokes?: number
  pageIndex?: number
  /** block-reviewed：知识块自评结果 */
  status?: 'understood' | 'question'
}

interface ActivityFile {
  schema: 3
  /** 启用日（ISO）：足迹只承诺记录此之后的本机活动 */
  startedAt: string
  events: ActivityEvent[]
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 主进程本地日期键（与渲染层 time-label 的 localDateKey 同口径，主进程不能引渲染层模块） */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function dateOfKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 周一为一周开始 */
export function weekRangeOf(dateKey: string): { start: string; end: string } {
  const date = dateOfKey(dateKey)
  const dow = (date.getDay() + 6) % 7
  return {
    start: localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - dow)),
    end: localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + (6 - dow)))
  }
}

export function monthRangeOf(dateKey: string): { start: string; end: string } {
  const date = dateOfKey(dateKey)
  return {
    start: localDateKey(new Date(date.getFullYear(), date.getMonth(), 1)),
    end: localDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 0))
  }
}

export class ActivityStore {
  private data: ActivityFile | null = null
  /** 最近一次磁盘写入是否成功；失败时查询方据此在面板提示「活动记录暂不可用」 */
  healthy = true
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {}

  private fileAbs(): string {
    return join(this.root, '足迹.json')
  }

  /** 启动/首次需要时调用：无文件则以现在为启用日创建；损坏文件备份为 足迹.json.broken 后重建，不抛出 */
  ensure(): void {
    if (this.data) return
    const abs = this.fileAbs()
    if (existsSync(abs)) {
      try {
        const raw = JSON.parse(readFileSync(abs, 'utf8')) as { schema?: unknown; startedAt?: unknown; events?: unknown }
        if (raw && (raw.schema === 2 || raw.schema === 3) && typeof raw.startedAt === 'string' && Array.isArray(raw.events)) {
          // schema 2 的旧事件原样保留（种类未变）；未知种类也保留，写回不丢（前向兼容）
          const events = (raw.events as unknown[]).filter(
            (e): e is ActivityEvent => Boolean(e) && typeof (e as ActivityEvent).id === 'string' && typeof (e as ActivityEvent).date === 'string'
          )
          this.data = { schema: 3, startedAt: raw.startedAt, events }
          return
        }
        throw new Error('结构不符')
      } catch (err) {
        logError('activity', err instanceof Error ? err : new Error(String(err)))
        try { renameSync(abs, `${abs}.broken`) } catch { /* 覆盖失败也无妨，下次写入覆盖 */ }
      }
    }
    this.data = { schema: 3, startedAt: new Date().toISOString(), events: [] }
    // 同步落盘：启用日文件即时存在（启动期一次性小文件，几毫秒）
    try {
      atomicWriteJsonSync(abs, this.data)
      logInfo('activity', `学习足迹启用：${abs}`)
    } catch (err) {
      // 初始化失败不阻断启动；下次 record 重试
      this.healthy = false
      logError('activity', err instanceof Error ? err : new Error(String(err)))
    }
  }

  startedAt(): string {
    this.ensure()
    return this.data!.startedAt
  }

  all(): ActivityEvent[] {
    this.ensure()
    return this.data!.events
  }

  /** 追加事件并落盘。内存中立即生效（查询一致）；磁盘失败标记 unhealthy，不向保存流程抛错 */
  record(input: Omit<ActivityEvent, 'id' | 'at' | 'date'> & { at?: string }): void {
    this.ensure()
    const at = input.at ?? new Date().toISOString()
    const event: ActivityEvent = {
      id: randomUUID(),
      kind: input.kind,
      at,
      date: localDateKey(new Date(at)),
      noteId: input.noteId,
      documentId: input.documentId,
      title: input.title,
      spaceId: input.spaceId,
      groupId: input.groupId,
      pages: input.pages,
      seconds: input.seconds,
      strokes: input.strokes,
      pageIndex: input.pageIndex,
      status: input.status
    }
    this.data!.events.push(event)
    void this.persist()
  }

  private persist(): Promise<void> {
    // 串行化写入，避免并发 saveNote 的足迹写互相覆盖
    this.writeChain = this.writeChain.then(async () => {
      if (!this.data) return
      try {
        await atomicWriteJson(this.fileAbs(), this.data)
        this.healthy = true
      } catch (err) {
        this.healthy = false
        logError('activity', err instanceof Error ? err : new Error(String(err)))
      }
    })
    return this.writeChain
  }
}
