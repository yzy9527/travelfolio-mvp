import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import type {INestApplication} from '@nestjs/common';
import {Database} from '../src/db';
import {createApp} from '../src/app';
import {AppService} from '../src/service';
import {GenerationWorker} from '../src/worker';
import {generateItinerary} from '../src/provider';
import {encryptApiKey} from '../src/crypto';
import {digest} from '../src/passwords';
import {testDatabase,config,constraints,seedUser} from './helpers';
import {boundOutlineHash,sha256} from '../src/skill/hash';
import {OperationLedger,PipelineError} from '../src/skill/operations';
import {SafeProviderError} from '../src/safe-http';
import {JobWorkspace} from '../src/skill/workspace';
import {readFile,mkdtemp,symlink} from 'node:fs/promises';
let db:Database,app:INestApplication,service:AppService,worker:GenerationWorker;
let alice:any,bob:any,admin:any,tripId:string,firstVersion:string,secondVersion:string;
const clients:Record<string,{cookie:string;csrf:string}>={};
const password='Test-only-password-2026';
async function login(email:string){const r=await request(app.getHttpServer()).post('/api/auth/login').set('Origin',config.appOrigin).send({email,password});assert.equal(r.status,201,r.text);return {cookie:r.headers['set-cookie'][0].split(';')[0],csrf:r.body.csrfToken};}
function call(who:string,method:'get'|'post'|'put'|'patch'|'delete',path:string,body?:unknown){let r=request(app.getHttpServer())[method]('/api'+path).set('Cookie',clients[who].cookie);if(method!=='get')r=r.set('Origin',config.appOrigin).set('X-CSRF-Token',clients[who].csrf).send(body??{});return r;}
async function newJob(userId:string,trip:string,requestText=''){return (await service.createJob(userId,trip,{mode:'demo',request:requestText,idempotencyKey:randomUUID()})).job;}
async function approve(userId:string,id:string){const {job}=await service.getJob(userId,id);return service.approveOutline(userId,id,{outlineHash:job.outlineHash,outlineVersion:job.outlineVersion});}
async function finish(userId:string,id:string){let result;for(let n=0;n<30;n++){result=(await service.getJob(userId,id)).job;if(result.status==='succeeded'||result.status==='failed'||result.status==='cancelled')break;await worker.tick();}assert.equal(result!.status,'succeeded',JSON.stringify(result));return result!;}
async function fullTrip(userId:string,tripId:string){const result=await service.getTrip(userId,tripId);for(const version of result.versions){if(version.status!=='discarded')Object.assign(version,(await service.getVersion(userId,tripId,version.id)).version);}return result;}
async function syntheticReview(userId:string,t:string,v:string){const artifact=await service.artifact(userId,t,v);await service.reviewVersion(userId,t,v,{artifactHash:artifact.hash,checks:{desktop:true,mobile:true,content:true,maps:true},note:'Automated test-only human confirmation fixture; not live or browser QA evidence.'});}
before(async()=>{db=await testDatabase();service=new AppService(db,config);app=await createApp(db,config);alice=await seedUser(db,'alice@example.test');bob=await seedUser(db,'bob@example.test');admin=await seedUser(db,'admin@example.test','admin');for(const [key,u] of Object.entries({alice,bob,admin}))clients[key]=await login(u.email);worker=new GenerationWorker(db,config);});
after(async()=>{await worker?.stop();await app?.close();await db?.close();});

test('authentication, Origin, CSRF and account isolation remain enforced',async()=>{
 assert.equal((await request(app.getHttpServer()).get('/api/health')).status,200);
 assert.equal((await request(app.getHttpServer()).get('/api/trips')).status,401);
 const loginResult=await request(app.getHttpServer()).post('/api/auth/login').set('Origin',config.appOrigin).send({email:alice.email,password});assert.match(loginResult.headers['set-cookie'][0],/HttpOnly/);assert.match(loginResult.headers['set-cookie'][0],/SameSite=Lax/);assert.equal(loginResult.body.sessionToken,undefined);
 assert.equal((await request(app.getHttpServer()).post('/api/auth/login').set('Origin','https://evil.example').send({email:alice.email,password})).status,403);
 assert.equal((await request(app.getHttpServer()).post('/api/trips').set('Origin',config.appOrigin).set('Cookie',clients.alice.cookie).send(constraints)).status,403);
 for(const body of [{...constraints,endDate:'2026-09-30'},{...constraints,startDate:'2026-02-30'},{...constraints,endDate:'2026-11-01'},{...constraints,budget:-1},{...constraints,ownerId:bob.id}])assert.equal((await call('alice','post','/trips',body)).status,400);
 const t=await call('alice','post','/trips',{...constraints,title:'测试行程'});tripId=t.body.trip.id;assert.equal(t.status,201);
 for(const who of ['bob','admin']){assert.equal((await call(who,'get',`/trips/${tripId}`)).status,404);assert.equal((await call(who,'post',`/trips/${tripId}/jobs`,{mode:'demo',request:'',idempotencyKey:randomUUID()})).status,404);}
});
test('outline first, deduplicated create, full generation never runs before explicit hash approval',async()=>{
 const key=randomUUID(),body={mode:'demo',request:'',idempotencyKey:key};const a=await call('alice','post',`/trips/${tripId}/jobs`,body);const b=await call('alice','post',`/trips/${tripId}/jobs`,body);assert.equal(a.body.job.id,b.body.job.id);
 assert.equal((await call('alice','post',`/trips/${tripId}/jobs`,{...body,request:'conflict'})).status,409);
 await worker.tick();let job=(await service.getJob(alice.id,a.body.job.id)).job;assert.equal(job.status,'awaiting_outline');assert.ok(job.outlineHash);assert.equal(job.outlineVersion,1);
 for(let n=0;n<3;n++)await worker.tick();assert.equal((await fullTrip(alice.id,tripId)).versions.length,0);assert.equal((await db.query('SELECT count(*)::int n FROM job_operations')).rows[0].n,0);
 assert.equal((await call('bob','post',`/jobs/${job.id}/approve-outline`,{outlineHash:job.outlineHash,outlineVersion:1})).status,404);
 await assert.rejects(service.approveOutline(alice.id,job.id,{outlineHash:'a'.repeat(64),outlineVersion:1}),(e:any)=>e.code==='OUTLINE_CHANGED');
 await approve(alice.id,job.id);await approve(alice.id,job.id);job=await finish(alice.id,job.id);firstVersion=job.versionId;
 const detail=await fullTrip(alice.id,tripId);assert.equal(detail.trip.currentVersionId,null);assert.equal(detail.versions[0].schemaVersion,2);assert.equal(detail.versions[0].guide.qa.handoffAllowed,false);assert.equal(detail.versions[0].qaStatus,'pending');
});
test('complete fixture renders 8 modules with trusted scripts and authenticated download isolation',async()=>{
 const result=await call('alice','get',`/trips/${tripId}/versions/${firstVersion}/artifact`);assert.equal(result.status,200);assert.match(result.headers['content-disposition'],/^attachment;/);assert.match(result.headers['content-security-policy'],/sandbox allow-scripts/);assert.match(result.headers['content-security-policy'],/frame-ancestors 'none'/);assert.equal(result.headers['x-artifact-sha256'],sha256(result.text));
 const guide=(await fullTrip(alice.id,tripId)).versions[0].guide;assert.equal(guide.profile.itinerary.length,3);assert.ok(guide.profile.module_groups.language);assert.ok(guide.profile.module_groups.food);
 assert.equal((await call('bob','get',`/trips/${tripId}/versions/${firstVersion}/artifact`)).status,404);assert.equal((await call('admin','get',`/trips/${tripId}/versions/${firstVersion}/artifact`)).status,404);
});
test('manual review binds exact artifact bytes and adoption is a separate explicit transaction',async()=>{
 await assert.rejects(service.adoptVersion(alice.id,tripId,firstVersion,{expectedRevision:0,acknowledgePartial:true}),(e:any)=>e.code==='REVIEW_REQUIRED');
 const review={artifactHash:'0'.repeat(64),checks:{desktop:true,mobile:true,content:true,maps:true},note:'Actual test observation fixture'};
 await assert.rejects(service.reviewVersion(alice.id,tripId,firstVersion,review),(e:any)=>e.code==='ARTIFACT_CHANGED');
 await assert.rejects(service.reviewVersion(alice.id,tripId,firstVersion,{...review,checks:{...review.checks,maps:false}}));
 await syntheticReview(alice.id,tripId,firstVersion);assert.equal((await fullTrip(alice.id,tripId)).trip.currentVersionId,null);
 const results=await Promise.all([service.adoptVersion(alice.id,tripId,firstVersion,{expectedRevision:0,acknowledgePartial:true}),service.adoptVersion(alice.id,tripId,firstVersion,{expectedRevision:0,acknowledgePartial:true})].map(p=>p.then(()=>200,e=>e.status)));assert.deepEqual(results.sort(),[200,409]);
});
test('local adjustment invalidates dependent packs, preserves independent pack hashes and old current',async()=>{
 const first=(await fullTrip(alice.id,tripId)).versions.find(v=>v.id===firstVersion)!;const job=await newJob(alice.id,tripId,'只调整第二天节奏');await worker.tick();
 // Test-only deterministic planning decision; no model call or live research.
 const raw=(await db.query('SELECT * FROM jobs WHERE id=$1',[job.id])).rows[0];raw.outline.changedPacks=['itinerary'];const hash=boundOutlineHash(raw.outline,raw,constraints,raw.outline_version);await db.query('UPDATE jobs SET outline=$1,outline_hash=$2 WHERE id=$3',[JSON.stringify(raw.outline),hash,job.id]);
 await approve(alice.id,job.id);const completed=await finish(alice.id,job.id);secondVersion=completed.versionId;const second=(await fullTrip(alice.id,tripId)).versions.find(v=>v.id===secondVersion)!;
 assert.equal(second.guide.provenance.packHashes['places-core'],first.guide.provenance.packHashes['places-core']);assert.equal((await fullTrip(alice.id,tripId)).trip.currentVersionId,firstVersion);
 await syntheticReview(alice.id,tripId,secondVersion);await service.adoptVersion(alice.id,tripId,secondVersion,{expectedRevision:1,acknowledgePartial:true});await service.adoptVersion(alice.id,tripId,firstVersion,{expectedRevision:2,acknowledgePartial:true});assert.equal((await fullTrip(alice.id,tripId)).trip.currentVersionId,firstVersion);
});
test('stale candidate and stale outline cannot replace a changed adopted version',async()=>{
 const job=await newJob(alice.id,tripId,'测试旧候选');await worker.tick();await approve(alice.id,job.id);const candidate=await finish(alice.id,job.id);await syntheticReview(alice.id,tripId,candidate.versionId!);
 await service.adoptVersion(alice.id,tripId,secondVersion,{expectedRevision:3,acknowledgePartial:true});await assert.rejects(service.adoptVersion(alice.id,tripId,candidate.versionId!,{expectedRevision:4,acknowledgePartial:true}),(e:any)=>e.code==='STALE_CANDIDATE');await service.discardVersion(alice.id,tripId,candidate.versionId!);
 const outline=await newJob(alice.id,tripId,'测试旧大纲');await worker.tick();await service.adoptVersion(alice.id,tripId,firstVersion,{expectedRevision:4,acknowledgePartial:true});await assert.rejects(approve(alice.id,outline.id),(e:any)=>e.code==='STALE_CANDIDATE');await service.cancelJob(alice.id,outline.id);
});
test('cancellation at outline and checkpoint stages never publishes a candidate',async()=>{
 const before=(await fullTrip(alice.id,tripId)).versions.length;let job=await newJob(alice.id,tripId,'取消大纲');await worker.tick();await service.cancelJob(alice.id,job.id);await worker.tick();assert.equal((await service.getJob(alice.id,job.id)).job.status,'cancelled');
 job=await newJob(alice.id,tripId,'取消研究');await worker.tick();await approve(alice.id,job.id);await worker.tick();await service.cancelJob(alice.id,job.id);await worker.tick();assert.equal((await fullTrip(alice.id,tripId)).versions.length,before);
});
test('expired nonpaid lease resumes checkpoint; ambiguous paid lease requires explicit billing acknowledgment',async()=>{
 const job=await newJob(alice.id,tripId,'中断恢复');await worker.tick();await approve(alice.id,job.id);await worker.tick();
 await db.query("UPDATE jobs SET status='running',lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);await worker.tick();assert.equal((await service.getJob(alice.id,job.id)).job.status,'queued');
 await db.query("INSERT INTO job_operations(id,job_id,operation_key,input_hash,status) VALUES($1,$2,'test-payment','hash','started')",[randomUUID(),job.id]);await db.query("UPDATE jobs SET status='running',lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);await worker.tick();const failed=(await service.getJob(alice.id,job.id)).job;assert.equal(failed.status,'failed');assert.equal(failed.possibleCharge,true);
 await assert.rejects(service.resumeJob(alice.id,job.id,{}),(e:any)=>e.code==='CHARGE_ACK_REQUIRED');await service.resumeJob(alice.id,job.id,{acknowledgePossibleCharge:true});assert.equal((await service.getJob(alice.id,job.id)).job.status,'queued');await service.cancelJob(alice.id,job.id);
});
test('durable operation ledger caches successful model result and never repeats ambiguous call',async()=>{
 const t=(await service.createTrip(alice.id,constraints)).trip;const job=await newJob(alice.id,t.id);const instance=randomUUID();await db.query("UPDATE jobs SET status='running',claimed_by=$1 WHERE id=$2",[instance,job.id]);let calls=0;
 const ledger=new OperationLedger(db,job.id,instance,0,async()=>{});assert.deepEqual(await ledger.run('model',{input:'same'},async()=>{calls++;return {value:1};}),{value:1});assert.deepEqual(await new OperationLedger(db,job.id,instance,0,async()=>{}).run('model',{input:'same'},async()=>{calls++;return {value:2};}),{value:1});assert.equal(calls,1);
 await assert.rejects(ledger.run('model',{input:'different'},async()=>({})),(e:any)=>e.code==='CHECKPOINT_MISMATCH');
 await assert.rejects(ledger.run('ambiguous',{},async()=>{throw Error('private upstream detail');}));await assert.rejects(ledger.run('ambiguous',{},async()=>{calls++;return {};}),(e:any)=>e.code==='POSSIBLE_CHARGE');assert.equal(calls,1);await service.cancelJob(alice.id,job.id);
});
test('a proved pre-send DNS failure is recorded without charge ambiguity and can be retried',async()=>{
 const t=(await service.createTrip(alice.id,constraints)).trip,job=await newJob(alice.id,t.id);const instance=randomUUID();
 await db.query("UPDATE jobs SET status='running',claimed_by=$1 WHERE id=$2",[instance,job.id]);
 const ledger=new OperationLedger(db,job.id,instance,0,async()=>{});
 await assert.rejects(ledger.run('evidence:framing:search:0',{},async()=>{throw new SafeProviderError('PROVIDER_DNS_FAILED',{phase:'dns',requestSent:false});}));
 const row=(await db.query("SELECT status,failure_code,failure_phase,http_status FROM job_operations WHERE job_id=$1",[job.id])).rows[0];
 assert.deepEqual(row,{status:'not_sent',failure_code:'PROVIDER_DNS_FAILED',failure_phase:'dns',http_status:null});
 assert.deepEqual(await ledger.run('evidence:framing:search:0',{},async()=>({ok:true})),{ok:true});
 assert.equal((await db.query("SELECT count(*)::int n FROM job_operations WHERE job_id=$1",[job.id])).rows[0].n,2);
 await service.cancelJob(alice.id,job.id);
});
test('model response validation stores only bounded detail and remains charge ambiguous',async()=>{
 const t=(await service.createTrip(alice.id,constraints)).trip,job=await newJob(alice.id,t.id),instance=randomUUID();
 await db.query("UPDATE jobs SET status='running',claimed_by=$1 WHERE id=$2",[instance,job.id]);
 const ledger=new OperationLedger(db,job.id,instance,0,async()=>{});
 await assert.rejects(ledger.run('outline',{},async()=>{throw new SafeProviderError('PROVIDER_OUTLINE_SCHEMA',{phase:'response',requestSent:true,validationDetail:'outline.days.0.pace.invalid_enum_value'});}));
 const row=(await db.query("SELECT status,failure_code,failure_phase,failure_detail,result FROM job_operations WHERE job_id=$1",[job.id])).rows[0];
 assert.deepEqual(row,{status:'ambiguous',failure_code:'PROVIDER_OUTLINE_SCHEMA',failure_phase:'response',failure_detail:'outline.days.0.pace.invalid_enum_value',result:null});
 await assert.rejects(ledger.run('outline',{},async()=>({})),(error:any)=>error.code==='POSSIBLE_CHARGE');
 await service.cancelJob(alice.id,job.id);
});
test('secret metadata, exports, and admin views cannot expose BYOK keys or ciphertext',async()=>{
 const key='test-key-not-real',cipher=encryptApiKey(key,alice.id,config.encryptionSecret);await db.query("INSERT INTO settings(user_id,provider,base_url,model,key_cipher) VALUES($1,'openai','https://api.openai.com/v1','test-model',$2)",[alice.id,cipher]);
 const settings=await call('alice','get','/settings');assert.equal(settings.body.hasApiKey,true);const exported=await call('alice','get',`/trips/${tripId}/export?format=json`);const adminView=await call('admin','get','/admin/overview');for(const response of [settings,exported,adminView])for(const secret of [key,cipher,'key_cipher','password_hash'])assert.equal(response.text.includes(secret),false,secret);
 for(const baseUrl of ['http://example.com','https://127.0.0.1','https://169.254.169.254','https://[::1]','https://user:pass@example.com','https://example.com:444'])assert.equal((await call('bob','put','/settings',{provider:'custom',baseUrl,model:'x',apiKey:'test'})).status,400);
 await service.deleteKey(alice.id);
});
test('legacy adopted versions remain readable/exportable/rollback-compatible after additive migration',async()=>{
 const owner=await seedUser(db,'legacy@example.test'),trip=(await service.createTrip(owner.id,constraints)).trip;const content=await generateItinerary({constraints,current:null,request:'',mode:'demo',settings:null});const id=randomUUID();await db.query("INSERT INTO versions(id,trip_id,number,status,request,content) VALUES($1,$2,1,'adopted','',$3)",[id,trip.id,JSON.stringify(content)]);await service.adoptVersion(owner.id,trip.id,id,{expectedRevision:0,acknowledgePartial:true});const detail=await fullTrip(owner.id,trip.id);assert.equal(detail.versions[0].schemaVersion,1);assert.equal((await service.exportVersion(owner.id,trip.id)).itinerary.title,content.title);
 const {migrate}=await import('../src/migrate');await migrate(db);assert.equal((await db.query('SELECT count(*)::int count FROM schema_migrations')).rows[0].count,4);
});
test('private job workspace rejects traversal and preexisting symlink components',async()=>{
 const root=await mkdtemp('/tmp/travelfolio-workspace-test-');const user=randomUUID(),job=randomUUID();const workspace=await JobWorkspace.open(root,user,job);await workspace.write('result.json','safe');assert.equal(await readFile(workspace.directory+'/result.json','utf8'),'safe');await assert.rejects(workspace.write('../escape','unsafe'));await assert.rejects(JobWorkspace.open(root,'../outside',job));const other=randomUUID();await symlink('/tmp',root+'/'+other);await assert.rejects(JobWorkspace.open(root,other,randomUUID()));
});
test('invite is single-use; disabling account cancels waiting jobs and revokes sessions',async()=>{
 const trip=(await service.createTrip(bob.id,constraints)).trip,job=await newJob(bob.id,trip.id);await worker.tick();const invite=await service.createInvite(admin);assert.equal((await db.query('SELECT token_hash FROM invites')).rows[0].token_hash,digest(invite.inviteCode));const body={email:'new@example.test',password,inviteCode:invite.inviteCode};assert.equal((await request(app.getHttpServer()).post('/api/auth/register').set('Origin',config.appOrigin).send(body)).status,201);assert.equal((await request(app.getHttpServer()).post('/api/auth/register').set('Origin',config.appOrigin).send({...body,email:'other@example.test'})).status,400);
 await service.setUserStatus(admin,bob.id,{status:'disabled'});assert.equal((await service.getJob(bob.id,job.id)).job.status,'cancelled');assert.equal((await call('bob','get','/trips')).status,401);await assert.rejects(service.createJob(bob.id,trip.id,{mode:'demo',request:'',idempotencyKey:randomUUID()}),(e:any)=>e.code==='ACCOUNT_DISABLED');
});

test('late completion from expired worker cannot overwrite a resumed operation row',async()=>{
 const owner=await seedUser(db,'late@example.test'),trip=(await service.createTrip(owner.id,constraints)).trip,job=await newJob(owner.id,trip.id),old=randomUUID(),replacement=randomUUID();
 await db.query("UPDATE jobs SET status='running',claimed_by=$1 WHERE id=$2",[old,job.id]);let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),begun=new Promise<void>(r=>started=r);
 const ledger=new OperationLedger(db,job.id,old,0,async()=>{});const late=ledger.run('model',{},async()=>{started();await gate;return {value:'stale'};});await begun;
 await db.query("UPDATE jobs SET status='failed',possible_charge=true WHERE id=$1",[job.id]);await db.query("UPDATE job_operations SET status='ambiguous' WHERE job_id=$1",[job.id]);await service.resumeJob(owner.id,job.id,{acknowledgePossibleCharge:true});await db.query("UPDATE jobs SET status='running',claimed_by=$1 WHERE id=$2",[replacement,job.id]);
 const fresh=new OperationLedger(db,job.id,replacement,1,async()=>{});assert.deepEqual(await fresh.run('model',{},async()=>({value:'fresh'})),{value:'fresh'});release();await assert.rejects(late,(e:any)=>e.code==='POSSIBLE_CHARGE');assert.deepEqual((await db.query("SELECT result FROM job_operations WHERE job_id=$1 AND operation_key='model'",[job.id])).rows[0].result,{value:'fresh'});await service.cancelJob(owner.id,job.id);
});

test('v2 HTML export bytes match reviewed artifact rather than legacy rendering',async()=>{
 const artifact=await call('alice','get',`/trips/${tripId}/versions/${firstVersion}/artifact`);const exported=await call('alice','get',`/trips/${tripId}/export?format=html&versionId=${firstVersion}`);assert.equal(exported.status,200);assert.equal(exported.text,artifact.text);assert.equal(sha256(exported.text),artifact.headers['x-artifact-sha256']);assert.match(exported.headers['content-security-policy'],/sandbox/);
});

test('resume honors per-user pending quota under the account lock',async()=>{
 const owner=await seedUser(db,'resume-quota@example.test');const tripIds=[];for(let n=0;n<3;n++)tripIds.push((await service.createTrip(owner.id,constraints)).trip.id);
 const failed=await newJob(owner.id,tripIds[0]);await db.query("UPDATE jobs SET status='failed' WHERE id=$1",[failed.id]);const a=await newJob(owner.id,tripIds[1]),b=await newJob(owner.id,tripIds[2]);await assert.rejects(service.resumeJob(owner.id,failed.id,{}),(e:any)=>e.code==='PENDING_LIMIT');await service.cancelJob(owner.id,a.id);await service.cancelJob(owner.id,b.id);
});

test('human preview adoption cannot promote original handoff gates',async()=>{
 const detail=await fullTrip(alice.id,tripId),v=detail.versions.find(x=>x.id===firstVersion)!;assert.equal(v.review.acceptance,'preview_only');assert.equal(v.guide.qa.handoffAllowed,false);assert.equal(v.guide.qa.status,'fixture');assert.notEqual(v.guide.qa.maps,'passed');
});

test('asset review is tenant-isolated, hash-bound, nonpaid and creates a fresh immutable candidate',async()=>{
 const sharp=(await import('sharp')).default;const owner=await seedUser(db,'media-review@example.test'),trip=(await service.createTrip(owner.id,constraints)).trip;
 const j=await newJob(owner.id,trip.id);await worker.tick();await approve(owner.id,j.id);const done=await finish(owner.id,j.id);const row=(await db.query('SELECT * FROM versions WHERE id=$1',[done.versionId])).rows[0];
 const bytes=await sharp({create:{width:320,height:240,channels:3,background:'#aabbcc'}}).webp().toBuffer(),hash=sha256(bytes);
 // Test-only synthetic receipt to exercise evidence ingestion, never a real media QA claim.
 const asset={id:'test-image',placeId:'sight-1',kind:'place-image',file:'assets/sight-1.webp',sourceId:'fixture-source',sourcePage:'https://fixture.invalid/research',downloadUrl:'https://fixture.invalid/photo.webp',status:'downloaded_unreviewed',sha256:hash,mime:'image/webp',bytes:bytes.length,width:320,height:240,dataBase64:bytes.toString('base64'),sourceIdentityBound:false,visuallyConfirmed:false,watermarkChecked:false};row.guide.assets=[asset];
 row.research_packs['places-core'].sights[0].images=[{file:asset.file,source_id:asset.sourceId,source_page:asset.sourcePage,download_url:asset.downloadUrl,media_class:'official_photo',original_media_class:'official_photo',visual_subject_type:'place_exterior',source_identity_note:'Synthetic fixture for review path'}];
 await db.query('UPDATE versions SET guide=$1,research_packs=$2 WHERE id=$3',[JSON.stringify(row.guide),JSON.stringify(row.research_packs),done.versionId]);
 const body={artifactHash:row.artifact_hash,idempotencyKey:randomUUID(),coverAssetId:asset.id,reviews:[{assetId:asset.id,sha256:hash,sourcePage:asset.sourcePage,identity:true,visual:true,watermark:true,note:'Synthetic test observation only; this is not an actual destination image review.'}]};
 await assert.rejects(service.reviewAssets(alice.id,trip.id,done.versionId!,body),(e:any)=>e.status===404);await assert.rejects(service.reviewAssets(owner.id,trip.id,done.versionId!,{...body,reviews:[{...body.reviews[0],sha256:'0'.repeat(64)}]}),(e:any)=>e.code==='ASSET_CHANGED');
 const next=await service.reviewAssets(owner.id,trip.id,done.versionId!,body);assert.equal(next.job.stage,'compile');assert.equal((await service.reviewAssets(owner.id,trip.id,done.versionId!,body)).job.id,next.job.id);const rebuilt=await finish(owner.id,next.job.id);assert.notEqual(rebuilt.versionId,done.versionId);
 assert.equal((await db.query('SELECT artifact_hash FROM versions WHERE id=$1',[done.versionId])).rows[0].artifact_hash,row.artifact_hash);assert.equal((await db.query('SELECT count(*)::int count FROM job_operations WHERE job_id=$1',[next.job.id])).rows[0].count,0);assert.equal((await fullTrip(owner.id,trip.id)).trip.currentVersionId,null);
 const version=(await fullTrip(owner.id,trip.id)).versions.find(x=>x.id===rebuilt.versionId)!;assert.equal(version.guide.assets[0].status,'reviewed');assert.equal(version.guide.qa.handoffAllowed,false);assert.equal(version.guide.provenance.mode,'fixture');
});

test('history excludes heavy guide bytes and selected guide endpoint stays owner-only',async()=>{
 const history=await call('alice','get',`/trips/${tripId}`);assert.equal(history.status,200);assert.ok(history.body.versions.every((v:any)=>v.guide===null));assert.equal(history.text.includes('dataBase64'),false);assert.equal(history.text.includes('research_packs'),false);assert.equal(history.text.includes('artifact_html'),false);
 const selected=await call('alice','get',`/trips/${tripId}/versions/${firstVersion}`);assert.equal(selected.status,200);assert.ok(selected.body.version.guide.profile.module_groups);assert.equal((await call('bob','get',`/trips/${tripId}/versions/${firstVersion}`)).status,401); // bob disabled earlier
});
