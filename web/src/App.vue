<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from './components/Icon.vue'
import Handbook from './components/Handbook.vue'
import TripWizard from './components/TripWizard.vue'
import GenerationPipeline from './components/GenerationPipeline.vue'
import ArtifactPreview from './components/ArtifactPreview.vue'
import GuideEvidence from './components/GuideEvidence.vue'
import AssetReview from './components/AssetReview.vue'
import type { AssetReviewRequest } from './lib/assets'
import { api, ApiError, downloadExport, setCsrf, write } from './lib/api'
import type { AdminOverview, AdminUser, Constraints, Job, Settings, Trip, TripDetail, User, Version, ReviewChecks } from './lib/types'
import { dateLabel, dateTime, dayCount, money, newId, pendingJob, requiresManualReview, withCachedGuides } from './lib/utils'

type Page = 'trips' | 'new' | 'trip' | 'settings' | 'admin'
const user = ref<User | null>(null)
const booting = ref(true)
const bootError = ref('')
const page = ref<Page>('trips')
const selectedTripId = ref('')
const trips = ref<Trip[]>([])
const detail = ref<TripDetail | null>(null)
const selectedVersionId = ref('')
const settings = ref<Settings | null>(null)
const mobileNav = ref(false)
const historyOpen = ref(false)
const loading = ref(false)
const busy = ref('')
const error = ref('')
const toast = ref('')
const authMode = ref<'login' | 'register'>('login')
const auth = reactive({ email: '', password: '', inviteCode: '' })
const model = reactive({ provider: 'openai' as Settings['provider'], baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' })
const regenerateRequest = ref('')
const mode = ref<'live' | 'demo'>('demo')
const adminUsers = ref<AdminUser[]>([])
const overview = ref<AdminOverview | null>(null)
const invite = ref<{ inviteCode: string; expiresAt: string } | null>(null)
const wizard = ref<InstanceType<typeof TripWizard> | null>(null)
const connectionIssue = ref(false)
const versionLoading = ref(false)
const versionError = ref('')
const fullVersionCache = new Map<string, Version>()
let versionEpoch = 0
let versionController: AbortController | undefined
const submissionKeys = new Map<string,string>()
let authEpoch = 0
let loadEpoch = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let toastTimer: ReturnType<typeof setTimeout> | undefined
const version = computed(() => detail.value?.versions.find(v => v.id === selectedVersionId.value) || detail.value?.versions.find(v => v.id === detail.value?.trip.currentVersionId) || null)
const activeJob = computed(() => pendingJob(detail.value?.jobs || []))
const versionReady = computed(() => !version.value || version.value.schemaVersion !== 2 || !!version.value.guide)
const pipelineJob = computed(() => activeJob.value || detail.value?.jobs[0] || null)
const isCurrentVersion = computed(() => !!version.value && version.value.id === detail.value?.trip.currentVersionId)
const candidates = computed(() => detail.value?.versions.filter(v => v.status === 'candidate') || [])
const adoptedCount = computed(() => trips.value.filter(trip => trip.currentVersionId).length)
const pageTitle = computed(() => ({ trips: '我的旅行', new: '计划新旅行', trip: '旅行手册', settings: '模型设置', admin: '管理控制台' })[page.value])
const canGenerate = computed(() => mode.value === 'demo' ? settings.value?.demoEnabled : settings.value?.hasApiKey)
const versionLabel = (v: Version) => v.id === detail.value?.trip.currentVersionId ? '当前采用' : v.status === 'candidate' ? '待确认草案' : v.status === 'discarded' ? '已舍弃' : '历史版本'

function notify(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = '' }, 5000) }
function clearSession() {
  authEpoch++; loadEpoch++; versionEpoch++; versionController?.abort(); fullVersionCache.clear(); versionLoading.value = false; versionError.value = ''; booting.value = false; bootError.value = ''; stopPoll();
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('travelfolio:draft:')) sessionStorage.removeItem(key) } catch { /* Storage can be unavailable. */ } clearTimeout(toastTimer); setCsrf(''); user.value = null;
  detail.value = null; trips.value = []; settings.value = null; adminUsers.value = []; overview.value = null; invite.value = null;
  selectedTripId.value = ''; selectedVersionId.value = ''; regenerateRequest.value = ''; model.apiKey = ''; model.model = 'gpt-4.1-mini'; model.baseUrl = 'https://api.openai.com/v1'; model.provider = 'openai';
  auth.password = ''; auth.inviteCode = ''; toast.value = ''; error.value = ''; busy.value = ''; loading.value = false; historyOpen.value = false; connectionIssue.value = false; submissionKeys.clear();
}
function report(err: unknown) {
  if (err instanceof ApiError && err.status === 401) { clearSession(); error.value = '登录已过期，请重新登录'; return }
  error.value = err instanceof Error ? err.message : '操作未完成，请稍后重试'
}
function stopPoll() { clearTimeout(pollTimer); pollTimer = undefined }
function navigate(target: Page, id = '') { const hash = target === 'trip' ? `#/trips/${encodeURIComponent(id)}` : `#/${target}`; if (location.hash === hash) void readRoute(); else location.hash = hash }
async function readRoute() {
  stopPoll(); loadEpoch++; mobileNav.value = false; historyOpen.value = false; error.value = ''; connectionIssue.value = false
  const match = location.hash.match(/^#\/trips\/([^/]+)$/)
  const route = location.hash.replace(/^#\//, '')
  if (match) { try { selectedTripId.value = decodeURIComponent(match[1]) } catch { navigate('trips'); return }; page.value = 'trip'; await loadTrip(selectedTripId.value, true); return }
  page.value = ['trips','new','settings','admin'].includes(route) ? route as Page : 'trips'
  if (page.value === 'admin') { if (user.value?.role !== 'admin') { navigate('trips'); return }; await loadAdmin() }
  if (page.value === 'trips') await loadTrips()
  await nextTick(); document.getElementById('main-content')?.focus({ preventScroll: true })
}
async function loadTrips(epoch = authEpoch) { try { const result = await api<{trips: Trip[]}>('/trips'); if (epoch === authEpoch) trips.value = result.trips } catch (err) { if (epoch === authEpoch) report(err) } }
async function loadSettings(epoch = authEpoch) {
  const result = await api<Settings>('/settings')
  if (epoch !== authEpoch) return
  settings.value = result
  Object.assign(model, { provider: settings.value.provider || 'openai', baseUrl: settings.value.baseUrl || 'https://api.openai.com/v1', model: settings.value.model || 'gpt-4.1-mini', apiKey: '' })
  mode.value = settings.value.demoEnabled ? 'demo' : 'live'
}
async function startSession(epoch = authEpoch) { await Promise.all([loadTrips(epoch), loadSettings(epoch)]); if (epoch === authEpoch && user.value) await readRoute() }
async function boot() {
  booting.value = true; bootError.value = ''; const epoch = authEpoch
  try { const data = await api<{user: User; csrfToken: string}>('/auth/me'); if (epoch !== authEpoch) return; user.value = data.user; setCsrf(data.csrfToken); await startSession(epoch) }
  catch (err) { if (epoch === authEpoch) { if (err instanceof ApiError && err.status === 401) clearSession(); else bootError.value = err instanceof Error ? err.message : '暂时无法连接服务' } }
  finally { if (epoch === authEpoch) booting.value = false }
}
async function submitAuth() {
  if (busy.value) return
  busy.value = 'auth'; error.value = ''; const epoch = authEpoch
  try { const body = authMode.value === 'login' ? {email: auth.email, password: auth.password} : {...auth}; const result = await write<{user: User; csrfToken: string}>(`/auth/${authMode.value}`, body); if (epoch !== authEpoch) return; user.value = result.user; setCsrf(result.csrfToken); auth.password = ''; auth.inviteCode = ''; await startSession(epoch) }
  catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function logout() {
  if (busy.value) return; busy.value = 'logout'; const epoch = authEpoch
  try { await write('/auth/logout'); if (epoch !== authEpoch) return; clearSession(); auth.email = ''; location.hash = '#/trips' }
  catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function createTrip(constraints: Constraints) {
  const epoch = authEpoch
  if (busy.value) return; busy.value = 'create'; error.value = ''
  try { const result = await write<{trip: Trip}>('/trips', constraints); if (epoch !== authEpoch) return; wizard.value?.clearDraft(); trips.value.unshift(result.trip); navigate('trip', result.trip.id); notify('旅行已创建，选择生成方式开始规划') }
  catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function loadTrip(id: string, reset = false) {
  const epoch = ++loadEpoch; stopPoll(); if (reset) { detail.value = null; selectedVersionId.value = ''; regenerateRequest.value = ''; loading.value = true }
  try {
    const result = await api<TripDetail>(`/trips/${encodeURIComponent(id)}`)
    if (epoch !== loadEpoch || page.value !== 'trip' || selectedTripId.value !== id) return
    result.versions = withCachedGuides(result.versions, fullVersionCache)
    detail.value = result; connectionIssue.value = false
    if (!result.versions.some(v => v.id === selectedVersionId.value)) selectedVersionId.value = result.versions.find(v => v.status === 'candidate')?.id || result.trip.currentVersionId || ''
    const index = trips.value.findIndex(t => t.id === id); if (index >= 0) trips.value[index] = result.trip
    const polling = pendingJob(result.jobs); if (polling && ['queued','running'].includes(polling.status)) pollJob(polling, epoch)
  } catch (err) { if (epoch === loadEpoch) report(err) } finally { if (epoch === loadEpoch) loading.value = false }
}
async function loadSelectedVersion(force = false) {
  const current = ++versionEpoch; versionController?.abort(); versionError.value = ''; versionLoading.value = false
  const chosen = version.value
  if (page.value !== 'trip' || !detail.value || !chosen || chosen.schemaVersion !== 2 || chosen.status === 'discarded') return
  const id = detail.value.trip.id; const key = `${chosen.id}:${chosen.artifactHash || ''}`
  if (!force && chosen.guide) return
  if (force) fullVersionCache.delete(key)
  const epoch = authEpoch; versionLoading.value = true; versionController = new AbortController()
  try {
    const result = await api<{version: Version}>(`/trips/${encodeURIComponent(id)}/versions/${encodeURIComponent(chosen.id)}`, {signal: versionController.signal})
    if (epoch !== authEpoch || current !== versionEpoch || page.value !== 'trip' || selectedTripId.value !== id || version.value?.id !== chosen.id || !detail.value) return
    if (result.version.id !== chosen.id || result.version.artifactHash !== chosen.artifactHash || !result.version.guide) throw new Error('本版完整研究资料暂不可用，或文件校验值已变化；请刷新状态后重试')
    fullVersionCache.delete(key); fullVersionCache.set(key, result.version)
    while (fullVersionCache.size > 2) fullVersionCache.delete(fullVersionCache.keys().next().value!)
    detail.value.versions = withCachedGuides(detail.value.versions, fullVersionCache)
  } catch (err) {
    if (epoch !== authEpoch || current !== versionEpoch) return
    if (err instanceof ApiError && err.status === 401) report(err)
    else versionError.value = err instanceof Error ? err.message : '无法读取完整研究资料'
  } finally { if (epoch === authEpoch && current === versionEpoch) versionLoading.value = false }
}
async function refreshTrip() {
  const epoch = authEpoch; const id = selectedTripId.value
  try { const result = await api<Settings>('/settings'); if (epoch === authEpoch) settings.value = result } catch (err) { if (epoch === authEpoch) report(err) }
  if (epoch === authEpoch && page.value === 'trip' && selectedTripId.value === id) await loadTrip(id)
}
function pollJob(job: Job, epoch: number) {
  stopPoll()
  pollTimer = setTimeout(async () => {
    if (epoch !== loadEpoch || page.value !== 'trip') return
    try {
      const result = await api<{job: Job}>(`/jobs/${encodeURIComponent(job.id)}`)
      if (epoch !== loadEpoch || !detail.value) return
      connectionIssue.value = false
      detail.value.jobs = detail.value.jobs.map(item => item.id === job.id ? result.job : item)
      if (['queued','running'].includes(result.job.status)) pollJob(result.job, epoch)
      else if (result.job.status === 'awaiting_outline') { /* Approval is always an explicit action. */ }
      else { const session = authEpoch; if (result.job.versionId) selectedVersionId.value = result.job.versionId; await loadTrip(job.tripId); if (session === authEpoch && result.job.status === 'succeeded') notify('完整手册已生成，请先人工审阅，再单独采用') }
    } catch (err) { if (epoch !== loadEpoch) return; if (err instanceof ApiError && [401,403,404].includes(err.status)) report(err); else { connectionIssue.value = true; pollJob(job, epoch) } }
  }, 2000)
}
async function generate() {
  const epoch = authEpoch
  if (!detail.value || busy.value || activeJob.value || !canGenerate.value) return
  if (detail.value.trip.currentVersionId && !regenerateRequest.value.trim()) { error.value = '请写下希望调整的内容'; return }
  const id = detail.value.trip.id
  const request = regenerateRequest.value.trim()
  const intent = JSON.stringify({id, request, mode: mode.value, revision: detail.value.trip.revision})
  const idempotencyKey = submissionKeys.get(intent) || newId(); submissionKeys.set(intent, idempotencyKey)
  busy.value = 'generate'; error.value = ''
  try {
    const result = await write<{job: Job}>(`/trips/${encodeURIComponent(id)}/jobs`, { request, mode: mode.value, idempotencyKey })
    if (epoch !== authEpoch) return
    submissionKeys.delete(intent)
    if (selectedTripId.value === id && page.value === 'trip' && detail.value) {
      detail.value.jobs = [result.job, ...detail.value.jobs.filter(j => j.id !== result.job.id)]
      if (['queued','running'].includes(result.job.status)) pollJob(result.job, loadEpoch); else await loadTrip(id)
    }
  } catch (err) { if (epoch !== authEpoch) return; if (err instanceof ApiError && err.status < 500) submissionKeys.delete(intent); report(err); if (selectedTripId.value === id && page.value === 'trip') await loadTrip(id) }
  finally { if (epoch === authEpoch) busy.value = '' }
}
async function cancelJob() {
  const epoch = authEpoch
  if (!activeJob.value || busy.value) return
  const job = activeJob.value; busy.value = 'cancel'
  try { await write(`/jobs/${job.id}/cancel`); if (epoch !== authEpoch) return; if (selectedTripId.value === job.tripId && page.value === 'trip') await loadTrip(job.tripId); if (epoch !== authEpoch) return; notify(job.mode === 'live' ? '已请求取消；已经发出的外部请求可能仍产生费用' : '演示任务已取消；当前手册未改变') } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function approveOutline(approval: { jobId: string; outlineHash: string; outlineVersion: number }) {
  if (busy.value || !detail.value || activeJob.value?.id !== approval.jobId || activeJob.value.status !== 'awaiting_outline') return
  const epoch = authEpoch; const id = detail.value.trip.id; busy.value = 'approve-outline'; error.value = ''
  try {
    await write(`/jobs/${encodeURIComponent(approval.jobId)}/approve-outline`, { outlineHash: approval.outlineHash, outlineVersion: approval.outlineVersion })
    if (epoch !== authEpoch) return
    if (selectedTripId.value === id && page.value === 'trip') await loadTrip(id)
    notify('已确认这份大纲，开始制作完整手册；当前采用版本未改变')
  } catch (err) {
    if (epoch !== authEpoch) return
    report(err)
    if (err instanceof ApiError && err.status === 409 && selectedTripId.value === id && page.value === 'trip') { await loadTrip(id); error.value = '大纲状态已变化，已刷新。请重新检查当前大纲后再确认。' }
  } finally { if (epoch === authEpoch) busy.value = '' }
}
async function resumeJob(acknowledgePossibleCharge: boolean) {
  if (busy.value || !pipelineJob.value || pipelineJob.value.status !== 'failed') return
  const epoch = authEpoch; const job = pipelineJob.value; busy.value = 'resume'; error.value = ''
  try {
    await write(`/jobs/${encodeURIComponent(job.id)}/resume`, { acknowledgePossibleCharge })
    if (epoch !== authEpoch) return
    if (selectedTripId.value === job.tripId && page.value === 'trip') await loadTrip(job.tripId)
    notify('任务已从可用检查点恢复，尚未确认的大纲仍需你确认')
  } catch (err) { if (epoch === authEpoch) { report(err); if (selectedTripId.value === job.tripId && page.value === 'trip') await loadTrip(job.tripId) } }
  finally { if (epoch === authEpoch) busy.value = '' }
}
async function reviewAssets(review: AssetReviewRequest) {
  if (busy.value || activeJob.value || !detail.value || version.value?.id !== review.versionId) return
  const epoch = authEpoch; const id = detail.value.trip.id
  const intent = JSON.stringify({ type: 'asset-review', id, ...review })
  const idempotencyKey = submissionKeys.get(intent) || newId(); submissionKeys.set(intent, idempotencyKey)
  busy.value = 'review-assets'; error.value = ''
  try {
    const result = await write<{job: Job}>(`/trips/${encodeURIComponent(id)}/versions/${encodeURIComponent(review.versionId)}/review-assets`, { artifactHash: review.artifactHash, idempotencyKey, reviews: review.reviews, ...(review.coverAssetId ? {coverAssetId: review.coverAssetId} : {}) })
    if (epoch !== authEpoch) return
    submissionKeys.delete(intent)
    if (selectedTripId.value === id && page.value === 'trip' && detail.value) { detail.value.jobs = [result.job, ...detail.value.jobs.filter(job => job.id !== result.job.id)]; if (['queued', 'running'].includes(result.job.status)) pollJob(result.job, loadEpoch); else await loadTrip(id) }
    notify('素材检查已保存，正在重新编译独立候选；旧文件和当前采用版本不变')
  } catch (err) { if (epoch === authEpoch) { if (err instanceof ApiError && err.status < 500) submissionKeys.delete(intent); report(err) } }
  finally { if (epoch === authEpoch) busy.value = '' }
}
async function reviewVersion(review: { versionId: string; artifactHash: string; checks: ReviewChecks; note: string }) {
  if (busy.value || !detail.value || !versionReady.value || version.value?.id !== review.versionId) return
  const epoch = authEpoch; const id = detail.value.trip.id; busy.value = 'review'; error.value = ''
  try {
    await write(`/trips/${encodeURIComponent(id)}/versions/${encodeURIComponent(review.versionId)}/review`, { artifactHash: review.artifactHash, checks: review.checks, note: review.note })
    if (epoch !== authEpoch) return
    if (selectedTripId.value === id && page.value === 'trip') await loadTrip(id)
    notify('本文件的人工审阅已保存。采用这一版仍需单独确认')
  } catch (err) { if (epoch === authEpoch) report(err) }
  finally { if (epoch === authEpoch) busy.value = '' }
}
async function changeVersion(action: 'adopt' | 'discard', chosen = version.value) {
  const epoch = authEpoch
  if (!chosen || !detail.value || busy.value) return
  if (action === 'adopt' && (!versionReady.value || requiresManualReview(chosen))) { error.value = '请先检查本版完整手册并保存人工审阅记录，再采用'; return }
  const id = detail.value.trip.id; busy.value = action; error.value = ''
  try { await write(`/trips/${encodeURIComponent(id)}/versions/${encodeURIComponent(chosen.id)}/${action}`, action === 'adopt' ? {expectedRevision: detail.value.trip.revision, ...(chosen.schemaVersion === 2 && chosen.status === 'candidate' && chosen.guide?.qa.handoffAllowed !== true ? {acknowledgePartial: true} : {})} : {}); if (epoch !== authEpoch) return; if (selectedTripId.value === id && page.value === 'trip') { if (action === 'discard') selectedVersionId.value = ''; await loadTrip(id) }; if (epoch !== authEpoch) return; notify(action === 'adopt' ? `已采用第 ${chosen.number} 版${chosen.schemaVersion === 2 && chosen.guide?.qa.handoffAllowed !== true ? '，未验证标记保留' : '，历史版本仍保留'}` : '草案已舍弃，当前手册未改变') }
  catch (err) { if (epoch !== authEpoch) return; if (err instanceof ApiError && err.status === 409 && selectedTripId.value === id && page.value === 'trip') { await loadTrip(id); if (epoch !== authEpoch) return; error.value = '手册已在另一个页面更新，已刷新至最新状态。请重新查看后操作。' } else report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function exportTrip(format: 'json' | 'html') {
  const epoch = authEpoch
  if (!detail.value || !version.value || busy.value) return; busy.value = 'export'
  try { await downloadExport(detail.value.trip.id, version.value.id, format, () => epoch === authEpoch); if (epoch !== authEpoch) return; notify(format === 'html' ? 'HTML 手册已下载，可离线打开或打印为 PDF' : 'JSON 手册已下载') } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
function changeProvider() {
  model.apiKey = ''
  if (model.provider === 'openai') { model.baseUrl = 'https://api.openai.com/v1'; model.model = 'gpt-4.1-mini' }
  else if (model.provider === 'deepseek') { model.baseUrl = 'https://api.deepseek.com'; model.model = 'deepseek-flash' }
  else { model.baseUrl = ''; model.model = '' }
}
async function saveSettings() {
  const epoch = authEpoch
  if (busy.value) return
  if ((!settings.value?.hasApiKey || settings.value.provider !== model.provider || settings.value.baseUrl !== model.baseUrl) && !model.apiKey.trim()) { error.value = '首次设置或更换服务商 / 地址时，请输入对应的 API Key'; return }
  busy.value = 'settings'; error.value = ''
  try { await write('/settings', {...model, apiKey: model.apiKey.trim() || undefined}, 'PUT'); if (epoch !== authEpoch) return; model.apiKey = ''; await loadSettings(epoch); if (epoch !== authEpoch) return; notify('模型设置已保存；仅在点击生成时调用模型') } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function deleteKey() {
  const epoch = authEpoch
  if (busy.value) return; busy.value = 'delete-key'; error.value = ''
  try { await write('/settings/key', {}, 'DELETE'); if (epoch !== authEpoch) return; model.apiKey = ''; await loadSettings(epoch); if (epoch !== authEpoch) return; notify('API Key 已删除') } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function loadAdmin() {
  const epoch = authEpoch
  loading.value = true
  try { const [users, stats] = await Promise.all([api<{users:AdminUser[]}>('/admin/users'), api<AdminOverview>('/admin/overview')]); if (epoch !== authEpoch) return; adminUsers.value = users.users; overview.value = stats } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) loading.value = false }
}
async function toggleUser(row: AdminUser) {
  const epoch = authEpoch
  if (busy.value || row.id === user.value?.id) return; busy.value = `user-${row.id}`
  try { await write(`/admin/users/${encodeURIComponent(row.id)}`, {status: row.status === 'active' ? 'disabled' : 'active'}, 'PATCH'); if (epoch !== authEpoch) return; await loadAdmin(); if (epoch !== authEpoch) return; notify(row.status === 'active' ? '用户已停用' : '用户已启用') } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' }
}
async function createInvite() { if (busy.value) return; const epoch = authEpoch; busy.value = 'invite'; try { const result = await write<{inviteCode:string;expiresAt:string}>('/admin/invites'); if (epoch !== authEpoch) return; invite.value = result; notify('邀请码已创建，请及时复制，仅展示这一次') } catch (err) { if (epoch === authEpoch) report(err) } finally { if (epoch === authEpoch) busy.value = '' } }
async function copyInvite() { if (!invite.value) return; try { await navigator.clipboard.writeText(invite.value.inviteCode); notify('邀请码已复制') } catch { notify('浏览器无法自动复制，请选中邀请码手动复制') } }
function routeChange() { if (user.value) void readRoute() }
watch(() => `${page.value}:${selectedTripId.value}:${version.value?.id || ''}:${version.value?.artifactHash || ''}`, () => { void loadSelectedVersion() })
watch(authMode, () => { error.value = ''; auth.password = '' })
onMounted(() => { window.addEventListener('hashchange', routeChange); void boot() })
onBeforeUnmount(() => { versionEpoch++; versionController?.abort(); stopPoll(); clearTimeout(toastTimer); window.removeEventListener('hashchange', routeChange) })
</script>

<template>
  <div v-if="booting" class="boot-screen"><span class="brand-icon"><Icon name="compass" :size="30"/></span><strong>旅页 <span>Travelfolio</span></strong><div class="loading-line"></div><p>把下一程，慢慢展开</p></div>
  <div v-else-if="bootError" class="boot-screen"><Icon name="info" :size="34"/><h1>暂时无法连接服务</h1><p>{{ bootError }}</p><button class="button primary" @click="boot">重新连接</button></div>
  <main v-else-if="!user" class="auth-layout">
    <section class="auth-story"><a href="#/trips" class="brand"><span class="brand-icon"><Icon name="compass" :size="25"/></span><span>旅页<small>TRAVELFOLIO</small></span></a><div class="auth-story-content"><span class="eyebrow">LESS PLANNING. MORE WANDERING.</span><h1>世界很大，<br/>从容出发。</h1><p>把零散的灵感，整理成一份属于你的旅行手册。<br/>路线、预算、每一天，都心里有数。</p><div class="auth-landscape" aria-hidden="true"><svg viewBox="0 0 560 290" fill="none"><circle cx="419" cy="70" r="38" fill="#dcb76e"/><path d="M0 203 131 66l134 141L385 91l175 137v62H0Z" fill="#9cae9e"/><path d="m54 207 136-97 144 149 112-120 114 82v69H0Z" fill="#577d71"/><path d="M0 247c120-68 160 46 297-16 93-42 135-20 263 27v32H0Z" fill="#244f48"/><path d="M155 285c0-44 186-7 154-67s-56-58-34-101" stroke="#eee2bc" stroke-width="4" stroke-dasharray="7 8"/><circle cx="274" cy="112" r="8" fill="#f5f0df"/><circle cx="274" cy="112" r="3" fill="#244f48"/><path d="m54 62 14 6 6-14 3 17 15 3-18 4-7 14-2-18-11-12Z" fill="#567e73"/></svg><span class="landscape-caption">THE JOURNEY IS YOURS.</span></div></div><div class="auth-story-footer"><span>你的灵感 · 你的模型 · 你的旅程</span><span>EST. 2026</span></div></section>
    <section class="auth-panel"><div class="auth-card"><span class="auth-kicker">很高兴，在这里遇见你</span><h2>{{ authMode === 'login' ? '欢迎回到旅页' : '开启你的旅行手册' }}</h2><p class="muted">{{ authMode === 'login' ? '下一段值得期待的旅程，等你翻开。' : '这是一个邀请制空间，请使用管理员提供的邀请码。' }}</p><div class="auth-tabs"><button :class="{active: authMode === 'login'}" @click="authMode = 'login'">登录</button><button :class="{active: authMode === 'register'}" @click="authMode = 'register'">邀请注册</button></div><form @submit.prevent="submitAuth"><label>邮箱地址<div class="input-icon"><Icon name="mail" :size="18"/><input v-model="auth.email" type="email" autocomplete="username" placeholder="you@example.com" required maxlength="254"/></div></label><label>密码<div class="input-icon"><Icon name="lock" :size="18"/><input v-model="auth.password" type="password" :autocomplete="authMode === 'login' ? 'current-password' : 'new-password'" :minlength="authMode === 'register' ? 12 : 1" maxlength="128" placeholder="输入你的密码" required/></div><small v-if="authMode === 'register'" class="field-note">至少 12 个字符，建议使用独特的长密码</small></label><label v-if="authMode === 'register'">邀请码<input v-model="auth.inviteCode" autocomplete="off" placeholder="由管理员提供" required maxlength="200"/></label><p v-if="error" class="inline-error" role="alert">{{ error }}</p><button class="button primary full-width" :disabled="!!busy">{{ busy ? '请稍候…' : authMode === 'login' ? '登录，继续旅程' : '创建账号' }}<Icon name="arrow" :size="18"/></button></form><div class="auth-privacy"><Icon name="shield" :size="16"/><span>私人旅行空间 · 自带模型密钥 · 无需共享账号</span></div></div><p class="auth-bottom">让计划轻一点，让体验多一点。</p></section>
  </main>
  <div v-else class="app-shell">
    <button v-if="mobileNav" class="nav-scrim" aria-label="关闭导航" @click="mobileNav = false"></button>
    <aside class="sidebar" :class="{open: mobileNav}"><a href="#/trips" class="brand"><span class="brand-icon"><Icon name="compass" :size="25"/></span><span>旅页<small>TRAVELFOLIO</small></span></a><button class="button primary new-trip-button" @click="navigate('new')"><Icon name="plus" :size="18"/>计划新旅行</button><span class="nav-label">你的旅行空间</span><nav aria-label="主导航"><a href="#/trips" :class="{active: ['trips','trip','new'].includes(page)}"><Icon name="grid"/>我的旅行<span class="nav-count">{{ trips.length }}</span></a><a href="#/settings" :class="{active: page === 'settings'}"><Icon name="settings"/>模型设置</a><a v-if="user.role === 'admin'" href="#/admin" :class="{active: page === 'admin'}"><Icon name="shield"/>管理控制台</a></nav><div class="sidebar-note"><span class="tiny-compass">✳</span><p>好的旅行计划，<br/>也为意外留一页。</p><span>MAKE ROOM FOR WONDER</span></div><div class="sidebar-profile"><span class="avatar">{{ user.email[0].toUpperCase() }}</span><div><strong>{{ user.email.split('@')[0] }}</strong><small>{{ user.role === 'admin' ? '管理员' : '旅行者' }}</small></div><button class="icon-button" aria-label="退出登录" title="退出登录" :disabled="!!busy" @click="logout"><Icon name="logout" :size="18"/></button></div></aside>
    <div class="app-main"><header class="topbar"><div><button class="icon-button mobile-menu" aria-label="打开导航" @click="mobileNav = true"><Icon name="menu"/></button><span class="breadcrumb">你的旅行空间<span>/</span><strong>{{ pageTitle }}</strong></span></div><span class="topbar-note"><span class="status-dot"></span>每一程，心里有数</span></header>
    <main id="main-content" class="main-content" tabindex="-1"><div v-if="error" class="notice notice-error global-error" role="alert"><Icon name="info"/><p>{{ error }}</p><button class="icon-button" aria-label="关闭错误提示" @click="error = ''"><Icon name="close" :size="16"/></button></div>
      <section v-if="page === 'trips'"><header class="page-heading overview-heading"><div><span class="eyebrow">COLLECT MOMENTS, NOT THINGS</span><h1>总有一程，值得期待</h1><p>你的旅行灵感，都在这里慢慢成形。</p></div><span class="edition-mark">YOUR PERSONAL<br/>TRAVEL COLLECTION</span></header><section class="overview-hero"><div class="hero-copy"><span class="hero-tag"><Icon name="spark" :size="14"/>灵感到出发，一页就够</span><h2>下一站，<br/>想去哪里走走？</h2><p>告诉旅页目的地与期待，<br/>把琐碎的规划，变成清晰的旅程。</p><button class="button primary" @click="navigate('new')">开启一段新旅程<Icon name="arrow" :size="18"/></button></div><div class="hero-art" aria-hidden="true"><svg viewBox="0 0 470 330" fill="none"><circle cx="237" cy="164" r="132" fill="#e5e8d8"/><circle cx="237" cy="164" r="132" stroke="#c9d3bd" stroke-dasharray="3 9"/><path d="M143 219c-58-20-53-65-19-92 40-31 68-11 91-39 43-52 132 26 113 74-17 42-82 10-78 60 5 60 102 25 111-7" stroke="#759a87" stroke-width="2" stroke-dasharray="6 7"/><g transform="rotate(-11 235 160)"><rect x="163" y="69" width="151" height="212" rx="7" fill="#284e46"/><rect x="170" y="64" width="151" height="211" rx="7" fill="#fffdf4" stroke="#d7d4c6"/><rect x="180" y="76" width="130" height="116" rx="2" fill="#e1e9dd"/><circle cx="275" cy="103" r="14" fill="#d2ae67"/><path d="m180 167 41-55 42 49 22-28 25 34v25H180Z" fill="#92ab93"/><path d="m180 182 49-34 43 36 38-17v25H180Z" fill="#3d6b58"/><path d="M190 218h91M190 231h71M190 244h45" stroke="#c1c6b6" stroke-width="3" stroke-linecap="round"/><text x="190" y="209" font-size="8" letter-spacing="2" fill="#325a4e">THE NEXT CHAPTER</text></g><rect x="87" y="206" width="119" height="42" rx="6" fill="#fffdf6" stroke="#dedfd2"/><circle cx="110" cy="227" r="11" fill="#e1ede5"/><path d="m105 227 3 3 6-7" stroke="#356b58" stroke-width="2"/><path d="M130 221h59M130 231h41" stroke="#b7c4b4" stroke-width="3"/><path d="m335 70 12 23 28 2-21 17 6 28-23-15-24 14 7-28-20-19 27-1Z" fill="#d6b879"/><path d="m95 82 13 7-1-20 7 4 4 24 15 9c10 6 5 12-5 7l-16-8-23 10-6-4 15-13-16-7-6 3-5-3 9-10 15 1Z" fill="#618678"/></svg><div class="hero-stamp">PLAN A LITTLE.<br/>LIVE A LOT.</div></div></section>
      <div class="collection-heading"><h2>我的旅行手册 <span>{{ trips.length }}</span></h2><span class="muted small">{{ adoptedCount }} 份已采用 · 按最近更新排列</span></div><div v-if="trips.length" class="trip-grid"><button v-for="(trip,index) in trips" :key="trip.id" class="trip-card" @click="navigate('trip',trip.id)"><div class="trip-card-art" :class="`art-${index % 3}`"><div class="art-sun"></div><div class="art-mountain back"></div><div class="art-mountain front"></div><div class="art-path"></div><span class="trip-card-status">{{ trip.currentVersionId ? '手册已就绪' : '等待编排' }}</span><span class="trip-art-word">{{ trip.constraints.destination }}</span></div><div class="trip-card-body"><div class="trip-title-row"><h3>{{ trip.title || trip.constraints.destination }}</h3><Icon name="arrow" :size="18"/></div><p><Icon name="calendar" :size="14"/>{{ dateLabel(trip.constraints.startDate) }} — {{ dateLabel(trip.constraints.endDate) }}<span>· {{ dayCount(trip.constraints.startDate,trip.constraints.endDate) }} 天</span></p><div class="trip-card-footer"><span><Icon name="people" :size="14"/>{{ trip.constraints.people }} 人同行</span><strong>{{ money(trip.constraints.budget,trip.constraints.currency) }}<small>总预算</small></strong></div></div></button><button class="new-trip-card" @click="navigate('new')"><span><Icon name="plus" :size="28"/></span><h3>再添一段期待</h3><p>下一页，写下新的目的地</p></button></div><div v-else class="empty-collection"><div class="empty-icon"><Icon name="book" :size="32"/></div><h3>你的第一本旅行手册，还差一个目的地</h3><p>创建旅行后，每次调整和历史版本都会保留在这里。</p><button class="text-button" @click="navigate('new')">开始计划<Icon name="arrow" :size="16"/></button></div><footer class="page-footer"><span>TRAVELFOLIO / 为每一段旅程留一页</span><span>TAKE THE SCENIC ROUTE.</span></footer></section>
      <TripWizard v-else-if="page === 'new'" ref="wizard" :user-id="user.id" :busy="busy === 'create'" @create="createTrip" @close="navigate('trips')"/>
      <section v-else-if="page === 'trip'" class="trip-page"><div class="page-topline"><button class="text-button" @click="navigate('trips')">← 我的旅行</button><button class="text-button" :disabled="loading" @click="refreshTrip"><Icon name="history" :size="15"/>刷新状态</button></div><div v-if="loading" class="loading-card"><div class="spinner"></div><p>正在展开旅行手册…</p></div><template v-else-if="detail"><header class="page-heading trip-heading"><div><span class="eyebrow">{{ detail.trip.constraints.departure }} → {{ detail.trip.constraints.destination }}</span><h1>{{ detail.trip.title || detail.trip.constraints.destination }}</h1><div class="trip-facts"><span><Icon name="calendar" :size="16"/>{{ detail.trip.constraints.startDate }} — {{ detail.trip.constraints.endDate }}</span><span><Icon name="people" :size="16"/>{{ detail.trip.constraints.people }} 人</span><span><Icon name="wallet" :size="16"/>{{ money(detail.trip.constraints.budget,detail.trip.constraints.currency) }} 总预算</span></div></div><div class="trip-header-actions"><button class="button secondary compact" @click="historyOpen = !historyOpen"><Icon name="history" :size="16"/>版本 {{ detail.versions.length }}</button><div v-if="version" class="export-buttons"><button class="button secondary compact" :disabled="!!busy" @click="exportTrip('html')"><Icon name="download" :size="15"/>HTML</button><button class="button secondary compact" :disabled="!!busy" @click="exportTrip('json')">JSON</button></div></div></header>
      <section v-if="historyOpen" class="card history-panel"><div class="section-heading"><div><span class="eyebrow">EVERY VERSION COUNTS</span><h3>每一次调整，都有迹可循</h3></div><button class="icon-button" aria-label="关闭版本历史" @click="historyOpen = false"><Icon name="close"/></button></div><p class="muted small">查看旧版后可重新采用；不会删除更新的版本。版本切换会检查最新修订号。</p><p v-if="!detail.versions.length" class="muted">还没有生成过版本。</p><div v-for="item in [...detail.versions].sort((a,b) => b.number-a.number)" :key="item.id" class="history-row" :class="{selected: item.id === version?.id}"><div class="history-version">V{{ String(item.number).padStart(2,'0') }}</div><div><strong>{{ versionLabel(item) }} <span v-if="item.content.verification.mode === 'demo'" class="badge amber">演示</span></strong><p>{{ item.request || '初次生成' }}</p><small>{{ dateTime(item.createdAt) }}</small></div><button class="button secondary compact" @click="selectedVersionId = item.id">查看</button></div></section>
      <div v-if="connectionIssue" class="notice notice-amber"><Icon name="info"/><p>连接暂时中断，正在恢复状态查询。任务仍保存在服务器，请勿重复发起生成。</p></div><GenerationPipeline v-if="pipelineJob" :job="pipelineJob" :version="detail?.versions.find(item => item.id === pipelineJob?.versionId)" :busy="!!busy" :provider="settings?.provider" :search-available="settings?.searchAvailable" @cancel="cancelJob" @approve="approveOutline" @resume="resumeJob"/>
      <div v-if="detail.trip.currentVersionId && !isCurrentVersion" class="notice notice-blue"><Icon name="book"/><p>当前采用的手册仍是第 {{ detail.versions.find(item => item.id === detail?.trip.currentVersionId)?.number }} 版。研究、生成与审阅均不会自动替换它。</p><button class="text-button" @click="selectedVersionId = detail!.trip.currentVersionId!">查看当前手册</button></div>
      <div v-if="version" class="version-toolbar"><div><span class="version-number">V{{ String(version.number).padStart(2,'0') }}</span><strong>{{ versionLabel(version) }}</strong><span v-if="version.content.verification.mode === 'demo'" class="badge amber">演示</span><span v-if="candidates.length > 1" class="muted small">另有 {{ candidates.length-1 }} 份草案，可在版本历史中查看</span></div><div><button v-if="version.status === 'candidate'" class="text-button danger" :disabled="!!busy" @click="changeVersion('discard')">舍弃草案</button><button v-if="!isCurrentVersion && version.status !== 'discarded'" class="button primary compact" :disabled="!!busy || versionLoading || !versionReady || requiresManualReview(version)" :title="requiresManualReview(version) ? '请先完成本文件的人工审阅' : undefined" @click="changeVersion('adopt')"><Icon name="check" :size="16"/>{{ version.status === 'candidate' ? version.schemaVersion === 2 && version.guide?.qa.handoffAllowed !== true ? '采用这一版（保留未验证标记）' : '采用这一版' : '回滚到这一版' }}</button><span v-if="isCurrentVersion" class="adopted-label"><Icon name="check" :size="15"/>当前旅行手册</span></div></div>
      <p v-if="versionLoading" class="notice notice-blue" role="status">正在按需读取所选版本的研究证据与素材，历史版本不会全部载入。</p>
      <div v-if="versionError" class="notice notice-error" role="alert"><p>{{ versionError }}。资料载入前不能完成审阅或采用。</p><button class="button secondary compact" @click="loadSelectedVersion(true)">重试读取本版资料</button></div>
      <div v-if="version?.schemaVersion === 2 && version.guide && version.guide.qa.handoffAllowed !== true" class="notice notice-amber"><Icon name="info"/><p>本版尚未达到完整交付门槛。图片、地图、浏览器或离线检查仍可能缺失；人工审阅与采用不会把这些状态变为已验证。选择采用即表示接受当前披露的限制，未验证标记会保留。</p></div>
      <GuideEvidence v-if="version?.guide" :guide="version.guide"/>
      <AssetReview v-if="version?.guide && version.status === 'candidate'" :version="version" :busy="!!busy" :active-job="!!activeJob" @review="reviewAssets"/>
      <ArtifactPreview v-if="version?.schemaVersion === 2 && version.status !== 'discarded'" :key="`${detail.trip.id}:${version.id}`" :trip-id="detail.trip.id" :version="version" :busy="!!busy || versionLoading || !versionReady" @review="reviewVersion" @error="report"/>
      <Handbook v-else-if="version" :version="version" :constraints="detail.trip.constraints"/>
      <div v-else-if="!activeJob" class="card generation-empty"><div class="empty-icon"><Icon name="spark" :size="34"/></div><span class="eyebrow">YOUR JOURNEY STARTS HERE</span><h2>旅行的轮廓有了，<br/>让每一天也清晰起来。</h2><p>先生成可审阅的行程大纲，确认后才开展研究与完整编译。<br/>八章手册还需人工检查，最后单独采用才会更新当前版本。</p></div>
      <section v-if="!activeJob" class="card generate-card"><div><span class="eyebrow">{{ detail.trip.currentVersionId ? 'MAKE IT MORE YOU' : 'TURN AN IDEA INTO AN ITINERARY' }}</span><h3>{{ detail.trip.currentVersionId ? '想调整什么？' : '选择一种方式，开始规划' }}</h3><p class="muted small">{{ detail.trip.currentVersionId ? '以当前已采用的版本为基础先生成调整大纲。确认大纲、审阅手册和采用版本是三个独立步骤。' : '先查看并确认行程大纲，再开始完整手册。建议用演示模式熟悉流程。' }}</p></div><label v-if="detail.trip.currentVersionId" class="regenerate-label">调整要求<textarea v-model="regenerateRequest" rows="3" maxlength="2000" placeholder="例如：第二天轻松一点，增加一间咖啡馆，把总预算控制在 6000 元以内" :disabled="!!busy"/></label><div class="generation-options"><div class="mode-selector"><label v-if="settings?.demoEnabled" :class="{selected: mode === 'demo'}"><input v-model="mode" type="radio" value="demo" :disabled="!!busy"/><span><strong>演示模式</strong><small>虚构示例 · 不调用模型</small></span></label><label :class="{selected: mode === 'live'}"><input v-model="mode" type="radio" value="live" :disabled="!!busy"/><span><strong>真实 AI 生成</strong><small>使用你的模型 · 按服务商计费</small></span></label></div><button class="button primary" :disabled="!!busy || !canGenerate" @click="generate"><Icon name="spark" :size="17"/>{{ busy === 'generate' ? '正在提交…' : detail.trip.currentVersionId ? '生成调整大纲' : '生成行程大纲' }}</button></div><div v-if="mode === 'live'" class="generation-disclosure"><Icon name="shield" :size="16"/><p>点击生成大纲即将目的地、日期、人数、预算、偏好、排除事项及调整要求（重新生成还包括当前已采用手册）发送至你配置的 {{ settings?.provider }} 模型服务商；大纲调用可能产生费用；完整研究与生成需要你另行确认大纲后才开始。{{ settings?.searchAvailable ? '已配置 Brave Search，目的地与日期会用于搜索查询并发送至该服务商。' : '当前未配置必需的 Brave Search 服务；可先生成大纲，但完整研究暂不能继续。' }}<a v-if="!settings?.hasApiKey" href="#/settings">请先配置 API Key →</a></p></div><p v-else class="field-note">演示内容专为体验流程生成，所有行程与价格均需重新核实，不能作为真实旅行建议。</p></section></template><div v-else class="empty-collection"><h2>暂时无法读取这份旅行</h2><button class="button secondary" @click="navigate('trips')">返回我的旅行</button></div></section>
      <section v-else-if="page === 'settings'" class="settings-page"><header class="page-heading"><span class="eyebrow">YOUR MODEL, YOUR CHOICE</span><h1>让旅页，用你信任的模型</h1><p>自带 API Key，连接 OpenAI 兼容接口。只在你明确发起大纲或确认后续生成时调用。</p></header><div class="settings-layout"><form class="card settings-form" @submit.prevent="saveSettings"><div class="section-heading"><h3>模型连接</h3><span class="badge" :class="settings?.hasApiKey ? 'green' : 'neutral'">{{ settings?.hasApiKey ? '已保存密钥' : '尚未配置' }}</span></div><label>服务商<select v-model="model.provider" @change="changeProvider"><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="custom">自定义兼容服务</option></select></label><label>API Base URL<input v-model="model.baseUrl" :readonly="model.provider !== 'custom'" type="url" placeholder="https://api.example.com/v1" required maxlength="500" spellcheck="false"/><small class="field-note">仅支持公开 HTTPS 地址，不允许本机、内网或带用户名密码的地址。</small></label><label>模型名称<input v-model="model.model" placeholder="例如 gpt-4.1-mini / deepseek-flash" required maxlength="120" spellcheck="false"/><small class="field-note">完整研究包含较长的结构化输出。自定义模型与兼容网关需要支持相应的输出 token 上限（研究步骤最高 24,000）；不支持时请调整模型，不能把截断内容视为有效结果。</small></label><label>API Key<div class="input-icon"><Icon name="lock" :size="18"/><input v-model="model.apiKey" type="password" autocomplete="new-password" :placeholder="settings?.hasApiKey ? '已保存，留空保留原密钥' : '粘贴该服务商提供的密钥'" maxlength="1000" spellcheck="false"/></div><small class="field-note">密钥不会回传到浏览器。更换服务商或 API 地址后需要重新填写。</small></label><div class="notice notice-blue"><Icon name="shield"/><div><strong>生成前，先知道信息会去哪里</strong><p>真实生成会将旅行信息发送至上面配置的服务商。请确认你信任该地址，了解对方的数据政策与 API 费用。不必在偏好中输入敏感个人信息。</p></div></div><div class="form-actions"><button type="button" class="text-button danger" :disabled="!!busy || !settings?.hasApiKey" @click="deleteKey">删除已存密钥</button><button class="button primary" :disabled="!!busy">{{ busy === 'settings' ? '保存中…' : '保存设置' }}<Icon name="check" :size="17"/></button></div></form><aside><div class="card settings-note"><Icon name="compass" :size="32"/><h3>连上模型，<br/>保留自己的节奏。</h3><p>设置保存不代表连接验证通过。首次生成时会检查服务商响应；失败不会自动重试付费请求。</p><hr/><div class="capability"><span>演示体验</span><strong>{{ settings?.demoEnabled ? '已开启' : '部署未开启' }}</strong></div><div class="capability"><span>搜索服务</span><strong>{{ settings?.searchAvailable ? '已配置' : '未配置' }}</strong></div><p class="tiny">搜索由部署管理员配置，即使使用搜索资料也不保证票务库存、天气或营业时间已确认。</p></div></aside></div></section>
      <section v-else-if="page === 'admin' && user.role === 'admin'"><header class="page-heading overview-heading"><div><span class="eyebrow">A LITTLE HOUSEKEEPING</span><h1>管理控制台</h1><p>管理邀请与访问权限，查看系统的运行概况。</p></div><button class="button secondary compact" :disabled="loading" @click="loadAdmin"><Icon name="history" :size="16"/>刷新</button></header><div v-if="overview" class="admin-stats"><div v-for="(label,key) in {users:'用户',trips:'旅行',queued:'排队中',running:'生成中',failed:'失败任务'}" :key="key" class="card stat-card"><span>{{ label }}</span><strong>{{ overview.counts[key] }}</strong></div></div><section class="card admin-users"><div class="section-heading"><div><span class="eyebrow">PEOPLE & ACCESS</span><h3>用户与邀请</h3></div><button class="button primary compact" :disabled="!!busy" @click="createInvite"><Icon name="plus" :size="16"/>创建邀请码</button></div><div v-if="invite" class="invite-box"><div><strong>邀请码仅在本次显示，请及时保存</strong><p class="invite-code">{{ invite.inviteCode }}</p><small>有效期至 {{ dateTime(invite.expiresAt) }}</small></div><button class="button secondary compact" @click="copyInvite">复制</button></div><div class="table-scroll"><table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="row in adminUsers" :key="row.id"><td>{{ row.email }}<small>{{ dateTime(row.createdAt) }} 加入</small></td><td>{{ row.role === 'admin' ? '管理员' : '旅行者' }}</td><td><span class="badge" :class="row.status === 'active' ? 'green' : 'neutral'">{{ row.status === 'active' ? '启用' : '已停用' }}</span></td><td><span v-if="row.id === user.id" class="muted small">当前账号</span><span v-else-if="row.role === 'admin'" class="muted small">管理员受保护</span><button v-else class="text-button" :class="{danger: row.status === 'active'}" :disabled="!!busy" @click="toggleUser(row)">{{ row.status === 'active' ? '停用' : '重新启用' }}</button></td></tr></tbody></table></div></section><section class="card failure-card"><div class="section-heading"><div><span class="eyebrow">SYSTEM HEALTH</span><h3>近期失败任务</h3></div><Icon name="shield"/></div><p class="muted small">仅显示运行元信息，不提供他人的旅行内容、密钥或原始错误响应。</p><p v-if="!overview?.failures.length" class="success-empty"><Icon name="check" :size="18"/>暂无失败记录</p><div v-for="failure in overview?.failures" :key="failure.id" class="failure-row"><div><strong>{{ failure.errorCode }}</strong><small>任务 {{ failure.id }} · 用户 {{ failure.userId }}</small></div><span class="muted small">{{ dateTime(failure.createdAt) }}</span></div></section></section>
    </main></div>
  </div>
  <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><Icon name="check" :size="17"/>{{ toast }}</div></Transition>
</template>

