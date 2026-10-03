import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dayCount, mapUrl, pendingJob, safeUrl, validateConstraints } from '../src/lib/utils'
import type { Constraints, Job } from '../src/lib/types'
const constraints: Constraints = { destination: '京都', departure: '上海', startDate: '2026-10-01', endDate: '2026-10-05', people: 2, budget: 8000, currency: 'CNY', preferences: '慢节奏', exclusions: '' }
describe('handbook URL safety', () => {
  it('allows HTTP(S) and rejects script, data, credential and relative URLs', () => {
    assert.match(safeUrl('https://example.com/a?q=京都')!,/^https:\/\/example.com/)
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', '//example.com', '/local', 'https://user:pass@example.com']) assert.equal(safeUrl(url),null)
  })
  it('encodes map queries, including script-looking source content', () => {
    const result = mapUrl('京都 & <script>alert(1)</script>')
    assert.match(result,/^https:\/\/www.google.com\/maps\/search\/\?api=1&query=/)
    assert.ok(!result.includes('<script>'))
    assert.equal(new URL(result).searchParams.get('query'),'京都 & <script>alert(1)</script>')
  })
})
describe('trip constraints', () => {
  it('counts inclusive days without timezone/DST ambiguity', () => { assert.equal(dayCount('2026-03-07','2026-03-09'),3); assert.equal(dayCount('2026-10-01','2026-10-01'),1) })
  it('accepts valid entire-party constraints', () => assert.equal(validateConstraints(constraints),null))
  for(const patch of [{people:0},{people:21},{people:1.5},{budget:0},{budget:NaN},{currency:'cny'},{endDate:'2026-09-30'},{endDate:'2026-10-16'},{destination:' '},{startDate:''},{startDate:'2026-02-30',endDate:'2026-03-02'}]) it(`rejects invalid constraints ${JSON.stringify(patch)}`, () => assert.notEqual(validateConstraints({...constraints,...patch}),null))
})
describe('persisted job recovery', () => {
  it('selects a running/queued job and ignores terminal states', () => {
    const jobs = [{id:'old',status:'failed'},{id:'running',status:'running'},{id:'done',status:'succeeded'}] as Job[]
    assert.equal(pendingJob(jobs)?.id,'running')
    assert.equal(pendingJob([{status:'succeeded'},{status:'cancelled'}] as Job[]),undefined)
  })
})
