import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenDocumentResult } from '@shared/types'
import type { Nav } from '../App'
import { ReadingWorkspacePanel } from '../components/ReadingWorkspacePanel'
import { useToast } from '../components/Toast'

export function HtmlReaderView({ nav, documentId }: { nav: Nav; documentId: string }): React.ReactElement {
  const [opened, setOpened] = useState<OpenDocumentResult | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [showNoteForm, setShowNoteForm] = useState(false)
  const [title, setTitle] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [panelKey, setPanelKey] = useState(0)
  const [selectedNoteId, setSelectedNoteId] = useState<string | undefined>(undefined)
  const toast = useToast()
  const generation = useRef(0)
  const savePending = useRef(false)

  const panelFlushers = useRef(new Set<() => Promise<void>>())
  const registerPanelFlusher = useCallback((fn: () => Promise<void>) => {
    panelFlushers.current.add(fn)
    return () => { panelFlushers.current.delete(fn) }
  }, [])
  useEffect(() => {
    nav.registerFlusher(async () => {
      await Promise.all([...panelFlushers.current].map((fn) => fn()))
      await window.api.readingSave({ documentId, pageIndex: 0, scale: 1, rotation: 0 })
    })
    return () => nav.registerFlusher(null)
  }, [documentId])

  useEffect(() => {
    const current = ++generation.current
    setOpened(null)
    setLoadError('')
    void window.api.docOpen(documentId).then((result) => {
      if (generation.current !== current) return
      if (result.mediaType !== 'text/html') throw new Error('这份材料不是 HTML 文档，请返回文库重新打开。')
      setOpened(result)
      return window.api.readingSave({ documentId, pageIndex: 0, scale: 1, rotation: 0 })
    }).catch((error: unknown) => {
      if (generation.current === current) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => { generation.current++ }
  }, [documentId, reload])

  useEffect(() => {
    setShowNoteForm(false)
    setTitle('')
    setBodyMd('')
    setSaveError('')
  }, [documentId])

  async function createNote(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!opened || !title.trim() || savePending.current) return
    const current = generation.current
    savePending.current = true
    setSaving(true)
    setSaveError('')
    try {
      const note = await window.api.noteCreate({ title: title.trim(), bodyMd, documentId })
      if (generation.current === current) {
        toast.push('已创建材料笔记，可在右侧继续编辑', 'success')
        setShowNoteForm(false)
        setSelectedNoteId(note.id)
        setPanelKey((k) => k + 1)
      }
    } catch (error) {
      if (generation.current === current) setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      savePending.current = false
      setSaving(false)
    }
  }

  return (
    <div className="reader html-reader">
      <div className="reader-toolbar">
        <button className="btn" onClick={() => nav.go({ kind: 'library' })}>← 文献</button>
        <span className="reader-title" title={opened?.title}>{opened?.title ?? 'HTML 材料'}</span>
        <button className="btn" disabled={saving} onClick={() => setReload((value) => value + 1)}>重新加载</button>
        <button
          className="btn btn-primary"
          disabled={!opened}
          aria-expanded={showNoteForm}
          onClick={() => setShowNoteForm((value) => !value)}
        >
          为此材料新建笔记
        </button>
      </div>
      <div className="html-reader-hint muted small">
        支持单文件 HTML 中的内嵌样式和交互；外部资源暂不加载。笔记关联整份材料。
      </div>
      <div className="reader-body">
        {loadError ? (
          <div className="empty-state" role="alert">
            <div className="empty-title">HTML 材料无法打开</div>
            <div>{loadError}</div>
            <button className="btn" onClick={() => setReload((value) => value + 1)}>重试</button>
          </div>
        ) : opened ? (
          // The asset endpoint supplies a restrictive HTTP CSP. Unlike srcDoc,
          // a separate document does not inherit the app's script-src policy.
          // Never add allow-same-origin: imported scripts must not access window.api.
          <iframe
            key={`${documentId}:${reload}`}
            className="html-frame"
            title={`HTML 材料：${opened.title}`}
            src={opened.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="reader-loading muted" role="status">正在打开 HTML 材料…</div>
        )}
        <aside className="reader-side">
          {showNoteForm && opened ? (
            <form className="html-note-form" onSubmit={(event) => void createNote(event)}>
              <div className="side-title">新建材料笔记</div>
              <label htmlFor="html-note-title">标题</label>
              <input
                id="html-note-title"
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：弱收敛与范数收敛的区别"
                disabled={saving}
                required
                autoFocus
              />
              <label htmlFor="html-note-body">正文（可选）</label>
              <textarea
                id="html-note-body"
                className="input"
                rows={8}
                value={bodyMd}
                onChange={(event) => setBodyMd(event.target.value)}
                placeholder="记录你的理解、疑问，或粘贴材料中的内容。支持 Markdown。"
                disabled={saving}
              />
              <div className="muted small">来源：{opened.title}（整份 HTML）</div>
              {saveError && <div role="alert">保存失败：{saveError}</div>}
              <div className="html-note-actions">
                <button className="btn" type="button" onClick={() => setShowNoteForm(false)}>取消</button>
                <button className="btn btn-primary" type="submit" disabled={saving || !title.trim()}>
                  {saving ? '保存中…' : '创建笔记'}
                </button>
              </div>
            </form>
          ) : null}
          {opened && (
              <>
                <button className="btn btn-sm mnp-new" onClick={() => setShowNoteForm(true)}>＋ 为这份材料写笔记</button>
                <ReadingWorkspacePanel
                  docType={opened.docType}
                  spaceId={opened.spaceId}
                  registerFlusher={registerPanelFlusher}
                  documentId={opened.documentId}
                  versionId={opened.versionId}
                  pageIndex={-1}
                  htmlMode
                  refreshKey={panelKey}
                  initialSelectedNoteId={selectedNoteId}
                  onOpenFullEditor={(noteId) => nav.go({ kind: 'note', noteId })}
                />
              </>
          )}
        </aside>
      </div>
    </div>
  )
}
