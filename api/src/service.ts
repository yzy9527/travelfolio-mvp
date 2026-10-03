import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Database,Queryable} from './db';
import {Config} from './config';
import {ApiError,reject} from './errors';
import {credentialsSchema,registerSchema,tripConstraintsSchema,settingsSchema,jobSchema,idSchema} from './schemas';
import {hashPassword,verifyPassword,token,digest} from './passwords';
import {encryptApiKey} from './crypto';
import {validateProviderBaseUrl,validatePublicHost} from './safe-http';
import {rateLimit} from './rate-limit';
import {boundOutlineHash,sha256,hashObject} from './skill/hash';
import {safeRaster} from './skill/validation';
export interface User {id:string;email:string;role:'admin'|'user';}
export interface Session {user:User;csrfToken:string;tokenHash:string;}
const userView=(r:any):User=>({id:r.id,email:r.email,role:r.role});
export const tripView=(r:any)=>({id:r.id,title:r.title,constraints:r.constraints,currentVersionId:r.current_version_id,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at});
export const versionView=(r:any)=>({id:r.id,number:r.number,status:r.status,baseVersionId:r.base_version_id,createdAt:r.created_at,request:r.request,content:r.content,schemaVersion:r.schema_version||1,guide:r.guide||null,artifactHash:r.artifact_hash||null,qaStatus:r.qa_status||null,review:r.review||null});
export const jobView=(r:any)=>({id:r.id,tripId:r.trip_id,status:r.status,mode:r.mode,request:r.request,versionId:r.version_id,errorCode:r.error_code,errorMessage:r.error_message,createdAt:r.created_at,updatedAt:r.updated_at,stage:r.stage||'outline',outline:r.outline||null,outlineHash:r.outline_hash||null,outlineVersion:r.outline_version||0,recoveryRequired:r.status==='failed',possibleCharge:!!r.possible_charge,checkpoints:r.checkpoint?.completed||[]});
export class AppService {
  private dummyHash:Promise<string>;
  constructor(public db:Database,public config:Config){this.dummyHash=hashPassword(token());}
  async login(input:unknown,ip:string){
    const body=credentialsSchema.parse(input);
    await this.authLimit(ip,body.email);
    const row=(await this.db.query('SELECT * FROM users WHERE email=$1',[body.email])).rows[0];
    const valid=await verifyPassword(body.password,row?.password_hash||await this.dummyHash);
    if(!row||!valid||row.status!=='active')reject(401,'LOGIN_FAILED','邮箱或密码无效，或账户已停用');
    return this.createSession(row);
  }
  private async authLimit(ip:string,email:string){await rateLimit(this.db,`auth:ip:${digest(ip)}`,60,900);await rateLimit(this.db,`auth:email:${digest(email)}`,12,900);}
  async register(input:unknown,ip:string){
    const body=registerSchema.parse(input);await this.authLimit(ip,body.email);
    const passwordHash=await hashPassword(body.password);
    let user:any;
    try{user=await this.db.transaction(async tx=>{
      const inv=(await tx.query('SELECT * FROM invites WHERE token_hash=$1 FOR UPDATE',[digest(body.inviteCode)])).rows[0];
      if(!inv||inv.used_by||new Date(inv.expires_at)<=new Date())reject(400,'INVITE_INVALID','邀请码无效、已使用或已过期');
      const id=randomUUID();
      const row=(await tx.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'user') RETURNING *",[id,body.email,passwordHash])).rows[0];
      await tx.query('UPDATE invites SET used_by=$1 WHERE token_hash=$2',[id,digest(body.inviteCode)]);return row;
    });}catch(error:any){if(error.code==='23505')reject(409,'REGISTRATION_FAILED','无法创建账户，请检查邮箱或联系管理员');throw error;}
    return this.createSession(user);
  }
  private async createSession(user:any){
    const sessionToken=token();const csrfToken=token();
    await this.db.query('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)',[digest(sessionToken),user.id,csrfToken,new Date(Date.now()+7*86400000)]);
    return {sessionToken,user:userView(user),csrfToken};
  }
  async authenticate(raw:string|undefined):Promise<Session>{
    if(!raw||raw.length>200)reject(401,'AUTH_REQUIRED','请先登录');
    const tokenHash=digest(raw);
    const row=(await this.db.query("SELECT u.id,u.email,u.role,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active'",[tokenHash])).rows[0];
    if(!row)reject(401,'AUTH_REQUIRED','登录已过期，请重新登录');
    return {user:userView(row),csrfToken:row.csrf_token,tokenHash};
  }
  async logout(session:Session){await this.db.query('DELETE FROM sessions WHERE token_hash=$1',[session.tokenHash]);return {ok:true};}
  async getSettings(userId:string){
    const row=(await this.db.query('SELECT provider,base_url,model,key_cipher IS NOT NULL AS has_key FROM settings WHERE user_id=$1',[userId])).rows[0];
    return {provider:row?.provider||'openai',baseUrl:row?.base_url||'https://api.openai.com/v1',model:row?.model||'gpt-4.1-mini',hasApiKey:row?.has_key||false,searchAvailable:!!this.config.searchApiKey||!!this.config.searchConfigured,demoEnabled:this.config.demoEnabled};
  }
  async saveSettings(userId:string,input:unknown){
    const body=settingsSchema.parse(input);
    await rateLimit(this.db,`settings:${userId}`,20,3600);
    const endpoint=body.provider==='openai'?'https://api.openai.com/v1':body.provider==='deepseek'?'https://api.deepseek.com':body.baseUrl;
    if(!endpoint)reject(400,'ENDPOINT_REQUIRED','请填写自定义接口地址');
    let baseUrl:string;
    try{const url=validateProviderBaseUrl(endpoint);await validatePublicHost(url);baseUrl=url.href.replace(/\/$/,'');}
    catch{reject(400,'ENDPOINT_BLOCKED','接口必须是可解析的公网 HTTPS 地址，不允许内网、重定向地址或非 443 端口');}
    const cipher=body.apiKey?encryptApiKey(body.apiKey,userId,this.config.encryptionSecret):null;
    await this.db.transaction(async tx=>{
      const prev=(await tx.query('SELECT * FROM settings WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
      const keep=prev?.provider===body.provider&&prev?.base_url===baseUrl;
      if(!cipher&&!keep)reject(400,'KEY_REQUIRED','更换服务商或接口地址时，请重新填写 API Key');
      await tx.query(`INSERT INTO settings(user_id,provider,base_url,model,key_cipher) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(user_id) DO UPDATE SET provider=$2,base_url=$3,model=$4,key_cipher=$5,updated_at=now()`,[userId,body.provider,baseUrl,body.model,cipher||(keep?prev.key_cipher:null)]);
    });
    return this.getSettings(userId);
  }
  async deleteKey(userId:string){await this.db.query('UPDATE settings SET key_cipher=NULL,updated_at=now() WHERE user_id=$1',[userId]);return this.getSettings(userId);}
  async listTrips(userId:string){return {trips:(await this.db.query('SELECT * FROM trips WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 200',[userId])).rows.map(tripView)};}
  async createTrip(userId:string,input:unknown){
    const envelope=z.object({title:z.string().trim().min(1).max(160).optional()}).passthrough().parse(input);
    const {title,...raw}=envelope;const constraints=tripConstraintsSchema.parse(raw);
    await rateLimit(this.db,`trips:${userId}`,30,86400);
    const row=(await this.db.query('INSERT INTO trips(id,user_id,title,constraints) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),userId,title||`${constraints.destination} · ${constraints.startDate}`,JSON.stringify(constraints)])).rows[0];
    return {trip:tripView(row)};
  }
  async ownedTrip(userId:string,id:string,db:Queryable=this.db,lock=false){
    idSchema.parse(id);const row=(await db.query(`SELECT * FROM trips WHERE id=$1 AND user_id=$2${lock?' FOR UPDATE':''}`,[id,userId])).rows[0];
    if(!row)reject(404,'NOT_FOUND','未找到行程');return row;
  }
  async getTrip(userId:string,id:string){
    const trip=await this.ownedTrip(userId,id);
    const versions=await this.db.query('SELECT id,trip_id,number,status,base_version_id,created_at,request,content,schema_version,artifact_hash,qa_status,review FROM versions WHERE trip_id=$1 AND (id=$2 OR id IN (SELECT id FROM versions WHERE trip_id=$1 ORDER BY number DESC LIMIT 200)) ORDER BY number DESC',[id,trip.current_version_id]);
    const jobs=await this.db.query('SELECT id,trip_id,status,mode,request,version_id,error_code,error_message,created_at,updated_at,stage,outline,outline_hash,outline_version,possible_charge,jsonb_build_object(\'completed\',checkpoint->\'completed\') AS checkpoint FROM jobs WHERE trip_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50',[id,userId]);
    return {trip:tripView(trip),versions:versions.rows.map(versionView),jobs:jobs.rows.map(jobView)};
  }
  async getVersion(userId:string,tripId:string,versionId:string){
    idSchema.parse(versionId);await this.ownedTrip(userId,tripId);
    const row=(await this.db.query("SELECT id,trip_id,number,status,base_version_id,created_at,request,content,schema_version,artifact_hash,qa_status,review,guide FROM versions WHERE id=$1 AND trip_id=$2 AND status<>'discarded'",[versionId,tripId])).rows[0];
    if(!row)reject(404,'NOT_FOUND','未找到版本');return {version:versionView(row)};
  }
  private verifyIdempotency(existing:any,tripId:string,body:z.infer<typeof jobSchema>){
    if(existing.trip_id!==tripId||existing.request!==body.request||existing.mode!==body.mode)reject(409,'IDEMPOTENCY_CONFLICT','此请求标识已用于另一项操作，请刷新后重试');
    return {job:jobView(existing)};
  }
  async createJob(userId:string,tripId:string,input:unknown){
    const body=jobSchema.parse(input);await this.ownedTrip(userId,tripId);
    const existing=(await this.db.query('SELECT * FROM jobs WHERE user_id=$1 AND idempotency_key=$2',[userId,body.idempotencyKey])).rows[0];
    if(existing)return this.verifyIdempotency(existing,tripId,body);
    return this.db.transaction(async tx=>{
      // Consistent order: account before trip; avoids cycles with account disabling.
      const account=(await tx.query('SELECT status FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
      if(!account||account.status!=='active')reject(403,'ACCOUNT_DISABLED','账户已停用');
      const trip=await this.ownedTrip(userId,tripId,tx,true);
      const active=(await tx.query("SELECT * FROM jobs WHERE trip_id=$1 AND status IN ('queued','running','awaiting_outline')",[tripId])).rows[0];
      if(active)return {job:jobView(active)};
      if(body.mode==='demo'&&!this.config.demoEnabled)reject(400,'DEMO_DISABLED','演示模式未启用');
      if(body.mode==='live'){
        const configured=(await tx.query('SELECT key_cipher IS NOT NULL AS ready FROM settings WHERE user_id=$1',[userId])).rows[0];
        if(!configured?.ready)reject(400,'PROVIDER_REQUIRED','请先在模型设置中保存自己的 API Key');
      }
      if(trip.current_version_id&&!body.request)reject(400,'REQUEST_REQUIRED','请说明希望如何调整当前行程');
      const again=(await tx.query('SELECT * FROM jobs WHERE user_id=$1 AND idempotency_key=$2',[userId,body.idempotencyKey])).rows[0];
      if(again)return this.verifyIdempotency(again,tripId,body);
      const quota=(await tx.query("SELECT count(*)::int AS count FROM jobs WHERE user_id=$1 AND created_at>now()-interval '24 hours'",[userId])).rows[0];
      if(quota.count>=20)reject(429,'DAILY_LIMIT','已达到每日 20 次生成上限，请明天再试');
      const pending=(await tx.query("SELECT count(*)::int AS count FROM jobs WHERE user_id=$1 AND status IN ('queued','running','awaiting_outline')",[userId])).rows[0];
      if(pending.count>=2)reject(429,'PENDING_LIMIT','已有两项生成任务，请等待完成');
      const row=(await tx.query("INSERT INTO jobs(id,trip_id,user_id,idempotency_key,request,mode,status,base_version_id,schema_version) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,2) RETURNING *",[randomUUID(),tripId,userId,body.idempotencyKey,body.request,body.mode,trip.current_version_id])).rows[0];
      return {job:jobView(row)};
    });
  }
  async getJob(userId:string,id:string){idSchema.parse(id);const row=(await this.db.query("SELECT id,trip_id,status,mode,request,version_id,error_code,error_message,created_at,updated_at,stage,outline,outline_hash,outline_version,possible_charge,jsonb_build_object('completed',checkpoint->'completed') AS checkpoint FROM jobs WHERE id=$1 AND user_id=$2",[id,userId])).rows[0];if(!row)reject(404,'NOT_FOUND','未找到任务');return {job:jobView(row)};}
  async cancelJob(userId:string,id:string){await this.getJob(userId,id);await this.db.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('queued','running','awaiting_outline')",[id,userId]);return this.getJob(userId,id);}
  async approveOutline(userId:string,id:string,input:unknown){
    idSchema.parse(id);const body=z.object({outlineHash:z.string().regex(/^[a-f0-9]{64}$/),outlineVersion:z.number().int().positive()}).strict().parse(input);
    return this.db.transaction(async tx=>{
      const job=(await tx.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])).rows[0];
      if(!job)reject(404,'NOT_FOUND','未找到任务');
      const trip=await this.ownedTrip(userId,job.trip_id,tx);
      if(job.outline_hash!==body.outlineHash||job.outline_version!==body.outlineVersion||!job.outline||boundOutlineHash(job.outline,job,trip.constraints,job.outline_version)!==body.outlineHash)reject(409,'OUTLINE_CHANGED','大纲已变化，请重新阅读并确认');
      if(job.base_version_id!==trip.current_version_id)reject(409,'STALE_CANDIDATE','当前采用版本已变化，请重新生成大纲');
      if(job.approved_outline_hash===body.outlineHash&&['queued','running','succeeded'].includes(job.status))return {job:jobView(job)};
      if(job.mode==='live'&&!this.config.searchApiKey&&!this.config.searchConfigured)reject(400,'SEARCH_REQUIRED','完整研究需要管理员配置检索服务');
      if(job.status!=='awaiting_outline')reject(409,'INVALID_JOB_STATE','此任务目前不能确认大纲');
      const row=(await tx.query("UPDATE jobs SET status='queued',stage='research',approved_outline_hash=$1,approved_at=now(),updated_at=now() WHERE id=$2 RETURNING *",[body.outlineHash,id])).rows[0];
      await tx.query("INSERT INTO job_events(id,job_id,stage,event) VALUES($1,$2,'outline','user_approved')",[randomUUID(),id]);
      return {job:jobView(row)};
    });
  }
  async resumeJob(userId:string,id:string,input:unknown){
    idSchema.parse(id);const body=z.object({acknowledgePossibleCharge:z.boolean().default(false)}).strict().parse(input);
    return this.db.transaction(async tx=>{
      const account=(await tx.query('SELECT status FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
      if(account?.status!=='active')reject(403,'ACCOUNT_DISABLED','账户已停用');
      const job=(await tx.query('SELECT * FROM jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])).rows[0];
      if(!job)reject(404,'NOT_FOUND','未找到任务');
      if(job.status!=='failed')reject(409,'INVALID_JOB_STATE','仅失败任务可以恢复');
      if(job.schema_version!==2)reject(409,'LEGACY_JOB','历史任务请重新创建大纲');
      if(job.resume_attempt>=5)reject(429,'RESUME_LIMIT','此任务已恢复五次，请检查设置后重新创建任务');
      const trip=await this.ownedTrip(userId,job.trip_id,tx,true);
      if(trip.current_version_id!==job.base_version_id)reject(409,'STALE_CANDIDATE','当前采用版本已变化，请重新生成大纲');
      const active=(await tx.query("SELECT id FROM jobs WHERE trip_id=$1 AND status IN ('queued','running','awaiting_outline')",[trip.id])).rows[0];
      if(active)reject(409,'ACTIVE_JOB','此行程已有进行中的任务');
      const pending=(await tx.query("SELECT count(*)::int AS count FROM jobs WHERE user_id=$1 AND status IN ('queued','running','awaiting_outline')",[userId])).rows[0];
      if(pending.count>=2)reject(429,'PENDING_LIMIT','已有两项生成任务，请等待完成');
      if(job.possible_charge&&!body.acknowledgePossibleCharge)reject(409,'CHARGE_ACK_REQUIRED','上次调用可能已计费，请先检查服务商用量并确认再次调用');
      await tx.query("UPDATE job_operations SET operation_key=operation_key||':retired-'||$1 WHERE job_id=$2 AND status='not_sent' AND operation_key NOT LIKE '%:retired-%'",[String(job.resume_attempt),id]);
      await tx.query("UPDATE job_operations SET operation_key=operation_key||':retired-'||$1,status='ambiguous' WHERE job_id=$2 AND status IN ('started','ambiguous') AND operation_key NOT LIKE '%:retired-%'",[String(job.resume_attempt),id]);
      const row=(await tx.query("UPDATE jobs SET status='queued',resume_attempt=resume_attempt+1,possible_charge=false,error_code=NULL,error_message=NULL,claimed_by=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
      await tx.query('INSERT INTO job_events(id,job_id,stage,event) VALUES($1,$2,$3,$4)',[randomUUID(),id,job.stage,job.possible_charge?'user_retry_charge_acknowledged':'user_resumed']);
      return {job:jobView(row)};
    });
  }
  async reviewVersion(userId:string,tripId:string,versionId:string,input:unknown){
    idSchema.parse(versionId);const body=z.object({artifactHash:z.string().regex(/^[a-f0-9]{64}$/),checks:z.object({desktop:z.literal(true),mobile:z.literal(true),content:z.literal(true),maps:z.literal(true)}).strict(),note:z.string().trim().min(10).max(2000)}).strict().parse(input);
    return this.db.transaction(async tx=>{
      await this.ownedTrip(userId,tripId,tx,true);
      const v=(await tx.query('SELECT * FROM versions WHERE id=$1 AND trip_id=$2 FOR UPDATE',[versionId,tripId])).rows[0];
      if(!v||v.status==='discarded')reject(404,'NOT_FOUND','未找到版本');
      if(v.schema_version!==2||!v.artifact_html||v.artifact_hash!==body.artifactHash||sha256(v.artifact_html)!==body.artifactHash)reject(409,'ARTIFACT_CHANGED','手册版本已变化，请重新检查');
      const review={...body,reviewedAt:new Date().toISOString(),reviewerId:userId,validationMode:'human_confirmation',acceptance:v.guide?.qa?.handoffAllowed?'handoff':'preview_only',notice:'此记录来自用户确认。尚未完成的来源、素材、地图和浏览器验收不会因此变成通过；采用的仍可能是预览版本'};
      const row=(await tx.query("UPDATE versions SET review=$1,qa_status='passed' WHERE id=$2 RETURNING *",[JSON.stringify(review),versionId])).rows[0];return {version:versionView(row)};
    });
  }
  async artifact(userId:string,tripId:string,versionId:string){
    idSchema.parse(versionId);await this.ownedTrip(userId,tripId);
    const row=(await this.db.query("SELECT artifact_html,artifact_hash,number FROM versions WHERE id=$1 AND trip_id=$2 AND status<>'discarded' AND schema_version=2",[versionId,tripId])).rows[0];
    if(!row?.artifact_html||sha256(row.artifact_html)!==row.artifact_hash)reject(404,'ARTIFACT_UNAVAILABLE','手册文件暂不可用');
    return {html:row.artifact_html as string,hash:row.artifact_hash as string,number:row.number};
  }
  async reviewAssets(userId:string,tripId:string,versionId:string,input:unknown){
    idSchema.parse(versionId);const body=z.object({artifactHash:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().uuid(),coverAssetId:z.string().max(160).optional(),reviews:z.array(z.object({assetId:z.string().max(160),sha256:z.string().regex(/^[a-f0-9]{64}$/),sourcePage:z.string().url().max(2000),identity:z.literal(true),visual:z.literal(true),watermark:z.literal(true),note:z.string().trim().min(10).max(1000)}).strict()).min(1).max(80)}).strict().parse(input);
    return this.db.transaction(async tx=>{
      const account=(await tx.query('SELECT status FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];if(account?.status!=='active')reject(403,'ACCOUNT_DISABLED','账户已停用');
      const trip=await this.ownedTrip(userId,tripId,tx,true);
      const previous=(await tx.query('SELECT * FROM jobs WHERE user_id=$1 AND idempotency_key=$2',[userId,body.idempotencyKey])).rows[0];
      if(previous){if(previous.trip_id!==tripId||previous.checkpoint?.assetReview?.artifactHash!==body.artifactHash||previous.checkpoint?.assetReview?.versionId!==versionId||previous.checkpoint?.assetReview?.coverAssetId!==(body.coverAssetId||null)||hashObject(previous.checkpoint?.assetReview?.reviews)!==hashObject(body.reviews))reject(409,'IDEMPOTENCY_CONFLICT','此请求标识已用于另一项操作');return {job:jobView(previous)};}
      const version=(await tx.query('SELECT * FROM versions WHERE id=$1 AND trip_id=$2',[versionId,tripId])).rows[0];
      if(!version||version.status!=='candidate'||version.schema_version!==2)reject(409,'CANDIDATE_REQUIRED','请对尚未采用的完整候选手册记录素材检查');
      if(version.artifact_hash!==body.artifactHash||sha256(version.artifact_html)!==body.artifactHash)reject(409,'ARTIFACT_CHANGED','手册文件已变化，请重新检查');
      if(version.base_version_id!==trip.current_version_id)reject(409,'STALE_CANDIDATE','当前采用版本已经变化');
      const active=(await tx.query("SELECT id FROM jobs WHERE trip_id=$1 AND status IN ('queued','running','awaiting_outline')",[tripId])).rows[0];if(active)reject(409,'ACTIVE_JOB','此行程已有进行中的任务');
      const pending=(await tx.query("SELECT count(*)::int count FROM jobs WHERE user_id=$1 AND status IN ('queued','running','awaiting_outline')",[userId])).rows[0];if(pending.count>=2)reject(429,'PENDING_LIMIT','已有两项生成任务');
      const original=(await tx.query('SELECT * FROM jobs WHERE version_id=$1 AND user_id=$2 AND schema_version=2',[versionId,userId])).rows[0];
      if(!original?.approved_at||!original.outline||original.approved_outline_hash!==original.outline_hash)reject(409,'OUTLINE_REQUIRED','原候选缺少已批准大纲');
      const assets=structuredClone(version.guide.assets);const seen=new Set<string>();
      for(const review of body.reviews){
        const asset=assets.find((a:any)=>a.id===review.assetId);
        if(!asset||seen.has(asset.id)||asset.sha256!==review.sha256||asset.sourcePage!==review.sourcePage||!safeRaster(asset))reject(409,'ASSET_CHANGED','素材内容或来源不匹配，请重新逐项检查');seen.add(asset.id);
        Object.assign(asset,{status:'reviewed',sourceIdentityBound:true,visuallyConfirmed:true,watermarkChecked:true,review:{sha256:asset.sha256,sourcePage:asset.sourcePage,file:asset.file,toolReference:`human-confirmation:${userId}:${versionId}`,note:review.note,checkedAt:new Date().toISOString()}});
      }
      const packs=structuredClone(version.research_packs);
      if(body.coverAssetId){const cover=assets.find((a:any)=>a.id===body.coverAssetId&&a.kind==='place-image'&&a.status==='reviewed');if(!cover)reject(400,'COVER_REVIEW_REQUIRED','封面必须选用已实际复核的场所图片');Object.assign(packs.framing.cover,{image:cover.file,source_id:cover.sourceId,source_page:cover.sourcePage,derived_from:cover.file});}
      const checkpoint={packs,sources:version.guide.sources,assets,plan:[],startedAt:new Date().toISOString(),completed:[{stage:'outline',status:'complete',updatedAt:original.approved_at}],assetReview:{artifactHash:body.artifactHash,reviews:body.reviews,coverAssetId:body.coverAssetId||null,versionId}};
      const row=(await tx.query("INSERT INTO jobs(id,trip_id,user_id,idempotency_key,request,mode,status,base_version_id,schema_version,stage,outline,outline_hash,outline_version,approved_outline_hash,approved_at,checkpoint) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,2,'compile',$8,$9,$10,$9,$11,$12) RETURNING *",[randomUUID(),tripId,userId,body.idempotencyKey,original.request,original.mode,version.base_version_id,JSON.stringify(original.outline),original.outline_hash,original.outline_version,original.approved_at,JSON.stringify(checkpoint)])).rows[0];
      return {job:jobView(row)};
    });
  }
  async adoptVersion(userId:string,tripId:string,versionId:string,input:unknown){
    idSchema.parse(versionId);const body=z.object({expectedRevision:z.number().int().min(0),acknowledgePartial:z.boolean().optional()}).strict().parse(input);
    return this.db.transaction(async tx=>{
      const trip=await this.ownedTrip(userId,tripId,tx,true);
      if(trip.revision!==body.expectedRevision)reject(409,'REVISION_CONFLICT','行程已在其他窗口发生变化，请刷新后再操作');
      const v=(await tx.query('SELECT * FROM versions WHERE id=$1 AND trip_id=$2 FOR UPDATE',[versionId,tripId])).rows[0];
      if(!v||v.status==='discarded')reject(404,'NOT_FOUND','版本不存在或已取消');
      if(v.status==='candidate'&&v.base_version_id!==trip.current_version_id)reject(409,'STALE_CANDIDATE','当前行程已经变化，请基于当前版本重新生成');
      if(v.schema_version===2&&v.status==='candidate'&&(v.qa_status!=='passed'||v.review?.artifactHash!==v.artifact_hash))reject(409,'REVIEW_REQUIRED','请对当前手册完成并保存实际检查，再单独采用版本');
      if(v.schema_version===2&&v.status==='candidate'&&!v.guide?.qa?.handoffAllowed&&body.acknowledgePartial!==true)reject(409,'PARTIAL_ACK_REQUIRED','该预览仍有未通过的完整交付检查；请明确确认保留这些未验证标记再采用');
      if(trip.current_version_id===versionId)return {trip:tripView(trip)};
      await tx.query("UPDATE versions SET status='adopted' WHERE id=$1",[versionId]);
      const row=(await tx.query('UPDATE trips SET current_version_id=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *',[versionId,tripId])).rows[0];return {trip:tripView(row)};
    });
  }
  async discardVersion(userId:string,tripId:string,versionId:string){
    idSchema.parse(versionId);
    return this.db.transaction(async tx=>{await this.ownedTrip(userId,tripId,tx,true);
      const row=(await tx.query("UPDATE versions SET status='discarded' WHERE id=$1 AND trip_id=$2 AND status='candidate' RETURNING *",[versionId,tripId])).rows[0];
      if(!row)reject(409,'CANNOT_DISCARD','只能取消尚未采用的候选版本');return {version:versionView(row)};
    });
  }
  async exportVersion(userId:string,tripId:string,versionId?:string){
    const trip=await this.ownedTrip(userId,tripId);const id=versionId||trip.current_version_id;
    if(!id)reject(400,'NO_VERSION','请先采用一个生成版本');idSchema.parse(id);
    const version=(await this.db.query("SELECT * FROM versions WHERE id=$1 AND trip_id=$2 AND status<>'discarded'",[id,tripId])).rows[0];
    if(!version)reject(404,'NOT_FOUND','未找到可导出的版本');
    // Explicit allowlist: never serialize user, settings, job internals or generation request.
    return {formatVersion:1,exportedAt:new Date().toISOString(),title:trip.title,constraints:trip.constraints,version:version.number,versionId:version.id,itinerary:version.content,...(version.schema_version===2?{guide:version.guide,artifactHash:version.artifact_hash,qaStatus:version.qa_status}: {})};
  }
  admin(user:User){if(user.role!=='admin')reject(403,'ADMIN_REQUIRED','需要管理员权限');}
  async listUsers(user:User){this.admin(user);return {users:(await this.db.query('SELECT id,email,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 500')).rows.map(r=>({...userView(r),status:r.status,createdAt:r.created_at}))};}
  async setUserStatus(user:User,id:string,input:unknown){
    this.admin(user);idSchema.parse(id);const {status}=z.object({status:z.enum(['active','disabled'])}).strict().parse(input);
    if(id===user.id)reject(400,'SELF_DISABLE','不能停用自己的账户');
    return this.db.transaction(async tx=>{const row=(await tx.query("UPDATE users SET status=$1 WHERE id=$2 AND role<>'admin' RETURNING id,email,role,status,created_at",[status,id])).rows[0];
      if(!row)reject(400,'PROTECTED_USER','无法修改此账户（管理员需通过服务器操作）');
      if(status==='disabled'){await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE user_id=$1 AND status IN ('queued','running','awaiting_outline')",[id]);}
      return {user:{...userView(row),status:row.status,createdAt:row.created_at}};
    });
  }
  async createInvite(user:User){this.admin(user);await rateLimit(this.db,`invites:${user.id}`,30,86400);const inviteCode=token();const expiresAt=new Date(Date.now()+7*86400000);await this.db.query('INSERT INTO invites(token_hash,created_by,expires_at) VALUES($1,$2,$3)',[digest(inviteCode),user.id,expiresAt]);return {inviteCode,expiresAt};}
  async overview(user:User){this.admin(user);
    const counts=(await this.db.query(`SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM trips) AS trips,
      (SELECT count(*)::int FROM jobs WHERE status='queued') AS queued,(SELECT count(*)::int FROM jobs WHERE status='running') AS running,
      (SELECT count(*)::int FROM jobs WHERE status='failed') AS failed`)).rows[0];
    const failures=(await this.db.query("SELECT id,user_id,error_code,created_at FROM jobs WHERE status='failed' ORDER BY created_at DESC LIMIT 30")).rows.map(r=>({id:r.id,userId:r.user_id,errorCode:r.error_code,createdAt:r.created_at}));return {counts,failures};
  }
}
