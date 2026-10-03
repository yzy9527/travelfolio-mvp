import type { Constraints, Job, Version } from './types'
export function safeUrl(value: string): string | null {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
export function mapUrl(location: string) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}` }
export function dayCount(start: string, end: string): number {
  const delta = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  return Number.isFinite(delta) ? Math.floor(delta / 86400000) + 1 : 0
}
export function validateConstraints(c: Constraints): string | null {
  if (!c.destination.trim() || !c.departure.trim()) return '请填写目的地和出发地'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(c.endDate)) return '请选择完整的出发和返程日期'
  for (const date of [c.startDate, c.endDate]) { const parsed = new Date(`${date}T00:00:00Z`); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) return '请选择有效的日历日期' }
  const days = dayCount(c.startDate, c.endDate)
  if (days < 1 || days > 14) return '旅行天数需为 1 至 14 天，返程不能早于出发'
  if (!Number.isInteger(c.people) || c.people < 1 || c.people > 20) return '同行人数需为 1 至 20 人'
  if (!Number.isFinite(c.budget) || c.budget <= 0) return '请填写大于 0 的整团总预算'
  if (!/^[A-Z]{3}$/.test(c.currency)) return '请选择有效的预算币种'
  return null
}
export function money(amount: number, currency = 'CNY'): string {
  try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount) } catch { return `${currency} ${amount.toFixed(0)}` }
}
export function dateLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
}
export function dateTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
export const pendingJob = (jobs: Job[]) => jobs.find(job => job.status === 'queued' || job.status === 'running' || job.status === 'awaiting_outline')
export const newId = () => crypto.randomUUID()


export function requiresManualReview(version: Version) {
  if (version.schemaVersion !== 2) return false
  const review = version.review
  return !(version.qaStatus === 'passed' && !!version.artifactHash && review?.artifactHash === version.artifactHash && review?.checks.desktop === true && review?.checks.mobile === true && review?.checks.content === true && review?.checks.maps === true)
}
export const requiresChargeAcknowledgment = (job: Job) => job.mode === 'live' && job.possibleCharge === true
export const stageNames: Record<string, string> = { outline: '行程大纲', research: '资料研究', assets: '图片素材', maps: '路线地图', compile: '编译手册', validate: '自动检查', candidate: '人工审阅' }
export const pipelineStages = ['outline', 'research', 'assets', 'maps', 'compile', 'validate', 'candidate']
export function jobHeading(job: Job) {
  if (job.status === 'awaiting_outline') return '大纲已就绪，等你确认'
  if (job.status === 'succeeded') return '候选手册已生成，等待人工审阅'
  if (job.status === 'failed') return '任务暂停：上次运行未完成'
  if (job.status === 'cancelled') return '任务已取消'
  if (job.status === 'queued') return '任务已保存，等待执行'
  return `正在${stageNames[job.stage || 'outline'] || '处理任务'}`
}

// History rows stay lightweight. Only a bounded, authenticated selected-version cache supplies guide bytes.
export function withCachedGuides(versions: Version[], cache: ReadonlyMap<string, Version>): Version[] {
  return versions.map(version => ({ ...version, guide: cache.get(`${version.id}:${version.artifactHash || ''}`)?.guide || null }))
}
