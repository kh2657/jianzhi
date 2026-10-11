/** 数据加载失败的统一占位：可读错误信息 + 重试。配合 useAsyncData 使用。 */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }): React.ReactElement {
  return (
    <div className="empty-state" role="alert">
      <div className="empty-title">加载失败</div>
      <div className="muted">{message}</div>
      <button className="btn" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}
