import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Browser, LaunchOptions, Route } from 'playwright-core';
import { captureRouteMaps, allowedMapUrl, sourceBoundMapStops, MAP_STYLE_URL } from '../src/skill/maps';
import type { ResearchPacks, Place, ItineraryDay } from '../src/skill/types';
import type { ResearchEvidence } from '../src/skill/tools';

// Browser and service transports are fixtures, not a claim of successful live map capture.
const evidence: ResearchEvidence = { id: 'src-map-fixture', url: 'https://official.example/venue', title: 'Fixture', retrievedAt: '2026-09-30T00:00:00Z',
  discoveredBy: 'brave_search', query: 'fixture', packIds: ['places-core'], retrievalStatus: 'page_retrieved', authority: 'unclassified', contentHash: 'a'.repeat(64),
  metadata: { title: 'Fixture Venue', description: '', imageUrls: [], entities: [{ name: 'Fixture Venue', latitude: 35, longitude: 139 }] } };
const place = { id: 'venue-1', display_name: '测试地点', local_name: 'Fixture Venue', latitude: 35, longitude: 139, source_ids: [evidence.id],
  coordinate_source: { source_id: evidence.id, url: evidence.url, note: 'Fixture exact coordinates', precision: 'area' } } as Place;
const day = { date: '2026-10-01', theme: '测试路线', stops: [{ place_id: place.id }] } as ItineraryDay;
const packs: Partial<ResearchPacks> = { 'places-core': { sights: [place], support: [] }, itinerary: [day] };

test('map fetch allowlist permits only fixed public HTTPS tile host', () => {
  assert.equal(allowedMapUrl(MAP_STYLE_URL), true);
  for (const url of ['https://tiles.openfreemap.org.evil.example/x', 'http://tiles.openfreemap.org/x', 'https://tiles.openfreemap.org:8443/x',
    'https://user:pass@tiles.openfreemap.org/x', 'https://127.0.0.1/x', 'data:text/html,evil', 'file:///etc/passwd', 'https://tiles.openfreemap.org/x#fragment']) assert.equal(allowedMapUrl(url), false, url);
});
test('source-bound pins require matching retrieved metadata, not model reference flags alone', () => {
  assert.equal(sourceBoundMapStops(day, packs, [evidence])?.length, 1);
  assert.equal(sourceBoundMapStops(day, packs, [{ id: evidence.id, url: evidence.url, title: evidence.title, retrievedAt: evidence.retrievedAt }]), null);
  assert.equal(sourceBoundMapStops(day, { ...packs, 'places-core': { sights: [{ ...place, latitude: 36 }], support: [] } }, [evidence]), null);
});
test('missing coordinates skip browser launch and report no screenshot coverage', async () => {
  const result = await captureRouteMaps({ packs, sources: [] }, { launch: async () => { assert.fail('must not launch for guessed pins'); } });
  assert.equal(result.assets[0].status, 'pending'); assert.equal(result.assets[0].dataBase64, undefined);
  assert.equal(result.failures[0].code, 'MAP_COORDINATES_REQUIRED');
});
test('sandboxed browser unavailability returns an honest pending map without retry or bypass', async () => {
  let launches = 0;
  const result = await captureRouteMaps({ packs, sources: [evidence], executablePath: '/usr/bin/chromium' }, { launch: async (options) => {
    launches++; assert.equal(options.chromiumSandbox, true); assert.equal(options.headless, true); assert.equal(options.args, undefined);
    throw new Error('EPERM fixture browser startup denied');
  } });
  assert.equal(launches, 1); assert.equal(result.assets[0].status, 'pending'); assert.equal(result.assets[0].dataBase64, undefined);
  assert.equal(result.failures[0].code, 'MAP_BROWSER_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('EPERM'), false);
});

test('unexpected browser request is blocked before HTTP transport; no substitute screenshot is saved', async () => {
  let routeHandler: ((route: Route) => Promise<void>) | undefined; let aborted = 0; let calls = 0;
  const browser = { newContext: async () => ({ route: async (_pattern: string, fn: (route: Route) => Promise<void>) => { routeHandler = fn; }, close: async () => {},
    newPage: async () => ({ setDefaultTimeout: () => {}, setContent: async () => {}, addStyleTag: async () => {}, addScriptTag: async () => {},
      evaluate: async (script: string) => { if (script.includes('const input=')) await routeHandler!({ request: () => ({ method: () => 'GET', url: () => 'https://127.0.0.1/secret' }), abort: async () => { aborted++; } } as unknown as Route);
        return { status: 'ready', labels: 1, tiles_loaded: true }; }, waitForFunction: async () => {}, screenshot: async () => { assert.fail('must not screenshot failed map'); } }),
  }), close: async () => {} } as unknown as Browser;
  const result = await captureRouteMaps({ packs, sources: [evidence] }, { launch: async () => browser, resourceTransport: async () => { calls++; assert.fail('must not send blocked host'); } });
  assert.equal(calls, 0); assert.equal(aborted, 1); assert.equal(result.assets[0].status, 'failed'); assert.equal(result.assets[0].dataBase64, undefined);
});

test('fixture browser capture requires tile load and makes decoded but explicitly unreviewed receipts', async () => {
  let routeHandler: ((route: Route) => Promise<void>) | undefined; let fulfilled = 0; const requests: string[] = [];
  const screenshot = await sharp({ create: { width: 1400, height: 1050, channels: 3, background: '#dddddd' } }).png().toBuffer();
  const browser = { newContext: async (options: any) => { assert.equal(options.serviceWorkers, 'block'); assert.equal(options.acceptDownloads, false); return {
    route: async (_pattern: string, fn: (route: Route) => Promise<void>) => { routeHandler = fn; }, close: async () => {},
    newPage: async () => ({ setDefaultTimeout: () => {}, setContent: async (html: string) => { assert.match(html, /OpenStreetMap contributors/); }, addStyleTag: async () => {}, addScriptTag: async () => {},
      evaluate: async (script: string) => { if (script.includes('const input=')) for (const url of [MAP_STYLE_URL, 'https://tiles.openfreemap.org/planet/14/123/456.pbf']) await routeHandler!({ request: () => ({ method: () => 'GET', url: () => url }), fulfill: async () => { fulfilled++; }, abort: async () => { assert.fail('safe fixture request'); } } as unknown as Route);
        return { status: 'ready', labels: 1, tiles_loaded: true }; }, waitForFunction: async () => {}, screenshot: async () => screenshot }),
  }; }, close: async () => {} } as unknown as Browser;
  const result = await captureRouteMaps({ packs, sources: [evidence] }, { launch: async (_options: LaunchOptions) => browser, resourceTransport: async (request) => {
    requests.push(request.url); assert.equal(request.kind, 'map'); assert.ok(request.signal); return { bytes: Buffer.from('{}'), contentType: request.url.endsWith('.pbf') ? 'application/x-protobuf' : 'application/json' }; } });
  assert.equal(requests.length, 2); assert.equal(fulfilled, 2); assert.equal(result.assets[0].status, 'downloaded_unreviewed');
  assert.equal(result.assets[0].kind, 'route-map'); assert.ok(result.assets[0].dataBase64); assert.equal(result.assets[0].visuallyConfirmed, false);
  assert.equal(result.assets[0].sourceIdentityBound, false); assert.match(result.assets[0].reason!, /not road routing/);
  assert.equal(result.assets[0].capture?.styleUrl, MAP_STYLE_URL); assert.match(result.assets[0].capture?.routeHash ?? '', /^[a-f\d]{64}$/);
  assert.deepEqual(result.assets[0].capture?.sourceIds, [evidence.id]); assert.equal(result.assets[0].capture?.resources.length, 2);
  assert.deepEqual(result.assets[0].capture?.viewport, { width: 1400, height: 1050 });
});
