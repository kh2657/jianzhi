import type { EntryMeta } from './types'

/**
 * 文献条目 → BibTeX（纯函数）。
 * citekey：第一作者姓（去空格连字）+ 年份 + 标题首词；缺作者用条目 id 前缀兜底。
 * docType 映射：paper→@article，book→@book，other→@misc。
 */

export function entryToBibtex(meta: EntryMeta): string {
  const type = meta.docType === 'paper' ? 'article' : meta.docType === 'book' ? 'book' : 'misc'
  const key = citeKey(meta)
  const lines: string[] = [`@${type}{${key},`]
  lines.push(`  title = {${brace(meta.title)}}`)
  if (meta.authors.length) lines.push(`  author = {${brace(meta.authors.join(' and '))}}`)
  if (meta.year !== null) lines.push(`  year = {${meta.year}}`)
  else lines.push('  year = {nd}')
  if (meta.venue) {
    lines.push(meta.docType === 'book' ? `  publisher = {${brace(meta.venue)}}` : `  journal = {${brace(meta.venue)}}`)
  }
  if (meta.doi) lines.push(`  doi = {${meta.doi}}`)
  if (meta.arxivId) lines.push(`  eprint = {${meta.arxivId}}`)
  if (meta.tags.length) lines.push(`  keywords = {${brace(meta.tags.join(', '))}}`)
  if (meta.abstract) lines.push(`  abstract = {${brace(meta.abstract)}}`)
  lines.push('}')
  return lines.join('\n')
}

export function citeKey(meta: EntryMeta): string {
  // 中文/拼音姓名姓氏在首，西文姓名姓氏在末：优先取首词（面向中文用户的常见写法）
  const first = meta.authors[0] ?? ''
  const surname = first.trim().split(/\s+/)[0] ?? ''
  const clean = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '')
  const year = meta.year ?? 'nd'
  const titleWord = clean(meta.title).slice(0, 12) || 'untitled'
  if (!meta.authors.length) return `unknown${year}${titleWord}-${meta.id.slice(0, 8)}`.toLowerCase()
  return `${clean(surname)}${year}${titleWord}`.toLowerCase()
}

/** BibTeX 值中大写保护：除首字母外的大写字母加花括号（保留人名/缩写大小写） */
function brace(value: string): string {
  return value.replace(/([A-Z])/g, (m, ch, offset) => (offset === 0 ? m : `{${ch}}`))
}
