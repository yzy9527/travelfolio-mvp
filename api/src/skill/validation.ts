import { createHash } from 'node:crypto';
import { safeLink } from './schemas';
import type { AssetEvidence, DestinationProfile, ItineraryDay, Place, SourceEvidence, ValidationIssue } from './types';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
export function sha256(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex'); }
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const validIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const fields = (o: Record<string, unknown>, keys: string[]) => keys.filter(k => typeof o[k] !== 'string' || !(o[k] as string).trim());

export function inspectProfile(profile: DestinationProfile, evidence: { sources: SourceEvidence[]; mode: 'live' | 'fixture' }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, path: string, message: string, severity: 'error' | 'warning' = 'error') => issues.push({ code, path, message, severity });
  const p = profile, places = new Map(p.places.map(place => [place.id, place])), sources = new Map(evidence.sources.map(source => [source.id, source]));
  if (sources.size !== evidence.sources.length) add('DUPLICATE_SOURCE', '/sources', 'Source IDs must be unique');
  if (places.size !== p.places.length) add('DUPLICATE_PLACE', '/places', 'A place must be owned exactly once');
  for (const s of evidence.sources) {
    if (!safeLink(s.url) || !s.id || !s.title || Number.isNaN(Date.parse(s.retrievedAt))) add('SOURCE_RECEIPT', '/sources', 'Source evidence needs a safe URL, identity and actual retrieval timestamp');
  }
  const source = (sourceId: string, path: string, url?: string) => {
    if (evidence.mode === 'fixture') return;
    const receipt = sources.get(sourceId);
    if (!receipt) add('UNKNOWN_SOURCE', path, 'Reference does not match trusted retrieved source evidence');
    else if (url && safeLink(url) !== safeLink(receipt.url)) add('SOURCE_URL_MISMATCH', path, 'Reference URL differs from the trusted source receipt');
  };
  const resolve = (placeId: string, path: string, kind?: string) => {
    const place = places.get(placeId);
    if (!place) add('DANGLING_PLACE', path, `Unknown place reference: ${placeId}`);
    else if (kind && place.type !== kind) add('PLACE_TYPE', path, `Expected ${kind}, found ${place.type}`);
    return place;
  };
  if (p.itinerary.length !== p.trip.days) add('DAY_COUNT', '/itinerary', 'One itinerary day is required for every trip day');
  const dates = p.itinerary.map(d => d.date);
  const calendar = Boolean(p.trip.start_date || p.trip.end_date);
  if (calendar && (!validIso(p.trip.start_date) || !validIso(p.trip.end_date))) add('TRIP_DATES', '/trip', 'Trip dates must both be real ISO calendar dates or both empty');
  const expected = Array.from({ length: p.trip.days }, (_, i) => calendar && validIso(p.trip.start_date) ? new Date(Date.parse(p.trip.start_date) + i * 86400000).toISOString().slice(0, 10) : `Day ${i + 1}`);
  if (dates.some((d, i) => d !== expected[i]) || (calendar && expected.at(-1) !== p.trip.end_date)) add('DAY_DATES', '/itinerary', 'Itinerary must cover trip dates exactly, in chronological order');
  if (p.transport.status === 'pending' && p.transport.legs.length || p.transport.status === 'confirmed' && !p.transport.legs.length) add('TRANSPORT_STATE', '/transport', 'Pending transport has no legs; confirmed transport requires complete legs');
  for (const [i, stay] of p.stays.entries()) {
    if (stay.status === 'pending') {
      if (stay.place_id || stay.check_in || stay.check_out) add('PENDING_STAY', `/stays/${i}`, 'Pending stays must not invent a property or dates');
    } else {
      if (!stay.place_id || !stay.check_in || !stay.check_out) add('CONFIRMED_STAY', `/stays/${i}`, 'Confirmed stay requires property and dates');
      if (stay.place_id) resolve(stay.place_id, `/stays/${i}`, 'hotel');
      if (stay.check_in && stay.check_out && stay.check_out < stay.check_in) add('STAY_DATES', `/stays/${i}`, 'Checkout cannot precede check-in');
    }
  }
  const phaseDays = p.journey_phases?.flatMap(phase => phase.day_numbers) ?? [];
  if (phaseDays.length && (phaseDays.length !== p.trip.days || [...phaseDays].sort((a, b) => a - b).some((n, i) => n !== i + 1))) add('PHASE_COVERAGE', '/journey_phases', 'Phases must cover every day exactly once');
  if (p.places.filter(x => x.type === 'sight').length < 8) add('SIGHT_FLOOR', '/places', 'At least eight researched sights are required');
  const usedPhotos = new Map<string, string>();
  for (const [i, place] of p.places.entries()) {
    const path = `/places/${i}`;
    place.source_ids.forEach(s => source(s, `${path}/source_ids`));
    if (evidence.mode === 'live' && !place.source_ids.some(id => sources.get(id)?.url === place.source_url)) add('PLACE_PROVENANCE', `${path}/source_url`, 'Place source URL must be one of its retrieved sources');
    if (place.official_url && evidence.mode === 'live' && !evidence.sources.some(s => s.url === place.official_url)) add('OFFICIAL_PROVENANCE', `${path}/official_url`, 'Official URL must be supplied by trusted source retrieval');
    if (place.coordinate_source) source(place.coordinate_source.source_id, `${path}/coordinate_source`, place.coordinate_source.url);
    if ((place.latitude == null) !== (place.longitude == null)) add('COORDINATE_PAIR', path, 'Coordinates must be a complete latitude/longitude pair');
    if (place.same_place_as) {
      const original = resolve(place.same_place_as, `${path}/same_place_as`);
      if (original && (original.id === place.id || original.same_place_as || place.latitude == null || original.latitude == null || place.longitude == null || original.longitude == null || Math.abs(place.latitude - original.latitude) > .0001 || Math.abs(place.longitude - original.longitude) > .0001)) add('SAME_PLACE', path, 'Same-place relationship requires an original distinct record and matching verified coordinates');
    }
    if (place.type === 'souvenir') {
      if (fields(place as unknown as Record<string, unknown>, ['why_buy', 'best_for', 'where_to_buy', 'buying_tip']).length) add('SOUVENIR_ADVICE', path, 'Concrete souvenir must explain why, for whom, where and buying checks');
      if (!place.images.length && !place.text_only_reason) add('SOUVENIR_IMAGE_GAP', path, 'Text-only souvenir requires a recorded bounded search outcome or explicit user choice');
    }
    if (place.type === 'restaurant') {
      if (fields(place as unknown as Record<string, unknown>, ['cuisine', 'venue_type', 'signature_dishes', 'per_person']).length) add('RESTAURANT_FIELDS', path, 'Restaurant requires cuisine, venue type, concrete signature dishes and per-person price basis');
    }
    if (place.type === 'experience' && (!place.experience_type || !place.route_fit)) add('EXPERIENCE_FIELDS', path, 'Experience must have controlled activity type and route fit');
    if (place.type === 'sight' && !place.gallery_featured && place.images.length > 1) add('UNREQUESTED_GALLERY', path, 'Only explicitly featured sights receive multiple images');
    const imageFiles = new Set<string>();
    for (const image of place.images) {
      if (imageFiles.has(image.file)) add('DUPLICATE_GALLERY', `${path}/images`, 'A gallery must contain genuinely distinct files');
      imageFiles.add(image.file); source(image.source_id, `${path}/images`, image.source_page);
      if (image.media_class !== image.original_media_class) add('MEDIA_CLASS', `${path}/images`, 'An adaptation cannot silently relabel original media');
      const existingId = usedPhotos.get(image.file);
      if (existingId && existingId !== place.id) {
        const existing = places.get(existingId)!;
        const same = place.same_place_as === existing.id || existing.same_place_as === place.id || (place.same_place_as && place.same_place_as === existing.same_place_as);
        const original = existing.images.find(x => x.file === image.file);
        if (!same || original?.source_page !== image.source_page || original?.download_url !== image.download_url) add('IMAGE_REUSE', `${path}/images`, 'Independent venues cannot reuse one photo; exact-place aliases must preserve provenance');
      } else usedPhotos.set(image.file, place.id);
    }
    for (const rating of place.ratings ?? []) {
      source(rating.source_id, `${path}/ratings`, rating.source_url);
      if (evidence.mode === 'live') {
        const hostname = new URL(rating.source_url).hostname;
        if (!/(^|\.)(google\.[a-z.]+|maps\.app\.goo\.gl)$/.test(hostname) || sources.get(rating.source_id)?.retrievedAt.slice(0, 10) !== rating.verified_at) add('RATING_RECEIPT', `${path}/ratings`, 'Google rating requires an exact Google source and matching actual retrieval date');
      }
    }
  }
  const scheduled = new Set<string>(); const photoPayloads = new Set<string>();
  let interestStops = 0, discretionaryStops = 0;
  for (const [di, day] of p.itinerary.entries()) {
    const path = `/itinerary/${di}`;
    const names: string[] = [];
    for (const [si, stop] of day.stops.entries()) {
      scheduled.add(stop.place_id);
      const place = resolve(stop.place_id, `${path}/stops/${si}`);
      if (place) {
        names.push(place.display_name, place.local_name);
        if (place.type === 'souvenir') add('SOUVENIR_STOP', `${path}/stops/${si}`, 'Souvenir products are not route places');
        if (place.latitude == null || place.longitude == null || !place.coordinate_source) add('SCHEDULE_COORDINATES', `${path}/stops/${si}`, 'Scheduled place needs source-bound coordinates; never infer a district pin', stop.distance_basis==='unconfirmed'?'warning':'error');
        if (!['transport', 'hotel', 'other'].includes(place.type)) {
          discretionaryStops++;
          if (place.interest_tags.some(tag => p.trip.interests.some(interest => tag.toLowerCase().includes(interest.toLowerCase()) || interest.toLowerCase().includes(tag.toLowerCase())))) interestStops++;
        }
      }
      if (si && minutes(stop.arrival_time) < minutes(day.stops[si - 1].arrival_time) + day.stops[si - 1].dwell_minutes + stop.transfer_minutes) add('TIMELINE_OVERLAP', `${path}/stops/${si}`, 'Arrival precedes previous arrival + dwell + this incoming transfer');
      if (minutes(stop.arrival_time) + stop.dwell_minutes > 1440) add('OVERNIGHT_REVIEW', `${path}/stops/${si}`, 'Overnight stops need explicit schedule review instead of automatic approval');
      if (!/\d|分钟|半小时|小时/.test(stop.time_guard)) add('TIME_GUARD', `${path}/stops/${si}/time_guard`, 'Time guard needs a measurable departure, queue, shortening or buffer boundary');
      if (/^(根据体力调整|注意安全|拍照打卡)[。！!]*$/.test(stop.practical_note)) add('GENERIC_STOP_NOTE', `${path}/stops/${si}`, 'Practical advice must change an action at this place');
    }
    const photo = day.photo_advice, copy = photo.shooting_plan.map(x => `${x.title} ${x.note}`).join(' ');
    const technique = photo.shooting_plan.map(x => x.note).join(' ');
    if (!technique.includes('手机') || !technique.includes('相机') || !/(?:0\.5|1|2)[×xX]|镜头/.test(technique) || !/mm|毫米|焦距/.test(technique)) add('PHOTOGRAPHY_TECHNIQUE', `${path}/photo_advice`, 'Shooting notes must distinguish actionable phone lens and camera focal-length technique');
    if (!names.some(name => copy.includes(name))) add('PHOTOGRAPHY_ROUTE', `${path}/photo_advice`, 'Shooting plan must name a scheduled place');
    const photoHash = sha256(photo);
    if (photoPayloads.has(photoHash)) add('REPEATED_PHOTOGRAPHY', `${path}/photo_advice`, 'Every day needs distinct route-specific photography');
    photoPayloads.add(photoHash);
  }
  if (p.trip.interests.length && discretionaryStops && interestStops / discretionaryStops < 2 / 3) add('INTEREST_ALIGNMENT_REVIEW', '/itinerary', 'Fewer than roughly two thirds of discretionary stops have matching interest tags; review selection against actual preferences', 'warning');
  const availableSights = p.places.filter(place => place.type === 'sight');
  if (availableSights.filter(place => scheduled.has(place.id)).length < Math.min(availableSights.length, p.trip.days)) add('SIGHT_ROUTE_FLOOR', '/itinerary', 'Schedule at least one distinct first-visit sight per day where the researched inventory allows');
  const discovery = p.module_groups;
  for (const [key, kind] of [['shopping', 'shop'], ['experiences', 'experience']] as const) {
    const refs = discovery[key].flatMap(group => group.items);
    if (new Set(refs.map(x => x.place_id)).size !== refs.length) add('DUPLICATE_MODULE_PLACE', `/module_groups/${key}`, 'Each option occurs only once in a module');
    discovery[key].forEach((group, gi) => group.items.forEach(ref => {
      const place = resolve(ref.place_id, `/module_groups/${key}/${gi}`, kind);
      if (key === 'experiences' && group.experience_types?.length && place?.experience_type && !group.experience_types.includes(place.experience_type)) add('EXPERIENCE_TAXONOMY', `/module_groups/${key}/${gi}`, 'Group activity types must match its records');
    }));
  }
  const mode = p.trip.experience_mode ?? 'standard', groups = discovery.experiences.length, count = discovery.experiences.reduce((s, g) => s + g.items.length, 0);
  if (mode === 'standard' && (groups !== 3 || count !== 6) || mode === 'constrained' && (groups !== 2 || count !== 4) || mode === 'expanded' && (groups < 3 || count < 6)) add('EXPERIENCE_COUNTS', '/module_groups/experiences', 'Experience inventory does not match the explicit standard/constrained/expanded mode');
  const experienceTypes = new Set(discovery.experiences.flatMap(g => g.items).map(ref => places.get(ref.place_id)?.experience_type).filter(Boolean));
  if (experienceTypes.size < (mode === 'constrained' ? 2 : 3)) add('EXPERIENCE_VARIETY', '/module_groups/experiences', 'Activity selection requires distinct researched experience types, not relabeled duplicates');
  const food = discovery.food;
  const dedicated = new Set(food.dedicated_trip.map(x => x.place_id)), chains = new Set(food.reliable_chains.map(x => x.place_id));
  if (dedicated.size !== food.dedicated_trip.length || chains.size !== food.reliable_chains.length || [...dedicated].some(id => chains.has(id))) add('FOOD_DISJOINT', '/module_groups/food', 'Dedicated restaurants and chain branches must be unique and disjoint');
  [...dedicated, ...chains].forEach(id => resolve(id, '/module_groups/food', 'restaurant'));
  if ((p.places.filter(place=>place.type==='restaurant').length<8 || dedicated.size<6) && !food.inventory_limit_reason?.trim()) add('FOOD_INVENTORY_LIMIT', '/module_groups/food', 'Insufficient researched restaurants requires an explicit evidence limitation; never invent records');
  if(food.inventory_limit_reason?.trim())add('FOOD_INVENTORY_LIMIT','/module_groups/food',food.inventory_limit_reason,'warning');
  if (new Set([...dedicated].map(id => places.get(id)?.cuisine).filter(Boolean)).size < Math.min(4,dedicated.size)) add('CUISINE_FLOOR', '/module_groups/food/dedicated_trip', 'Dedicated restaurant cuisine variety is limited; see the explicit inventory limitation', food.inventory_limit_reason?.trim() ? 'warning' : 'error');
  if (p.trip.days >= 3 && [...dedicated].filter(id => scheduled.has(id)).length < 3) add('DINING_ROUTE', '/itinerary', 'Fewer than three dedicated restaurants are scheduled; remaining meals require confirmation', food.inventory_limit_reason?.trim() ? 'warning' : 'error');
  for (const id of chains) if (!places.get(id)?.chain_evidence) add('CHAIN_IDENTITY', `/places/${id}`, 'Chain fallback needs evidence of a locally established chain and exact branch');
  if (chains.size < 4 && !food.chain_limit_reason) add('CHAIN_LIMIT', '/module_groups/food', 'Fewer than four chains requires explicit narrower scope or a documented suitability limit');
  for (const [i, meal] of (p.dining_plan ?? []).entries()) {
    const day = p.itinerary.find(d => d.date === meal.date);
    if (!day || meal.place_id && !day.stops.some(s => s.place_id === meal.place_id) || !meal.place_id && !meal.flexible) add('MEAL_BINDING', `/dining_plan/${i}`, 'Named meals must match the same-date scheduled restaurant; unassigned meals must explicitly be flexible');
    if (meal.place_id) resolve(meal.place_id, `/dining_plan/${i}`, 'restaurant');
  }
  if (discovery.preparation.essentials.length + discovery.preparation.confirm_ahead.length < Math.max(24, p.trip.days * 3)) add('PREPARATION_FLOOR', '/module_groups/preparation', 'Preparation requires at least max(24, days * 3) useful items');
  const lang = discovery.language;
  for (const group of [...lang.english_keyword_groups]) for (const item of group.items) if (!/[A-Za-z]/.test(item.term)) add('ENGLISH_TERM', '/module_groups/language', 'English fallback must contain English terms');
  if (/^(Japan|日本)$/i.test(p.country)) for (const group of [...lang.keyword_groups, ...lang.phrase_groups]) for (const item of group.items) {
    if (!item.reading || item.reading === item.term || !/[A-Za-z]/.test(item.reading) || /\bromaji\b/i.test(item.reading)) add('JAPANESE_READING', '/module_groups/language', 'Japanese terms and phrases need useful romaji readings');
  }
  if (new Set(discovery.travel_notes.map(n => n.category)).size !== 5) add('NOTE_CATEGORIES', '/module_groups/travel_notes', 'Local notes must cover weather, culture, transport, safety and payment exactly once');
  for (const [i, group] of discovery.travel_notes.entries()) for (const [j, note] of group.items.entries()) {
    if (/^(提示|当地交通|天气|文化|安全|支付)\s*\d+$/.test(note.title)) add('GENERIC_NOTE_TITLE', `/module_groups/travel_notes/${i}/items/${j}`, 'Use natural, decision-oriented topic headings');
    if (note.source_ids) note.source_ids.forEach(s => source(s, `/module_groups/travel_notes/${i}/items/${j}/source_ids`));
  }
  return issues;
}

export function safeRaster(asset: AssetEvidence): boolean {
  if (!asset.dataBase64 || !asset.mime || !asset.sha256 || !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.dataBase64) || asset.dataBase64.length > 12_000_000) return false;
  const bytes = Buffer.from(asset.dataBase64, 'base64');
  if (bytes.toString('base64') !== asset.dataBase64 || createHash('sha256').update(bytes).digest('hex') !== asset.sha256 || asset.bytes !== bytes.length) return false;
  const png = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.length > 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const gif = bytes.length > 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
  return asset.mime === 'image/png' && png || asset.mime === 'image/jpeg' && jpeg || asset.mime === 'image/webp' && webp || asset.mime === 'image/gif' && gif;
}
export function assetReviewed(asset: AssetEvidence): boolean {
  const r = asset.review;
  return asset.status === 'reviewed' && safeRaster(asset) && (asset.width ?? 0) > 0 && (asset.height ?? 0) > 0 && asset.sourceIdentityBound && asset.visuallyConfirmed && asset.watermarkChecked && Boolean(r && r.sha256 === asset.sha256 && r.sourcePage === asset.sourcePage && r.file === asset.file && r.toolReference.trim() && r.note.trim() && !Number.isNaN(Date.parse(r.checkedAt)));
}

/** Exact receipt shape used by the controlled capture adapter; changed route geometry invalidates old images. */
export function routeCaptureHash(day: ItineraryDay, places: Map<string, Place>): string | null {
  const stops = [];
  for (const [index, stop] of day.stops.entries()) {
    const p = places.get(stop.place_id);
    if (!p || p.latitude == null || p.longitude == null || !p.coordinate_source) return null;
    stops.push({ placeId: p.id, name: p.display_name.slice(0, 80), latitude: p.latitude, longitude: p.longitude, number: index + 1, sourceId: p.coordinate_source.source_id, sourceUrl: p.coordinate_source.url });
  }
  return sha256(JSON.stringify({ date: day.date, stops }));
}
export function currentMapAsset(asset: AssetEvidence, day: ItineraryDay, places: Map<string, Place>): boolean {
  return asset.kind === 'route-map' && asset.day === day.date && safeRaster(asset) && Boolean(asset.capture && asset.capture.routeHash === routeCaptureHash(day, places) && asset.capture.resources.length && asset.capture.viewport.width > 0 && asset.capture.viewport.height > 0 && !Number.isNaN(Date.parse(asset.capture.capturedAt)));
}
