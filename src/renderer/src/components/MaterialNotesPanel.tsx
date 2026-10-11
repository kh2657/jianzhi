import { useEffect, useMemo, useRef, useState } from 'react'
import { useRemarkSaver } from '../lib/use-remark-saver'
import { useAsyncData } from '../lib/use-async-data'
import { NOTE_TYPE_LABELS, type MaterialNoteView } from '@shared/types'
import { shortDate, fullStamp } from '../lib/time-label'
import { renderMarkdown } from '../md'

export interface MaterialNotesPanelProps {
  documentId: string
  versionId: string
  pageIndex: number
  htmlMode?: boolean
  refreshKey?: number
  initialSelectedNoteId?: string
  scope?: 'page' | 'doc'
  selectedId?: string | null
  /** 对照态默认展开「预览」（KaTeX/Markdown 渲染）；阅读态窄栏默认关 */
  defaultPreviewOn?: boolean
  onNoteSaved?(): void
  onSaveErrorCountChange?(count: number): void
  onScopeChange?(scope: 'page' | 'doc'): void
  onSelectedIdChange?(id: string | null): void
  registerFlusher?(fn: () => Promise<void>): () => void
  onJumpToAnchor?(anchorId: string, pageIndex: number, rects: Array<[number, number, number, number]>): void
  onOpenFullEditor?(noteId: string): void
}

/** 每条笔记独立保存；切页或折叠不会销毁尚未保存的内容。 */
export function MaterialNotesPanel({
  documentId, versionId, pageIndex, htmlMode = false, refreshKey = 0,
  initialSelectedNoteId, scope: controlledScope, selectedId: controlledSelectedId,
  defaultPreviewOn = false,
  onScopeChange, onSelectedIdChange, registerFlusher, onJumpToAnchor, onOpenFullEditor, onNoteSaved, onSaveErrorCountChange
}: MaterialNotesPanelProps): React.ReactElement {
  const [localScope, setLocalScope] = useState<'page' | 'doc'>(htmlMode ? 'doc' : 'page')
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(initialSelectedNoteId ?? null)
  // 就地编辑的预览开关（预览 = Markdown/KaTeX 渲染；对照态默认开，切笔记时回到默认）
  const [previewOn, setPreviewOn] = useState(defaultPreviewOn)
  const scope = htmlMode ? 'doc' : controlledScope ?? localScope
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : localSelectedId
  const setScope = (value: 'page' | 'doc') => { setLocalScope(value); onScopeChange?.(value) }
  const setSelectedId = (value: string | null) => { setLocalSelectedId(value); onSelectedIdChange?.(value) }
  const noteMetadata = useRef(new Map<string, MaterialNoteView>())
  /** 元数据随列表异步到达：等到位再落盘，而不是把「还没加载完」当成保存失败报给用户 */
  const waitForNoteMetadata = async (id: string, timeoutMs = 3000): Promise<MaterialNoteView> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = noteMetadata.current.get(id)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error('这份材料的笔记尚未加载完成，请稍后重试')
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
  const { saver, states } = useRemarkSaver(async (id, value) => {
    const note = await waitForNoteMetadata(id)
    const draft = JSON.parse(value) as { title: string; bodyMd: string }
    // 标题是 wiki 链接的入口；改名保留原名，连续改名也不丢既有别名。
    const aliases = [...new Set([...note.aliases, ...(note.title.trim() && note.title !== draft.title ? [note.title] : [])])]
    // 带上编辑起点的磁盘指纹：外部修改时主进程拒绝写入（面板不做三选处理，指向完整编辑器）
    const res = await window.api.noteSave({ id, ...draft, noteType: note.noteType,
      aliases, verifiedStatus: note.verifiedStatus, baseHash: note.baseHash })
    if (res.conflict) {
      throw new Error('这篇笔记已在外部被修改；为避免覆盖，保存已暂停。请点「完整编辑」处理冲突')
    }
    noteMetadata.current.set(id, { ...note, ...draft, aliases, baseHash: res.baseHash })
    onNoteSaved?.()
  })
  useEffect(() => registerFlusher?.(() => saver.flushAll()), [registerFlusher, saver])
  // 本页模式还展示「仅标记」（尚无笔记的摘录锚点），可直接回跳
  const anchors = useAsyncData(
    () => (htmlMode ? Promise.resolve([]) : window.api.anchorListPage(versionId, pageIndex)),
    [versionId, htmlMode ? -1 : pageIndex, refreshKey],
    { debounceMs: 0 }
  )
  const list = useAsyncData(
    () => window.api.notesForDocument(documentId, scope === 'page' ? { pageIndex } : undefined),
    [documentId, scope, htmlMode ? -1 : pageIndex, refreshKey],
    { debounceMs: 120 }
  )
  const notes = list.data ?? []
  const bareAnchors = (anchors.data ?? []).filter(
    (a) => a.noteIds.length === 0
  )

  useEffect(() => {
    for (const note of list.data ?? []) {
      const state = saver.get(note.id)
      if (!state || state.status === 'saved') noteMetadata.current.set(note.id, note)
      saver.syncServer(note.id, JSON.stringify({ title: note.title, bodyMd: note.bodyMd }))
    }
  }, [list.data, saver])

  useEffect(() => {
    if (initialSelectedNoteId) {
      setLocalSelectedId(initialSelectedNoteId)
      onSelectedIdChange?.(initialSelectedNoteId)
    }
  }, [initialSelectedNoteId])

  // 切到另一篇笔记时，预览开关回到该模式的默认（对照态开 / 阅读态关）
  useEffect(() => { setPreviewOn(defaultPreviewOn) }, [selectedId, defaultPreviewOn])

  const failedNotes = [...states.entries()].filter(([, state]) => state.status === 'error')
  useEffect(() => { onSaveErrorCountChange?.(failedNotes.length) }, [failedNotes.length, onSaveErrorCountChange])

  return (
    <div className="mnp">
      {failedNotes.filter(([id]) => id !== selectedId || !notes.some((note) => note.id === id)).map(([id, state]) => <div key={id} className="status-error small" role="alert">
        {noteMetadata.current.get(id)?.title ?? '笔记'}保存失败：{state.error}
        <button className="btn btn-sm" onClick={() => saver.retry(id)}>重试笔记保存</button>
      </div>)}
      <div className="side-title mnp-head">
        <span>这份材料的笔记</span>
        {!htmlMode && (
          <div className="segmented mnp-scope" role="tablist" aria-label="笔记范围">
            <button role="tab" aria-selected={scope === 'page'} className={`seg-btn ${scope === 'page' ? 'seg-active' : ''}`} onClick={() => setScope('page')}>
              本页
            </button>
            <button role="tab" aria-selected={scope === 'doc'} className={`seg-btn ${scope === 'doc' ? 'seg-active' : ''}`} onClick={() => setScope('doc')}>
              整份
            </button>
          </div>
        )}
      </div>
      {htmlMode && <div className="muted small mnp-hint">HTML 材料目前按「整份材料」关联笔记。</div>}

      {list.error ? (
        <div className="empty-state" role="alert">
          <div>笔记加载失败：{list.error}</div>
          <button className="btn btn-sm" onClick={() => void list.retry()}>重试</button>
        </div>
      ) : (
        <>
          {list.loading && <div className="muted small">加载中…</div>}
          {!list.loading && notes.length === 0 && (
            <div className="mnp-empty">
              <div className="mnp-empty-title">{scope === 'page' ? '这一页还没有笔记' : '这份材料还没有笔记'}</div>
              <div className="muted small">{scope === 'page' ? '划选一句 → 摘录，或在上面的输入卡直接记一条。' : '打开上面输入卡的「随手记」写下第一条。'}</div>
            </div>
          )}
          <div className="mnp-list">
            {notes.map((n) => {
              const open = n.id === selectedId
              const saved = states.get(n.id)
              const draft: { title: string; bodyMd: string } = saved
                ? JSON.parse(saved.value) : { title: n.title, bodyMd: n.bodyMd }
              const edit = (patch: Partial<typeof draft>) => {
                const current = saver.get(n.id)
                const latest = current ? JSON.parse(current.value) as typeof draft : draft
                saver.edit(n.id, JSON.stringify({ ...latest, ...patch }))
              }
              const status = saved?.status ?? 'saved'
              const saveError = saved?.error ?? ''
              return (
                <div key={n.id} className={`mnp-item ${open ? 'mnp-item-open' : ''}`}>
                  <button className="mnp-item-head" onClick={() => setSelectedId(open ? null : n.id)} aria-expanded={open}>
                    {n.noteType !== 'note' && <span className={`tag tag-${n.noteType}`}>{NOTE_TYPE_LABELS[n.noteType]}</span>}
                    <span className="mnp-item-title">{draft.title || '未命名笔记'}</span>
                    {/* 简短日期=最近更新时间；完整时间悬停可见 */}
                    <span className="muted small mnp-item-date" title={`最近更新：${fullStamp(n.updatedAt)}`}>{shortDate(n.updatedAt)}</span>
                    {n.anchors.length > 0 && <span className="muted small">第 {n.anchors[0].pageIndex + 1} 页{n.anchors.length > 1 ? ` 等${n.anchors.length}处` : ''}</span>}
                  </button>
                  {open && (
                    <div className="mnp-item-body">
                      <input
                        className="input mnp-title-input"
                        aria-label="笔记名称"
                        value={draft.title}
                        maxLength={200}
                        placeholder="给这条笔记起个名字"
                        onChange={(e) => edit({ title: e.target.value })}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault()
                            saver.retry(n.id)
                          }
                        }}
                      />
                      <textarea
                        className="mnp-textarea"
                        value={draft.bodyMd}
                        onChange={(e) => edit({ bodyMd: e.target.value })}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault()
                            saver.retry(n.id)
                          }
                        }}
                        placeholder="写下你的理解或问题…（支持 Markdown / LaTeX）"
                        aria-label={`编辑笔记：${draft.title || '未命名笔记'}`}
                      />
                      {previewOn && (
                        <div className="mnp-preview md-body" aria-label={`预览：${draft.title || '未命名笔记'}`}
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.bodyMd) }} />
                      )}
                      <div className="mnp-item-foot">
                        <button className="btn btn-ghost btn-sm" aria-pressed={previewOn}
                          title="Markdown / 公式预览" onClick={() => setPreviewOn((v) => !v)}>
                          {previewOn ? '✓ 预览' : '预览'}
                        </button>
                        <span className={`small ${status === 'error' ? 'status-error' : status === 'saved' ? 'status-saved' : status === 'saving' ? 'status-saving' : status === 'dirty' ? 'status-dirty' : 'muted'}`}>
                          {status === 'dirty' && '编辑中…'}
                          {status === 'saving' && '保存中…'}
                          {status === 'saved' && '已保存'}
                          {status === 'error' && `保存失败：${saveError}`}
                          {status === 'error' && (
                            <button className="btn btn-sm" onClick={() => saver.retry(n.id)}>重试</button>
                          )}
                        </span>
                        {n.anchors.length > 0 && onJumpToAnchor && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              const a = n.anchors.find((x) => x.pageIndex === pageIndex) ?? n.anchors[0]
                              onJumpToAnchor(a.anchorId, a.pageIndex, a.rects)
                            }}
                          >
                            回原文 · 第 {(n.anchors.find((x) => x.pageIndex === pageIndex) ?? n.anchors[0]).pageIndex + 1} 页
                          </button>
                        )}
                        {onOpenFullEditor && (
                          <button className="btn btn-ghost btn-sm" onClick={() => onOpenFullEditor(n.id)} title="打开完整编辑器（双链、来源、照片附件）">
                            完整编辑
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {!htmlMode && scope === 'page' && bareAnchors.length > 0 && (
            <>
              <div className="section-title mnp-sub">仅标记（还没有笔记）</div>
              <div className="mnp-list">
                {bareAnchors.map((a) => (
                  <div key={a.id} className="mnp-item">
                    <button
                      className="mnp-item-head"
                      onClick={() => onJumpToAnchor?.(a.id, pageIndex, a.rects)}
                      title="回到这个标记"
                    >
                      <span className="tag tag-anchor">标记</span>
                      <span className="mnp-item-title">{a.quote ? a.quote.slice(0, 60) : '区域标记'}</span>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
