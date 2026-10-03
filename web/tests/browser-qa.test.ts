import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium, type Browser } from 'playwright-core'
import { runGuideBrowserQa } from '../../api/src/skill/browser-qa'
import { GUIDE_SCRIPT_SHA256 } from '../../api/src/skill/renderer'
import { TRUSTED_RUNTIME } from '../../api/src/skill/runtime'
afterEach(() => mock.restoreAll())
describe('production iframe CSP', () => {
  it('pins the actual fixed renderer runtime hash in the production parent CSP', async () => {
    const nginx = await readFile(new URL('../nginx.conf', import.meta.url), 'utf8')
    assert.equal(GUIDE_SCRIPT_SHA256, `sha256-${createHash('sha256').update(TRUSTED_RUNTIME).digest('base64')}`)
    const script = nginx.match(/script-src ([^;]+);/)?.[1] || ''
    assert.ok(script.includes(`'${GUIDE_SCRIPT_SHA256}'`), 'Update the exact nginx script hash when trusted runtime bytes change')
    assert.ok(!script.includes('unsafe-inline')); assert.ok(!script.includes('unsafe-eval'))
  })
  it('never grants same-origin, popups, forms or top navigation to artifact preview', async () => {
    const source = await readFile(new URL('../src/components/ArtifactPreview.vue', import.meta.url), 'utf8')
    assert.ok(source.includes('sandbox="allow-scripts"')); assert.ok(!source.includes('allow-same-origin')); assert.ok(!source.includes('v-html'))
  })
})
describe('browser QA unavailable state (mocked launch only)', () => {
  it('returns honest pending evidence when secure browser launch is unavailable', async () => {
    const launch = mock.method(chromium, 'launch', async () => { throw new Error('process_singleton: socket() failed Operation not permitted') })
    const html = '<!doctype html><h1>fixture</h1>'
    const result = await runGuideBrowserQa({ html, fingerprint: 'a'.repeat(64) })
    assert.equal(result.browser.status, 'pending'); assert.equal(result.offline.status, 'pending')
    assert.equal(result.browser.fingerprint, 'a'.repeat(64)); assert.equal(result.offline.fingerprint, createHash('sha256').update(html).digest('hex'))
    assert.equal(result.screenshots.length, 0)
    assert.ok(Object.values(result.browser.checks).every(check => !check.passed && check.note.includes('permitted sandbox')))
    assert.equal((launch.mock.calls[0].arguments[0] as {chromiumSandbox: boolean}).chromiumSandbox, true)
  })
  it('closes a browser whose launch finishes after cancellation without opening a page', async () => {
    let finish!: (browser: Browser) => void
    mock.method(chromium, 'launch', () => new Promise<Browser>(resolve => { finish = resolve }))
    const close = mock.fn(async () => {})
    const newContext = mock.fn(async () => { throw new Error('Must not open context after cancellation') })
    const controller = new AbortController()
    const pending = runGuideBrowserQa({html: '<!doctype html><p>fixture</p>', fingerprint: 'a'.repeat(64), signal: controller.signal})
    controller.abort(); finish({close, newContext} as unknown as Browser)
    const result = await pending
    assert.equal(result.browser.status, 'pending'); assert.equal(newContext.mock.calls.length, 0); assert.equal(close.mock.calls.length, 1)
    assert.ok(Object.values(result.browser.checks).every(check => !check.passed && check.note.includes('cancelled')))
  })
  it('respects cancellation without launching a browser', async () => {
    const launch = mock.method(chromium, 'launch', async () => { throw new Error('should not launch') })
    const controller = new AbortController(); controller.abort()
    const result = await runGuideBrowserQa({ html: '<html></html>', fingerprint: 'a'.repeat(64), signal: controller.signal })
    assert.equal(launch.mock.calls.length, 0); assert.equal(result.browser.status, 'pending')
    assert.ok(Object.values(result.browser.checks).every(check => !check.passed))
  })
})
