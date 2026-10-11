/**
 * 外部链接打开守卫：渲染层请求打开的 URL 一律先过这里，
 * 只放行 http/https，防 file: / javascript: / 自定义 deep link 被 shell.openExternal 放大。
 */
export function externalOpenableUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null
  try {
    const u = new URL(raw)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString()
    return null
  } catch {
    return null
  }
}
