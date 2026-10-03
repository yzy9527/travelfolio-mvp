// Deterministic synthetic handbook; no network, no model, no destination claims.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makeFixturePacks} from '../api/src/skill/fixtures.ts';
import {compileGuide} from '../api/src/skill/compiler.ts';
import {renderGuideHtml} from '../api/src/skill/renderer.ts';
const directory=path.resolve(process.argv[2]||'artifacts/synthetic-fixture');
const constraints={destination:'合成合同测试城市',departure:'合成出发地',startDate:'2026-10-01',endDate:'2026-10-03',people:2,budget:4000,currency:'CNY',preferences:'城市漫步',exclusions:'不爬山'};
const guide=compileGuide(makeFixturePacks(constraints),{mode:'fixture',sources:[],generatedAt:'2026-09-30T00:00:00.000Z'});
const html=renderGuideHtml(guide);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'synthetic-handbook.html'),html);await writeFile(path.join(directory,'synthetic-guide.json'),JSON.stringify(guide,null,2));
console.log(JSON.stringify({directory,htmlSha256:createHash('sha256').update(html).digest('hex'),days:guide.profile.itinerary.length,places:guide.profile.places.length,handoffAllowed:guide.qa.handoffAllowed,mode:guide.provenance.mode},null,2));
