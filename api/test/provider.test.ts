import test from 'node:test';
import assert from 'node:assert/strict';
import { generateItinerary, type GenerateItineraryInput, type ProviderDependencies } from '../src/provider';
import { SafeProviderError, type SafeJsonRequest } from '../src/safe-http';
import { itinerarySchema, type Itinerary } from '../src/schemas';

const input: GenerateItineraryInput = {
  constraints: { destination: '杭州', departure: '上海', startDate: '2026-10-01', endDate: '2026-10-02', people: 2,
    budget: 3000, currency: 'CNY', preferences: '少走路，喜欢博物馆', exclusions: '不去游乐园' },
  current: null, request: '', mode: 'live',
  settings: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: 'mock-fixture-not-a-real-key' },
};
const now = () => new Date('2026-09-30T08:00:00.000Z');
const clone = <T>(value: T): T => structuredClone(value);
function content(): Itinerary {
  return {
    title: '杭州两日草案', summary: '需要进一步核验的行程建议。',
    days: ['2026-10-01', '2026-10-02'].map((date) => ({ date, title: '舒适游览', summary: '分配充足休息时间。',
      activities: [{ time: '09:00', title: '待确认活动', description: '先核对营业情况再前往。', location: '待确认地点',
        transport: '交通方式待确认', estimatedCost: 100, bookingNote: '未预订', sourceIds: [] }] })),
    budget: [{ category: '活动估算', amount: 200, note: '全体旅客估算，不是报价' }], packing: ['舒适鞋履'], notes: ['开放时间需确认'],
    sources: [], verification: { mode: 'not_live_verified', notice: '待服务器设置', researchedAt: null },
  };
}
const completion = (value: unknown, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] });
const errorCode = (code: string) => (error: unknown) => error instanceof SafeProviderError && error.code === code;

function fixtureTransport(reply: unknown, requests: SafeJsonRequest[] = []): ProviderDependencies['transport'] {
  return async (request) => { requests.push(request); return reply; };
}

test('live completion includes original constraints, current adopted version and new request', async () => {
  const requests: SafeJsonRequest[] = [];
  const current = content();
  const generated = await generateItinerary({ ...input, current, request: '第二天改成室内活动，仍少走路' },
    { transport: fixtureTransport(completion(content()), requests), now });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.baseUrl, 'https://api.openai.com/v1');
  assert.equal(request.path, 'chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers?.authorization, 'Bearer mock-fixture-not-a-real-key');
  const body = request.body as { model: string; response_format: { type: string }; stream: boolean; messages: { role: string; content: string }[] };
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, false);
  assert.match(body.messages[0].content, /JSON/);
  const prompt = JSON.parse(body.messages[1].content);
  assert.deepEqual(prompt.constraints, input.constraints);
  assert.deepEqual(prompt.currentAdoptedItinerary, current);
  assert.equal(prompt.newRequest, '第二天改成室内活动，仍少走路');
  assert.deepEqual(prompt.requiredDates, ['2026-10-01', '2026-10-02']);
  assert.equal(JSON.stringify(body).includes('mock-fixture-not-a-real-key'), false);
  assert.equal(generated.verification.mode, 'not_live_verified');
  assert.equal(generated.verification.researchedAt, null);
  assert.deepEqual(generated.sources, []);
});

test('OpenAI and DeepSeek use canonical destinations; custom uses validated configured base', async () => {
  for (const [provider, expected] of [['openai', 'https://api.openai.com/v1'], ['deepseek', 'https://api.deepseek.com'], ['custom', 'https://gateway.example.com/openai/v1']] as const) {
    const requests: SafeJsonRequest[] = [];
    await generateItinerary({ ...input, settings: { ...input.settings!, provider, baseUrl: 'https://gateway.example.com/openai/v1' } },
      { transport: fixtureTransport(completion(content()), requests) });
    assert.equal(requests[0].baseUrl, expected);
  }
  await assert.rejects(generateItinerary({ ...input, settings: { ...input.settings!, provider: 'custom', baseUrl: 'http://localhost:1234/v1' } },
    { transport: async () => { assert.fail('network must not run'); } }), errorCode('INVALID_PROVIDER_URL'));
});

test('server replaces model sources and verification; invented or stale source IDs are removed', async () => {
  const requests: SafeJsonRequest[] = [];
  const model = content();
  model.sources = [{ id: 'fake', title: 'Invented proof', url: 'https://invented.example.com/fake', retrievedAt: '2000-01-01T00:00:00.000Z' }];
  model.verification = { mode: 'live_search', notice: '库存全部已确认', researchedAt: '2000-01-01T00:00:00.000Z' };
  model.days[0].activities[0].sourceIds = ['fake', 'S1', 'S1', 'S2'];
  model.days[0].activities[0].description += ' https://invented.example.com/fake';
  const generated = await generateItinerary({ ...input, searchApiKey: 'test-search-key', request: 'secret-new-request' }, { now,
    transport: async (request) => {
      requests.push(request);
      if (request.baseUrl === 'https://api.search.brave.com') return { web: { results: [
        { title: 'Retrieved official evidence', url: 'https://example.com/visit?lang=zh', description: 'Retrieved snippet' },
        { title: 'duplicate', url: 'https://example.com/visit?lang=zh' },
        { title: 'bad scheme', url: 'javascript:alert(1)' },
        { title: 'internal link', url: 'https://127.0.0.1/secret' },
      ] } };
      return completion(model);
    },
  });
  assert.equal(requests.length, 2);
  const search = requests[0];
  assert.equal(search.path, 'res/v1/web/search');
  assert.equal(search.headers?.['x-subscription-token'], 'test-search-key');
  const query = JSON.stringify(search.body);
  assert.equal(query.includes('杭州'), true);
  assert.equal(query.includes('2026-10-01'), true);
  for (const privateField of ['secret-new-request', input.constraints.departure, input.constraints.preferences, input.constraints.exclusions, '3000']) assert.equal(query.includes(privateField), false);
  assert.deepEqual(generated.sources, [{ id: 'S1', title: 'Retrieved official evidence', url: 'https://example.com/visit?lang=zh', retrievedAt: now().toISOString() }]);
  assert.deepEqual(generated.days[0].activities[0].sourceIds, ['S1']);
  assert.equal(generated.days[0].activities[0].description.includes('https://invented'), false);
  assert.equal(generated.verification.mode, 'live_search');
  assert.match(generated.verification.notice, /未核验实时库存/);
  assert.equal(generated.verification.researchedAt, now().toISOString());
  const body = requests[1].body as { messages: { content: string }[] };
  const prompt = JSON.parse(body.messages[1].content);
  assert.equal(prompt.searchEvidence[0].description, 'Retrieved snippet');
});

test('without search, model cannot assert live verification or introduce citations', async () => {
  const model = content();
  model.days[0].activities[0].sourceIds = ['S1'];
  model.verification.mode = 'live_search';
  model.sources = [{ id: 'S1', title: 'Fake', url: 'https://fake.example.com', retrievedAt: now().toISOString() }];
  const result = await generateItinerary(input, { transport: fixtureTransport(completion(model)), now });
  assert.equal(result.verification.mode, 'not_live_verified');
  assert.equal(result.verification.researchedAt, null);
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.days[0].activities[0].sourceIds, []);
});

test('missing or malformed model metadata is replaced by trusted server fields', async () => {
  const model = { ...content(), sources: 'malicious metadata', verification: { allInventory: 'verified' } };
  const result = await generateItinerary(input, { transport: fixtureTransport(completion(model)), now });
  assert.deepEqual(result.sources, []);
  assert.equal(result.verification.mode, 'not_live_verified');
});

test('failed/empty search is clearly disclosed and does not manufacture citations or retry', async () => {
  for (const failure of [true, false]) {
    let searchAttempts = 0; let modelAttempts = 0;
    const result = await generateItinerary({ ...input, searchApiKey: 'fixture-key' }, { now, transport: async (request) => {
      if (request.baseUrl === 'https://api.search.brave.com') {
        searchAttempts++;
        if (failure) throw new Error('secret search key raw error');
        return { web: { results: [] } };
      }
      modelAttempts++;
      return completion(content());
    } });
    assert.equal(searchAttempts, 1); assert.equal(modelAttempts, 1);
    assert.equal(result.verification.mode, 'not_live_verified');
    assert.match(result.verification.notice, failure ? /检索失败/ : /没有返回可用来源/);
    assert.equal(result.verification.notice.includes('secret'), false);
    assert.deepEqual(result.sources, []);
  }
});

test('malformed content, missing required fields, extra keys and truncated/refused completions fail', async () => {
  const malformed = [completion({}), completion({ ...content(), extra: 'unexpected' }),
    { choices: [{ message: { content: '```json\n{}\n```' } }] },
    { choices: [] }, completion(content(), 'length'), completion(content(), 'content_filter'),
    { choices: [{ finish_reason: 'stop', message: { content: '{}', refusal: 'refused' } }] },
    completion({ ...content(), budget: [{ category: 'bad', amount: -1, note: 'invalid' }] }),
  ];
  for (const reply of malformed) {
    let attempts = 0;
    await assert.rejects(generateItinerary(input, { transport: async () => { attempts++; return reply; } }), errorCode('INVALID_ITINERARY'));
    assert.equal(attempts, 1);
  }
});

test('exact inclusive dates are enforced, including day count, ordering and duplication', async () => {
  for (const dates of [['2026-10-01'], ['2026-10-01', '2026-10-03'], ['2026-10-02', '2026-10-01'], ['2026-10-01', '2026-10-01']]) {
    const model = content();
    model.days = dates.map((date) => ({ ...clone(model.days[0]), date }));
    await assert.rejects(generateItinerary(input, { transport: fixtureTransport(completion(model)) }), errorCode('ITINERARY_DATE_MISMATCH'));
  }
});

test('invalid constraints or adopted state fail before paid calls', async () => {
  const noTransport = { transport: async () => { assert.fail('must fail before paid call'); } };
  await assert.rejects(generateItinerary({ ...input, constraints: { ...input.constraints, endDate: '2026-10-15' } }, noTransport), errorCode('INVALID_CONSTRAINTS'));
  await assert.rejects(generateItinerary({ ...input, constraints: { ...input.constraints, startDate: '2026-02-30' } }, noTransport), errorCode('INVALID_CONSTRAINTS'));
  const current = content(); current.days[0].date = '2026-09-01';
  await assert.rejects(generateItinerary({ ...input, current }, noTransport), errorCode('INVALID_ITINERARY'));
  await assert.rejects(generateItinerary({ ...input, settings: null }, noTransport), errorCode('PROVIDER_SETTINGS_REQUIRED'));
});

test('demo is explicitly synthetic, date-correct, zero external calls and empty citations', async () => {
  const demo = await generateItinerary({ ...input, mode: 'demo', settings: null,
    constraints: { ...input.constraints, startDate: '2026-12-25', endDate: '2027-01-07' }, request: '第三天多休息' },
    { transport: async () => { assert.fail('demo must not call a model or search service'); } });
  assert.equal(itinerarySchema.safeParse(demo).success, true);
  assert.equal(demo.days.length, 14);
  assert.equal(demo.days[0].date, '2026-12-25');
  assert.equal(demo.days[13].date, '2027-01-07');
  assert.equal(demo.verification.mode, 'demo');
  assert.equal(demo.verification.researchedAt, null);
  assert.deepEqual(demo.sources, []);
  for (const day of demo.days) for (const activity of day.activities) {
    assert.match(activity.title, /示例/);
    assert.deepEqual(activity.sourceIds, []);
  }
  assert.match(demo.verification.notice, /合成占位/);
});

test('upstream errors are redacted and there is exactly one paid model attempt', async () => {
  let attempts = 0;
  await assert.rejects(generateItinerary(input, { transport: async () => { attempts++; throw new Error('Bearer mock-fixture-not-a-real-key; private prompt'); } }),
    (error: unknown) => error instanceof SafeProviderError && error.code === 'PROVIDER_UNAVAILABLE' && !JSON.stringify(error).includes('mock-fixture') && !('cause' in error));
  assert.equal(attempts, 1);
});


test('rejects over-budget category totals and activity totals without retrying', async () => {
  for (const overrun of ['budget', 'activities']) {
    const model = content();
    if (overrun === 'budget') model.budget = [{ category: 'lodging', amount: 2000, note: '' }, { category: 'transport', amount: 1001, note: '' }];
    else model.days[0].activities[0].estimatedCost = 3001;
    let attempts = 0;
    await assert.rejects(generateItinerary(input, { transport: async () => { attempts++; return completion(model); } }), errorCode('ITINERARY_BUDGET_EXCEEDED'));
    assert.equal(attempts, 1);
  }
});


test('credential reflected by an upstream service is never returned or forwarded', async () => {
  const model = content();
  model.summary = 'Reflected credential: ' + input.settings!.apiKey;
  await assert.rejects(generateItinerary(input, { transport: fixtureTransport(completion(model)) }), errorCode('INVALID_ITINERARY'));
  const requests: SafeJsonRequest[] = [];
  const result = await generateItinerary({ ...input, searchApiKey: 'brave-secret-fixture' }, { transport: async (request) => {
    requests.push(request);
    if (request.baseUrl === 'https://api.search.brave.com') return { web: { results: [{ title: 'Reflected brave-secret-fixture', url: 'https://example.com/search' }] } };
    return completion(content());
  } });
  assert.deepEqual(result.sources, []);
  assert.equal(JSON.stringify(requests[1].body).includes('brave-secret-fixture'), false);
});


test('JSON Unicode escaping cannot hide a reflected provider or search credential', async () => {
  const searchApiKey = 'brave-sensitive-reflection-fixture';
  for (const secret of [input.settings!.apiKey, searchApiKey]) {
    const model = content();
    model.summary = 'Reflected credential: ' + secret;
    const escaped = [...secret].map((char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const serialized = JSON.stringify(model).replace(secret, escaped);
    assert.equal(serialized.includes(secret), false);
    assert.equal(JSON.parse(serialized).summary.includes(secret), true);
    await assert.rejects(generateItinerary({ ...input, searchApiKey }, { transport: async (request) => {
      if (request.baseUrl === 'https://api.search.brave.com') return { web: { results: [] } };
      return { choices: [{ finish_reason: 'stop', message: { content: serialized } }] };
    } }), errorCode('INVALID_ITINERARY'));
  }
});

test('final output rejects a provider credential reflected by search metadata', async () => {
  await assert.rejects(generateItinerary({ ...input, searchApiKey: 'brave-fixture-key' }, { transport: async (request) => {
    if (request.baseUrl === 'https://api.search.brave.com') return { web: { results: [{ title: input.settings!.apiKey, url: 'https://example.com/visit' }] } };
    return completion(content());
  } }), errorCode('INVALID_ITINERARY'));
});
