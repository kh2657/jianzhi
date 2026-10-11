// 一次性迁移：v1 SQLite 资料库 → v2 纯文件夹（docs/存储格式.md）。
// 用法：npm run migrate -- <库目录>（默认当前目录）
// 旧产物（library.db / assets/ / derived/）移入 <库目录>/_v1备份-<时间>/，可随时整体删除或另存。
import { resolve } from 'node:path'
import { migrateSqliteLibrary } from '../src/main/storage/migrate-from-sqlite'

const arg = process.argv[2]
if (!arg) {
  console.error('用法：npm run migrate -- <库目录>（包含 library.db 的目录）')
  process.exit(2)
}
const dir = resolve(arg)
console.log(`[migrate] 迁移旧版资料库：${dir}`)
try {
  const r = await migrateSqliteLibrary(dir)
  console.log(`[migrate] 完成：条目 ${r.entries}，笔记 ${r.notes}，照片 ${r.captures}，锚点 ${r.anchors}，学习区 ${r.spaces}，订阅 ${r.feeds}，候选 ${r.items}`)
  for (const w of r.warnings) console.warn(`[migrate] ⚠ ${w}`)
  if (r.warnings.length === 0) console.log('[migrate] 无警告。全部条目落入「待整理」分区，请在应用内拖入目标分区。')
} catch (err) {
  console.error('[migrate] 失败：', err instanceof Error ? err.message : err)
  process.exit(1)
}
