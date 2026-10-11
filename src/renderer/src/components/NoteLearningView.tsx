import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteLearningState, NoteLinkIndexEntry } from '@shared/types'
import { renderMarkdown } from '../md'
import { blockStatus, contentFingerprint, parseKnowledgeNote, parseLearningState, type LearningState, type LearningStatus } from '../lib/knowledge-blocks'
import { useToast } from './Toast'

function LearningText({ markdown, links, onOpen }: { markdown: string; links: NoteLinkIndexEntry[]; onOpen: (id: string) => void }): React.ReactElement {
  const toast = useToast()
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMarkdown(markdown), [markdown])
  useEffect(() => {
    const names = new Map<string, string>()
    for (const link of links) for (const name of [link.title, ...link.aliases]) names.set(name.trim().toLowerCase(), link.id)
    ref.current?.querySelectorAll<HTMLAnchorElement>('a.wikilink').forEach(a => {
      const id = names.get((a.dataset.wikilink ?? '').trim().toLowerCase())
      a.classList.toggle('wikilink-resolved', Boolean(id))
      a.classList.toggle('wikilink-unresolved', !id)
      a.tabIndex = 0
      a.setAttribute('role', 'link')
      if (id) a.dataset.noteId = id
      else delete a.dataset.noteId
    })
  }, [html, links])
  const open = (target: EventTarget | null): boolean => {
    const a = target instanceof Element ? target.closest<HTMLAnchorElement>('a.wikilink') : null
    if (!a) return false
    if (a.dataset.noteId) onOpen(a.dataset.noteId)
    else toast.push(`没有匹配「${a.dataset.wikilink ?? ''}」的笔记`, 'info')
    return true
  }
  return <div ref={ref} className="md-body learning-text" dangerouslySetInnerHTML={{ __html: html }}
    onClick={e => { if (open(e.target)) e.preventDefault() }}
    onKeyDown={e => { if (e.key === 'Enter' && open(e.target)) e.preventDefault() }} />
}

/**
 * 知识块学习视图（WP-8 起为**受控组件**）。
 *
 * 存储位置：自评状态存在**笔记 front-matter 的 `learning` 字段**（此前存机器本地 settings.json，
 * 双机工作流下换机即丢失）。保存走父组件（NoteEditor）的同一条保存管线——冲突保护、关窗冲刷、
 * baseHash 全部自动生效；且自评**不算内容编辑**（不动修订号与「最近更新」）。
 *
 * 旧数据迁移：笔记里没有 `learning` 且存在旧的本地偏好键时，首次打开自动搬进笔记文件一次。
 */
export function NoteLearningView({ noteId, title, body, links, onOpen, learning, onChange, saveStatus, onRetry }: {
  noteId: string
  title: string
  body: string
  links: NoteLinkIndexEntry[]
  onOpen: (id: string) => void
  learning: NoteLearningState | null
  onChange: (next: NoteLearningState) => void
  saveStatus: string
  onRetry: () => void
}): React.ReactElement {
  const note = useMemo(() => parseKnowledgeNote(body), [body])
  const state: LearningState = learning ?? { records: {} }

  // 旧偏好迁移（一次性）：把 `mathwb-learning:*` 搬进笔记文件
  const migratedRef = useRef(false)
  useEffect(() => {
    if (migratedRef.current) return
    migratedRef.current = true
    if (learning && (learning.activeId || Object.keys(learning.records).length)) return
    let cancelled = false
    const key = `mathwb-learning:${noteId}`
    void Promise.all([window.api.prefGet(key), ...note.blocks.map(b => window.api.prefGet(`${key}:${contentFingerprint(b.id)}`))])
      .then(values => {
        if (cancelled) return
        const records: LearningState['records'] = {}
        note.blocks.forEach((block, i) => {
          const parsed = parseLearningState(`{"records":{${JSON.stringify(block.id)}:${values[i + 1] || 'null'}}}`)
          if (parsed.records[block.id]) records[block.id] = parsed.records[block.id]
        })
        const activeId = values[0] || undefined
        if (!activeId && Object.keys(records).length === 0) return
        onChange({ ...(activeId ? { activeId } : {}), records })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [noteId, learning, note.blocks, onChange])

  const active = note.blocks.find(b => b.id === state.activeId) ?? note.blocks[0]
  const index = active ? note.blocks.indexOf(active) : -1
  const blockRef = useRef<HTMLElement>(null)
  useEffect(() => { blockRef.current?.scrollIntoView({ block: 'nearest' }) }, [active?.id])
  const understood = note.blocks.filter(b => blockStatus(b, state) === 'understood').length
  const choose = (id: string): void => { onChange({ ...state, activeId: id }) }
  const mark = (status: LearningStatus): void => {
    if (!active) return
    const records = { ...state.records }
    if (blockStatus(active, state) === status) delete records[active.id]
    else records[active.id] = { status, fingerprint: active.fingerprint }
    onChange({ activeId: active.id, records })
  }
  const text = (markdown: string): React.ReactElement => <LearningText markdown={markdown} links={links} onOpen={onOpen} />
  if (!active) return <div className="learning-empty"><p>写下第一个想弄清楚的问题。</p><span className="muted">在编辑视图中，用二级标题组织知识块，三级标题组织例子、推导与自测。</span></div>
  return <div className="note-learning">
    <nav className="learning-map" aria-label="知识地图">
      <div className="learning-map-root">{title}</div>
      <p className="learning-map-caption">选择一个问题，逐块学习</p>
      <ol className="learning-branches">
        {note.blocks.map((block, i) => <li key={block.id}>
          <button className={`learning-node ${block.id === active.id ? 'learning-node-active' : ''}`} aria-current={block.id === active.id ? 'step' : undefined}
            onClick={() => choose(block.id)}>
            <span className="learning-node-number">{i + 1}</span><span className="learning-node-title">{block.title}</span>
            <span className={`learning-node-status learning-node-status-${blockStatus(block, state)}`}>{blockStatus(block, state) === 'understood' ? '已理解' : blockStatus(block, state) === 'question' ? '有疑问' : '待学习'}</span>
          </button>
        </li>)}
      </ol>
      <p className="muted small">已理解 {understood} / {note.blocks.length} · 自己标记，不代表内容已核验</p>
      {note.introductionMd.trim() && <details className="learning-overview"><summary>这份笔记的范围与来源</summary>{text(note.introductionMd)}</details>}
    </nav>
    <section ref={blockRef} className="learning-block" aria-label="当前知识块">
      <h2>{active.title}</h2>
      {text(active.summaryMd)}
      <div className="learning-panels" key={active.id}>
        {active.panels.map((panel, i) => {
          // 自测/检查理解是「先想再看」的交互，必须与陈述性内容一眼可辨——加修饰类走独立样式
          const isQuiz = /自测|检查理解/.test(panel.title)
          return (
            <details className={`learning-panel ${isQuiz ? 'learning-panel-quiz' : ''}`} key={`${active.id}-${i}`} open={isQuiz || undefined}>
              <summary>{panel.title}</summary>{text(panel.bodyMd)}
            </details>
          )
        })}
      </div>
      <div className="learning-check" role="group" aria-label="标记理解情况">
        <button className="btn" aria-pressed={blockStatus(active, state) === 'understood'} onClick={() => mark('understood')}>我已理解</button>
        <button className="btn" aria-pressed={blockStatus(active, state) === 'question'} onClick={() => mark('question')}>仍有疑问</button>
        <span role="status" className="small muted learning-check-status">
          {saveStatus === 'saving'
            ? '保存学习记录…'
            : saveStatus === 'error'
              ? '学习记录保存失败'
              : saveStatus === 'conflict'
                ? '保存冲突待处理'
                : '学习记录已保存'}
        </span>
        {saveStatus === 'error' && <button className="btn btn-sm" onClick={onRetry}>重试</button>}
      </div>
      <div className="learning-pagination">
        <button className="btn" disabled={index === 0} onClick={() => choose(note.blocks[index - 1].id)}>上一块</button>
        <span className="learning-block-position">第 {index + 1} 块 / 共 {note.blocks.length} 块</span>
        <button className="btn" disabled={index === note.blocks.length - 1} onClick={() => choose(note.blocks[index + 1].id)}>下一块</button>
      </div>
    </section>
  </div>
}