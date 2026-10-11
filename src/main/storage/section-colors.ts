// 分区颜色标签（库根/分区.json）。与 ActivityStore 同构：原子写 + 串行写链 + 失败不抛。
//
// 为什么是库根的一个映射文件，而不是分区目录内的隐藏文件：
//   1) 分区目录里除「条目文件夹」外的任何东西都可能被外部扫描/同步工具动到，
//      藏在库根的单一小文件里不参与条目扫描（FolderStore 对未知文件宽容）；
//   2) 一次读取即可回填整个左栏，不必为 N 个分区各读一个文件；
//   3) 键 = 分区目录名。重命名分区时随目录一起迁移（见 Repo.sectionRename），
//      删除分区时清理（见 Repo.sectionDelete）；外部改名会让键变成孤儿键——
//      孤儿键不显示、不报错，同名分区再次出现时颜色自动复用（可接受且有界）。
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isSectionColor, type SectionColor } from '@shared/types'
import { atomicWriteJson, atomicWriteJsonSync } from './fsutil'
import { error as logError } from '../logger'

interface SectionColorFile {
  schema: 1
  /** 分区名 → 颜色 id；只存已设色的分区 */
  colors: Record<string, SectionColor>
}

const FILE_NAME = '分区.json'

export class SectionColorStore {
  private data: SectionColorFile | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly root: string) {}

  private fileAbs(): string {
    return join(this.root, FILE_NAME)
  }

  /** 无文件 / 结构不符时重建为空表；坏文件备份为 分区.json.broken，不抛出 */
  ensure(): void {
    if (this.data) return
    const abs = this.fileAbs()
    if (existsSync(abs)) {
      try {
        const raw = JSON.parse(readFileSync(abs, 'utf8')) as SectionColorFile
        if (raw && raw.schema === 1 && raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors)) {
          const colors: Record<string, SectionColor> = {}
          for (const [name, color] of Object.entries(raw.colors)) {
            // 非法颜色 id（手改文件 / 未来版本降级）按未设色处理，其余键保留
            if (isSectionColor(color)) colors[name] = color
          }
          this.data = { schema: 1, colors }
          return
        }
        throw new Error('结构不符')
      } catch (err) {
        logError('section-color', err instanceof Error ? err : new Error(String(err)))
        try { renameSync(abs, `${abs}.broken`) } catch { /* 覆盖失败也无妨，下次写入覆盖 */ }
      }
    }
    this.data = { schema: 1, colors: {} }
    try {
      atomicWriteJsonSync(abs, this.data)
    } catch (err) {
      logError('section-color', err instanceof Error ? err : new Error(String(err)))
    }
  }

  all(): Record<string, SectionColor> {
    this.ensure()
    return { ...this.data!.colors }
  }

  /** 设色（color=null 即清除）；内存立即生效，落盘失败只记日志 */
  set(section: string, color: SectionColor | null): void {
    this.ensure()
    if (color) this.data!.colors[section] = color
    else delete this.data!.colors[section]
    void this.persist()
  }

  /** 分区改名：颜色跟着目录走 */
  rename(oldName: string, newName: string): void {
    this.ensure()
    const color = this.data!.colors[oldName]
    if (!color) return
    delete this.data!.colors[oldName]
    this.data!.colors[newName] = color
    void this.persist()
  }

  /** 分区删除：清掉键（避免遗留孤儿键在重建同名分区时意外复活） */
  drop(section: string): void {
    this.ensure()
    if (!(section in this.data!.colors)) return
    delete this.data!.colors[section]
    void this.persist()
  }

  /** 等待所有排队的落盘完成（测试与关窗前冲刷用） */
  flush(): Promise<void> {
    return this.writeChain
  }

  private persist(): Promise<void> {
    // 串行化：并发设色不会互相覆盖（与 ActivityStore 同策略）
    this.writeChain = this.writeChain.then(async () => {
      if (!this.data) return
      try {
        await atomicWriteJson(this.fileAbs(), this.data)
      } catch (err) {
        logError('section-color', err instanceof Error ? err : new Error(String(err)))
      }
    })
    return this.writeChain
  }
}
