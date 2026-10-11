import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Nav } from '../App'
import { useToast } from '../components/Toast'
import { Modal } from '../components/Picker'
import { Icon } from '../components/Icon'
import { useStudySpace } from '../study-space'
import type { DailyImportResult, PaperFeed, PaperItem, PaperStatus } from '@shared/types'

/** 论文状态筛选（原为外壳侧栏维度，筛选收敛后移入视图内的标签行） */
const PAPER_TABS: Array<[PaperStatus | 'all', string]> = [['new', '待挑选'], ['imported', '已在文献'], ['skipped', '已忽略'], ['all', '全部']]

export function PapersView({ nav, deepLinkBaseId, statusTab, onStatusTab }: {
  nav: Nav
  deepLinkBaseId?: string | null
  statusTab: PaperStatus | 'all'
  onStatusTab(tab: PaperStatus | 'all'): void
}): React.ReactElement {
  const { scope, spaces } = useStudySpace()
  const [feeds, setFeeds] = useState<PaperFeed[]>([])
  const [items, setItems] = useState<PaperItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [days, setDays] = useState(7)
  const [editingFeed, setEditingFeed] = useState<PaperFeed | 'new' | null>(null)
  const [daily, setDaily] = useState<{ folder: string; autoCheck: boolean; lastCheck: string | null } | null>(null)
  const [importingDaily, setImportingDaily] = useState(false)
  const toast = useToast()

  const refreshFeedsAndItems = useCallback(async () => {
    setLoading(true)
    try {
      const [f, list] = await Promise.all([window.api.paperFeedList(), window.api.paperList(statusTab, days)])
      setFeeds(f)
      setItems(list)
    } catch (err) {
      toast.push(`加载失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [statusTab, days, toast])

  useEffect(() => {
    void refreshFeedsAndItems()
  }, [refreshFeedsAndItems])

  useEffect(() => {
    void window.api.paperDailySettings().then(setDaily).catch(() => undefined)
  }, [])

  const importDaily = async () => {
    if (importingDaily) return
    setImportingDaily(true)
    try {
      const results = await window.api.paperImportDaily()
      if (!results.length) {
        toast.push(`清单文件夹还没有 JSON 文件（${(await window.api.paperDailySettings()).folder}）`, 'info')
      }
      for (const r of results as DailyImportResult[]) {
        if (r.error) toast.push(`「${r.file}」导入失败：${r.error}（已移入 failed/ 文件夹）`, 'error')
        else if (r.imported > 0) toast.push(`「${r.file}」导入 ${r.imported} 篇${r.skipped ? `，跳过 ${r.skipped}` : ''}`, 'success')
        else toast.push(`「${r.file}」没有新增（${r.skipped} 篇已处理过）`, 'info')
      }
      await refreshFeedsAndItems()
      setDaily(await window.api.paperDailySettings())
    } catch (err) {
      toast.push(`清单导入失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setImportingDaily(false)
    }
  }

  const toggleAutoCheck = async () => {
    if (!daily) return
    const next = !daily.autoCheck
    try {
      await window.api.paperSetDailySettings({ autoCheck: next })
      setDaily({ ...daily, autoCheck: next })
      toast.push(next ? '已开启：每天首次打开应用时自动读取清单（仅本地文件，不联网）' : '已关闭自动读取清单', 'success')
    } catch (err) {
      toast.push(`设置失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const doRefresh = async (feedId?: string) => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const results = await window.api.paperRefresh(feedId)
      for (const r of results) {
        if (r.error) toast.push(`「${r.feedName}」抓取失败：${r.error}`, 'error')
        else toast.push(`「${r.feedName}」抓到 ${r.fetched} 篇，新增 ${r.newItems} 篇`, 'success')
      }
      await refreshFeedsAndItems()
    } catch (err) {
      toast.push(`抓取失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const importOne = async (item: PaperItem) => {
    if (importingId) return
    setImportingId(item.arxivId)
    try {
      const r = await window.api.paperImport(item.arxivId, scope ?? null)
      if (r.ok) {
        toast.push(r.duplicate ? `《${item.title}》已在文库` : `已导入《${item.title}》`, 'success')
        await refreshFeedsAndItems()
        window.dispatchEvent(new Event('mathwb:counts-changed'))
        if (r.documentId) nav.go({ kind: 'reader', documentId: r.documentId })
      } else {
        toast.push(`导入失败：${r.error}`, 'error')
      }
    } catch (err) {
      toast.push(`开始阅读失败：${String(err)}`, 'error')
    } finally {
      setImportingId(null)
    }
  }

  /**
   * 忽略：这是可逆操作（「已忽略」里给了「移回待挑选」），所以不再弹确认框——
   * 挑论文时「忽略」是高频动作，可撤销就不该再加一道拦截。
   */
  const skipOne = async (item: PaperItem) => {
    const ok = await setPaperStatus(item, 'skipped')
    if (ok) toast.push('已忽略，可在「已忽略」里点「移回待挑选」', 'info')
  }

  /** 论文状态切换（忽略 / 移回待挑选）：失败明确提示，成功后刷新列表；返回是否成功 */
  const setPaperStatus = async (item: PaperItem, status: PaperStatus): Promise<boolean> => {
    try {
      await window.api.paperSetStatus(item.arxivId, status)
      await refreshFeedsAndItems()
      if (status === 'new') toast.push('已移回待挑选', 'success')
      return true
    } catch (err) {
      toast.push(`操作失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      return false
    }
  }

  const openAbs = async (item: PaperItem) => {
    try {
      await window.api.paperOpenAbs(item.arxivId)
    } catch (err) {
      toast.push(`打开失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  // deep link：确保目标论文在当前列表可见（切到「全部」，时间窗放大）
  useEffect(() => {
    if (!deepLinkBaseId) return
    setDays(30)
    onStatusTab('all')
  }, [deepLinkBaseId, onStatusTab])

  // 按日期分组（published 的日期部分）
  const groups = useMemo(() => {
    const map = new Map<string, PaperItem[]>()
    for (const it of items) {
      const key = (it.publishedAt || '').slice(0, 10) || '未知日期'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(it)
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [items])

  return (
    <div className="view view-scroll">
      <div className="view-head">
        <h1>每日论文</h1>
        <div className="view-actions">
          <button className="btn" onClick={() => setEditingFeed('new')}>＋ 新订阅</button>
          <button className="btn btn-primary" onClick={() => void doRefresh()} disabled={refreshing}>
            {refreshing ? '抓取中…' : feeds.length ? <><Icon name="rotate" size={15} /> 抓取更新</> : '抓取'}
          </button>
        </div>
      </div>
      <p className="muted view-desc">
        点「抓取」时从 arXiv 拉取最新论文（其余时间完全离线）。感兴趣的导入文库——标题作者自动填好、归入当前学习区；不看的一键忽略。
      </p>

      {daily && (
        <div className="daily-bar">
          <div className="daily-bar-main">
            <strong>每日邮件清单</strong>
            <span className="muted small">
              邮件脚本把候选论文输出为 JSON 放进清单文件夹，这里一键导入（按论文 ID 去重，可多来源）。
              上次读取：{daily.lastCheck ? new Date(daily.lastCheck).toLocaleString('zh-CN', { hour12: false }) : '尚未读取'}
            </span>
            <span className="muted small mono daily-folder">{daily.folder}</span>
          </div>
          <div className="daily-bar-actions">
            <button className="btn" onClick={() => void window.api.paperRevealFolder()}>打开文件夹</button>
            <label className="chip" title="每天首次打开应用时自动读取清单；仅读本地文件，不联网">
              <input type="checkbox" checked={daily.autoCheck} onChange={() => void toggleAutoCheck()} style={{ marginRight: 6 }} />
              每天自动读取
            </label>
            <button className="btn btn-primary" onClick={() => void importDaily()} disabled={importingDaily}>
              {importingDaily ? '读取中…' : '读取清单文件夹'}
            </button>
          </div>
        </div>
      )}

      {/* 论文状态筛选：原为外壳侧栏维度，筛选收敛后移入视图内的下划线标签行（无订阅时也恒显，状态是视图属性） */}
      <div className="filter-tabs" role="group" aria-label="论文状态">
        {PAPER_TABS.map(([value, label]) => (
          <button key={value} className={`chip ${statusTab === value ? 'chip-active' : ''}`} aria-pressed={statusTab === value} onClick={() => onStatusTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {feeds.length === 0 && !loading && (
        <div className="empty-state">
          <div className="empty-title">还没有论文订阅</div>
          <div>把关注的 arXiv 分类和关键词（如 math.AG、moduli space）配成订阅，每天在这里直接挑选。</div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setEditingFeed('new')}>
            创建第一个订阅
          </button>
        </div>
      )}

      {feeds.length > 0 && (
        <>
          <div className="library-filters" role="group" aria-label="论文筛选">
            <span className="chip-days">
              最近
              <select className="input input-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="时间范围">
                <option value={1}>1 天</option>
                <option value={3}>3 天</option>
                <option value={7}>7 天</option>
                <option value={14}>14 天</option>
                <option value={30}>30 天</option>
              </select>
            </span>
            {feeds.map((f) => (
              <button key={f.id} className="chip" title={`单独抓取「${f.name}」：${f.categories || '无分类'}${f.keywords ? ` · ${f.keywords}` : ''}`} onClick={() => void doRefresh(f.id)}>
                <Icon name="rotate" size={13} /> {f.name}
              </button>
            ))}
            <span className="muted small">{items.length} 篇</span>
          </div>

          {loading && <div className="muted">加载中…</div>}
          {!loading && items.length === 0 && (
            <div className="empty-state">
              <div className="empty-title">没有符合条件的论文</div>
              <div>试试扩大时间范围，或点「抓取更新」看看最新提交。</div>
            </div>
          )}

          {groups.map(([date, list]) => (
            <div key={date}>
              <div className="section-title paper-date">{formatDate(date)}</div>
              <div className="paper-list">
                {list.map((it) => (
                  <div
                    key={it.id}
                    className={`paper-card ${it.status !== 'new' ? 'paper-card-done' : ''} ${it.baseId === deepLinkBaseId ? 'paper-card-target' : ''}`}
                    data-base-id={it.baseId}
                  >
                    <div className="paper-main">
                      <div className="paper-title-row">
                        <span className="paper-title">{it.title}</span>
                        {it.primaryCategory && <span className="tag">{it.primaryCategory}</span>}
                        <span className={`tag paper-status-${it.status}`}>
                          {it.status === 'imported' ? '已在文库' : it.status === 'skipped' ? '已忽略' : '新'}
                        </span>
                      </div>
                      <div className="muted small paper-authors">{it.authors.join(' · ')}</div>
                      <details className="paper-abstract">
                        <summary className="muted small">摘要</summary>
                        <p className="small">{it.abstract}</p>
                      </details>
                      <div className="muted small">
                        {it.feedNames.length > 0 && <span>来自 {it.feedNames.map((f) => `「${f}」`).join(' ')} · </span>}
                        <button className="link-btn" onClick={() => void openAbs(it)}>arXiv 页面 ↗</button>
                        {it.status === 'imported' && it.documentId && (
                          <>
                            {' · '}
                            <button className="link-btn" onClick={() => nav.go({ kind: 'reader', documentId: it.documentId! })}>
                              继续阅读 →
                            </button>
                          </>
                        )}
                        {it.status === 'skipped' && (
                          <>
                            {' · '}
                            <button className="link-btn" onClick={() => void setPaperStatus(it, 'new')}>移回待挑选</button>
                          </>
                        )}
                      </div>
                    </div>
                    {it.status === 'new' && (
                      <div className="paper-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => void importOne(it)} disabled={importingId === it.arxivId}>
                          {importingId === it.arxivId ? '正在打开…' : '开始阅读'}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => void skipOne(it)}>忽略</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {editingFeed && (
        <FeedModal
          feed={editingFeed === 'new' ? null : editingFeed}
          onClose={() => setEditingFeed(null)}
          onSaved={async () => {
            setEditingFeed(null)
            await refreshFeedsAndItems()
          }}
        />
      )}
    </div>
  )
}

function FeedModal({ feed, onClose, onSaved }: {
  feed: PaperFeed | null
  onClose(): void
  onSaved(): void | Promise<void>
}): React.ReactElement {
  const toast = useToast()
  const [name, setName] = useState(feed?.name ?? '')
  const [categories, setCategories] = useState(feed?.categories ?? '')
  const [keywords, setKeywords] = useState(feed?.keywords ?? '')
  const [maxResults, setMaxResults] = useState(feed?.maxResults ?? 50)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      if (feed) await window.api.paperFeedUpdate(feed.id, { name, categories, keywords, maxResults })
      else await window.api.paperFeedCreate({ name, categories, keywords, maxResults })
      toast.push(feed ? '订阅已更新' : '订阅已创建', 'success')
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!feed || saving) return
    if (!window.confirm(`删除订阅「${feed.name}」？已抓取的论文条目会一并删除（已导入文库的 PDF 不受影响）。`)) return
    setSaving(true)
    try {
      await window.api.paperFeedDelete(feed.id)
      toast.push('订阅已删除', 'success')
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <Modal title={feed ? '编辑订阅' : '新建论文订阅'} onClose={onClose} width={520}>
      <div className="doc-info-form">
        <label>订阅名称<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：代数几何每日" maxLength={80} autoFocus /></label>
        <label>
          arXiv 分类（逗号分隔）
          <input className="input mono" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="math.AG, math.NT" />
        </label>
        <label>
          关键词（逗号分隔，可空）
          <input className="input" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder='例如：moduli space, Calabi-Yau' />
        </label>
        <label>
          每次抓取上限
          <select className="input" value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value))}>
            {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n} 篇</option>)}
          </select>
        </label>
        <p className="muted small">分类与关键词是「且」的关系；关键词之间、分类之间是「或」。查询会在你点「抓取」时发送给 arXiv，其余时间完全离线。</p>
        {error && <p role="alert" className="status-error">{error}</p>}
        <div className="doc-info-actions">
          {feed && <button className="btn btn-ghost" style={{ marginRight: 'auto', color: 'var(--danger)' }} onClick={() => void remove()}>删除订阅</button>}
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !name.trim()}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </Modal>
  )
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(`${dateStr}T12:00:00Z`)
    if (Number.isNaN(d.getTime())) return dateStr
    const today = new Date()
    const diff = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400_000)
    const cn = d.toLocaleDateString('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' })
    if (diff === 0) return `今天 · ${cn}`
    if (diff === 1) return `昨天 · ${cn}`
    return cn
  } catch {
    return dateStr
  }
}
