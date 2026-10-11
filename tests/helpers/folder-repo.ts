import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FolderStore } from '../../src/main/storage/folder-store'
import { Repo } from '../../src/main/storage/repo'
import { ImageVariants } from '../../src/main/assets/images'

/**
 * 存储层测试共享骨架：临时目录 + FolderStore + FolderRepo。
 * 「重启」语义 = reopen()：全新 FolderStore 扫描磁盘 + 全新 Repo，不共享任何内存状态。
 */
export interface TestRepo {
  root: string
  library: FolderStore
  repo: Repo
  reopen(): Promise<Repo>
  dispose(): void
}

/** 清理阈值：超过这个条目数的临时库交给后台进程删（见 dispose 注释） */
const BIG_LIBRARY_ENTRIES = 50

/** 粗略数一下文献库条目数（只数分区下的目录，不做递归） */
function roughEntryCount(root: string): number {
  try {
    let n = 0
    for (const section of readdirSync(join(root, '文献库'), { withFileTypes: true })) {
      if (section.isDirectory()) n += readdirSync(join(root, '文献库', section.name)).length
    }
    return n
  } catch {
    return 0
  }
}

export async function makeTestRepo(prefix = 'mathwb-'): Promise<TestRepo> {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const variantsDir = join(root, '.cache', 'variants')
  mkdirSync(variantsDir, { recursive: true })
  const library = new FolderStore(root)
  await library.scan()
  const repo = new Repo(library, new ImageVariants(variantsDir))
  return {
    root,
    library,
    repo,
    async reopen(): Promise<Repo> {
      const lib = new FolderStore(root)
      await lib.scan()
      return new Repo(lib, new ImageVariants(variantsDir))
    },
    dispose(): void {
      library.stopWatch()
      // 临时库清理不能拖住用例收尾：Windows 上每删一个条目目录要 100ms 量级，
      // 200+ 条目的库同步删要 30 秒以上（曾超过 hookTimeout 让整个文件报「Hook timed out」），
      // 异步删（await/void promise）又会让 Node 进程一直等到删完才退出，wall time 照样涨。
      // 因此：小库同步删干净（毫秒级）；大库交给 detached 子进程后台删（unref 后不阻塞退出），
      // 极端情况下残留的目录在系统临时区，由系统回收。
      if (roughEntryCount(root) > BIG_LIBRARY_ENTRIES) {
        const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'rmdir', '/s', '/q', root]] : ['rm', ['-rf', root]]
        try {
          spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
        } catch {
          /* 起不来就算了 */
        }
        return
      }
      try {
        rmSync(root, { force: true, recursive: true, maxRetries: 1 })
      } catch {
        /* 句柄尚未释放时放弃；目录由系统回收 */
      }
    }
  }
}
