/** TypeScript adaptation of Personalized Travel Guide, MIT, pinned in provenance.ts. */
export const PACK_IDS = ['framing', 'places-core', 'places-shopping', 'places-experiences', 'places-food', 'itinerary', 'modules-discovery', 'modules-practical', 'modules-language-notes'] as const;
export type PackId = typeof PACK_IDS[number];
export interface SourceEvidence { id: string; url: string; title: string; retrievedAt: string; excerpt?: string }
export type Priority = '必须' | '建议' | '随缘';
export interface ImageDeclaration {
  file: string; source_id: string; source_page: string; download_url?: string;
  media_class: 'real_photo' | 'official_photo' | 'licensed_photo' | 'official_brand_asset';
  original_media_class: 'real_photo' | 'official_photo' | 'licensed_photo' | 'official_brand_asset';
  visual_subject_type: 'place_exterior' | 'place_interior' | 'room' | 'dish' | 'product' | 'experience_scene' | 'landscape' | 'official_logo' | 'official_share_card';
  source_identity_note: string;
}
export interface Place {
  id: string; type: 'hotel' | 'sight' | 'shop' | 'souvenir' | 'experience' | 'restaurant' | 'transport' | 'other';
  display_name: string; local_name: string; english_name?: string; description: string;
  area: string; address?: string; map_query: string; map_url?: string; source_url: string; official_url?: string; source_ids: string[];
  latitude?: number; longitude?: number;
  coordinate_source?: { source_id: string; url: string; note: string; precision: 'entrance' | 'building' | 'area' };
  hours: string; closed_days: string; duration_minutes: number; best_time: string; practical_tip: string; price_note: string;
  suggested_day?: number; interest_tags: string[]; images: ImageDeclaration[]; gallery_featured?: boolean; same_place_as?: string;
  ratings?: { platform: 'Google'; status: 'verified'; rating: number; review_count?: number; source_id: string; source_url: string; verified_at: string }[];
  experience_type?: 'wellness' | 'culture' | 'craft' | 'nature' | 'adventure' | 'performance' | 'food_workshop' | 'nightlife' | 'urban_walk' | 'food_culture' | 'pop_culture' | 'digital_art';
  route_fit?: string; cuisine?: string; venue_type?: string; signature_dishes?: string; per_person?: string; chain_evidence?: string;
  why_buy?: string; best_for?: string; where_to_buy?: string; buying_tip?: string; text_only_reason?: string;
}
export interface PlaceRef { place_id: string }
export interface PlaceGroup { title: string; subtitle: string; items: PlaceRef[]; experience_types?: NonNullable<Place['experience_type']>[] }
export interface PhotoAdvice {
  title: string; lighting: string; suitable_shots: string[]; portrait_tip: string;
  outfit_advice: { women: string; men: string; practical_note: string };
  shooting_plan: { time: string; title: string; note: string }[];
}
export interface Stop {
  place_id: string; arrival_time: string; dwell_minutes: number; transport_mode: string;
  transfer_minutes: number; distance_km: number; distance_basis?: 'route' | 'coordinate_straight_line' | 'unconfirmed';
  estimated_cost: string | number; practical_note: string; time_guard: string; rationale: string;
}
export interface ItineraryDay {
  date: string; area: string; theme: string; summary: string;
  periods: Record<'morning' | 'afternoon' | 'evening', { title: string; description: string }>;
  stops: Stop[]; fallback: string; route_note?: string;
  shopping_advice: { title: string; description: string }; photo_advice: PhotoAdvice;
}
export interface Framing {
  destination: string; display_name: string; country: string; year: string;
  trip: { start_date: string; end_date: string; days: number; rhythm: 'relaxed' | 'standard' | 'full'; travelers: string; interests: string[]; constraints: string[]; quality_mode: 'standard'; currency: string; budget: number; experience_mode?: 'standard' | 'constrained' | 'expanded' };
  cover: { kicker: string; title: string; summary: string; image: string; tags: string[]; show_summary?: boolean; source_id?: string; source_page?: string; derived_from?: string };
  transport: { status: 'pending' | 'confirmed'; legs: { direction: string; date: string; service_number: string; origin: string; destination: string; departure_time: string; arrival_time: string; mode?: string; terminal?: string; buffer_note: string }[] };
  stays: { status: 'pending' | 'confirmed'; place_id: string | null; check_in: string | null; check_out: string | null; notes: string }[];
  journey_phases?: { title: string; kicker?: string; day_numbers: number[] }[];
  dining_plan?: { date: string; meal: string; title: string; place_id?: string; flexible?: boolean; note: string }[];
  map_delivery: 'screenshots'; render_bindings_file: string;
}
export interface CheckItem { title: string; note: string; priority: Priority; timing?: string; source_ids?: string[] }
export interface FoodModule {
  menu_guide: { kicker: string; title: string; intro: string; cards: { title: string; note: string }[] };
  menu_primer: { term: string; meaning: string; note: string }[];
  local_snacks: { name: string; local_name: string; description: string; why_try: string; where_to_find: string }[];
  dedicated_trip: PlaceRef[]; reliable_chains: PlaceRef[]; chain_limit_reason?: string; inventory_limit_reason?: string;
}
export interface LanguageItem { term: string; meaning: string; reading?: string }
export interface LanguageGroup { title: string; items: LanguageItem[] }
export interface LanguageModule {
  local_label: string; locale: string; keyword_groups: LanguageGroup[]; phrase_groups: LanguageGroup[];
  english_keyword_groups: LanguageGroup[];
  english_phrase_groups: { title: string; items: { sentence: string; meaning: string }[] }[];
}
export interface NoteGroup { category: 'weather' | 'culture' | 'transport' | 'safety' | 'payment'; title: string; summary: string; items: CheckItem[] }
export interface ResearchPacks {
  framing: Framing;
  'places-core': { sights: Place[]; support: Place[] };
  'places-shopping': { shops: Place[]; souvenirs: Place[] };
  'places-experiences': Place[];
  'places-food': Place[];
  itinerary: ItineraryDay[];
  'modules-discovery': { shopping: PlaceGroup[]; experiences: PlaceGroup[]; experience_mode: 'standard' | 'constrained' | 'expanded'; experience_mode_reason?: string };
  'modules-practical': { food: FoodModule; preparation: { essentials: CheckItem[]; confirm_ahead: CheckItem[] } };
  'modules-language-notes': { language: LanguageModule; travel_notes: NoteGroup[] };
}
export interface DestinationProfile extends Framing {
  itinerary: ItineraryDay[]; places: Place[];
  module_groups: { shopping: PlaceGroup[]; experiences: PlaceGroup[]; food: FoodModule; preparation: ResearchPacks['modules-practical']['preparation']; language: LanguageModule; travel_notes: NoteGroup[] };
}
/** Created by a trusted fetch/review adapter, NEVER accepted from a model response. */
export interface AssetEvidence {
  id: string; placeId?: string; day?: string; kind: 'place-image' | 'cover' | 'route-map';
  sourceId: string; sourcePage: string; downloadUrl?: string; file: string;
  status: 'downloaded_unreviewed' | 'pending' | 'failed' | 'reviewed';
  sha256?: string; mime?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; bytes?: number; width?: number; height?: number;
  /** Only server-decoded raster bytes; HTML/SVG and remote requests are forbidden. */
  dataBase64?: string;
  sourceIdentityBound: boolean; visuallyConfirmed: boolean; watermarkChecked: boolean;
  review?: { sha256: string; sourcePage: string; file: string; toolReference: string; note: string; checkedAt: string };
  reason?: string;
  capture?: { styleUrl: string; routeHash: string; sourceIds: string[]; resources: { url: string; sha256: string; mime: string }[]; capturedAt: string; viewport: { width: number; height: number }; browserVersion?: string };
}
export interface QaEvidence {
  scope: 'browser' | 'offline'; fingerprint: string; status: 'passed' | 'pending' | 'failed';
  checkedAt: string; toolReference: string;
  checks: Record<string, { passed: boolean; note: string }>;
}
export interface ValidationIssue { code: string; path: string; severity: 'error' | 'warning'; message: string }
export type GateStatus = 'passed' | 'pending' | 'failed' | 'fixture';
export interface GuideQa {
  status: 'preview_ready' | 'waiting_for_review' | 'complete' | 'fixture';
  handoffAllowed: boolean; content: GateStatus; research: GateStatus; media: GateStatus; maps: GateStatus; browser: GateStatus; offline: GateStatus;
  fingerprint: string; issues: ValidationIssue[];
}
export interface ResearchProvenance {
  compiler: string; compilerVersion: string; upstreamCommit: string; upstreamRepository: string;
  mode: 'live' | 'fixture'; generatedAt: string; packHashes: Record<PackId, string>; profileHash: string; sourcesHash: string; assetsHash: string;
  fixtureDetected: boolean;
}
export interface CompiledGuide { profile: DestinationProfile; provenance: ResearchProvenance; qa: GuideQa; sources: SourceEvidence[]; assets: AssetEvidence[] }
export interface CompileOptions { mode: 'live' | 'fixture'; sources: SourceEvidence[]; generatedAt: string; assets?: AssetEvidence[]; qaEvidence?: QaEvidence[] }
