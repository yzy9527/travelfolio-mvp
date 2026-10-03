import {createHash} from 'node:crypto';
import {chromium, type Browser, type Page} from 'playwright-core';
import type {QaEvidence} from './types';

export interface BrowserQaScreenshot {name: 'desktop' | 'mobile'; mime: 'image/png'; width: number; height: number; sha256: string; dataBase64: string;}
export interface GuideBrowserQaResult {browser: QaEvidence; offline: QaEvidence; artifactHash: string; screenshots: BrowserQaScreenshot[];}
export interface GuideBrowserQaInput {html: string; fingerprint: string; executablePath?: string; signal?: AbortSignal;}
const browserKeys=['desktop_layout','mobile_layout','no_horizontal_overflow','disclosures','trip_mode','trip_day_switch'] as const;
const offlineKeys=['chapter_navigation','disclosures','trip_mode','trip_day_switch','map_viewer'] as const;
const hash=(input: string | Buffer)=>createHash('sha256').update(input).digest('hex');
const selectors={chapters:'section[data-chapter]',tripOpen:'.floating-trip[data-trip-open]',tripClose:'#trip-mode [data-close]',tripPanel:'#trip-mode',tripDay:'#trip-mode [data-select-day]',mapOpen:'[data-map-open]',mapDialog:'#map-viewer',mapClose:'#map-viewer [data-close]'};
function pending(scope: QaEvidence['scope'],fingerprint: string,keys: readonly string[],note: string,toolReference: string): QaEvidence {
  return {scope,fingerprint,status:'pending',checkedAt:new Date().toISOString(),toolReference,checks:Object.fromEntries(keys.map(key=>[key,{passed:false,note}]))};
}
function safeRuntimeReason(error: unknown): string {
  const value=error instanceof Error?error.message:'';
  if(/abort|cancel/i.test(value))return 'Browser checks were cancelled before completion';
  if(/sandbox|operation not permitted|EPERM|process_singleton|crashpad/i.test(value))return 'Chromium could not start within the permitted sandbox; no browser checks were completed';
  if(/executable|ENOENT|browser.*not found|doesn.t exist/i.test(value))return 'A supported Chromium executable was unavailable; no browser checks were completed';
  if(/timeout/i.test(value))return 'The browser check timed out before completion';
  return 'The isolated browser runtime was unavailable or interrupted; no successful check is inferred';
}
async function expect(condition: boolean,note: string){if(!condition)throw new Error(note);}
async function record(evidence: QaEvidence,key: string,action: ()=>Promise<string>){
  try{evidence.checks[key]={passed:true,note:await action()};}
  catch(error){evidence.checks[key]={passed:false,note:error instanceof Error&&error.message.startsWith('QA:')?error.message:'Browser interaction did not complete; this check has not passed'};}
}
async function overflow(page: Page){return page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.body.scrollWidth<=innerWidth+1);}
async function chapterIds(page: Page){return page.locator(selectors.chapters).evaluateAll(nodes=>[...new Set(nodes.map(node=>node.id).filter(Boolean))]);}
async function disclose(page: Page){
  const fold=page.locator('details#stay').first();await expect(await fold.count()>0,'QA: No native disclosure was present');
  const summary=fold.locator(':scope > summary');const initial=await fold.getAttribute('open');await summary.click();
  await expect((await fold.getAttribute('open'))!==initial,'QA: Disclosure did not toggle');await summary.click();
  await expect((await fold.getAttribute('open'))===initial,'QA: Disclosure did not return to its original state');return 'A native disclosure opened and closed in the rendered browser';
}
async function openTrip(page: Page){
  const button=page.locator(selectors.tripOpen).first();await expect(await button.count()>0,'QA: Trip Mode control is missing');await button.click();
  const panel=page.locator(selectors.tripPanel).first();await panel.waitFor({state:'visible'});return panel;
}
async function closeTrip(page: Page){const close=page.locator(selectors.tripClose).first();await expect(await close.count()>0,'QA: Trip Mode close control is missing');await close.click();await page.locator(selectors.tripPanel).first().waitFor({state:'hidden'});}
async function tripMode(page: Page){await openTrip(page);await closeTrip(page);return 'Trip Mode opened and closed; the normal handbook remained accessible';}
async function switchTripDay(page: Page){
  const panel=await openTrip(page);
  try{
    const controls=page.locator(selectors.tripDay);await expect(await controls.count()>0,'QA: Trip Mode day controls are missing');
    const select=controls.locator('xpath=self::select').first();
    if(await select.count()){
      const options=await select.locator('option').evaluateAll(nodes=>nodes.map(node=>({value:(node as HTMLOptionElement).value,disabled:(node as HTMLOptionElement).disabled})));
      const usable=options.filter(option=>!option.disabled);await expect(usable.length>0,'QA: No Trip Mode day options exist');
      const initial=await select.inputValue();const alternative=usable.find(option=>option.value!==initial);
      if(!alternative)return 'Single-day handbook: one enabled day selection is present; no second day exists to switch to';
      const before=await panel.innerText();await select.selectOption(alternative.value);await expect(await select.inputValue()===alternative.value,'QA: Day selector did not update');await expect(await panel.innerText()!==before,'QA: Day selection did not update Trip Mode content');
      await select.selectOption(initial);return 'Changed Trip Mode day and observed different content, then restored the first selection';
    }
    const count=await controls.count();
    const selected=await controls.evaluateAll(nodes=>nodes.findIndex(node=>node.getAttribute('aria-pressed')==='true'));
    await expect(selected>=0,'QA: Trip Mode has no selected day');
    if(count===1){await expect(await panel.locator('[data-day-panel][data-panel="itinerary"]:visible').count()===1,'QA: Single-day Trip Mode content was not visible');return 'Single-day handbook: the only day is selected and its itinerary panel is visible; no second day exists to switch to';}
    const alternate=(selected+1)%count;const before=await panel.innerText();await controls.nth(alternate).click();
    await expect(await controls.nth(alternate).getAttribute('aria-pressed')==='true','QA: Day control state did not update');
    await expect(await panel.innerText()!==before,'QA: Day switch did not update Trip Mode content');
    await expect(await panel.locator(`[data-day-panel="${alternate}"][data-panel="itinerary"]`).isVisible(),'QA: Selected day itinerary is not visible');
    await controls.nth(selected).click();return 'Changed Trip Mode day, checked selected control and corresponding visible itinerary, then restored the previous day';
  }finally{await closeTrip(page).catch(()=>{});}
}
async function navigateChapters(page: Page){
  const ids=await chapterIds(page);await expect(ids.length===8,'QA: Expected all eight handbook chapters');
  for(const id of ids){
    const target=page.locator('a[href]').filter({visible:true});
    // Match href using DOM values rather than interpolating model-authored identifiers into a selector.
    const index=await target.evaluateAll((nodes,wanted)=>nodes.findIndex(node=>node.getAttribute('href')===`#${wanted}`),id);
    await expect(index>=0,'QA: A chapter navigation link is missing');await target.nth(index).click();
    await expect(await page.evaluate(wanted=>{const node=document.getElementById(wanted);if(!node)return false;const rect=node.getBoundingClientRect();return rect.top<innerHeight&&rect.bottom>0;},id),'QA: Chapter navigation did not reach its visible target');
  }
  return 'Every one of the eight chapter links reached its matching internal anchor with all network access disabled';
}
async function mapViewer(page: Page){
  const buttons=page.locator(selectors.mapOpen);await expect(await buttons.count()>0,'QA: No rendered map image/viewer is available; map-viewer verification remains pending');
  await buttons.first().click();const dialog=page.locator(selectors.mapDialog).first();await dialog.waitFor({state:'visible'});
  const image=dialog.locator('img').first();await expect(await image.count()>0&&await image.evaluate(node=>(node as HTMLImageElement).complete&&(node as HTMLImageElement).naturalWidth>0),'QA: Map viewer image did not decode');
  const zoom=page.locator('#map-zoom-label');const before=await zoom.innerText();await page.locator('#map-zoom-in').click();await expect(await zoom.innerText()!==before,'QA: Map zoom control did not update');await page.locator('#map-fit').click();
  await page.locator(selectors.mapClose).first().click();await dialog.waitFor({state:'hidden'});return 'An embedded map image decoded; its viewer opened, zoomed, reset and closed with all networking disabled';
}
/** Runs only on trusted compiler output. No provider calls, network reads, persistent profiles or implicit security overrides. */
export async function runGuideBrowserQa(input: GuideBrowserQaInput): Promise<GuideBrowserQaResult>{
  const artifactHash=hash(input.html);const reference=`playwright-core; artifact-sha256:${artifactHash}; network:blocked`;
  const result:GuideBrowserQaResult={artifactHash,browser:pending('browser',input.fingerprint,browserKeys,'Not run',reference),offline:pending('offline',artifactHash,offlineKeys,'Not run',reference),screenshots:[]};
  let browser:Browser|undefined;let launched=false;
  const abort=()=>{void browser?.close().catch(()=>{});};
  try{
    if(input.signal?.aborted)throw new Error('cancelled');
    if(!/^[a-f0-9]{64}$/i.test(input.fingerprint)||!input.html.trim()||Buffer.byteLength(input.html,'utf8')>12_000_000)throw new Error('Invalid browser QA input');
    input.signal?.addEventListener('abort',abort,{once:true});
    browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:input.executablePath||process.env.CHROMIUM_PATH||'/usr/bin/chromium',timeout:15000});launched=true;
    if(input.signal?.aborted)throw new Error('cancelled');
    const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',acceptDownloads:false});await context.route('**/*',route=>route.abort('blockedbyclient'));await context.setOffline(true);
    const page=await context.newPage();page.setDefaultTimeout(3500);page.setDefaultNavigationTimeout(8000);
    let errors=0;page.on('pageerror',()=>{errors++;});await page.setContent(input.html,{waitUntil:'load',timeout:12000});
    const toolReference=`${reference}; browser:${browser.version()}`;result.browser.toolReference=toolReference;result.offline.toolReference=toolReference;
    let desktopOverflow=false,mobileOverflow=false;
    for(const viewport of [{name:'desktop' as const,width:1280,height:900},{name:'mobile' as const,width:390,height:844}]){
      await record(result.browser,`${viewport.name}_layout`,async()=>{
        await page.setViewportSize(viewport);await page.evaluate(()=>window.scrollTo(0,0));
        await expect((await chapterIds(page)).length===8,'QA: Expected eight rendered chapters');
        const hasOverflow=!await overflow(page);if(viewport.name==='desktop')desktopOverflow=hasOverflow;else mobileOverflow=hasOverflow;
        await expect(!hasOverflow,'QA: Horizontal overflow was observed at the tested viewport');await expect(errors===0,'QA: Browser script errors were observed');
        const bytes=await page.screenshot({type:'png',fullPage:false,animations:'disabled'});result.screenshots.push({name:viewport.name,mime:'image/png',width:viewport.width,height:viewport.height,sha256:hash(bytes),dataBase64:bytes.toString('base64')});
        return `Measured ${viewport.width}×${viewport.height}, eight chapters, no horizontal overflow or uncaught script errors; viewport screenshot saved (not a human visual review)`;
      });
    }
    result.browser.checks.no_horizontal_overflow={passed:!desktopOverflow&&!mobileOverflow&&result.browser.checks.desktop_layout.passed&&result.browser.checks.mobile_layout.passed,note:!desktopOverflow&&!mobileOverflow?'Desktop/mobile document widths were measured; passing also requires both layout checks':'Horizontal overflow was measured in at least one viewport'};
    await page.setViewportSize({width:1280,height:900});await record(result.browser,'disclosures',()=>disclose(page));await record(result.browser,'trip_mode',()=>tripMode(page));await record(result.browser,'trip_day_switch',()=>switchTripDay(page));
    if(errors>0)result.browser.checks.desktop_layout={passed:false,note:'QA: Uncaught browser script errors were observed during interaction checks'};
    result.browser.status=Object.values(result.browser.checks).every(check=>check.passed)?'passed':'failed';
    if(input.signal?.aborted)throw new Error('cancelled');
    const offline=await context.newPage();offline.setDefaultTimeout(3500);offline.setDefaultNavigationTimeout(8000);let offlineErrors=0;offline.on('pageerror',()=>{offlineErrors++;});await offline.setContent(input.html,{waitUntil:'load',timeout:12000});
    await record(result.offline,'chapter_navigation',()=>navigateChapters(offline));await record(result.offline,'disclosures',()=>disclose(offline));await record(result.offline,'trip_mode',()=>tripMode(offline));await record(result.offline,'trip_day_switch',()=>switchTripDay(offline));await record(result.offline,'map_viewer',()=>mapViewer(offline));
    if(offlineErrors>0)result.offline.checks.chapter_navigation={passed:false,note:'QA: Uncaught script errors were observed in the offline document'};
    result.offline.status=Object.values(result.offline.checks).every(check=>check.passed)?'passed':result.offline.checks.map_viewer.note.startsWith('QA: No rendered map')&&Object.entries(result.offline.checks).every(([key,check])=>key==='map_viewer'||check.passed)?'pending':'failed';
    await context.close();
  }catch(error){
    const note=safeRuntimeReason(error);for(const evidence of [result.browser,result.offline]){evidence.status='pending';for(const check of Object.values(evidence.checks))if(!check.passed)check.note=note;evidence.toolReference=`${reference}; runtime:${launched?'interrupted':'unavailable'}`;}
  }finally{input.signal?.removeEventListener('abort',abort);await browser?.close().catch(()=>{});}
  return result;
}
