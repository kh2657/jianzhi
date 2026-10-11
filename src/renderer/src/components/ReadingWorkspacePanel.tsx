import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocType, ReaderSplitState, ReadingWorkspace } from '@shared/types'
import { useAsyncData } from '../lib/use-async-data'
import { useRemarkSaver } from '../lib/use-remark-saver'
import { MaterialNotesPanel, type MaterialNotesPanelProps } from './MaterialNotesPanel'

export interface ReadingWorkspacePanelProps extends MaterialNotesPanelProps {
  docType?: DocType
  spaceId?: string | null
  registerFlusher(fn: () => Promise<void>): () => void
  /** 对照态默认展开笔记预览（透传给 MaterialNotesPanel） */
  notePreviewDefaultOn?: boolean
  /** 工作区数据到达/变化时回报当前布局（ReaderView 据此同步分段控件） */
  onReaderSplitInit?(split: ReaderSplitState | undefined): void
  /** 把「写入布局」的唯一通道交给 ReaderView：面板是工作区 JSON 的单一写入者，避免读写竞态 */
  bindSplitWriter?(api: { set(split: ReaderSplitState): void } | null): void
}

const SECTION_LABELS: Record<ReadingWorkspace['sections'][number]['id'], string> = {
  question: '阅读方向', method: '方法与思路', findings: '我的理解',
  evidence: '原文依据', relevance: '关联与想法'
}
const BOOK_LABELS: typeof SECTION_LABELS = {
  question: '本章重点', method: '定义与推导', findings: '我的理解',
  evidence: '证明与例子', relevance: '知识联系'
}

/** 文档切换时隔离保存队列，父级在导航前冲刷注册的任务。 */
export function ReadingWorkspacePanel(props: ReadingWorkspacePanelProps): React.ReactElement {
  return <ReadingWorkspaceContent key={props.documentId} {...props} />
}

function ReadingWorkspaceContent({
  documentId, versionId, pageIndex, htmlMode = false, refreshKey = 0,
  initialSelectedNoteId, docType, spaceId, registerFlusher, onJumpToAnchor, onOpenFullEditor,
  notePreviewDefaultOn = false, onReaderSplitInit, bindSplitWriter
}: ReadingWorkspacePanelProps): React.ReactElement {
  const [localRefresh, setLocalRefresh] = useState(0)
  const [creating, setCreating] = useState(false)
  const [creationError, setCreationError] = useState('')
  const [jumpError, setJumpError] = useState('')
  const [noteSaveErrors, setNoteSaveErrors] = useState(0)
  const [moreSections, setMoreSections] = useState(false)
  const [focusedSectionId, setFocusedSectionId] = useState<string | null>(null)
  const quickInput = useRef<HTMLTextAreaElement>(null)
  const pendingCreate = useRef<Promise<void> | null>(null)
  const workspaceData = useAsyncData(() => window.api.readingWorkspaceGet(documentId), [documentId])
  const materialNotes = useAsyncData(() => window.api.notesForDocument(documentId), [documentId, refreshKey, localRefresh])
  const pageAnchors = useAsyncData(() => htmlMode ? Promise.resolve([]) : window.api.anchorListPage(versionId, pageIndex), [versionId, pageIndex, htmlMode, refreshKey, localRefresh])
  const { saver, states } = useRemarkSaver(async (_id, value) => {
    await window.api.readingWorkspaceSave(JSON.parse(value) as ReadingWorkspace)
  })
  useEffect(() => {
    if (workspaceData.data?.documentId === documentId) saver.syncServer(documentId, JSON.stringify(workspaceData.data))
  }, [workspaceData.data, documentId, saver])
  useEffect(() => registerFlusher(async () => {
    await pendingCreate.current
    await saver.flushAll()
  }), [registerFlusher, saver])
  const state = states.get(documentId)
  const workspace: ReadingWorkspace | null = state ? JSON.parse(state.value) : null
  const update = useCallback((patch: Partial<ReadingWorkspace>) => {
    const previous = saver.get(documentId)
    if (!previous) return
    saver.edit(documentId, JSON.stringify({ ...JSON.parse(previous.value), ...patch }))
  }, [documentId, saver])

  // 专注/对照布局：数据到达时上报初值；写入通道交给 ReaderView（面板仍是工作区 JSON 的单一写入者）
  useEffect(() => {
    if (workspaceData.data?.documentId === documentId) onReaderSplitInit?.(workspaceData.data.readerSplit)
  }, [workspaceData.data, documentId, onReaderSplitInit])
  const splitWriter = useMemo(() => ({ set: (s: ReaderSplitState) => update({ readerSplit: s }) }), [update])
  useEffect(() => {
    bindSplitWriter?.(splitWriter)
    return () => bindSplitWriter?.(null)
  }, [bindSplitWriter, splitWriter])
  const selectNote = useCallback((expandedNoteId: string | null) => update({ expandedNoteId }), [update])
  const selectScope = useCallback((scope: 'page' | 'doc') => update({ notesScope: scope === 'page' ? 'page' : 'all' }), [update])
  // 入口传入的目标笔记只在「首次拿到阅读记录」时应用一次：此前依赖 workspaceData.data，
  // 记录因重试/外部改动重载时会把用户手动切换到的另一篇笔记强行拽回来。
  const appliedInitialRef = useRef<string | null>(null)
  useEffect(() => {
    if (!initialSelectedNoteId || !workspaceData.data) return
    const key = `${documentId}::${initialSelectedNoteId}`
    if (appliedInitialRef.current === key) return
    appliedInitialRef.current = key
    update({ expandedNoteId: initialSelectedNoteId, activeTab: 'notes' })
  }, [initialSelectedNoteId, workspaceData.data, documentId, update])

  const evidenceOptions = useMemo(() => {
    const options = new Map<string, { anchorId: string; pageIndex: number; rects: Array<[number, number, number, number]>; label: string }>()
    for (const note of materialNotes.data ?? []) {
      for (const anchor of note.anchors) options.set(anchor.anchorId, { ...anchor, label: note.title })
    }
    for (const anchor of pageAnchors.data ?? []) {
      if (!options.has(anchor.id)) options.set(anchor.id, { anchorId: anchor.id, pageIndex: anchor.pageIndex, rects: anchor.rects, label: anchor.quote || '本页标记' })
    }
    return options
  }, [materialNotes.data, pageAnchors.data])

  const jump = async (anchorId: string) => {
    setJumpError('')
    try {
      const known = evidenceOptions.get(anchorId)
      const anchor = known ?? await window.api.anchorGet(anchorId)
      onJumpToAnchor?.(anchorId, anchor.pageIndex, anchor.rects)
    } catch (error) { setJumpError(error instanceof Error ? error.message : String(error)) }
  }
  const createQuickNote = (noteType: 'problem' | 'note') => {
    const current = saver.get(documentId)
    if (!current || pendingCreate.current) return
    const draft = (JSON.parse(current.value) as ReadingWorkspace).quickDraft
    if (!draft.trim()) return
    const initialFocus = document.activeElement
    const quickActions = quickInput.current?.parentElement?.querySelector('.rw-quick-actions')
    const startedFromQuick = initialFocus === quickInput.current || !!quickActions?.contains(initialFocus)
    setCreating(true)
    setCreationError('')
    const operation = (async () => {
      try {
        const input = { title: draft.trim().replace(/\s+/g, ' ').slice(0, 60), noteType, bodyMd: draft, spaceId }
        const note = htmlMode
          ? await window.api.noteCreate({ ...input, documentId })
          : (await window.api.anchorCreateWithNote({ anchor: { documentVersionId: versionId, pageIndex, rects: [] }, note: input })).note
        const latest: ReadingWorkspace = JSON.parse(saver.get(documentId)!.value)
        update({ quickDraft: latest.quickDraft === draft ? '' : latest.quickDraft, expandedNoteId: note.id })
        setLocalRefresh((value) => value + 1)
        // 连续记录时回到输入框；等待过程中已转去编辑其他内容则保留用户焦点。
        const activeElement = document.activeElement
        if (activeElement === quickInput.current || quickActions?.contains(activeElement) ||
            (startedFromQuick && (activeElement === initialFocus || activeElement === document.body))) {
          quickInput.current?.focus()
        }
      } catch (error) {
        setCreationError(error instanceof Error ? error.message : String(error))
      } finally { setCreating(false); pendingCreate.current = null }
    })()
    pendingCreate.current = operation
  }

  if (!workspace) return <div className="reading-workspace">{workspaceData.error ? <div role="alert">阅读记录加载失败：{workspaceData.error}<button className="btn btn-sm" onClick={workspaceData.retry}>重试</button></div> : <p className="muted small">正在恢复阅读记录…</p>}</div>
  const labels = docType === 'book' ? BOOK_LABELS : SECTION_LABELS
  const questions = (materialNotes.data ?? []).filter((note) => note.noteType === 'problem')
  const unresolved = questions.filter((note) => !workspace.resolvedNoteIds.includes(note.id))
  const editSection = (id: ReadingWorkspace['sections'][number]['id'], patch: Partial<ReadingWorkspace['sections'][number]>) => {
    update({ sections: workspace.sections.map((section) => section.id === id ? { ...section, ...patch } : section) })
  }
  const renderQuestion = (note: typeof questions[number], resolved: boolean) => <div className="rw-question" key={note.id}>
    <span>{note.title}</span>
    <div className="rw-actions">
      {note.anchors.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => void jump(note.anchors[0].anchorId)}>第 {note.anchors[0].pageIndex + 1} 页原文</button>}
      <button className="btn btn-ghost btn-sm" onClick={() => update({ expandedNoteId: note.id, notesScope: 'all', activeTab: 'notes' })}>查看笔记</button>
      <button className="btn btn-ghost btn-sm" onClick={() => update({ resolvedNoteIds: resolved ? workspace.resolvedNoteIds.filter((id) => id !== note.id) : [...workspace.resolvedNoteIds, note.id] })}>{resolved ? '重新打开' : '标为已解决'}</button>
    </div>
  </div>

  return <div className="reading-workspace" data-testid="reading-workspace">
    <div className="segmented rw-tabs" role="tablist" aria-label="阅读工作区">
      <button className={`seg-btn ${workspace.activeTab === 'notes' ? 'seg-active' : ''}`} role="tab" aria-selected={workspace.activeTab === 'notes'} onClick={() => update({ activeTab: 'notes' })}>随手记</button>
      <button className={`seg-btn ${workspace.activeTab === 'card' ? 'seg-active' : ''}`} role="tab" aria-selected={workspace.activeTab === 'card'} onClick={() => update({ activeTab: 'card' })}>整理</button>
    </div>
    {noteSaveErrors > 0 && workspace.activeTab !== 'notes' && <div className="status-error small" role="alert">有 {noteSaveErrors} 条笔记未保存，草稿仍保留。<button className="btn btn-sm" onClick={() => update({ activeTab: 'notes' })}>查看保存错误</button></div>}
    {jumpError && <div role="alert" className="status-error">无法回到原文：{jumpError}</div>}
    <div hidden={workspace.activeTab !== 'notes'} role="tabpanel" aria-label="随手记" className="rw-notes">
      {/* 一张输入卡：输入面、提示、动作收在同一个块里，与下方笔记列表分层 */}
      <div className="rw-quick-card">
        <textarea ref={quickInput} className="mnp-textarea rw-quick" aria-label="随手记内容" placeholder="想法、疑问、摘录，先记在这里…" value={workspace.quickDraft} onChange={(e) => update({ quickDraft: e.target.value })} onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            createQuickNote('note')
          }
        }} />
        <div className="muted small">{htmlMode ? '记录关联整份 HTML 材料，暂不定位段落。' : `记在当前第 ${pageIndex + 1} 页，也可以划选原文留下更具体的摘录。`}</div>
        <div className="rw-actions rw-quick-actions"><button className="btn btn-primary btn-sm" disabled={creating || !workspace.quickDraft.trim()} onClick={() => createQuickNote('note')}>{creating ? '记录中…' : '记下来'}</button><span className="muted small">⌘ / Ctrl + Enter</span>
          <details className="rw-quick-options"><summary>更多</summary><button className="btn btn-ghost btn-sm" disabled={creating || !workspace.quickDraft.trim()} onClick={() => createQuickNote('problem')}>记下疑问</button></details>
        </div>
        {creationError && <div role="alert" className="status-error">记录失败，内容已保留：{creationError}</div>}
      </div>
      <MaterialNotesPanel documentId={documentId} versionId={versionId} pageIndex={pageIndex} htmlMode={htmlMode} refreshKey={refreshKey + localRefresh} selectedId={workspace.expandedNoteId} scope={workspace.notesScope === 'page' ? 'page' : 'doc'} defaultPreviewOn={notePreviewDefaultOn} onSelectedIdChange={selectNote} onScopeChange={selectScope} registerFlusher={registerFlusher} onJumpToAnchor={onJumpToAnchor} onOpenFullEditor={onOpenFullEditor} onNoteSaved={() => materialNotes.retry()} onSaveErrorCountChange={setNoteSaveErrors} />
      <details className="rw-details" open={unresolved.length > 0}><summary>未解决的问题 · {unresolved.length}</summary>{unresolved.map((note) => renderQuestion(note, false))}{questions.some((note) => workspace.resolvedNoteIds.includes(note.id)) && <details><summary>已解决的问题</summary>{questions.filter((note) => workspace.resolvedNoteIds.includes(note.id)).map((note) => renderQuestion(note, true))}</details>}</details>
    </div>
    <div hidden={workspace.activeTab !== 'card'} role="tabpanel" aria-label="整理" className="rw-card">
      <p className="muted small">写下值得留下的理解。栏目名称可以直接修改，按需整理。</p>
      {htmlMode && <p className="mnp-hint small">HTML 目前只有材料级关联，尚不能定位段落；卡片保持待核对。</p>}
      {[...workspace.sections].sort((a, b) => a.id === 'findings' ? -1 : b.id === 'findings' ? 1 : 0).map((section) => {
        const title = section.title?.trim() || labels[section.id]
        const visible = focusedSectionId === section.id || section.id === 'findings' || !!section.body.trim() || section.anchorIds.length > 0 || !!section.title?.trim() || moreSections
        return <section key={section.id} hidden={!visible} className="rw-section" data-testid={`card-section-${section.id}`} onFocusCapture={() => setFocusedSectionId(section.id)} onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedSectionId(null)
        }}>
        <input className="rw-section-title input" aria-label={`栏目名称：${labels[section.id]}`} value={section.title ?? labels[section.id]} maxLength={120} onChange={(e) => editSection(section.id, { title: e.target.value })} placeholder={labels[section.id]} />
        <textarea id={`card-${section.id}`} aria-label={title} className="mnp-textarea rw-card-body" value={section.body} onChange={(e) => editSection(section.id, { body: e.target.value, checked: false })} placeholder="写自己的理解，也可稍后再整理…" />
        <div className="rw-check"><span className={section.checked && section.anchorIds.length > 0 && !htmlMode ? 'status-saved' : 'muted'}>{section.checked && section.anchorIds.length > 0 && !htmlMode ? '已核对' : '待核对'}{section.anchorIds.length === 0 && ' · 尚无原文定位'}</span>
          {!htmlMode && section.anchorIds.length > 0 && <label><input type="checkbox" aria-label={`确认核对：${title}`} checked={section.checked} disabled={!section.body.trim()} onChange={(e) => editSection(section.id, { checked: e.target.checked })} />我已对照原文</label>}
        </div>
        {!htmlMode && <details className="rw-evidence"><summary>选择原文依据 · {section.anchorIds.length}</summary>
          {evidenceOptions.size === 0 && <p className="muted small">先在原文留下摘录或疑问，就能在这里引用。</p>}
          {[...evidenceOptions.values()].map((anchor) => <label className="rw-source-option" key={anchor.anchorId}><input type="checkbox" aria-label={`${title}依据：第 ${anchor.pageIndex + 1} 页 ${anchor.label}`} checked={section.anchorIds.includes(anchor.anchorId)} onChange={(e) => editSection(section.id, { anchorIds: e.target.checked ? [...section.anchorIds, anchor.anchorId] : section.anchorIds.filter((id) => id !== anchor.anchorId), checked: false })} /><span>第 {anchor.pageIndex + 1} 页 · {anchor.label}</span></label>)}
        </details>}
        <div className="rw-actions">{section.anchorIds.map((id, index) => <span className="rw-actions" key={id}><button className="btn btn-ghost btn-sm" onClick={() => void jump(id)}>回原文 · {evidenceOptions.has(id) ? `第 ${evidenceOptions.get(id)!.pageIndex + 1} 页` : `依据 ${index + 1}`}</button><button className="btn btn-ghost btn-sm" aria-label={`移除${title}的依据 ${index + 1}`} onClick={() => editSection(section.id, { anchorIds: section.anchorIds.filter((anchorId) => anchorId !== id), checked: false })}>移除</button></span>)}</div>
      </section>})}
      {workspace.sections.some((section) => section.id !== 'findings' && !section.body.trim() && !section.anchorIds.length && !section.title?.trim()) && <button className="btn btn-ghost btn-sm rw-more-toggle" aria-expanded={moreSections} onClick={() => setMoreSections((value) => !value)}>{moreSections ? '收起空白栏目' : '更多整理栏目'}</button>}
      <details className="rw-details"><summary>本篇摘录与问题 · {(materialNotes.data ?? []).length}</summary>
        {materialNotes.error && <div role="alert">笔记加载失败：{materialNotes.error}<button className="btn btn-sm" onClick={materialNotes.retry}>重试</button></div>}
        {(materialNotes.data ?? []).map((note) => <div className="rw-question" key={note.id}><strong>{note.title}</strong><p className="rw-note-preview">{note.bodyMd}</p><div className="rw-actions">{note.anchors.map((anchor) => <button className="btn btn-ghost btn-sm" key={anchor.anchorId} onClick={() => void jump(anchor.anchorId)}>第 {anchor.pageIndex + 1} 页原文</button>)}<button className="btn btn-ghost btn-sm" onClick={() => update({ activeTab: 'notes', expandedNoteId: note.id, notesScope: 'all' })}>编辑笔记</button></div></div>)}
      </details>
      <details className="rw-details"><summary>六部分核查提示</summary><ol className="rw-checklist"><li>问题与困难：未知量、观测与算子是什么？</li><li>核心贡献：相对已有方法真正增加了什么？</li><li>结论与条件：假设、定理号与不能推出的结论。</li><li>方法和证明：关键机制与证明链是否成立？</li><li>证据与局限：区分理论、数值现象与个人推断。</li><li>阅读价值：可直接用、只可借鉴，还是尚需验证？</li></ol><p className="muted small">这些提示用于整理时核查，无需读中逐项填写。</p></details>
    </div>
    <details className="rw-details rw-settings">
      <summary>阅读设置{workspace.coreQuestion.trim() && <span className="rw-settings-summary"> · {workspace.coreQuestion.trim().slice(0, 42)}{workspace.coreQuestion.trim().length > 42 ? '…' : ''}</span>}</summary>
      <label className="rw-core">阅读阶段
        <select className="input rw-phase" aria-label="阅读阶段" value={workspace.phase} onChange={(e) => update({ phase: e.target.value as ReadingWorkspace['phase'] })}>
          <option value="reading">正在读</option><option value="paused">暂放</option><option value="reviewing">整理中</option><option value="complete">已完成</option>
        </select>
      </label>
      <label className="rw-core">我读它想回答什么（可留空）
        <input className="input" aria-label="阅读核心问题" value={workspace.coreQuestion} onChange={(e) => update({ coreQuestion: e.target.value })} placeholder="留一个阅读方向…" />
      </label>
    </details>
    <div className={`small status-${state?.status}`} role="status" data-testid="workspace-save-status" hidden={!state || state.status === 'saved'}>
      {state?.status === 'saving' ? '阅读记录保存中…' : state?.status === 'error' ? `阅读记录保存失败：${state.error}` : '阅读记录待保存…'}
      {state?.status === 'error' && <button className="btn btn-sm" onClick={() => saver.retry(documentId)}>重试保存</button>}
    </div>
  </div>
}
