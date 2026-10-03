import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { generateOutline, researchPack, classifyChangePacks, compactCurrentForOutline, MODEL_LIMITS, type SkillOutline } from '../src/skill/provider';
import { acquireEvidence, acquireAssets, inspectSourcePage, imageDimensions, decodeRaster, RESEARCH_LIMITS, type ResearchEvidence, type RunOperation } from '../src/skill/tools';
import { PACK_IDS, type Place } from '../src/skill/types';
import { SafeProviderError, type SafeJsonRequest } from '../src/safe-http';
import type { TripConstraints } from '../src/schemas';

// All transports in this suite are deterministic fixtures. No paid service or key is used.
const constraints: TripConstraints = { destination: 'Fixture City', departure: 'Private Departure', startDate: '2026-10-01', endDate: '2026-10-02',
  people: 2, budget: 3000, currency: 'CNY', preferences: 'private preference', exclusions: 'private exclusion' };
const settings = { provider: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'fixture-model', apiKey: 'fixture-model-credential-not-real' };
const runOperation: RunOperation = async (_key, _input, action) => action();
const context = { settings, operationKey: 'fixture-job:attempt-0:outline', runOperation };
const now = () => new Date('2026-09-30T12:00:00Z');
const outline = (): SkillOutline => ({ title: '合成测试大纲', summary: '这个大纲只用于自动化测试',
  days: ['2026-10-01','2026-10-02'].map((date) => ({ date, title: '城区游览', focus: '区域主题待研究', pace: 'standard', areas: ['城区'] })),
  assumptions: ['时间与费用待确认'], openQuestions: [], changedPacks: ['framing'] });
const reply = (result: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ result }) } }] });
const source = (id = 'src-fixture'): ResearchEvidence => ({ id, title: 'Fixture official page', url: 'https://official.example/venue', retrievedAt: now().toISOString(),
  excerpt: 'Source fixture', packIds: ['places-experiences'], discoveredBy: 'brave_search', evidenceEpoch: 'fixture', query: 'fixed fixture query',
  retrievalStatus: 'page_retrieved', authority: 'operator_verified_official', text: 'Fixture venue facts', contentHash: 'a'.repeat(64),
  metadata: { title: 'Fixture Venue', description: 'Test', imageUrls: ['https://images.example/venue.png'], entities: [{ name: 'Fixture Venue', latitude: 35, longitude: 139 }] } });
function place(id: string): Place { return { id, type: 'experience', display_name: '测试场所', local_name: 'Fixture Venue', description: '测试证据中的文化体验', area: '测试城区',
  map_query: 'Fixture Venue', source_url: 'https://invented.example/fake', source_ids: ['src-fixture'], latitude: 35, longitude: 139,
  coordinate_source: { source_id: 'src-fixture', url: 'https://invented.example/fake', note: 'Model claims entrance verified', precision: 'entrance' },
  hours: '实际开放时间需确认', closed_days: '需确认', duration_minutes: 60, best_time: '白天', practical_tip: '提前核对开放安排', price_note: '价格待确认', interest_tags: ['文化'],
  images: [{ file: `assets/${id}.png`, source_id: 'src-fixture', source_page: 'https://official.example/venue', download_url: 'https://images.example/venue.png',
    media_class: 'official_photo', original_media_class: 'official_photo', visual_subject_type: 'place_exterior', source_identity_note: '测试官网声明的图片候选，尚未做视觉核验' }], experience_type: 'culture' }; }

test('outline is a separate bounded model call with durable wrapper, signal, no tools and no secrets in ledger', async () => {
  const requests: SafeJsonRequest[] = []; const records: unknown[] = []; const signal = new AbortController().signal;
  const result = await generateOutline({ ...context, constraints, request: '按原预算放慢节奏', signal,
    runOperation: async (key, input, action) => { records.push({ key, input }); return action(); } }, { transport: async (request) => { requests.push(request); return reply(outline()); } });
  assert.deepEqual(result.changedPacks, PACK_IDS);
  assert.equal(requests.length, 1); assert.equal(requests[0].signal, signal);
  assert.match(requests[0].headers!['idempotency-key'], /^[a-f\d]{64}$/);
  const body = requests[0].body as Record<string, any>;
  assert.equal(body.max_completion_tokens, 3500); assert.equal(body.tools, undefined);
  assert.equal(JSON.stringify(body).includes(settings.apiKey), false); assert.equal(JSON.stringify(records).includes(settings.apiKey), false);
  assert.match(body.messages[0].content, /不可信第三方内容/);
});

test('ambiguous model failures never retry and error text cannot disclose upstream credentials', async () => {
  let calls = 0;
  await assert.rejects(generateOutline({ ...context, constraints, request: '' }, { transport: async () => { calls++; throw new Error(settings.apiKey); } }),
    (error: unknown) => error instanceof SafeProviderError && error.code === 'PROVIDER_UNAVAILABLE' && !JSON.stringify(error).includes(settings.apiKey));
  assert.equal(calls, 1);
});

test('strict outline rejects wrong dates, missing days, refusals and decoded secret reflection', async () => {
  const changed = outline(); changed.days[1].date = '2026-10-03';
  await assert.rejects(generateOutline({ ...context, constraints, request: '' }, { transport: async () => reply(changed) }), /dates/);
  const reflected = outline(); reflected.summary = settings.apiKey;
  await assert.rejects(generateOutline({ ...context, constraints, request: '' }, { transport: async () => reply(reflected) }),
    (error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_RESPONSE_SECRET'&&!JSON.stringify(error).includes(settings.apiKey));
  await assert.rejects(generateOutline({ ...context, constraints, request: '' }, { transport: async () => ({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ result: outline() }) } }] }) }),
    (error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_COMPLETION_TRUNCATED');
});

test('DeepSeek structured output explicitly disables default thinking and computes outline pack scope on the server',async()=>{
  const deepseek={...settings,provider:'deepseek' as const,model:'deepseek-v4-pro',baseUrl:'https://api.deepseek.com'};
  let sent:any;
  const {changedPacks:_ignored,...modelOutline}=outline();
  const result=await generateOutline({...context,settings:deepseek,constraints,request:''},{transport:async input=>{sent=input;return reply(modelOutline);}});
  assert.equal(sent.body.thinking.type,'disabled');
  assert.equal(sent.body.max_tokens,MODEL_LIMITS.outlineOutputTokens);
  assert.deepEqual(sent.body.response_format,{type:'json_object'});
  assert.deepEqual(result.changedPacks,PACK_IDS);
  assert.equal(JSON.stringify(sent.body).includes('changedPacks'),false);
  const withDiscarded={...modelOutline,changedPacks:'model-controlled-invalid-value'};
  const sanitized=await generateOutline({...context,settings:deepseek,constraints,request:''},{transport:async()=>reply(withDiscarded)});
  assert.deepEqual(sanitized.changedPacks,PACK_IDS);
});

test('model response failures expose only specific safe validation codes and schema paths',async()=>{
  const invalidPace={...outline(),days:outline().days.map((day,index)=>index?day:{...day,pace:'impossible'})};
  const cases:[unknown,string,string|undefined][]=[
    [{choices:[]},'PROVIDER_COMPLETION_ENVELOPE','completion.choices.too_small'],
    [{choices:[{finish_reason:'length',message:{content:null}}]},'PROVIDER_COMPLETION_TRUNCATED',undefined],
    [{choices:[{finish_reason:'content_filter',message:{content:null}}]},'PROVIDER_COMPLETION_FILTERED',undefined],
    [{choices:[{finish_reason:'tool_calls',message:{content:'{}'}}]},'PROVIDER_COMPLETION_STOP_REASON',undefined],
    [{choices:[{finish_reason:'stop',message:{content:null,refusal:'private refusal body'}}]},'PROVIDER_COMPLETION_REFUSAL',undefined],
    [{choices:[{finish_reason:'stop',message:{content:''}}]},'PROVIDER_COMPLETION_EMPTY',undefined],
    [{choices:[{finish_reason:'stop',message:{content:'{broken'}}]},'PROVIDER_COMPLETION_JSON',undefined],
    [{choices:[{finish_reason:'stop',message:{content:'{"other":1}'}}]},'PROVIDER_RESULT_ENVELOPE','envelope.missing_result'],
    [{choices:[{finish_reason:'stop',message:{content:'[]'}}]},'PROVIDER_RESULT_ENVELOPE','envelope.array'],
    [{choices:[{finish_reason:'stop',message:{content:'null'}}]},'PROVIDER_RESULT_ENVELOPE','envelope.non_object'],
    [{choices:[{finish_reason:'stop',message:{content:JSON.stringify({result:outline(),privateUnknownField:'private response detail'})}}]},'PROVIDER_RESULT_ENVELOPE','envelope.extra_fields'],
    [reply(invalidPace),'PROVIDER_OUTLINE_SCHEMA','outline.days.0.pace.invalid_enum_value'],
  ];
  for(const [response,code,detail] of cases){
    let calls=0;
    await assert.rejects(generateOutline({...context,constraints,request:''},{transport:async()=>{calls++;return response;}}),
      (error:unknown)=>error instanceof SafeProviderError&&error.code===code&&error.validationDetail===detail&&error.phase==='response'&&error.requestSent===true&&
        !JSON.stringify(error).includes('private refusal body')&&!JSON.stringify(error).includes('private response detail')&&!JSON.stringify(error).includes('privateUnknownField'));
    assert.equal(calls,1,code);
  }
  const coreSource={...source(),packIds:['places-core' as const]};
  await assert.rejects(researchPack({...context,packId:'places-core',constraints,outline:outline(),previousPacks:{},evidence:[coreSource]},
    {transport:async()=>reply({sights:[],support:[]})}),
    (error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_RESEARCH_SCHEMA'&&
      error.validationDetail?.startsWith('research.places-core.sights.')===true);
});

test('direct outline JSON uses strict validation without another paid request', async () => {
  const {changedPacks: _ignored, ...direct} = outline();
  let calls = 0;
  const transport = (value: unknown) => async () => {
    calls++;
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]};
  };
  const input = {...context, constraints, request:''};
  const result = await generateOutline(input, {transport:transport(direct)});
  assert.deepEqual(result, {...direct, changedPacks:PACK_IDS});
  assert.equal(calls, 1);
  for (const [value, code] of [
    [{...direct, extra:'untrusted'}, 'PROVIDER_OUTLINE_SCHEMA'],
    [{...direct, days:direct.days.map(day=>({...day, pace:'invalid'}))}, 'PROVIDER_OUTLINE_SCHEMA'],
    [{...direct, days:direct.days.map(day=>({...day, date:'2026-10-03'}))}, 'ITINERARY_DATE_MISMATCH'],
    [{...direct, summary:settings.apiKey}, 'PROVIDER_RESPONSE_SECRET'],
  ] as const) {
    const before = calls;
    await assert.rejects(generateOutline(input, {transport:transport(value)}),
      (error:unknown)=>error instanceof SafeProviderError&&error.code===code);
    assert.equal(calls, before + 1);
  }
  await assert.rejects(researchPack({...context, packId:'places-core', constraints, outline:outline(), previousPacks:{}, evidence:[{...source(),packIds:['places-core']}]},
    {transport:transport(direct)}),
    (error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_RESULT_ENVELOPE');
});

test('research diagnostics retain array indices and Zod codes without reflecting unknown fields', async () => {
  const input = {...context, packId:'places-core' as const, constraints, outline:outline(), previousPacks:{}, evidence:[{...source(),packIds:['places-core' as const]}]};
  const sights = Array.from({length:8}, (_, index)=>({...place('sight-'+index),type:'sight'}));
  for (const [value, detail] of [
    [{sights:sights.map((item,index)=>index?item:{...item,duration_minutes:'60'}),support:[]},'research.places-core.sights.0.duration_minutes.invalid_type'],
    [{sights:sights.map((item,index)=>index?item:{...item,privateUnknownField:'private upstream value'}),support:[]},'research.places-core.sights.0.unrecognized_keys'],
    [{sights:[],support:[]},'research.places-core.sights.too_small'],
  ] as const) {
    let calls=0;
    await assert.rejects(researchPack(input,{transport:async()=>{calls++;return reply(value);}}),
      (error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_RESEARCH_SCHEMA'&&error.validationDetail===detail&&
        !JSON.stringify(error).includes('privateUnknownField')&&!JSON.stringify(error).includes('private upstream value'));
    assert.equal(calls,1);
  }
});

test('a durable operation cache reuses completed validated model result without a second paid call', async () => {
  let calls = 0; const cache = new Map<string, unknown>();
  const cached: RunOperation = async (key, _input, action) => { if (cache.has(key)) return cache.get(key) as any; const value = await action(); cache.set(key, value); return value; };
  const input = { ...context, constraints, request: '', runOperation: cached };
  const deps = { transport: async () => { calls++; return reply(outline()); } };
  assert.deepEqual(await generateOutline(input, deps), await generateOutline(input, deps)); assert.equal(calls, 1);
});

test('research pack uses executable contract and only fetched evidence owns URLs, coordinates and image candidates', async () => {
  const places = ['exp-1','exp-2','exp-3','exp-4'].map(place);
  places[1].latitude = 36;
  places[2].ratings = [{ platform: 'Google', status: 'verified', rating: 5, source_id: 'src-fixture', source_url: 'https://invented.example/rating', verified_at: '2026-09-30' }];
  places[3].images[0].download_url = 'https://arbitrary.example/private-image.png';
  const requests: SafeJsonRequest[] = [];
  const result = await researchPack({ ...context, operationKey: 'fixture-job:attempt-0:experiences', packId: 'places-experiences', constraints,
    outline: outline(), previousPacks: {}, evidence: [source()] }, { transport: async (request) => { requests.push(request); return reply(places); } });
  assert.equal(result[0].source_url, source().url); assert.equal(result[0].coordinate_source?.url, source().url);
  assert.equal(result[0].coordinate_source?.precision, 'area');
  assert.equal(result[1].latitude, undefined); assert.equal(result[1].coordinate_source, undefined);
  assert.deepEqual(result[2].ratings, []); assert.deepEqual(result[3].images, []);
  assert.match(result[0].map_url!, /^https:\/\/www.google.com\/maps\/search\//);
  const payload = JSON.parse((requests[0].body as any).messages[1].content);
  assert.equal(payload.currentPack, 'places-experiences'); assert.equal(payload.packContract.pack, 'places-experiences');
  assert.equal(payload.packContract.schema.minItems, 4);
});

test('bare research JSON retains strict schema and source checks',async()=>{
  const input={...context,packId:'places-experiences' as const,constraints,outline:outline(),previousPacks:{},evidence:[source()]};
  const direct=(value:unknown)=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
  const records=Array.from({length:4},(_,i)=>place('exp-'+i));
  assert.equal((await researchPack(input,{transport:async()=>direct(records)})).length,4);
  await assert.rejects(researchPack(input,{transport:async()=>direct(records.slice(0,1))}),(error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_RESEARCH_SCHEMA');
  const invalid=records.map(record=>({...record,source_ids:['invented']}));
  await assert.rejects(researchPack(input,{transport:async()=>direct(invalid)}),(error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_RESEARCH_SCHEMA');
});

test('snippet-only or invented source IDs cannot become canonical place evidence', async () => {
  const snippet = source(); snippet.retrievalStatus = 'snippet_only';
  await assert.rejects(researchPack({ ...context, packId: 'places-experiences', constraints, outline: outline(), previousPacks: {}, evidence: [snippet] },
    { transport: async () => { assert.fail('must not bill model without fetched evidence'); } }), /successfully retrieved source page/);
});

test('research prompt excludes failed pages and lists only retrieved source references', async () => {
  const retrieved=source();
  const failed={...source('failed-page'),retrievalStatus:'page_unavailable' as const};
  const snippet={...source('snippet-page'),retrievalStatus:'snippet_only' as const};
  await researchPack({...context,packId:'places-experiences',constraints,outline:outline(),previousPacks:{},evidence:[failed,snippet,retrieved]},
    {transport:async request=>{
      const payload=JSON.parse((request.body as any).messages[1].content);
      assert.deepEqual(payload.suppliedEvidence.map((item:any)=>item.id),[retrieved.id]);
      assert.deepEqual(payload.allowedSourceReferences,[{source_id:retrieved.id,source_url:retrieved.url}]);
      return reply(Array.from({length:4},(_,i)=>place('exp-'+i)));
    }});
});

test('search is bounded, minimized, ledgered and actually fetches only provider-result public URLs', async () => {
  const requests: SafeJsonRequest[] = []; const fetched: string[] = []; const ledger: string[] = [];
  const result = await acquireEvidence({ packId: 'framing', constraints, operationKey: 'fixture-job:evidence:framing', searchApiKey: 'fixture-search-key',
    runOperation: async (key, _input, action) => { ledger.push(key); return action(); } }, { now,
    officialHosts: ['official.example'], transport: async (request) => { requests.push(request); return { web: { results: [
      { title: 'Fixture City venue', url: 'https://official.example/venue', description: 'Only a snippet' },
      { title: 'Blocked', url: 'https://127.0.0.1/secret' }, { title: 'Credential', url: 'https://name:password@example.com/' },
    ] } }; }, pageTransport: async (request) => { fetched.push(request.url); return { bytes: Buffer.from('<html><title>Fixture venue</title><p>Official source fixture</p></html>'), contentType: 'text/html' }; } });
  assert.equal(requests.length, RESEARCH_LIMITS.searchesPerPack); assert.equal(ledger.length, 3); assert.deepEqual(fetched, ['https://official.example/venue']);
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].retrievalStatus, 'page_retrieved');
  assert.equal(result.sources[0].authority, 'operator_verified_official'); assert.match(result.sources[0].contentHash!, /^[a-f\d]{64}$/);
  for (const request of requests) for (const secret of ['private preference','private exclusion','Private Departure','3000']) assert.equal(JSON.stringify(request.body).includes(secret), false);
  assert.equal(result.status, 'retrieved');
});

test('search failure or ledger ambiguity stops further paid work immediately', async () => {
  let calls = 0;
  await assert.rejects(acquireEvidence({ packId: 'framing', constraints, operationKey: 'fixture', searchApiKey: 'fixture-search-key', runOperation },
    { transport: async () => { calls++; throw new SafeProviderError('PROVIDER_TIMEOUT'); } }), /timed out/);
  assert.equal(calls, 1);
});

test('existing fetched evidence is merged and not refetched; legacy minimal sources do not assert retrieval', async () => {
  const existing = source(); const legacy = { id: 'old', title: 'Legacy', url: 'https://legacy.example/', retrievedAt: now().toISOString() } as ResearchEvidence;
  const result = await acquireEvidence({ packId: 'places-core', constraints, operationKey: 'fixture', searchApiKey: 'fixture-search-key', existingSources: [existing, legacy], runOperation },
    { transport: async () => ({ web: { results: [{ title: 'Fixture City source', url: existing.url }] } }), pageTransport: async () => { assert.fail('must not refetch completed page'); } });
  assert.equal(result.sources.length, 1); assert.deepEqual(result.sources[0].packIds, ['places-experiences','places-core']);
  assert.deepEqual(existing.packIds, ['places-experiences']);
});

test('passive source parser removes executable text and extracts source-owned image/coordinate metadata without fetching', () => {
  const html = `<html><title>Fixture &amp; Museum</title><script>sendSecrets()</script><style>bad()</style>
  <meta property="og:image" content="/venue.png"><img src="https://127.0.0.1/blocked.png">
  <script type="application/ld+json">{"@type":"Museum","name":"Fixture Venue","geo":{"latitude":35,"longitude":139},"image":"https://images.example/venue.png"}</script>
  <p>Retrieved page text</p></html>`;
  const parsed = inspectSourcePage(Buffer.from(html), 'text/html', 'https://official.example/venue');
  assert.equal(parsed.metadata.title, 'Fixture & Museum'); assert.equal(parsed.text.includes('sendSecrets'), false); assert.equal(parsed.text.includes('bad()'), false);
  assert.deepEqual(parsed.metadata.entities, [{ name: 'Fixture Venue', latitude: 35, longitude: 139 }]);
  assert.deepEqual(parsed.metadata.imageUrls, ['https://official.example/venue.png','https://images.example/venue.png']);
});

function pngHeader(): Buffer { const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(640,16); bytes.writeUInt32BE(480,20); return bytes; }
test('official candidates become decoded bounded previews but never visually verified', async () => {
  const validPng = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  const requests: string[] = [];
  const result = await acquireAssets({ packs: { 'places-experiences': [place('exp-1')] }, evidence: [source()] }, {
    officialHosts: ['official.example'], pageTransport: async (request) => { requests.push(request.url); return { bytes: validPng, contentType: 'image/png' }; } });
  assert.deepEqual(requests, ['https://images.example/venue.png']); assert.equal(result.assets[0].status, 'downloaded_unreviewed');
  assert.equal(result.assets[0].sourceIdentityBound, false); assert.equal(result.assets[0].visuallyConfirmed, false); assert.equal(result.assets[0].watermarkChecked, false);
  assert.ok(result.assets[0].dataBase64); assert.match(result.assets[0].sha256!, /^[a-f\d]{64}$/);
  const decoded = await sharp(Buffer.from(result.assets[0].dataBase64!, 'base64')).metadata();
  assert.equal(decoded.format, 'webp'); assert.equal(decoded.width, 640); assert.equal(result.assets[0].mime, 'image/webp');
  assert.match(result.assets[0].reason!, /visual review/);
});

test('unapproved official hosts, invented image URLs and search snippets never trigger image downloads', async () => {
  for (const option of ['unapproved','invented','snippet'] as const) {
    const evidence = source(); const candidate = place('exp-1');
    if (option === 'invented') candidate.images[0].download_url = 'https://arbitrary.example/image.png';
    if (option === 'snippet') evidence.retrievalStatus = 'snippet_only';
    const result = await acquireAssets({ packs: { 'places-experiences': [candidate] }, evidence: [evidence] }, {
      officialHosts: option === 'unapproved' ? [] : ['official.example'], pageTransport: async () => { assert.fail('not an authorized source image'); } });
    assert.equal(result.assets[0].status, 'pending');
  }
});

test('image spoofing, tiny dimensions and oversized bytes fail closed', async () => {
  assert.equal(imageDimensions(Buffer.from('<html>fake image</html>'), 'image/png'), null);
  for (const bytes of [Buffer.from('<html>fake image</html>'), Buffer.alloc(RESEARCH_LIMITS.imageBytes + 1)]) {
    const result = await acquireAssets({ packs: { 'places-experiences': [place('exp-1')] }, evidence: [source()] }, {
      officialHosts: ['official.example'], pageTransport: async () => ({ bytes, contentType: 'image/png' }) });
    assert.equal(result.assets[0].status, 'failed'); assert.equal(result.assets[0].visuallyConfirmed, false);
  }
});

test('aborted outline/research requests cause no network or paid ledger action', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateOutline({ ...context, constraints, request: '', signal: controller.signal, runOperation: async () => { assert.fail('must not ledger'); } }), /cancelled/);
  await assert.rejects(acquireEvidence({ packId: 'framing', constraints, operationKey: 'fixture', runOperation, signal: controller.signal }), /cancelled/);
});

test('deterministic narrow edits invalidate only their owner; mixed, global, implicit and first-build changes invalidate all', () => {
  const current = { existingGuide: true };
  for (const [request, expected] of [['只调整第二天行程节奏', 'itinerary'], ['仅修改餐厅选择', 'places-food'], ['Only update shopping choices', 'places-shopping'], ['只修改语言短语措辞', 'modules-language-notes']] as const) {
    assert.deepEqual(classifyChangePacks(request, current), [expected]);
  }
  for (const request of ['只调整餐厅和购物', '修改第二天节奏', '只调整餐厅但增加预算', '重新规划全部行程', '只调整酒店', 'only optimize']) {
    assert.deepEqual(classifyChangePacks(request, current), PACK_IDS);
  }
  assert.deepEqual(classifyChangePacks('只调整餐厅', null), PACK_IDS);
});

test('full decoder rejects truncated raster headers, SVG and pixel bombs before preview embedding', async () => {
  await assert.rejects(decodeRaster(pngHeader(), 'image/png'), /valid JSON/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="red"/></svg>');
  await assert.rejects(decodeRaster(svg, 'image/svg+xml'));
  await assert.rejects(decodeRaster(svg, 'image/png'));
  const oversized = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  await assert.rejects(decodeRaster(oversized, 'image/png'), /valid JSON/);
  const small = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#aabbcc' } }).png().toBuffer();
  await assert.rejects(decodeRaster(small, 'image/png'));
});

test('new build epoch refetches URLs while preserving immutable receipts for reused packs', async () => {
  const existing = source(); let fetched = 0;
  const result = await acquireEvidence({ packId: 'places-core', constraints, operationKey: 'new-job:evidence', searchApiKey: 'fixture-search-key', existingSources: [existing], runOperation },
    { transport: async () => ({ web: { results: [{ title: 'Fixture City URL new run', url: existing.url }] } }), pageTransport: async () => { fetched++; return { bytes: Buffer.from('<p>Fresh facts</p>'), contentType: 'text/html' }; } });
  assert.equal(fetched, 1); assert.equal(result.sources.length, 2); assert.equal(result.sources[0].id, existing.id);
  assert.notEqual(result.sources[1].id, existing.id); assert.equal(result.sources[1].evidenceEpoch, 'new-job');
  assert.equal(result.sources[0].text, existing.text); assert.deepEqual(result.sources[0].packIds, ['places-experiences']);
});

test('malformed unclosed script and attribute text are parsed in bounded linear time', () => {
  const started = performance.now();
  for (const html of ['<script>'.repeat(74900), '<meta ' + 'a'.repeat(590000), ('<meta ' + 'a'.repeat(9000) + '>').repeat(60)]) {
    inspectSourcePage(Buffer.from(html), 'text/html', 'https://official.example/venue');
  }
  assert.ok(performance.now() - started < 1500, 'malformed-page parsing exceeded safe test budget');
});

test('outline edits exclude prior artifact image bytes and full source HTML from model context', () => {
  const compact = compactCurrentForOutline({ profile: { display_name: '测试城市', itinerary: [{ date: '2026-10-01', theme: '老城', summary: '散步', stops: [{ place_id: 'p1', arrival_time: '09:00' }] }], places: [{ id: 'p1', display_name: '测试场所' }] },
    assets: [{ dataBase64: 'large-image-secret-fixture' }], sources: [{ text: 'full-html-fixture' }] });
  assert.equal(JSON.stringify(compact).includes('large-image-secret-fixture'), false);
  assert.equal(JSON.stringify(compact).includes('full-html-fixture'), false);
  assert.equal((compact as any).days[0].stops[0].name, '测试场所');
});
