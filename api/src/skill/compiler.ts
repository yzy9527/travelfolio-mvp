import { itinerarySchema, type Itinerary } from '../schemas';
import { PACK_IDS, type CompileOptions, type CompiledGuide, type DestinationProfile, type QaEvidence, type ResearchPacks, type ValidationIssue } from './types';
import { validatePack, SkillValidationError } from './schemas';
import { assetReviewed, canonicalJson, currentMapAsset, inspectProfile, sha256 } from './validation';
import { COMPILER_VERSION, RENDERER_VERSION, UPSTREAM_COMMIT, UPSTREAM_REPOSITORY } from './provenance';

const BROWSER_CHECKS = ['desktop_layout', 'mobile_layout', 'no_horizontal_overflow', 'disclosures', 'trip_mode', 'trip_day_switch'];
const OFFLINE_CHECKS = ['chapter_navigation', 'disclosures', 'trip_mode', 'trip_day_switch', 'map_viewer'];
function currentQa(records: QaEvidence[], scope: 'browser' | 'offline', fingerprint: string, checks: string[]): boolean {
  return records.some(r => r.scope === scope && r.fingerprint === fingerprint && r.status === 'passed' && r.toolReference.trim() && !Number.isNaN(Date.parse(r.checkedAt)) && checks.every(key => r.checks[key]?.passed === true && r.checks[key].note.trim()));
}

export function compileGuide(input: ResearchPacks, options: CompileOptions): CompiledGuide {
  const packs = Object.fromEntries(PACK_IDS.map(id => [id, validatePack(id, input[id])])) as unknown as ResearchPacks;
  const framing = packs.framing, discovery = packs['modules-discovery'], practical = packs['modules-practical'], language = packs['modules-language-notes'];
  if (discovery.experience_mode !== 'standard' && !discovery.experience_mode_reason) throw new SkillValidationError([{ code: 'EXPERIENCE_MODE_REASON', path: '/modules-discovery/experience_mode_reason', severity: 'error', message: 'Constrained mode needs documented failed candidates; expanded mode needs an explicit traveler request' }]);
  const profile: DestinationProfile = {
    ...framing, trip: { ...framing.trip, experience_mode: discovery.experience_mode },
    journey_phases: framing.journey_phases?.length ? framing.journey_phases : [{ title: `${framing.trip.days} 天行程`, day_numbers: packs.itinerary.map((_, i) => i + 1) }],
    itinerary: packs.itinerary,
    places: [...packs['places-core'].sights, ...packs['places-core'].support, ...packs['places-shopping'].shops, ...packs['places-shopping'].souvenirs, ...packs['places-experiences'], ...packs['places-food']],
    module_groups: { shopping: discovery.shopping, experiences: discovery.experiences, food: practical.food, preparation: practical.preparation, language: language.language, travel_notes: language.travel_notes },
  };
  const issues = inspectProfile(profile, options);
  const families = [['places-core', packs['places-core'].sights, 'sight'], ['places-shopping', packs['places-shopping'].shops, 'shop'], ['places-shopping', packs['places-shopping'].souvenirs, 'souvenir'], ['places-experiences', packs['places-experiences'], 'experience'], ['places-food', packs['places-food'], 'restaurant']] as const;
  for (const [pack, records, type] of families) if (records.some(record => record.type !== type)) issues.push({ code: 'PACK_PLACE_TYPE', path: `/${pack}`, severity: 'error', message: `Owning pack must contain ${type} records` });
  const fixtureDetected = /(?:fixture\.invalid|example\.com|"test_fixture"|generated-fixture|local-regression-fixture|smoke_test)/i.test(canonicalJson(packs) + canonicalJson(options.sources));
  if (options.mode === 'live' && fixtureDetected) issues.push({ code: 'FIXTURE_IN_LIVE', path: '/', severity: 'error', message: 'Synthetic fixture content cannot be compiled as live research' });
  if (options.mode === 'live' && !options.sources.length) issues.push({ code: 'RESEARCH_MISSING', path: '/sources', severity: 'error', message: 'Live guide requires trusted retrieval evidence; model memory is not research' });
  if (Number.isNaN(Date.parse(options.generatedAt))) issues.push({ code: 'BUILD_TIMESTAMP', path: '/', severity: 'error', message: 'Build timestamp must be a valid actual timestamp' });
  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length) throw new SkillValidationError(errors);
  const sources = structuredClone(options.sources), assets = structuredClone(options.assets ?? []);
  const provenance = {
    compiler: 'compileGuide', compilerVersion: COMPILER_VERSION, upstreamRepository: UPSTREAM_REPOSITORY, upstreamCommit: UPSTREAM_COMMIT,
    mode: options.mode, generatedAt: options.generatedAt,
    packHashes: Object.fromEntries(PACK_IDS.map(id => [id, sha256(packs[id])])) as CompiledGuide['provenance']['packHashes'],
    profileHash: sha256(profile), sourcesHash: sha256(sources), assetsHash: sha256(assets.map(({ dataBase64: _bytes, ...receipt }) => receipt)), fixtureDetected,
  };
  const fingerprint = sha256({ profileHash: provenance.profileHash, sourcesHash: provenance.sourcesHash, assetsHash: provenance.assetsHash, compiler: COMPILER_VERSION, renderer: RENDERER_VERSION, mode: options.mode });
  const pending = (code: string, path: string, message: string) => issues.push({ code, path, severity: 'warning', message });
  let mediaReady = true;
  for (const place of profile.places) {
    if (['transport', 'other'].includes(place.type) || place.type === 'souvenir' && !place.images.length) continue;
    const required = place.type === 'hotel' || place.gallery_featured ? 2 : 1;
    const reviewed = place.images.filter(image => assets.some(a => a.kind === 'place-image' && a.placeId === place.id && a.file === image.file && a.sourceId === image.source_id && a.sourcePage === image.source_page && a.downloadUrl === image.download_url && assetReviewed(a)));
    if (reviewed.length < required) { mediaReady = false; pending('MEDIA_PENDING', `/places/${place.id}/images`, `Requires ${required} exact-place raster image(s) with independent hash-bound visual review`); }
  }
  if (!profile.cover.image || !assets.some(a => a.file === profile.cover.image && assetReviewed(a) && (a.kind === 'cover' || profile.cover.derived_from === a.file))) { mediaReady = false; pending('COVER_PENDING', '/cover/image', 'Cover needs source-bound image review; no decorative substitute is asserted'); }
  const placeIndex = new Map(profile.places.map(place => [place.id, place]));
  const mapsReady = profile.itinerary.every(day => assets.some(a => currentMapAsset(a, day, placeIndex) && assetReviewed(a)));
  if (!mapsReady) pending('MAPS_PENDING', '/itinerary', 'One genuine reviewed full-day street-map capture per day is required; the ordered route list is not an offline map');
  const browserReady = currentQa(options.qaEvidence ?? [], 'browser', fingerprint, BROWSER_CHECKS);
  if (!browserReady) pending('BROWSER_QA_PENDING', '/qa/browser', 'Desktop/mobile layout and actual interactions have not been accepted for these exact build inputs');
  pending('OFFLINE_QA_PENDING', '/qa/offline', 'The exact exported HTML requires separate hash-bound browser acceptance');
  const fixture = options.mode === 'fixture';
  return { profile, provenance, sources, assets, qa: {
    status: fixture ? 'fixture' : mediaReady && mapsReady ? 'waiting_for_review' : 'preview_ready', handoffAllowed: false,
    content: fixture ? 'fixture' : 'passed', research: fixture ? 'fixture' : 'passed', media: fixture ? 'fixture' : mediaReady ? 'passed' : 'pending', maps: fixture ? 'fixture' : mapsReady ? 'passed' : 'pending', browser: fixture ? 'fixture' : browserReady ? 'passed' : 'pending', offline: fixture ? 'fixture' : 'pending', fingerprint, issues,
  } };
}

/** Hash actual export bytes; code inspection or fixture tests are not export acceptance. */
export function assessOfflineQa(guide: CompiledGuide, html: string, records: QaEvidence[] = []): { artifactHash: string; qa: CompiledGuide['qa'] } {
  const artifactHash = sha256(html), qa = structuredClone(guide.qa);
  if (guide.provenance.mode === 'fixture') return { artifactHash, qa };
  if (currentQa(records, 'offline', artifactHash, OFFLINE_CHECKS)) {
    qa.offline = 'passed'; qa.issues = qa.issues.filter(i => i.code !== 'OFFLINE_QA_PENDING');
  }
  if ([qa.content, qa.research, qa.media, qa.maps, qa.browser, qa.offline].every(status => status === 'passed')) { qa.handoffAllowed = true; qa.status = 'complete'; }
  return { artifactHash, qa };
}

/** Compatibility projection only; the complete handbook remains the version's canonical skill document. */
export function toLegacyItinerary(guide: CompiledGuide): Itinerary {
  const p = guide.profile, places = new Map(p.places.map(x => [x.id, x]));
  const legacySources = guide.sources.slice(0, 20).map(s => ({ id: s.id, title: s.title, url: s.url, retrievedAt: s.retrievedAt }));
  const legacySourceIds = new Set(legacySources.map(s => s.id));
  const mode = guide.provenance.mode === 'fixture' ? 'demo' : 'live_search';
  return itinerarySchema.parse({
    title: `${p.display_name} · ${p.cover.title}`.slice(0, 160), summary: p.cover.summary,
    days: p.itinerary.map(day => ({ date: day.date, title: day.theme.slice(0, 160), summary: day.summary, activities: day.stops.slice(0, 12).map(stop => {
      const place = places.get(stop.place_id)!;
      return { time: stop.arrival_time, title: place.display_name.slice(0, 160), description: `${stop.rationale}\n${stop.practical_note}`.slice(0, 4000), location: place.map_query.slice(0, 240), transport: `${stop.transport_mode} · ${stop.transfer_minutes} 分钟 · ${stop.distance_km} km`.slice(0, 500), estimatedCost: typeof stop.estimated_cost === 'number' ? stop.estimated_cost : 0, bookingNote: `${stop.time_guard}；${place.price_note}`.slice(0, 1000), sourceIds: place.source_ids.filter(id => legacySourceIds.has(id)).slice(0, 10) };
    }) })),
    budget: [{ category: '预算上限参考', amount: p.trip.budget, note: '全员总预算上限；不是已核实报价。具体支出以各场所价格说明为准，尚不构成精确预算分项。' }],
    packing: p.module_groups.preparation.essentials.slice(0, 30).map(x => `${x.priority} · ${x.title}：${x.note}`.slice(0, 400)),
    notes: [guide.provenance.mode === 'fixture' ? '合成测试演示：场所、路线及语言条目不是真实旅行建议，未调用检索。' : '内容来自独立检索记录；来源关联不等于每项事实已人工核验，价格、开放时间及可订状态请预订前确认。', ...guide.qa.issues.slice(0, 20).map(i => i.message)],
    sources: legacySources,
    verification: { mode, notice: mode === 'demo' ? '合成演示数据，不能用于实际出行。没有实时检索、图片审核或浏览器验收。' : `八模块研究手册；${guide.qa.handoffAllowed ? '已完成当前版本验收' : '预览，图片、地图或浏览器验收仍可能待完成'}。未确认实时库存、票价或天气。`, researchedAt: mode === 'demo' ? null : guide.provenance.generatedAt },
  });
}
