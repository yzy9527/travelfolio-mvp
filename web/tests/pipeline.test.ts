import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ViteDevServer } from 'vite'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import type { Job, Version } from '../src/lib/types'
import { jobHeading, pendingJob, requiresChargeAcknowledgment, requiresManualReview, withCachedGuides } from '../src/lib/utils'
let server: ViteDevServer
let Pipeline: Component
let Evidence: Component
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, logLevel: 'silent' })
  Pipeline = (await server.ssrLoadModule('/src/components/GenerationPipeline.vue')).default
  Evidence = (await server.ssrLoadModule('/src/components/GuideEvidence.vue')).default
})
after(async () => { await server?.close() })
const job = (patch: Partial<Job> = {}): Job => ({ id: 'job-1', tripId: 'trip-1', status: 'awaiting_outline', stage: 'outline', mode: 'demo', request: '', versionId: null, errorCode: null, errorMessage: null, createdAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:01:00Z', outlineHash: 'a'.repeat(64), outlineVersion: 2, checkpoints: [{ stage: 'outline', status: 'complete', updatedAt: '2026-09-30T10:01:00Z' }], outline: { title: '京都大纲', summary: '沿河与旧城', days: [{ date: '2026-10-10', title: '东山与鸭川', focus: '先散步后晚餐', pace: '舒缓', areas: ['东山', '鸭川'] }], assumptions: ['航班待确认'], openQuestions: ['酒店地址待补充'], changedPacks: ['itinerary'] }, ...patch })
const render = (data = job()) => renderToString(createSSRApp(Pipeline, { job: data, busy: false, provider: 'openai' }))
describe('outline-first workflow', () => {
  it('treats awaiting approval as active and does not queue full generation', () => {
    assert.equal(pendingJob([job()])?.id, 'job-1')
    assert.equal(jobHeading(job()), '大纲已就绪，等你确认')
  })
  it('renders actual outline, assumptions, pending information and exact version/hash', async () => {
    const html = await render()
    for (const text of ['京都大纲', '东山与鸭川', '先散步后晚餐', '航班待确认', '酒店地址待补充', '大纲版本 2', 'a'.repeat(64), '尚未开始', '确认此大纲，生成完整手册']) assert.ok(html.includes(text), text)
    assert.match(html, /<button[^>]*disabled[^>]*>[^]*?确认此大纲，生成完整手册/)
    assert.ok(!html.includes('checked'))
  })
  it('escapes model-authored outline content', async () => {
    const data = job(); data.outline!.summary = '<img src=x onerror=alert(1)>'
    const html = await render(data)
    assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img src=x'))
  })
  it('does not present future stages as completed or invent percent progress', async () => {
    const html = await render(job({ status: 'running', stage: 'research' }))
    assert.ok(html.includes('正在资料研究')); assert.ok(html.includes('尚未完成'))
    assert.equal((html.match(/已保存<\/small>/g) || []).length, 1)
    assert.ok(!/\d+%/.test(html))
  })
  it('only requires possible duplicate-charge acknowledgment for flagged live recovery', async () => {
    assert.equal(requiresChargeAcknowledgment(job({ mode: 'demo', possibleCharge: true })), false)
    assert.equal(requiresChargeAcknowledgment(job({ mode: 'live', possibleCharge: false })), false)
    const html = await render(job({ status: 'failed', mode: 'live', possibleCharge: true, recoveryRequired: true }))
    assert.ok(html.includes('该请求可能已计费')); assert.match(html, /<button[^>]*disabled[^>]*>从检查点恢复任务/)
    const safe = await render(job({ status: 'cancelled', mode: 'demo' }))
    assert.ok(!safe.includes('同意恢复时可能再次产生费用'))
  })
})
describe('artifact-bound adoption', () => {
  const reviewed = () => ({ schemaVersion: 2, artifactHash: 'a'.repeat(64), qaStatus: 'passed', review: { artifactHash: 'a'.repeat(64), checks: { desktop: true, mobile: true, content: true, maps: true }, note: '实际检查记录', reviewedAt: '2026-09-30T10:00:00Z' } } as Version)
  it('retains legacy compatibility without pretending legacy versions were reviewed', () => assert.equal(requiresManualReview({ schemaVersion: 1 } as Version), false))
  it('requires all four checks and a matching reviewed artifact hash', () => {
    const version = reviewed(); assert.equal(requiresManualReview(version), false)
    version.review!.checks.maps = false; assert.equal(requiresManualReview(version), true)
    version.review!.checks.maps = true; version.artifactHash = 'b'.repeat(64); assert.equal(requiresManualReview(version), true)
    version.artifactHash = null; assert.equal(requiresManualReview(version), true)
    version.review = null; assert.equal(requiresManualReview(version), true)
  })
  it('shows completed review and adoption only for the matching artifact', async () => {
    const version = {...reviewed(), id:'version-1', status:'adopted' as const}
    const data = job({status:'succeeded',stage:'candidate',versionId:version.id})
    const output = () => renderToString(createSSRApp(Pipeline,{job:data,busy:false,version}))
    const done = await output()
    assert.ok(done.includes('手册已审阅并采用，可下载 HTML'))
    assert.ok(done.includes('已审阅</small>'))
    version.artifactHash='b'.repeat(64)
    assert.ok((await output()).includes('等待人工审阅'))
    version.artifactHash='a'.repeat(64);version.id='other-version'
    assert.ok((await output()).includes('等待人工审阅'))
  })
  it('does not accept a passed machine status with no human review', () => assert.equal(requiresManualReview({ schemaVersion: 2, artifactHash: 'a'.repeat(64), qaStatus: 'passed' } as Version), true))
})
describe('honest provenance rendering', () => {
  it('shows missing QA and avoids dangerous source links', async () => {
    const html = await renderToString(createSSRApp(Evidence, { guide: { profile: {}, provenance: { upstreamCommit: 'fixture-commit' }, qa: { browser: 'not_run', issues: ['没有真实底图'] }, sources: [{ title: '<script>fake</script>', url: 'javascript:alert(1)' }], assets: [] } }))
    for (const text of ['not_run', '未提供', '没有真实底图', 'fixture-commit', '无可用链接']) assert.ok(html.includes(text), text)
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('<script>fake'))
  })
})

describe('selected-version guide memory bounds', () => {
  it('retains only cached matching artifact bytes and does not restore stale review metadata', () => {
    const versions = Array.from({length: 200}, (_, index) => ({id: `v-${index}`, artifactHash: `hash-${index}`, qaStatus: 'pending', guide: {assets: ['large-base64-payload']}} as unknown as Version))
    const first = {...versions[0], qaStatus: 'passed'} as Version
    const second = versions[1]
    const cache = new Map([[`v-0:hash-0`, first], [`v-1:hash-1`, second], ['v-2:stale-hash', versions[2]]])
    const result = withCachedGuides(versions, cache)
    assert.equal(result.filter(version => version.guide).length, 2)
    assert.equal(result[0].qaStatus, 'pending')
    assert.equal(result[2].guide, null)
    assert.equal(withCachedGuides(versions, new Map()).filter(version => version.guide).length, 0)
  })
})
