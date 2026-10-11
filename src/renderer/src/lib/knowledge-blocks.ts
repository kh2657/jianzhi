import { marked } from 'marked'

export interface KnowledgePanel { title: string; bodyMd: string }
export interface KnowledgeBlock {
  id: string
  title: string
  summaryMd: string
  panels: KnowledgePanel[]
  fingerprint: string
}
export interface KnowledgeNote { introductionMd: string; blocks: KnowledgeBlock[] }

// Display structure comes from Markdown headings, never from inferred mathematical implications.
// Explicit comments retain a block's identity when its title changes; content hashes invalidate mastery.
export function contentFingerprint(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36)
}

export function parseKnowledgeNote(markdown: string): KnowledgeNote {
  const tokens = marked.lexer(markdown)
  const intro: string[] = []
  const sections: Array<{ title: string; raw: string[] }> = []
  for (const token of tokens) {
    if (token.type === 'heading' && token.depth === 2) sections.push({ title: token.text, raw: [] })
    else if (sections.length) sections[sections.length - 1].raw.push(token.raw)
    else if (!(token.type === 'heading' && token.depth === 1)) intro.push(token.raw)
  }
  // A note without sections remains readable; opening Learn never requires a conversion.
  if (!sections.length && markdown.trim()) {
    sections.push({ title: '这份笔记', raw: intro.splice(0) })
  }
  const used = new Map<string, number>()
  const blocks = sections.map(section => {
    const raw = section.raw.join('')
    const explicit = /<!--\s*block:([a-zA-Z0-9_-]+)\s*-->/.exec(raw)?.[1]
    const base = explicit && explicit.length <= 100 ? explicit : `section-${contentFingerprint(explicit ?? section.title)}`
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    const id = count ? `${base}-${count + 1}` : base
    const clean = raw.replace(/<!--\s*block:[a-zA-Z0-9_-]+\s*-->/g, '')
    let summaryMd = ''
    const panels: KnowledgePanel[] = []
    let panel: KnowledgePanel | undefined
    for (const token of marked.lexer(clean)) {
      if (token.type === 'heading' && token.depth === 3) {
        panel = { title: token.text, bodyMd: '' }
        panels.push(panel)
      } else if (panel) panel.bodyMd += token.raw
      else if (!summaryMd && token.type === 'paragraph') summaryMd = token.raw
      else if (token.type !== 'space') {
        panel = { title: '展开解释', bodyMd: token.raw }
        panels.push(panel)
      }
    }
    return { id, title: section.title, summaryMd, panels: panels.filter(p => p.bodyMd.trim()), fingerprint: contentFingerprint(section.title + clean) }
  })
  return { introductionMd: intro.join(''), blocks }
}

export type LearningStatus = 'understood' | 'question'
export interface LearningRecord { status: LearningStatus; fingerprint: string }
export interface LearningState { activeId?: string; records: Record<string, LearningRecord> }
export function parseLearningState(value: string | null): LearningState {
  try {
    const raw = JSON.parse(value ?? '{}') as Record<string, unknown>
    const records: Record<string, LearningRecord> = Object.create(null) as Record<string, LearningRecord>
    if (raw.records && typeof raw.records === 'object' && !Array.isArray(raw.records)) {
      for (const [id, record] of Object.entries(raw.records)) {
        if (!record || typeof record !== 'object') continue
        const r = record as Record<string, unknown>
        if ((r.status === 'understood' || r.status === 'question') && typeof r.fingerprint === 'string') {
          records[id] = { status: r.status, fingerprint: r.fingerprint }
        }
      }
    }
    return { activeId: typeof raw.activeId === 'string' ? raw.activeId : undefined, records }
  } catch { return { records: {} } }
}

export function blockStatus(block: KnowledgeBlock, state: LearningState): LearningStatus | 'new' {
  const record = state.records[block.id]
  return record?.fingerprint === block.fingerprint ? record.status : 'new'
}
