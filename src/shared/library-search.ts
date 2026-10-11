import type { LibraryFacetKind } from './types'
import { parseSearchTerms } from './search-terms'

/**
 * 文献库检索语法（学术检索式）：
 *   作者:张三 期刊:annals 标签:弱辨识 分区:随机分析 doi:10.1000 arxiv:2401.12345 年份:2020-2025
 * 规则（WP-3 声明化）：
 *   - 字段名**大小写不敏感**（arXiv: / Author: / YEAR: 都能识别，与文档别名一致）；
 *   - 字段值支持双引号精确短语：作者:"Zhang San"、标签:"弱 辨识"；
 *   - 自由词空白分隔为 AND（顺序无关、不必相邻），"..." 为精确短语；自由词与字段之间是 AND。
 *
 * 检索范围决策（2026-10-09，architecture §15）：自由词只匹配标题与标签；
 * 旧「全文:」/「fulltext:」条件**识别但废止**——解析时单独收集（fulltextDeprecated），
 * 由调用方给出明确提示，不得静默当自由词或忽略。
 */

export type LibraryField = '作者' | '期刊' | '标签' | '分区' | 'doi' | 'arxiv' | '年份'

export const LIBRARY_FIELD_ALIASES: Record<string, LibraryField> = {
  作者: '作者', author: '作者', authors: '作者',
  期刊: '期刊', venue: '期刊', journal: '期刊',
  标签: '标签', tag: '标签', tags: '标签',
  分区: '分区', section: '分区',
  doi: 'doi', DOI: 'doi',
  arxiv: 'arxiv', arxivId: 'arxiv',
  年份: '年份', year: '年份'
}

/** 已废止的全文字段别名：仍要**识别**（给出明确提示），不再参与匹配 */
const FULLTEXT_DEPRECATED_ALIASES = new Set(['全文', 'fulltext'])

/** 字段名查表（大小写不敏感）：`arXiv:` 与 `arxiv:` 等价——修复前大写写法会静默退化为自由词、0 命中 */
const ALIAS_LOOKUP: Record<string, LibraryField> = Object.fromEntries(
  Object.entries(LIBRARY_FIELD_ALIASES).map(([key, value]) => [key.toLowerCase(), value])
)

export interface ParsedLibraryQuery {
  /** 字段:值（值已小写化；同字段多值 OR） */
  fields: Partial<Record<LibraryField, string[]>>
  /** 年份区间（闭区间）；单个年份 = [y, y] */
  years: Array<[number, number]>
  /** 自由词（AND，全部命中才算；引号短语按原文匹配） */
  terms: string[]
  /** 废止的「全文:」条件值（非空时调用方必须明确提示，不得参与匹配） */
  fulltextDeprecated: string[]
}

export function parseLibraryQuery(raw: string): ParsedLibraryQuery {
  const parsed: ParsedLibraryQuery = { fields: {}, years: [], terms: [], fulltextDeprecated: [] }
  const fallbackTerms: string[] = []
  // 字段 token：字段名后接半角或全角冒号，值可以是 "精确短语"（可含空格）或空白前的连续段
  const tokenRe = /([A-Za-z\u4e00-\u9fff]+)[:：]\s*("[^"]*"|[^\s]*)/g
  const consumed: Array<[number, number]> = []
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(raw))) {
    const alias = m[1].toLowerCase()
    const rawValue = m[2]
    if (!rawValue) continue
    const value = rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2
      ? rawValue.slice(1, -1).trim()
      : rawValue.replace(/^"+|"+$/g, '')
    if (!value) continue
    const field = ALIAS_LOOKUP[alias]
    if (FULLTEXT_DEPRECATED_ALIASES.has(alias)) {
      // 废止字段：消费掉 token（不落入自由词），记录值供调用方提示
      consumed.push([m.index, m.index + m[0].length])
      parsed.fulltextDeprecated.push(value)
      continue
    }
    if (!field) continue
    consumed.push([m.index, m.index + m[0].length])
    if (field === '年份') {
      const range = parseYearRange(value)
      if (range) parsed.years.push(range)
      else fallbackTerms.push(value)
      continue
    }
    const values = parsed.fields[field] ?? []
    values.push(value.toLowerCase())
    parsed.fields[field] = values
  }
  // 未被字段 token 覆盖的片段 = 自由词（多词 AND；引号短语保留词内空格）
  let rest = ''
  let cursor = 0
  for (const [start, end] of consumed) {
    rest += ` ${raw.slice(cursor, start)} `
    cursor = end
  }
  rest += ` ${raw.slice(cursor)} `
  parsed.terms = [
    ...parseSearchTerms(rest).map((t) => t.text),
    ...fallbackTerms
  ]
  return parsed
}

export function parseYearRange(value: string): [number, number] | null {
  const single = /^\d{4}$/.exec(value)
  if (single) return [Number(value), Number(value)]
  const range = /^(\d{4})\s*[-~至]\s*(\d{4})$/.exec(value)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    return a <= b ? [a, b] : [b, a]
  }
  return null
}

/** 分面维度：与 LibraryFacetKind 对齐（年份单独处理为区间/直方） */
export const FACET_FIELDS: LibraryFacetKind[] = ['year', 'author', 'venue', 'tag', 'section']
