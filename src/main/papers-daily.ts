// 每日论文清单：扫描用户配置的文件夹，读取邮件脚本输出的版本化 JSON 并入库。
// 边界（行动计划 §4.1）：只读本地文件，无网络、无邮箱授权；坏文件隔离到 failed/ 并保留原因；
// 以文件摘要 + 基础 ID 幂等；JSON 只含公开论文元数据。
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Repo } from './storage/repo'
import type { ArxivEntry } from './papers'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ITEMS = 200
const MAX_TEXT = 8000
const MAX_AUTHORS = 50
const ARXIV_ID = /^[0-9]{4}\.[0-9]{4,5}(v\d+)?$/
const ARXIV_HOST = /^(www\.)?arxiv\.org$/

export interface DailyFileResult {
  file: string
  imported: number
  skipped: number
  error?: string
}

/** 清单条目净化：坏条目跳过（不 fail 整个文件），返回可入库的 entries */
export function parseDailyManifest(raw: string): { entries: ArxivEntry[]; matchedFeeds: string[][]; total: number } {
  const doc = JSON.parse(raw) as Record<string, unknown>
  if (doc.schemaVersion !== 1) throw new Error(`不支持的 schemaVersion：${String(doc.schemaVersion)}`)
  const items = doc.items
  if (!Array.isArray(items)) throw new Error('items 不是数组')
  if (items.length > MAX_ITEMS) throw new Error(`清单条目超过上限 ${MAX_ITEMS}`)
  const entries: ArxivEntry[] = []
  const matchedFeeds: string[][] = []
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (typeof item !== 'object' || item === null) continue
    const it = item as Record<string, unknown>
    if (it.provider !== 'arxiv') continue
    const base = typeof it.providerId === 'string' ? it.providerId.trim() : ''
    const version = typeof it.version === 'string' && /^v\d+$/.test(it.version) ? it.version : 'v1'
    const arxivId = `${base}${version}`
    if (!ARXIV_ID.test(arxivId)) continue
    const title = typeof it.title === 'string' ? it.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : ''
    if (!title) continue
    const url = typeof it.url === 'string' ? it.url : ''
    if (url) {
      try {
        const u = new URL(url)
        if (u.protocol !== 'https:' || !ARXIV_HOST.test(u.hostname)) continue
      } catch {
        continue
      }
    }
    const authors = Array.isArray(it.authors)
      ? it.authors.filter((a): a is string => typeof a === 'string').slice(0, MAX_AUTHORS)
      : []
    const feeds = Array.isArray(it.matchedFeeds)
      ? it.matchedFeeds.filter((f): f is string => typeof f === 'string').slice(0, 10)
      : []
    entries.push({
      arxivId,
      title,
      authors,
      abstract: typeof it.abstract === 'string' ? it.abstract.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '',
      primaryCategory: null,
      categories: [],
      publishedAt: typeof it.publishedAt === 'string' && !Number.isNaN(Date.parse(it.publishedAt))
        ? new Date(it.publishedAt).toISOString()
        : new Date().toISOString(),
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      absUrl: `https://arxiv.org/abs/${arxivId}`
    })
    matchedFeeds.push(feeds)
  }
  return { entries, matchedFeeds, total: entries.length }
}

/** 扫描导入文件夹：*.json 逐个导入；成功改名 .done，失败移入 failed/（保留原始文件供排查）。 */
export async function importDailyFolder(repo: Repo, folder: string): Promise<DailyFileResult[]> {
  let names: string[] = []
  try {
    names = readdirSync(folder)
  } catch {
    return [] // 文件夹不存在 = 尚无清单，不算错误
  }
  const results: DailyFileResult[] = []
  const feeds = repo.paperFeedList()
  const feedByName = new Map(feeds.map((f) => [f.name.trim(), f.id]))
  const failedDir = join(folder, 'failed')
  const doneDir = join(folder, 'imported')
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    const path = join(folder, name)
    const result: DailyFileResult = { file: name, imported: 0, skipped: 0 }
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      if (st.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限`)
      const raw = readFileSync(path, 'utf8')
      const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16)
      // 文件级幂等：同名同摘要跳过
      const seen = repo.paperDailyFileSeen(name, digest)
      const { entries, matchedFeeds, total } = parseDailyManifest(raw)
      let imported = 0
      for (let i = 0; i < entries.length; i++) {
        // 清单的 matchedFeeds（订阅名）映射到现有订阅；upsert 本身按基础 ID 幂等
        const feedIds = (matchedFeeds[i] ?? []).map((f) => feedByName.get(f.trim())).filter((x): x is string => Boolean(x))
        const primary = feedIds[0] ?? feeds[0]?.id
        if (!primary) continue // 库里还没有任何订阅，无法落库（计入 skipped）
        imported += await repo.paperItemsUpsert(primary, [entries[i]])
      }
      result.imported = imported
      result.skipped = total - imported
      await repo.paperMarkDailyFile(name, digest)
      if (seen) {
        // 同文件重复投递：内容已全部入库过，报告为 skipped
        result.skipped += result.imported
        result.imported = 0
      }
      mkdirSync(doneDir, { recursive: true })
      renameSync(path, join(doneDir, `${digest}-${name}`))
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      try {
        mkdirSync(failedDir, { recursive: true })
        renameSync(path, join(failedDir, name))
      } catch {
        /* 移动失败保留原位 */
      }
    }
    results.push(result)
  }
  return results
}
