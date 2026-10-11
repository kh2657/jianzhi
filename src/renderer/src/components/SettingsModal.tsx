import { useEffect, useState } from 'react'
import { Modal } from './Picker'
import { useToast } from './Toast'

/** 设置弹窗：数据文件夹（库根）查看与更换，以及「关于」里的版本信息。换根写设置后需重启应用生效。 */
export function SettingsModal({ onClose }: { onClose(): void }): React.ReactElement {
  const toast = useToast()
  const [info, setInfo] = useState<{ root: string; defaultRoot: string; isCustom: boolean } | null>(null)
  // 已写入设置、等重启生效的新位置；'' 表示恢复默认
  const [pending, setPending] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState<{ app: string; electron: string; node: string } | null>(null)

  useEffect(() => {
    void window.api.settingsLibraryInfo().then(setInfo).catch((err) => toast.push(`读取设置失败：${String(err)}`, 'error'))
    // 版本号：本地更新（install:mac）之后靠它确认装上的到底是哪一版
    void window.api.appVersionInfo().then(setVersions).catch(() => undefined)
  }, [toast])

  const choose = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.settingsChooseLibraryRoot()
      if (r.ok) setPending(r.path)
      else if (r.reason === 'not-library') {
        toast.push('该文件夹不是空的，也没有文献库/笔记/收件箱结构，不能作为数据文件夹', 'error')
      }
    } catch (err) {
      toast.push(`选择失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.settingsResetLibraryRoot()
      setPending('')
    } catch (err) {
      toast.push(`恢复默认失败：${String(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const relaunch = (): void => {
    void window.api.appRelaunch()
  }

  return (
    <Modal title="设置" onClose={onClose} width={560}>
      <div className="doc-info-form">
        <div>
          <span className="settings-label">数据文件夹</span>
          <div className="mono small settings-root">{info?.root ?? '读取中…'}</div>
          <p className="muted small">
            文献库、笔记、收件箱都保存在这里，应用不会上传。放到 iCloud、坚果云等网盘文件夹即可在多台电脑间同步。
            修改后需重启应用生效；原文件夹不会被移动或删除。
          </p>
        </div>
        <div className="doc-info-actions">
          <button className="btn" disabled={busy} onClick={() => void choose()}>
            选择数据文件夹…
          </button>
          {info?.isCustom && (
            <button className="btn" disabled={busy} onClick={() => void reset()}>
              恢复默认位置
            </button>
          )}
        </div>
        {pending !== null && (
          <div className="settings-pending" role="status">
            <p className="small">
              新位置：<span className="mono">{pending === '' ? '默认位置' : pending}</span>
              ，重启应用后生效。
            </p>
            <button className="btn btn-primary" onClick={relaunch}>
              重启应用
            </button>
          </div>
        )}
        <div>
          <span className="settings-label">关于</span>
          <div className="small settings-about">
            <span>
              数学学习工作台 <span className="mono">{versions?.app ?? '读取中…'}</span>
            </span>
            {versions && (
              <span className="muted">
                Electron {versions.electron} · Node {versions.node}
              </span>
            )}
            <span className="muted">本地运行，无账号、无上传、无遥测</span>
          </div>
        </div>
      </div>
    </Modal>
  )
}
