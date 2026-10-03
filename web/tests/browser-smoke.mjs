/* Optional full-stack browser smoke: playwright-core is declared; provide a supported secure Chromium executable.
 * Run from repo root: npm run build -w web && node web/tests/browser-smoke.mjs
 * Uses only disposable in-memory test accounts and demo generation. */
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright-core');
const root = path.resolve(__dirname,'../..');
const artifacts = path.join(root,'web/artifacts');
const base = 'http://127.0.0.1:5173';
const children=[]; const checks=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function launch(args,cwd=root){ const child=spawn(process.execPath,args,{cwd,stdio:['ignore','pipe','pipe'],env:process.env});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('exit',code=>{if(code)console.error('child exited',code,output)});children.push(child);return()=>output; }
async function waitHttp(url){for(let i=0;i<150;i++){try{await fetch(url);return}catch{}await sleep(100)}throw new Error(`Server did not start: ${url}`)}
async function checked(name,fn){await fn();checks.push(name);console.log('PASS',name)}
async function login(page,email='ui-admin@example.test'){await page.goto(base);await page.getByLabel('邮箱地址').fill(email);await page.getByLabel('密码',{exact:true}).fill('Test-only-password-2026');await page.getByRole('button',{name:'登录，继续旅程'}).click();await page.getByRole('heading',{name:'总有一程，值得期待'}).waitFor()}
async function approveOutline(page) {
 await page.getByRole('heading',{name:'大纲已就绪，等你确认'}).waitFor({timeout:30000});
 const approval=page.getByRole('button',{name:'确认此大纲，生成完整手册',exact:true});assert.equal(await approval.isDisabled(),true);
 const tripId=decodeURIComponent(new URL(page.url()).hash.split('/').pop());
 const before=await (await page.request.get(base+'/api/trips/'+tripId)).json();
 const job=before.jobs.find(job=>job.status==='awaiting_outline');assert.ok(job?.outlineHash);assert.ok(job?.outlineVersion>0);
 // The persisted outline is a stop point. A reload cannot authorize research.
 await page.reload();await page.getByRole('heading',{name:'大纲已就绪，等你确认'}).waitFor();
 const stopped=await (await page.request.get(base+'/api/trips/'+tripId)).json();assert.equal(stopped.versions.length,before.versions.length);assert.equal(stopped.jobs[0].status,'awaiting_outline');
 await page.getByRole('checkbox',{name:/我已检查这份大纲/}).check();
 const requestPromise=page.waitForRequest(request=>request.method()==='POST'&&request.url().endsWith('/approve-outline'));
 await approval.dblclick({force:true});const request=await requestPromise;assert.deepEqual(request.postDataJSON(),{outlineHash:job.outlineHash,outlineVersion:job.outlineVersion});
 await page.getByRole('heading',{name:'八章手册 · 安全预览'}).waitFor({timeout:45000});await page.locator('iframe.artifact-frame').waitFor();
 const after=await (await page.request.get(base+'/api/trips/'+tripId)).json();assert.equal(after.trip.currentVersionId,before.trip.currentVersionId);return {before,after};
}
async function reviewCandidate(page) {
 let corrupted=false;
 await page.route('**/versions/*/artifact',async route=>{const response=await route.fetch();corrupted=true;await route.fulfill({response,body:(await response.text())+' '})});
 await page.getByRole('button',{name:'重新加载预览',exact:true}).click();
 await page.locator('.artifact-panel').getByText(/手册文件与版本校验值不一致/).waitFor();assert.equal(corrupted,true);assert.equal(await page.locator('iframe.artifact-frame').count(),0);
 assert.equal(await page.getByRole('button',{name:'保存人工审阅记录',exact:true}).isDisabled(),true);
 await page.unroute('**/versions/*/artifact');await page.getByRole('button',{name:'重新加载预览',exact:true}).click();await page.locator('iframe.artifact-frame').waitFor();
 const adopt=page.getByRole('button',{name:/^采用这一版/});assert.equal(await adopt.isDisabled(),true);
 const frame=page.locator('iframe.artifact-frame');assert.equal(await frame.getAttribute('sandbox'),'allow-scripts');assert.equal(await frame.getAttribute('referrerpolicy'),'no-referrer');assert.equal(await frame.getAttribute('src'),null);
 const inside=page.frameLocator('iframe.artifact-frame');await inside.locator('body').waitFor();assert.ok((await inside.locator('body').innerText()).length>2000);
 // The browser actually loads the compiler artifact, while its opaque origin prevents app access.
 const child=page.frames().find(frame=>frame.parentFrame());assert.ok(child);
 assert.equal(await inside.locator('section[data-chapter]').count(),8);
 await inside.locator('.floating-trip[data-trip-open]').click();await inside.locator('#trip-mode').waitFor({state:'visible'});
 const firstDay=await inside.locator('#trip-day-label').innerText();await inside.locator('[data-select-day="1"]').click();assert.notEqual(await inside.locator('#trip-day-label').innerText(),firstDay);assert.equal(await inside.locator('[data-select-day="1"]').getAttribute('aria-pressed'),'true');
 await inside.locator('#trip-mode [data-close]').click();await inside.locator('#trip-mode').waitFor({state:'hidden'});
assert.equal(await child.evaluate(()=>{try{void parent.document;return false}catch{return true}}),true);
 await page.getByRole('button',{name:'移动预览 · 390px',exact:true}).click();assert.equal(await frame.getAttribute('width'),'390');
 assert.equal(await child.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.getByRole('button',{name:'桌面预览 · 1180px',exact:true}).click();assert.equal(await frame.getAttribute('width'),'1180');
 for(const check of await page.locator('.manual-review input[type=checkbox]').all())await check.check();
 await page.getByLabel('审阅记录（至少 10 字）',{exact:true}).fill('隔离演示验收：自动化检查桌面、移动、八章内容与缺失地图提示；不代表真实旅行事实核验。');
 await page.getByRole('button',{name:'保存人工审阅记录',exact:true}).click();await page.getByText('本文件已人工审阅',{exact:true}).waitFor();assert.equal(await adopt.isEnabled(),true);
}
async function main(){
 await mkdir(artifacts,{recursive:true});
 const apiLog=launch(['--import','tsx','test/serve-ui.ts'],path.join(root,'api')); const webLog=launch(['web/tests/serve-built.mjs']);
 await waitHttp('http://127.0.0.1:3000/api/auth/me');await waitHttp(base);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',chromiumSandbox:true,args:['--disable-dev-shm-usage']});
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1050}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const url=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(url.hostname)||url.protocol==='data:'?route.continue():route.abort()});
 await checked('Desktop login renders and authenticates with disposable admin',async()=>{await page.goto(base);await page.getByRole('heading',{name:'欢迎回到旅页'}).waitFor();await page.screenshot({path:path.join(artifacts,'01-login-desktop.png')});await login(page);await page.screenshot({path:path.join(artifacts,'02-overview-desktop.png')})});
 await checked('Four-step wizard validates, preserves interrupted draft and creates trip',async()=>{
  await page.getByRole('button',{name:'计划新旅行',exact:true}).click();await page.getByPlaceholder('例如：京都、日本，或云南大理').fill('京都');await page.getByPlaceholder('例如：上海',{exact:true}).fill('上海');await page.getByLabel('出发日期').fill('2026-10-10');await page.getByLabel('返程日期').fill('2026-10-14');
  await page.getByRole('button',{name:'我的旅行',exact:false}).click();await page.getByRole('button',{name:'计划新旅行',exact:true}).click();assert.equal(await page.getByPlaceholder('例如：京都、日本，或云南大理').inputValue(),'京都');
  await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByLabel('总预算',{exact:true}).fill('8800');await page.getByRole('button',{name:'下一步',exact:true}).click();await page.getByRole('button',{name:'慢节奏',exact:true}).click();await page.getByLabel('不想要什么？').fill('不要过早出发');await page.getByRole('button',{name:'下一步',exact:true}).click();await page.screenshot({path:path.join(artifacts,'03-wizard-desktop.png')});await page.getByRole('button',{name:'创建我的旅行',exact:true}).click();await page.getByRole('button',{name:'生成行程大纲',exact:true}).waitFor();
 });
 const tripUrl=page.url();
 await checked('Repeated generation creates one outline; reload remains gated until exact outline approval',async()=>{
  let writes=0;page.on('request',r=>{if(r.method()==='POST'&&/\/jobs$/.test(new URL(r.url()).pathname))writes++});
  await page.getByRole('button',{name:'生成行程大纲',exact:true}).dblclick({force:true});
  await page.getByRole('heading',{name:'大纲已就绪，等你确认'}).waitFor({timeout:30000});assert.equal(writes,1);
  await page.screenshot({path:path.join(artifacts,'04-outline-desktop.png'),fullPage:true});await approveOutline(page);
  await reviewCandidate(page);await page.screenshot({path:path.join(artifacts,'05-handbook-desktop.png'),fullPage:true});
 });
 await checked('Candidate adoption, regeneration, revision conflict and rollback work',async()=>{
  await page.getByRole('button',{name:/^采用这一版/}).click();await page.getByText('当前旅行手册',{exact:true}).waitFor();await page.getByLabel('调整要求',{exact:true}).fill('第二天慢一点，增加咖啡馆');await page.getByRole('button',{name:'生成调整大纲',exact:true}).click();await approveOutline(page);await reviewCandidate(page);
  const stale=await context.newPage();await stale.goto(tripUrl);await stale.getByRole('button',{name:/^采用这一版/}).waitFor();await page.getByRole('button',{name:/^采用这一版/}).click();await page.getByText('当前旅行手册',{exact:true}).waitFor();await stale.getByRole('button',{name:/^采用这一版/}).click();await stale.getByText('手册已在另一个页面更新，已刷新至最新状态。请重新查看后操作。',{exact:true}).waitFor();await stale.close();
  await page.getByRole('button',{name:/版本 2/}).click();await page.locator('.history-row').last().getByRole('button',{name:'查看'}).click();await page.getByRole('button',{name:'回滚到这一版'}).click();await page.getByText('当前旅行手册',{exact:true}).waitFor();
 });
 await checked('HTML and JSON exports download without key material',async()=>{
  for(const format of ['HTML','JSON']){const promise=page.waitForEvent('download');await page.getByRole('button',{name:format,exact:true}).click();const d=await promise;const save=path.join(artifacts,d.suggestedFilename());await d.saveAs(save);assert.ok(d.suggestedFilename().endsWith('.'+format.toLowerCase()))}
 });
 await checked('Discarding a candidate preserves adopted version',async()=>{
  await page.getByLabel('调整要求',{exact:true}).fill('多安排一处公园');await page.getByRole('button',{name:'生成调整大纲',exact:true}).click();await approveOutline(page);await page.getByRole('button',{name:'舍弃草案',exact:true}).waitFor({timeout:30000});await page.getByRole('button',{name:'舍弃草案',exact:true}).click();await page.getByText('当前旅行手册',{exact:true}).waitFor();
 });
 await checked('Cancelling the outline gate survives reload and preserves the adopted handbook',async()=>{
  const tripId=decodeURIComponent(new URL(page.url()).hash.split('/').pop());const before=await (await page.request.get(base+'/api/trips/'+tripId)).json();
  await page.getByLabel('调整要求',{exact:true}).fill('先探索另一条路线，但暂不生成完整手册');await page.getByRole('button',{name:'生成调整大纲',exact:true}).click();
  await page.getByRole('heading',{name:'大纲已就绪，等你确认'}).waitFor({timeout:30000});await page.getByRole('checkbox',{name:/我已检查这份大纲/}).check();
  await page.getByRole('button',{name:'取消任务',exact:true}).click();await page.getByRole('heading',{name:'任务已取消',exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'任务已取消',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认此大纲，生成完整手册',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'从检查点恢复任务',exact:true}).count(),0);
  const after=await (await page.request.get(base+'/api/trips/'+tripId)).json();assert.equal(after.trip.currentVersionId,before.trip.currentVersionId);assert.equal(after.versions.length,before.versions.length);
 });
 await checked('Model settings preserve blank keys, fix canonical URLs and delete keys',async()=>{
  await page.getByRole('link',{name:'模型设置',exact:true}).click();await page.getByLabel('API Key',{exact:false}).fill('TEST-DUMMY-NOT-A-REAL-PROVIDER-KEY');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('已保存密钥',{exact:true}).waitFor();assert.equal(await page.getByLabel('API Key',{exact:false}).inputValue(),'');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('已保存密钥',{exact:true}).waitFor();
  await page.getByLabel('服务商',{exact:true}).selectOption('deepseek');assert.equal(await page.getByLabel('API Base URL',{exact:false}).inputValue(),'https://api.deepseek.com');assert.ok(await page.getByLabel('API Base URL',{exact:false}).getAttribute('readonly')!==null);await page.getByLabel('API Key',{exact:false}).fill('TEST-DUMMY-DEEPSEEK-NOT-REAL');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.getByText('模型设置已保存；仅在点击生成时调用模型',{exact:true}).waitFor();await page.getByRole('button',{name:'删除已存密钥',exact:true}).click();await page.getByText('尚未配置',{exact:true}).waitFor();
 });
 let code='';
 await checked('Admin stats, one-time invite, user disable/reenable work',async()=>{
  await page.getByRole('link',{name:'管理控制台',exact:true}).click();await page.getByRole('heading',{name:'管理控制台'}).waitFor();const friend=page.getByRole('row').filter({hasText:'ui-friend@example.test'});await friend.getByRole('button',{name:'停用',exact:true}).click();await friend.getByText('已停用',{exact:true}).waitFor();await friend.getByRole('button',{name:'重新启用',exact:true}).click();await friend.getByText('启用',{exact:true}).waitFor();await page.getByRole('button',{name:'创建邀请码'}).click();code=await page.locator('.invite-code').innerText();assert.ok(code.length>10);await page.screenshot({path:path.join(artifacts,'05-admin-desktop.png'),fullPage:true});
 });
 await checked('Invitation signup opens isolated user space',async()=>{
  const c=await browser.newContext();const p=await c.newPage();await p.goto(base);await p.getByRole('button',{name:'邀请注册',exact:true}).click();await p.getByLabel('邮箱地址').fill('new-traveler@example.test');await p.getByLabel('密码',{exact:false}).fill('Test-only-password-2026');await p.getByLabel('邀请码',{exact:true}).fill(code);await p.getByRole('button',{name:'创建账号',exact:true}).click();await p.getByRole('heading',{name:'总有一程，值得期待'}).waitFor();assert.equal(await p.locator('.trip-card').count(),0);assert.equal(await p.getByRole('link',{name:'管理控制台'}).count(),0);await c.close();
 });
 await checked('Mobile overview, navigation, handbook and Back/Forward fit 390px',async()=>{
  await page.setViewportSize({width:390,height:844});await page.goto(base+'/#/trips');await page.getByRole('heading',{name:'总有一程，值得期待'}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(artifacts,'06-overview-mobile.png'),fullPage:true});await page.locator('.trip-card').first().click();await page.getByText('当前旅行手册',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(artifacts,'07-handbook-mobile.png'),fullPage:true});await page.goBack();await page.getByRole('heading',{name:'总有一程，值得期待'}).waitFor();await page.goForward();await page.getByText('当前旅行手册',{exact:true}).waitFor();await page.getByRole('button',{name:'打开导航'}).click();await page.getByRole('link',{name:'模型设置',exact:true}).click();assert.equal(await page.locator('.sidebar.open').count(),0);assert.equal(await page.locator('.nav-scrim').count(),0);
 });
 assert.deepEqual(errors,[]);checks.push('No uncaught browser exceptions');
 await writeFile(path.join(artifacts,'browser-report.json'),JSON.stringify({passed:checks,externalModelCalls:0,notes:'Disposable PGlite database; real Chromium/production-built Vue/API/compiler integration with exact nginx CSP using synthetic demo content only. The four manual-review checkboxes are exercised by test automation, not asserted as human or live-data QA. No production deploy, real keys, model or search calls.'},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
 }finally{await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{for(const child of children)child.kill('SIGTERM')});

