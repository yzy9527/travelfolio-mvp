import { PACK_IDS, type PackId } from './types';

/** Original phase barriers. Later batches cannot bind unqualified earlier records. */
export const RESEARCH_PHASES: readonly (readonly PackId[])[] = [
  ['framing'], ['places-core', 'places-shopping'], ['places-experiences', 'places-food'],
  ['itinerary'], ['modules-discovery', 'modules-practical'], ['modules-language-notes'],
];
/** Data dependencies, distinct from queue order: changing food does not research sights again. */
export const PACK_DEPENDENCIES: Record<PackId, readonly PackId[]> = {
  framing: [], 'places-core': ['framing'], 'places-shopping': ['framing'],
  'places-experiences': ['framing'], 'places-food': ['framing'],
  itinerary: ['framing', 'places-core', 'places-shopping', 'places-experiences', 'places-food'],
  'modules-discovery': ['places-shopping', 'places-experiences', 'itinerary'],
  'modules-practical': ['places-food', 'itinerary'],
  'modules-language-notes': ['framing', 'itinerary'],
};
export function planInvalidation(changed: readonly PackId[]): { packs: PackId[]; derived: string[] } {
  if (changed.some(id => !PACK_IDS.includes(id))) throw new Error('Unknown research pack');
  const invalid = new Set(changed);
  for (const id of PACK_IDS) if (PACK_DEPENDENCIES[id].some(d => invalid.has(d))) invalid.add(id);
  return { packs: PACK_IDS.filter(id => invalid.has(id)), derived: invalid.size ? ['profile', 'research-provenance', 'rendered-html', 'browser-qa', 'offline-export', 'offline-qa', ...(invalid.has('itinerary') ? ['route-maps'] : []), ...(invalid.has('framing') || [...invalid].some(id => id.startsWith('places-')) ? ['changed-asset-receipts'] : [])] : [] };
}
export function nextResearchBatch(completed: readonly PackId[], invalidated: readonly PackId[] = []): PackId[] {
  const valid = new Set(completed.filter(p => !invalidated.includes(p)));
  return [...(RESEARCH_PHASES.find(phase => phase.some(id => !valid.has(id))) ?? [])].filter(id => !valid.has(id));
}
