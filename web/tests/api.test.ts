import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, setCsrf, write, fetchArtifact, matchesArtifactHash } from '../src/lib/api'
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; mock.restoreAll(); setCsrf('') })
describe('same-origin API client', () => {
  it('sends cookies and CSRF token on writes', async () => {
    const fetchMock = mock.fn(async (_input: RequestInfo|URL,_init?: RequestInit) => new Response(JSON.stringify({ok:true}),{status:200}))
    globalThis.fetch = fetchMock; setCsrf('csrf-test'); await write('/trips',{destination:'京都'})
    const [url,options] = fetchMock.mock.calls[0].arguments
    assert.equal(url,'/api/trips'); assert.equal(options?.credentials,'same-origin'); assert.equal(new Headers(options?.headers).get('X-CSRF-Token'),'csrf-test'); assert.equal(new Headers(options?.headers).get('Content-Type'),'application/json')
  })
  it('does not add CSRF token to reads', async () => {
    const fetchMock = mock.fn(async (_input: RequestInfo|URL,_init?: RequestInit) => new Response('{}',{status:200})); globalThis.fetch=fetchMock; setCsrf('secret'); await api('/trips')
    assert.equal(new Headers(fetchMock.mock.calls[0].arguments[1]?.headers).has('X-CSRF-Token'),false)
  })
  it('surfaces structured revision conflicts', async () => {
    globalThis.fetch=async () => new Response(JSON.stringify({error:{code:'REVISION_CONFLICT',message:'Please refresh'}}),{status:409})
    await assert.rejects(write('/versions/1/adopt',{expectedRevision:1}),{status:409,code:'REVISION_CONFLICT',message:'Please refresh'})
  })
  it('handles non-JSON errors without exposing raw server text', async () => {
    globalThis.fetch=async () => new Response('<html>secret details</html>',{status:502})
    await assert.rejects(api('/settings'),(error: unknown) => error instanceof ApiError && !error.message.includes('secret details'))
  })
  it('sends application/json for key deletion', async () => {
    const fetchMock = mock.fn(async (_input: RequestInfo|URL,_init?: RequestInit) => new Response('{}',{status:200})); globalThis.fetch=fetchMock; await write('/settings/key',{},'DELETE')
    const options=fetchMock.mock.calls[0].arguments[1]; assert.equal(options?.method,'DELETE'); assert.equal(options?.body,'{}'); assert.equal(new Headers(options?.headers).get('Content-Type'),'application/json')
  })
})


describe('authenticated artifact transport', () => {
  it('fetches HTML with same-origin cookies and encoded identifiers', async () => {
    const fetchMock = mock.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('<!doctype html><h1>手册</h1>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    globalThis.fetch = fetchMock
    assert.equal(await fetchArtifact('trip/1', 'version/2'), '<!doctype html><h1>手册</h1>')
    const [url, options] = fetchMock.mock.calls[0].arguments
    assert.equal(url, '/api/trips/trip%2F1/versions/version%2F2/artifact')
    assert.equal(options?.credentials, 'same-origin')
  })
  it('rejects wrong content types and never treats raw error pages as handbooks', async () => {
    globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    await assert.rejects(fetchArtifact('t', 'v'), { code: 'ARTIFACT_TYPE' })
    globalThis.fetch = async () => new Response('private upstream details', { status: 502 })
    await assert.rejects(fetchArtifact('t', 'v'), (error: unknown) => error instanceof ApiError && !error.message.includes('private upstream'))
  })
  it('verifies exact UTF-8 artifact bytes, refusing stale or malformed hashes', async () => {
    const { createHash } = await import('node:crypto')
    const html = '<!doctype html><h1>京都 · 手册</h1>'
    const hash = createHash('sha256').update(html, 'utf8').digest('hex')
    assert.equal(await matchesArtifactHash(html, hash), true)
    assert.equal(await matchesArtifactHash(html + ' ', hash), false)
    assert.equal(await matchesArtifactHash(html, ''), false)
  })
})
