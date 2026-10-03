import { z } from 'zod';
import { validateProviderBaseUrl } from '../safe-http';
import type { PackId, ResearchPacks } from './types';

/** Navigation validation only. Any network fetch must additionally resolve/pin public DNS. */
export function safeLink(value: string): string | null {
  try {
    if (!value || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
    const u = new URL(value);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || (u.port && !['443', '80'].includes(u.port))) return null;
    const base = new URL(u); base.protocol = 'https:'; base.port = ''; base.search = ''; base.hash = '';
    validateProviderBaseUrl(base.toString());
    return u.toString();
  } catch { return null; }
}
const txt = z.string().trim().min(1).max(4000);
const short = z.string().trim().min(1).max(300);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
const url = z.string().max(2048).refine(v => safeLink(v) !== null, 'must be a safe public HTTP(S) URL');
const localFile = z.string().max(200).regex(/^assets\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:png|jpe?g|webp|gif)$/i).refine(v => !v.includes('..') && !v.includes('//'), 'unsafe asset path');
const boundedList = z.array(short).max(30);
const dayDate = z.string().regex(/^(?:\d{4}-\d{2}-\d{2}|Day (?:[1-9]|1[0-4]))$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const integer = z.number().int().min(0).max(1440);
const priority = z.enum(['必须', '建议', '随缘']);
const experienceType = z.enum(['wellness', 'culture', 'craft', 'nature', 'adventure', 'performance', 'food_workshop', 'nightlife', 'urban_walk', 'food_culture', 'pop_culture', 'digital_art']);
const mediaClass = z.enum(['real_photo', 'official_photo', 'licensed_photo', 'official_brand_asset']);
export const imageDeclarationSchema = z.object({
  file: localFile, source_id: id, source_page: url, download_url: url.optional(),
  media_class: mediaClass, original_media_class: mediaClass,
  visual_subject_type: z.enum(['place_exterior', 'place_interior', 'room', 'dish', 'product', 'experience_scene', 'landscape', 'official_logo', 'official_share_card']),
  source_identity_note: txt,
}).strict();
export const placeSchema = z.object({
  id, type: z.enum(['hotel', 'sight', 'shop', 'souvenir', 'experience', 'restaurant', 'transport', 'other']),
  display_name: short, local_name: short, english_name: short.optional(), description: txt,
  area: short, address: txt.optional(), map_query: short, map_url: url.optional(), source_url: url, official_url: url.optional(), source_ids: z.array(id).min(1).max(12),
  latitude: z.number().finite().min(-90).max(90).optional(), longitude: z.number().finite().min(-180).max(180).optional(),
  coordinate_source: z.object({ source_id: id, url, note: txt, precision: z.enum(['entrance', 'building', 'area']) }).strict().optional(),
  hours: txt, closed_days: txt, duration_minutes: integer, best_time: txt, practical_tip: txt, price_note: txt,
  suggested_day: z.number().int().min(1).max(14).optional(), interest_tags: boundedList, images: z.array(imageDeclarationSchema).max(3),
  gallery_featured: z.boolean().optional(), same_place_as: id.optional(),
  ratings: z.array(z.object({ platform: z.literal('Google'), status: z.literal('verified'), rating: z.number().min(0).max(5), review_count: z.number().int().nonnegative().optional(), source_id: id, source_url: url, verified_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()).max(1).optional(),
  experience_type: experienceType.optional(), route_fit: txt.optional(), cuisine: short.optional(), venue_type: short.optional(), signature_dishes: txt.optional(), per_person: short.optional(), chain_evidence: txt.optional(),
  why_buy: txt.optional(), best_for: txt.optional(), where_to_buy: txt.optional(), buying_tip: txt.optional(), text_only_reason: txt.optional(),
}).strict();
const placeRef = z.object({ place_id: id }).strict();
const placeGroup = z.object({ title: short, subtitle: short, items: z.array(placeRef).min(1).max(30), experience_types: z.array(experienceType).max(12).optional() }).strict();
const period = z.object({ title: short, description: txt }).strict();
export const daySchema = z.object({
  date: dayDate, area: short, theme: short, summary: txt,
  periods: z.object({ morning: period, afternoon: period, evening: period }).strict(),
  stops: z.array(z.object({ place_id: id, arrival_time: clock, dwell_minutes: integer, transport_mode: short,
    transfer_minutes: integer, distance_km: z.number().finite().min(0).max(30000), distance_basis: z.enum(['route', 'coordinate_straight_line', 'unconfirmed']).optional(),
    estimated_cost: z.union([txt, z.number().finite().min(0).max(100000000)]), practical_note: txt.min(18), time_guard: txt.min(8), rationale: txt,
  }).strict()).min(2).max(20),
  fallback: txt.min(24), route_note: txt.optional(), shopping_advice: z.object({ title: short, description: txt.min(30) }).strict(),
  photo_advice: z.object({ title: short, lighting: txt, suitable_shots: z.array(txt).min(2).max(6), portrait_tip: txt,
    outfit_advice: z.object({ women: txt, men: txt, practical_note: txt }).strict(),
    shooting_plan: z.array(z.object({ time: short, title: short, note: txt }).strict()).min(2).max(3),
  }).strict(),
}).strict();
const checkItem = z.object({ title: short, note: txt, priority, timing: short.optional(), source_ids: z.array(id).max(12).optional() }).strict();
const chineseHeading = short.regex(/[\u3400-\u9fff]/).refine(v => !/(?:\(|（)\s*(?:English|英语)\s*(?:\)|）)|英语版|中英对照/i.test(v), 'plain Chinese scenario heading required');
const languageItem = z.object({ term: short, meaning: txt, reading: short.optional() }).strict();
const languageGroup = z.object({ title: chineseHeading, items: z.array(languageItem).length(5) }).strict();
const englishPhraseGroup = z.object({ title: chineseHeading, items: z.array(z.object({ sentence: txt.regex(/[A-Za-z]/), meaning: txt }).strict()).length(5) }).strict();
export const packSchemas = {
  framing: z.object({
    destination: short, display_name: short, country: short, year: z.string().regex(/^\d{4}$/),
    trip: z.object({ start_date: z.string().max(10), end_date: z.string().max(10), days: z.number().int().min(1).max(14), rhythm: z.enum(['relaxed', 'standard', 'full']), travelers: short, interests: boundedList, constraints: boundedList, quality_mode: z.literal('standard'), currency: z.string().regex(/^[A-Z]{3}$/), budget: z.number().finite().positive().max(100000000), experience_mode: z.enum(['standard', 'constrained', 'expanded']).optional() }).strict(),
    cover: z.object({ kicker: short, title: short.max(80), summary: txt, image: z.union([localFile, z.literal('')]), tags: boundedList, show_summary: z.boolean().optional(), source_id: id.optional(), source_page: url.optional(), derived_from: localFile.optional() }).strict(),
    transport: z.object({ status: z.enum(['pending', 'confirmed']), legs: z.array(z.object({ direction: short, date: dayDate, service_number: short, origin: short, destination: short, departure_time: clock, arrival_time: clock, mode: short.optional(), terminal: short.optional(), buffer_note: txt }).strict()).max(12) }).strict(),
    stays: z.array(z.object({ status: z.enum(['pending', 'confirmed']), place_id: id.nullable(), check_in: dayDate.nullable(), check_out: dayDate.nullable(), notes: txt }).strict()).min(1).max(14),
    journey_phases: z.array(z.object({ title: short, kicker: short.optional(), day_numbers: z.array(z.number().int().min(1).max(14)).min(1).max(14) }).strict()).max(14).optional(),
    dining_plan: z.array(z.object({ date: dayDate, meal: short, title: short, place_id: id.optional(), flexible: z.boolean().optional(), note: txt }).strict()).max(60).optional(),
    map_delivery: z.literal('screenshots'), render_bindings_file: z.literal('render-bindings.json'),
  }).strict(),
  'places-core': z.object({ sights: z.array(placeSchema).min(8).max(40), support: z.array(placeSchema).max(30) }).strict(),
  'places-shopping': z.object({ shops: z.array(placeSchema).min(1).max(20), souvenirs: z.array(placeSchema).min(1).max(20) }).strict(),
  'places-experiences': z.array(placeSchema).min(4).max(30),
  'places-food': z.array(placeSchema).min(1).max(40),
  itinerary: z.array(daySchema).min(1).max(14),
  'modules-discovery': z.object({ shopping: z.array(placeGroup).min(1).max(10), experiences: z.array(placeGroup).min(2).max(10), experience_mode: z.enum(['standard', 'constrained', 'expanded']), experience_mode_reason: txt.optional() }).strict(),
  'modules-practical': z.object({
    food: z.object({ menu_guide: z.object({ kicker: short, title: short, intro: txt, cards: z.array(z.object({ title: short, note: txt.min(30) }).strict()).min(4).max(8) }).strict(),
      menu_primer: z.array(z.object({ term: short, meaning: txt, note: txt }).strict()).min(1).max(40),
      local_snacks: z.array(z.object({ name: short, local_name: short, description: txt, why_try: txt, where_to_find: txt }).strict()).length(4),
      dedicated_trip: z.array(placeRef).min(1).max(20), reliable_chains: z.array(placeRef).max(4), chain_limit_reason: txt.optional(), inventory_limit_reason: txt.optional(),
    }).strict(), preparation: z.object({ essentials: z.array(checkItem).min(1).max(60), confirm_ahead: z.array(checkItem).min(1).max(60) }).strict(),
  }).strict(),
  'modules-language-notes': z.object({
    language: z.object({ local_label: short, locale: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), keyword_groups: z.array(languageGroup).length(5), phrase_groups: z.array(languageGroup).length(5), english_keyword_groups: z.array(languageGroup).length(5), english_phrase_groups: z.array(englishPhraseGroup).length(5) }).strict(),
    travel_notes: z.array(z.object({ category: z.enum(['weather', 'culture', 'transport', 'safety', 'payment']), title: short, summary: txt.min(24), items: z.array(checkItem.extend({ note: txt.min(34) })).length(4) }).strict()).length(5),
  }).strict(),
} as const;

export class SkillValidationError extends Error {
  readonly code = 'SKILL_VALIDATION_FAILED';
  constructor(public readonly issues: { code: string; path: string; severity: 'error' | 'warning'; message: string; validationCode?: string; validationPath?: (string | number)[] }[]) {
    super('Research content failed validation. Repair the named source pack fields.'); this.name = 'SkillValidationError';
  }
}
export function validatePack<K extends PackId>(pack: K, value: unknown): ResearchPacks[K] {
  const parsed = packSchemas[pack].safeParse(value);
  if (!parsed.success) throw new SkillValidationError(parsed.error.issues.map(i => ({ code: 'PACK_SCHEMA', path: `/${pack}/${i.path.join('/')}`, severity: 'error', message: i.message,
    validationCode: i.code, validationPath: [pack, ...i.path] })));
  return parsed.data as ResearchPacks[K];
}

/** Generate the model contract from the SAME executable validator, without a second drifting schema. */
function jsonShape(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) {
    const inner = jsonShape(schema._def.innerType);
    return schema instanceof z.ZodNullable ? { anyOf: [inner, { type: 'null' }] } : inner;
  }
  if (schema instanceof z.ZodEffects) return jsonShape(schema.innerType());
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return { type: 'object', additionalProperties: false, required: Object.entries(shape).filter(([, s]) => !s.isOptional()).map(([key]) => key), properties: Object.fromEntries(Object.entries(shape).map(([key, s]) => [key, jsonShape(s)])) };
  }
  if (schema instanceof z.ZodArray) return { type: 'array', items: jsonShape(schema.element), ...(schema._def.minLength && { minItems: schema._def.minLength.value }), ...(schema._def.maxLength && { maxItems: schema._def.maxLength.value }), ...(schema._def.exactLength && { minItems: schema._def.exactLength.value, maxItems: schema._def.exactLength.value }) };
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    for (const c of schema._def.checks) { if (c.kind === 'min') out.minLength = c.value; if (c.kind === 'max') out.maxLength = c.value; if (c.kind === 'regex') out.pattern = c.regex.source; }
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: schema.isInt ? 'integer' : 'number' };
    if (schema.minValue != null) out.minimum = schema.minValue;
    if (schema.maxValue != null) out.maximum = schema.maxValue;
    return out;
  }
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodUnion) return { anyOf: (schema.options as z.ZodTypeAny[]).map(jsonShape) };
  throw new Error('Unsupported research schema type');
}
export function jsonContractForPack(pack: PackId): Record<string, unknown> {
  return { pack, schema: jsonShape(packSchemas[pack]), rules: [
    'Use only supplied evidence IDs and their exact URLs; never invent facts, coordinates, ratings, image URLs, or QA claims.',
    'Unknown flights/stays must use pending and no fictional property or transport legs.',
    'Images are declarations only; no boolean verification flags. Empty images remain explicitly pending media, never complete.',
    'Every place is owned exactly once. References are {place_id}. Transfers belong to the arriving stop. Times must fit dwell plus transfer.',
    'Standard experiences: exactly six options in three truthful groups. Constrained four/two or expanded requires an explicit reason.',
    'Food: four snacks, target six dedicated restaurants and four chain branches; fewer researched candidates require inventory_limit_reason/chain_limit_reason, never invented entities. Use distinct cuisine/scene labels and schedule three dedicated restaurants on trips of three days or more.',
    'Preparation count >= max(24, trip days * 3). Five local-word, local-phrase, English-word and English-phrase groups of five entries each.',
    'Each day: real morning/afternoon/evening transitions, stop practical_note + measurable time_guard, concrete fallback, shopping guidance, distinct phone/camera photography and outfits.',
  ] };
}
