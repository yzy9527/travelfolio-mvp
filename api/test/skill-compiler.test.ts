import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {compileGuide,toLegacyItinerary,assessOfflineQa} from '../src/skill/compiler';
import {makeFixturePacks} from '../src/skill/fixtures';
import {planInvalidation,nextResearchBatch} from '../src/skill/graph';
import {renderGuideHtml,GUIDE_SCRIPT_SHA256,GUIDE_CSP} from '../src/skill/renderer';
import {TRUSTED_RUNTIME} from '../src/skill/runtime';
import {validatePack,jsonContractForPack,SkillValidationError,safeLink} from '../src/skill/schemas';
import {assetReviewed,canonicalJson,currentMapAsset,routeCaptureHash,sha256} from '../src/skill/validation';
import {PACK_IDS,type AssetEvidence,type QaEvidence} from '../src/skill/types';
const constraints={destination:'非真实目的地 · 合成测试',departure:'',startDate:'2026-11-01',endDate:'2026-11-03',people:2,budget:10000,currency:'CNY',preferences:'文化',exclusions:''};
const options={mode:'fixture' as const,sources:[],generatedAt:'2026-09-30T13:00:00Z'};
const fixture=()=>makeFixturePacks(constraints);
const failure=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e instanceof SkillValidationError&&e.issues.some((i:any)=>i.code===code));

test('explicitly unconfirmed route can be previewed without asserting coordinates or map readiness',()=>{
 const packs=fixture();const id=packs.itinerary[0].stops[0].place_id;
 const place=packs['places-core'].sights.find(place=>place.id===id)!;
 delete place.latitude;delete place.longitude;delete place.coordinate_source;
 for(const day of packs.itinerary)for(const stop of day.stops)if(stop.place_id===id)stop.distance_basis='unconfirmed';
 const guide=compileGuide(packs,options);
 assert.ok(guide.qa.issues.some(issue=>issue.code==='SCHEDULE_COORDINATES'&&issue.severity==='warning'));
 assert.equal(guide.qa.handoffAllowed,false);
 packs.itinerary[0].stops[1].distance_basis='unconfirmed';packs.itinerary[0].stops[1].distance_km=987;
 const html=renderGuideHtml(compileGuide(packs,options));
 assert.ok(html.includes('距离待核验'));assert.equal(html.includes('987 km'),false);
 packs.itinerary[0].stops[0].distance_basis='route';
 failure(()=>compileGuide(packs,options),'SCHEDULE_COORDINATES');
});

test('limited dining inventory needs explicit limitations and renders them without fabricated chains',()=>{
 const packs=fixture();const food=packs['modules-practical'].food;
 food.reliable_chains=food.reliable_chains.slice(0,1);
 delete food.chain_limit_reason;
 failure(()=>compileGuide(packs,options),'CHAIN_LIMIT');
 food.chain_limit_reason='当前检索只找到一家有本地分店证据的连锁，其他候选未核验，不补造门店。';
 food.inventory_limit_reason='徒步行程的餐饮资料有限；其余候选缺少可靠地址，未纳入。';
 const html=renderGuideHtml(compileGuide(packs,options));
 assert.ok(html.includes(food.chain_limit_reason));assert.ok(html.includes(food.inventory_limit_reason));
});

test('documented dining limitations preserve variety and scheduling warnings without inventing meals',()=>{
 const packs=fixture();
 packs['places-food'].forEach(place=>place.cuisine='单一菜系');
 packs.itinerary[2].stops[1].place_id='restaurant-1';
 packs['modules-practical'].food.inventory_limit_reason='来源仅支持当地同一菜系；剩余餐次由旅客现场确认，不凑数安排餐馆。';
 const guide=compileGuide(packs,options);
 for(const code of ['CUISINE_FLOOR','DINING_ROUTE']) assert.ok(guide.qa.issues.some(issue=>issue.code===code&&issue.severity==='warning'));
 assert.ok(renderGuideHtml(guide).includes('剩余餐次由旅客现场确认'));
});

test('nine typed research packs compile deterministically to the complete eight-module model',()=>{
 const packs=fixture(); for(const id of PACK_IDS) assert.deepEqual(validatePack(id,packs[id]),packs[id]);
 const a=compileGuide(packs,options),b=compileGuide(structuredClone(packs),options);
 assert.deepEqual(a,b);assert.equal(a.profile.places.length,31);assert.equal(a.profile.itinerary.length,3);
 assert.equal(a.profile.module_groups.food.local_snacks.length,4);assert.equal(a.profile.module_groups.food.dedicated_trip.length,6);
 assert.equal(a.profile.module_groups.food.reliable_chains.length,4);assert.equal(a.profile.module_groups.language.keyword_groups.flatMap(g=>g.items).length,25);
 assert.equal(a.profile.module_groups.language.english_phrase_groups.flatMap(g=>g.items).length,25);assert.equal(a.profile.module_groups.travel_notes.flatMap(g=>g.items).length,20);
 assert.equal(a.qa.status,'fixture');assert.equal(a.qa.handoffAllowed,false);assert.equal(a.provenance.fixtureDetected,true);
 assert.equal(Object.keys(a.provenance.packHashes).length,9);
});
for(const n of [1,2,14])test(`complete synthetic fixture supports ${n} days without weakening real count floors`,()=>{
 const c={...constraints,endDate:`2026-11-${String(n).padStart(2,'0')}`};const g=compileGuide(makeFixturePacks(c),options);
 assert.equal(g.profile.itinerary.length,n);assert.equal(toLegacyItinerary(g).days.length,n);
 assert.equal(g.profile.module_groups.preparation.essentials.length+g.profile.module_groups.preparation.confirm_ahead.length,Math.max(24,n*3));
});
test('fixture contamination never becomes live research or fabricated passing QA',()=>{
 failure(()=>compileGuide(fixture(),{...options,mode:'live'}),'FIXTURE_IN_LIVE');
 const guide=compileGuide(fixture(),options),html=renderGuideHtml(guide);
 const forged:QaEvidence={scope:'offline',fingerprint:sha256(html),status:'passed',checkedAt:options.generatedAt,toolReference:'synthetic-test-only',checks:Object.fromEntries(['chapter_navigation','disclosures','trip_mode','trip_day_switch','map_viewer'].map(k=>[k,{passed:true,note:'Synthetic assertion, not browser evidence'}]))};
 const receipt=assessOfflineQa(guide,html,[forged]);assert.equal(receipt.qa.handoffAllowed,false);assert.equal(receipt.qa.offline,'fixture');
});
test('JSON prompt contract is generated from strict validators and forbids model QA booleans',()=>{
 const contract=jsonContractForPack('framing') as any;assert.equal(contract.schema.additionalProperties,false);assert.ok(contract.schema.required.includes('country'));
 const p=fixture();(p['places-core'].sights[0] as any).subject_verified=true;
 failure(()=>compileGuide(p,options),'PACK_SCHEMA');
});
test('source packs retain original ownership and reject cross-family disguise',()=>{
 const p=fixture();p['places-core'].sights[0].type='shop';failure(()=>compileGuide(p,options),'PACK_PLACE_TYPE');
});
test('incoming transfers belong to destination stop and impossible schedules fail',()=>{
 const p=fixture();p.itinerary[0].stops[1].arrival_time='10:10';p.itinerary[0].stops[1].transfer_minutes=20;
 failure(()=>compileGuide(p,options),'TIMELINE_OVERLAP');
});
test('calendar coverage, scheduled coordinates and complete phases are required',()=>{
 let p=fixture();p.itinerary[0].date='2026-11-02';failure(()=>compileGuide(p,options),'DAY_DATES');
 p=fixture();delete p['places-core'].sights[0].coordinate_source;p.itinerary[0].stops[0].distance_basis='route';failure(()=>compileGuide(p,options),'SCHEDULE_COORDINATES');
 p=fixture();p.framing.journey_phases=[{title:'缺少一天',day_numbers:[1,2]}];failure(()=>compileGuide(p,options),'PHASE_COVERAGE');
});
test('pending transportation and stays never invent confirmed entities',()=>{
 const p=fixture();p.framing.stays[0].place_id='sight-1';failure(()=>compileGuide(p,options),'PENDING_STAY');
 const html=renderGuideHtml(compileGuide(fixture(),options));assert.match(html,/去程待确认/);assert.match(html,/返程待确认/);assert.match(html,/住宿待确认/);
});
test('restaurants are disjoint, four cuisines and three scheduled dedicated meals for 3+ days',()=>{
 let p=fixture();p['modules-practical'].food.reliable_chains[0]={place_id:'restaurant-1'};failure(()=>compileGuide(p,options),'FOOD_DISJOINT');
 p=fixture();p['places-food'].forEach(r=>r.cuisine='单一菜系');failure(()=>compileGuide(p,options),'CUISINE_FLOOR');
 p=fixture();p.itinerary[2].stops[1].place_id='restaurant-1';failure(()=>compileGuide(p,options),'DINING_ROUTE');
 p=fixture();p['modules-practical'].food.reliable_chains.pop();failure(()=>compileGuide(p,options),'CHAIN_LIMIT');
});
test('experience counts and category membership cannot be padded by duplicates',()=>{
 const p=fixture();p['modules-discovery'].experiences[0].items[0].place_id='experience-3';failure(()=>compileGuide(p,options),'EXPERIENCE_TAXONOMY');
});
test('daily photography remains route-specific with both camera and phone advice',()=>{
 let p=fixture();p.itinerary[1].photo_advice=structuredClone(p.itinerary[0].photo_advice);failure(()=>compileGuide(p,options),'REPEATED_PHOTOGRAPHY');
 p=fixture();p.itinerary[0].photo_advice.shooting_plan.forEach(s=>s.note='只说光线好，未提供设备技巧');failure(()=>compileGuide(p,options),'PHOTOGRAPHY_TECHNIQUE');
});
test('local notes category coverage and substantive paragraphs remain enforced',()=>{
 let p=fixture();p['modules-language-notes'].travel_notes[1].category='weather';failure(()=>compileGuide(p,options),'NOTE_CATEGORIES');
 p=fixture();p['modules-language-notes'].travel_notes[0].items[0].note='注意天气';failure(()=>compileGuide(p,options),'PACK_SCHEMA');
});
test('full renderer has exactly eight chapter modules and honest missing-media/map states',()=>{
 const html=renderGuideHtml(compileGuide(fixture(),options));
 assert.equal((html.match(/data-chapter="[1-8]"/g)||[]).length,8);
 for(const id of ['route','sights','shops','move','food','booking','words','tips'])assert.ok(html.includes(`id="${id}"`));
 assert.equal((html.match(/data-panel="photo"/g)||[]).length,3);assert.match(html,/离线街道地图待完成/);
 assert.doesNotMatch(html,/data-map-open="/);assert.match(html,/不是经过截图和审核的离线地图/);
 assert.match(html,/SYNTHETIC CONTRACT FIXTURE/);assert.match(html,/女装参考/);assert.match(html,/男装参考/);
 const route=html.slice(html.indexOf('id="route"'),html.indexOf('id="sights"'));assert.doesNotMatch(route,/合成浏览<\/h3>/);
});
test('CSP permits only exact trusted script bytes and rejects untrusted markup/links',()=>{
 const packs=fixture();packs.framing.cover.title='</title><script>globalThis.pwned=1</script>';
 packs['places-core'].sights[0].display_name='<img src=x onerror=alert(1)>';
 packs.itinerary[0].photo_advice.shooting_plan[0].title=packs['places-core'].sights[0].display_name;
 const html=renderGuideHtml(compileGuide(packs,options));assert.doesNotMatch(html,/<script>globalThis.pwned/);assert.match(html,/&lt;script&gt;globalThis.pwned/);
 const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);assert.deepEqual(scripts,[TRUSTED_RUNTIME]);
 assert.equal(GUIDE_SCRIPT_SHA256,'sha256-'+createHash('sha256').update(scripts[0]).digest('base64'));
 assert.match(GUIDE_CSP,/connect-src 'none'/);assert.doesNotMatch(GUIDE_CSP,/script-src 'unsafe-inline'/);
 assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('<style>'));assert.doesNotThrow(()=>new Script(TRUSTED_RUNTIME));
 for(const unsafe of ['javascript:alert(1)','data:text/html,pwn','https://u:p@place.com/','https://localhost/a','https://127.0.0.1/a','https://[::1]/a','//evil.test'])assert.equal(safeLink(unsafe),null);
 assert.equal(safeLink('https://www.google.com/maps/search/?api=1&query=Place'),'https://www.google.com/maps/search/?api=1&query=Place');
});
test('media requires hash-bound review, actual raster type and matching source/file',()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4foAAAAASUVORK5CYII=','base64');
 const asset:AssetEvidence={id:'a',placeId:'sight-1',kind:'place-image',sourceId:'S1',sourcePage:'https://official.site/a',file:'assets/a.png',status:'downloaded_unreviewed',sha256:createHash('sha256').update(bytes).digest('hex'),mime:'image/png',bytes:bytes.length,width:1,height:1,dataBase64:bytes.toString('base64'),sourceIdentityBound:false,visuallyConfirmed:false,watermarkChecked:false};
 assert.equal(assetReviewed(asset),false);
 Object.assign(asset,{status:'reviewed',sourceIdentityBound:true,visuallyConfirmed:true,watermarkChecked:true});assert.equal(assetReviewed(asset),false);
 asset.review={sha256:asset.sha256!,file:asset.file,sourcePage:asset.sourcePage,checkedAt:options.generatedAt,toolReference:'synthetic-test-only',note:'This is injected unit-test evidence, not a real image review'};
 assert.equal(assetReviewed(asset),true);asset.dataBase64=Buffer.from('<svg onload="alert(1)"></svg>').toString('base64');assert.equal(assetReviewed(asset),false);
});
test('local adjustment modifies intended itinerary pack and reuses unrelated source packs',()=>{
 const a=fixture(),outline={days:a.itinerary.map((d,i)=>({title:d.theme,focus:i===1?'第二天更早休息':'保持原安排'}))};
 const b=makeFixturePacks(constraints,'第二天更早休息',outline);
 assert.notEqual(sha256(a.itinerary),sha256(b.itinerary));assert.equal(sha256(a['places-core']),sha256(b['places-core']));
 const invalid=planInvalidation(['itinerary']);assert.deepEqual(invalid.packs,['itinerary','modules-discovery','modules-practical','modules-language-notes']);assert.ok(invalid.derived.includes('route-maps'));assert.ok(!invalid.packs.includes('places-food'));
 assert.deepEqual(planInvalidation(['modules-language-notes']).packs,['modules-language-notes']);
 assert.deepEqual(nextResearchBatch([]),['framing']);assert.deepEqual(nextResearchBatch(['framing']),['places-core','places-shopping']);
});
test('compatibility projection strips extended research metadata and excludes missing source IDs',()=>{
 const g=compileGuide(fixture(),options);g.sources=[{id:'fixture-source',title:'synthetic source',url:'https://fixture.invalid/research',retrievedAt:options.generatedAt,excerpt:'test',query:'private test query',contentHash:'abc',metadata:{}} as any];
 const projected=toLegacyItinerary(g);assert.deepEqual(Object.keys(projected.sources[0]),['id','title','url','retrievedAt']);assert.deepEqual(projected.days[0].activities[0].sourceIds,['fixture-source']);
 g.sources=[];assert.deepEqual(toLegacyItinerary(g).days[0].activities[0].sourceIds,[]);
});
test('canonical hashing is order independent and evidence mutation invalidates build fingerprint',()=>{
 assert.equal(canonicalJson({b:2,a:1}),canonicalJson({a:1,b:2}));const a=compileGuide(fixture(),options),p=fixture();p.itinerary[0].summary+='测试调整';const b=compileGuide(p,options);
 assert.notEqual(a.qa.fingerprint,b.qa.fingerprint);assert.notEqual(a.provenance.profileHash,b.provenance.profileHash);
 assert.equal(assessOfflineQa(a,renderGuideHtml(a)).artifactHash,sha256(renderGuideHtml(a)));
});
test('trusted runtime never converts storage failure into a saved claim or invokes remote voices',()=>{
 assert.match(TRUSTED_RUNTIME,/localService === true/);assert.match(TRUSTED_RUNTIME,/if \(saved\) message/);
 assert.doesNotMatch(TRUSTED_RUNTIME,/\bfetch\(|\beval\(|innerHTML|postMessage\(/);
});

test('map capture cannot be reused after route order or coordinates change',()=>{
 const g=compileGuide(fixture(),options),places=new Map(g.profile.places.map(p=>[p.id,p]));
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4foAAAAASUVORK5CYII=','base64');
 const a:AssetEvidence={id:'synthetic-map',kind:'route-map',day:g.profile.itinerary[0].date,sourceId:'fixture-source',sourcePage:'https://fixture.invalid/research',file:'assets/map.png',status:'downloaded_unreviewed',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mime:'image/png',width:1,height:1,dataBase64:bytes.toString('base64'),sourceIdentityBound:false,visuallyConfirmed:false,watermarkChecked:false,capture:{styleUrl:'https://tiles.openfreemap.org/styles/liberty',routeHash:routeCaptureHash(g.profile.itinerary[0],places)!,sourceIds:['fixture-source'],resources:[{url:'https://tiles.openfreemap.org/styles/liberty',sha256:'synthetic-only',mime:'application/json'}],capturedAt:options.generatedAt,viewport:{width:1,height:1}}};
 assert.equal(currentMapAsset(a,g.profile.itinerary[0],places),true);assert.equal(assetReviewed(a),false);
 g.profile.itinerary[0].stops.reverse();assert.equal(currentMapAsset(a,g.profile.itinerary[0],places),false);
 g.profile.itinerary[0].stops.reverse();places.get('sight-1')!.latitude!+=.1;assert.equal(currentMapAsset(a,g.profile.itinerary[0],places),false);
});
