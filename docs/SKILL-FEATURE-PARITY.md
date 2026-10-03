# Travel Skill TypeScript port: feature and acceptance matrix

Baseline: [TokenHungryMash/personalized-travel-guide-skill](https://github.com/TokenHungryMash/personalized-travel-guide-skill/tree/66e54427e109d5601cd7cabf2cd85d550d1ba280), fixed commit `66e54427e109d5601cd7cabf2cd85d550d1ba280`. Original copyright © 2026 Personalized Travel Guide contributors, MIT. Original license is preserved in `docs/upstream-skill/LICENSE` and in exported HTML. Source documents and Git blob IDs are listed in `docs/upstream-skill/SOURCE-MANIFEST.json`.

This is a destination-neutral TypeScript adaptation, not a claim of byte-identical current-system restoration or exhaustive feature parity. The source scripts were read, never executed. Python is not a runtime dependency. “Implemented” below means the contract/code exists and its named tests pass, not that a real destination's facts or images have been verified.

## Content and compilation

| Upstream requirement | Status | Implementation / verification |
|---|---|---|
| Nine-pack source ownership and ordered research phases | Implemented | `types.ts`, `schemas.ts`, `graph.ts`; framing → core/shopping → experiences/food → itinerary → discovery/practical → language/notes; `nextResearchBatch` |
| Reusable destination-neutral compiler, repair source packs rather than HTML | Implemented | `compileGuide`, strict pack validators, stable SHA-256 pack/profile/source/asset receipts; no destination-specific live dataset |
| Original compact snake_case field families | Adapted | Preserved framing/itinerary/places/module_groups topology; strict supported field allowlist adds bounded inputs and trusted source IDs; old split-pack layouts and arbitrary optional upstream keys are not imported |
| Cover, transport, stay unnumbered framing | Implemented | Full outbound/return pending state, one card per confirmed leg, no invented connection; exact-property stay linkage before Chapter 01; neutral pending stay |
| 01: one day, three authored periods, stops and Mini Route per trip day | Implemented | Dates, itinerary order, dwell/incoming transfer timeline, rationale, cost basis, measurable time guard, practical note, coordinates and source binding; not just one generic daily paragraph |
| 01: distinct photography, 2–3 shooting plans, phone/camera, outfits | Implemented | Shared source payload used in main day and Trip Mode; route place binding and duplicate payload rejection; phone lens/camera focal-length hints required |
| 01: daily shopping only in Trip Mode; actionable fallback | Implemented | Main itinerary excludes shopping-advice block; Trip Mode reuses original daily shopping/fallback data |
| 02: at least eight sights, scheduled/optional split, hours/closures, visit/time/cautions/source/map | Implemented | Minimum inventory and distinct per-day scheduled-sight floor; cards include all fields; absent ratings are omitted |
| 03: shops/markets + immediately following souvenirs | Implemented | Exact place IDs for shops; concrete souvenir why/for whom/where/buying checks; optional product image with recorded text-only reason |
| 04: six experiences/three truthful categories, constrained four/two, expanded only with reason | Implemented | Exact counts, unique refs, controlled types, group-type matching, route-fit fields; source qualification itself still needs review |
| 05: four menu-guide cards, dictionary, exactly four snacks | Implemented | Separate visual primer, practical menu expression rows, food-first snack cards |
| 05: six dedicated restaurants/four cuisines, four chains by default, three scheduled on ≥3-day trips | Implemented | Type/identity/disjointness/cuisine/date checks; exceptions need explicit reason; restaurants preserve local names, dishes, branch/price/hours/source |
| 06: essentials + confirm-ahead, at least max(24, days×3), visible priority order | Implemented | Stable 必须 → 建议 → 随缘 order; compact native checkbox/disclosure; no separate entry/visa chapter |
| 07: four families × five groups × five entries, Chinese headings, romaji when Japan | Implemented | Local words/phrases and English words/phrases; English fallback labelled once; strict schema and reading validation |
| 08: exactly five folds × four substantive topics | Implemented | Weather, culture, transport, safety, payment once each; summary ≥24 and topic note ≥34 chars; priorities retained |
| Interest selection preference and nuanced semantic coherence | Adapted | Tag alignment warning and structural route validation; automatic code does not certify prose truth, appropriate taxonomy, accessibility, queues, safety, or factual freshness |
| Optional verified ratings | Adapted | Trusted source IDs, Google source host/retrieval date, numeric bounds, no default score; actual page interpretation remains research responsibility |
| Same physical place image reuse exception | Implemented | Original `same_place_as`, matching coordinates, identical source/download/file bindings; independent venues cannot reuse a photo |
| Scoped local edits and downstream invalidation | Implemented | Dependency graph preserves unaffected place packs; itinerary edit invalidates modules/render/provenance/map and QA receipts; tests compare pack hashes |

## Rendering and runtime

| Upstream feature | Status | Adaptation / limitation |
|---|---|---|
| Editorial 01–08 directory, desktop rail, mobile disclosure directory | Implemented | Two-column desktop directory, compact responsive single-column mobile and persistent wide-desktop rail |
| Responsive current-system visual design / locked byte ranges | Adapted | Reviewed TypeScript paper-style renderer preserves content hierarchy and controls; does not install the original 172KB HTML + CSS/JS stack, byte patch its 15 selectors, or claim pixel parity |
| One phone-oriented Trip Mode across desktop/mobile | Implemented | Native dialog, itinerary/map/photography-outfits/ledger tabs; day strip persists and switching day preserves selected tab |
| Main/Trip Mode data consistency | Implemented | Both rendered from one compiled profile; badge, route, restaurant and photography references share IDs and dates |
| Native disclosures and gallery navigation | Implemented | Keyboard-capable native details/dialogs; gallery controls only when ≥2 actual images exist; single images have no redundant gallery controls |
| Map viewer fit, zoom, internal scrolling, close | Implemented | Works only with actual safe embedded raster captures; no fake tile/capture or fabricated screenshot fallback |
| Automatic offline map capture | Adapted | Separate `maps.ts` controlled OpenFreeMap adapter records actual resources/route hash/viewport; captures remain unreviewed pending visual inspection; no silent online fallback |
| Source-owned photo acquisition and bounded machine decode | Implemented | Separate tool adapter downloads only inspected source-owned candidates, decodes/re-encodes bounded WebP and retains source receipt; renderer accepts safe raster bytes, never HTML/SVG or remote image fetches |
| Independent exact-subject/watermark visual review | Not yet automated | Machine decode and capture are not visual proof. Compiler media/map gates remain pending until trusted matching review evidence exists; provider/model booleans are forbidden |
| Preparation checklist persistence | Implemented | Local storage namespace per destination/trip; checkbox completion never asserts merchant booking/payment; opaque sandbox storage failure remains visible |
| Local reference-photo upload | Adapted | One bounded raster per day, device-only persistence, explicit failure feedback; no multiple-image board, crop editor or shared photo store |
| Word/phrase speech controls | Adapted | Click the phrase itself, stop/replay and capability feedback; device-local voices only, unavailable platform stays unavailable |
| Itinerary customizer and adjustment handoff | Adapted | Application provides outline/review/approved scoped version changes. Artifact has per-day source-bound local draft controls for name/time/dwell/transfer edits, move-up/down, add/delete, restore and bounded generated text requests; it does not silently alter the approved guide. Keyboard reorder replaces drag-and-drop; JSON request package is not ported |
| Local members/expense ledger and repayments | Adapted | Up to 12 stable IDs, name edits, selected participants, integer-cent equal split, deterministic remainder, separate currencies, expense edit/delete, settlement bookkeeping/reversal; no transfer APIs, member avatars, custom ratios or automatic FX |
| Cross-tab local ledger optimistic concurrency | Adapted | Storage-event invalidation and pre-write revision checks reject stale windows and preserve unsaved form inputs; no cross-device synchronization or transactional cross-tab lock is claimed |
| Original Cloudflare sharing package and shared attachment/member/ledger backend | Not yet ported | Separate authenticated application deployment replaces the original distribution architecture, but does not claim original shared-accounting/attachment functionality. Export is explicitly device-local |
| Offline self-contained artifact | Implemented | CSS, fixed trusted runtime and available raster bytes embedded; no remote JS/font/media dependencies; source/map navigation needs network |
| Static artwork/theme switching and GSAP effects | Not yet ported | Not required for content correctness; current typography/layout is an explicit adaptation |

## Security and quality gates

- Every model-authored display string is escaped. URLs accept only public-shaped HTTP(S); actual tool requests additionally require public DNS resolution and IP pinning. No `innerHTML`, `eval`, dynamic script generation from model content, provider credential, or parent-page message bridge appears in the guide runtime
- HTML begins with its own restrictive CSP meta, including only the SHA-256 of the fixed trusted runtime, `connect-src 'none'`, data-only raster images, blocked framing/media/forms/base changes. The authenticated app previews via `srcdoc` with `sandbox="allow-scripts"` and **without** `allow-same-origin`; downloads are authenticated attachments rather than executable authenticated-origin pages
- Data validation and valid source retrieval do not certify facts, image subjects or actual browser behavior. Media/maps/browser/offline-export are independent gates; exported HTML and QA receipts are hash bound
- Browser acceptance is separate from structural tests. `browser-qa.ts` records observed desktop/mobile layout, disclosure, Trip Mode/day switching and actual export map interactions, or an honest unavailable/pending result
- Synthetic fixtures never receive live, media, browser or handoff success through the compiler, even if caller supplies synthetic passing records. Fixture provenance is visibly stamped throughout the guide and is rejected in live mode
- Legacy itinerary JSON is a compatibility projection only, bounded by the old schema. The complete compiled skill document and standalone HTML are the canonical content; projection cannot carry all module records or >20 sources

## Verification

Run `npm run check` for current type checks, unit/integration tests and builds. Compiler coverage includes complete fixtures, inventory constraints, malformed references, timeline/source bindings, scoped invalidation, XSS/CSP and asset provenance. See [the frontend test guide](FRONTEND-TESTING.md) for browser and exported-handbook interaction tests.

Test doubles and synthetic fixtures do not establish live destination or production acceptance. Cross-pack validation has no automatic paid repair loop. Real provider compatibility, PostgreSQL/container operation, desktop/mobile interactions, media inspection and offline map checks must be verified in the target environment.
