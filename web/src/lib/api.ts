let csrfToken = ''
export const setCsrf = (token: string) => { csrfToken = token }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'ApiError' }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('X-CSRF-Token', csrfToken)
  const response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin', headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, data.error?.code || 'REQUEST_FAILED', data.error?.message || '请求未完成，请稍后重试')
  return data as T
}
export const write = <T>(path: string, body: unknown = {}, method = 'POST') => api<T>(path, { method, body: JSON.stringify(body) })
export async function downloadExport(tripId: string, versionId: string, format: 'json' | 'html', canDownload: () => boolean = () => true) {
  const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/export?format=${format}&versionId=${encodeURIComponent(versionId)}`, { credentials: 'same-origin' })
  if (!response.ok) throw new ApiError(response.status, 'EXPORT_FAILED', '导出失败，请重新登录后再试')
  const blob = await response.blob()
  if (!canDownload()) return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `travelfolio-${tripId}.${format}`
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}


// Artifact HTML stays isolated in an opaque-origin iframe, never inserted in the app DOM.
export async function fetchArtifact(tripId: string, versionId: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/versions/${encodeURIComponent(versionId)}/artifact`, { credentials: 'same-origin', signal, headers: { Accept: 'text/html' } })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new ApiError(response.status, data.error?.code || 'ARTIFACT_FAILED', data.error?.message || '无法读取手册预览，请刷新后重试')
  }
  if (!response.headers.get('Content-Type')?.includes('text/html')) throw new ApiError(502, 'ARTIFACT_TYPE', '手册文件格式不正确，无法安全预览')
  return response.text()
}
export async function matchesArtifactHash(html: string, expected: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false
  const bytes = new TextEncoder().encode(html)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') === expected.toLowerCase()
}
