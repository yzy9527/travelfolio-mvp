import {randomUUID} from 'node:crypto';
import {Database} from './db';
import {Config} from './config';
import {decryptApiKey} from './crypto';
import {tripConstraintsSchema,tripDates,type TripConstraints} from './schemas';
import {type ProviderSettings} from './provider';
import {PACK_IDS,type PackId,type ResearchPacks,type CompiledGuide,type AssetEvidence} from './skill/types';
import {generateOutline,researchPack,acquireEvidence,acquireAssets,type SkillOutline} from './skill/provider';
import {compileGuide,toLegacyItinerary,assessOfflineQa} from './skill/compiler';
import {captureRouteMaps} from './skill/maps';
import {runGuideBrowserQa} from './skill/browser-qa';
import {renderGuideHtml} from './skill/renderer';
import {makeFixturePacks} from './skill/fixtures';
import {planInvalidation} from './skill/graph';
import {boundOutlineHash,sha256,hashObject} from './skill/hash';
import {OperationLedger,PipelineError} from './skill/operations';
import {JobWorkspace} from './skill/workspace';
import {SafeProviderError} from './safe-http';
import {SkillValidationError} from './skill/schemas';

const researchErrors:Record<string,string>={
  RESEARCH_NO_RELEVANT_SOURCES:'搜索结果未找到与目的地匹配的资料，已停止抓取和模型调用。请在新行程中填写更明确的城市及省份或国家；重复恢复会复用同一批搜索结果。',
  RESEARCH_EVIDENCE_REQUIRED:'未能获取可用的来源网页正文。请检查来源网站的网络、DNS 或访问限制后恢复；恢复会重抓失败网页并复用已完成的搜索结果。',
  UNSAFE_PROVIDER_HOST:'外部服务或来源网站解析到了非公网地址（可能是代理 Fake IP）。请检查 Worker 的可信 DNS 模式后恢复。',
  PROVIDER_DNS_FAILED:'外部服务或来源网站 DNS 解析失败，请检查 Worker 的可信 DNS 连通性后恢复。',
};
export function operationService(key:string):string{
  if(key.startsWith('evidence:')&&key.includes(':search:'))return 'Brave 搜索';
  if(key==='outline')return '模型大纲';
  if(key.startsWith('research:'))return '模型研究';
  return '外部调用';
}
export function safeDiagnostic(row:any,error:unknown):string{
  const source=error instanceof SafeProviderError?error:null;
  const code=source?.code??(typeof row?.failure_code==='string'?row.failure_code:null);
  const phase=source?.phase??row?.failure_phase;
  const status=source?.httpStatus??row?.http_status;
  const detail=source?.validationDetail??row?.failure_detail;
  const parts=[row?.operation_key?operationService(row.operation_key):'外部服务'];
  if(['dns','connect','tls','response'].includes(phase))parts.push(`阶段 ${phase}`);
  if(code&&/^[A-Z_]{2,60}$/.test(code))parts.push(`错误 ${code}`);
  if(typeof detail==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(detail))parts.push(`字段 ${detail}`);
  if(Number.isInteger(status)&&status>=100&&status<=599)parts.push(`HTTP ${status}`);
  if(row?.status==='not_sent'||source?.requestSent===false)parts.push('请求未发送');
  return parts.join('；');
}

export interface WorkerAdapters {
  outline:typeof generateOutline; research:typeof researchPack; evidence:typeof acquireEvidence; assets:typeof acquireAssets;
  maps:typeof captureRouteMaps; browserQa:typeof runGuideBrowserQa;
}
const defaults:WorkerAdapters={outline:generateOutline,research:researchPack,evidence:acquireEvidence,assets:acquireAssets,maps:captureRouteMaps,browserQa:runGuideBrowserQa};
interface Checkpoint { packs?:Partial<ResearchPacks>; sources?:any[]; assets?:AssetEvidence[]; compiled?:CompiledGuide; plan?:PackId[]; completed?:{stage:string;status:'complete';updatedAt:string}[]; evidenceByPack?:Record<string,boolean>; startedAt?:string; }
const fixtureOutline=(c:TripConstraints,request:string):SkillOutline=>({title:`${c.destination} · 合成演示大纲`,summary:'用于验证流程的合成数据，不是真实旅行建议',days:tripDates(c.startDate,c.endDate).map((date,i)=>({date,title:`第 ${i+1} 天`,focus:request||'示例流程',pace:'standard',areas:['演示区域']})),assumptions:['演示不调用模型或检索，不证明真实目的地可用'],openQuestions:[],changedPacks:[...PACK_IDS]});
function assertNoSecrets(value:unknown,secrets:string[]){const text=JSON.stringify(value);if(secrets.some(s=>s&&text.includes(s)))throw new PipelineError('SECRET_REFLECTION');}
function referencedSources(value:unknown):Set<string>{
  const ids=new Set<string>();const visit=(item:unknown)=>{if(Array.isArray(item)){item.forEach(visit);return;}if(!item||typeof item!=='object')return;for(const [key,child] of Object.entries(item)){if(key==='source_id'&&typeof child==='string')ids.add(child);if(key==='source_ids'&&Array.isArray(child))child.forEach(id=>{if(typeof id==='string')ids.add(id);});visit(child);}};visit(value);return ids;
}
export class GenerationWorker {
  private instance=randomUUID();private timer?:NodeJS.Timeout;private running=false;private closed=false;private controller?:AbortController;
  private adapters:WorkerAdapters;
  constructor(private db:Database,private config:Config,adapters:Partial<WorkerAdapters>={}){this.adapters={...defaults,...adapters};}
  start(){this.timer=setInterval(()=>{void this.tick();},500);void this.tick();}
  async stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.controller?.abort();while(this.running)await new Promise(resolve=>setTimeout(resolve,20));}
  private async recover(){
    await this.db.transaction(async tx=>{
      const jobs=(await tx.query("SELECT id FROM jobs WHERE status='running' AND lease_until<now() FOR UPDATE SKIP LOCKED")).rows;
      for(const job of jobs){
        const ambiguous=(await tx.query("SELECT id FROM job_operations WHERE job_id=$1 AND status IN ('started','ambiguous') AND operation_key NOT LIKE '%:retired-%' LIMIT 1",[job.id])).rows[0];
        await tx.query("UPDATE job_operations SET status='ambiguous' WHERE job_id=$1 AND status='started'",[job.id]);
        await tx.query("UPDATE jobs SET status=$1,possible_charge=$2,error_code=$3,error_message=$4,claimed_by=NULL,lease_until=NULL,updated_at=now() WHERE id=$5",[ambiguous?'failed':'queued',!!ambiguous,ambiguous?'POSSIBLE_CHARGE':null,ambiguous?'调用中断，服务商可能已计费；请先核对用量，再确认恢复。':null,job.id]);
      }
    });
  }
  async tick(){
    if(this.running||this.closed)return;this.running=true;
    try{
      await this.recover();
      const claimed=await this.db.transaction(async tx=>{
        const row=(await tx.query("SELECT j.* FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.status='queued' AND u.status='active' ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1")).rows[0];
        if(!row)return null;
        await tx.query("UPDATE jobs SET status='running',claimed_by=$1,lease_until=now()+interval '60 seconds',updated_at=now() WHERE id=$2",[this.instance,row.id]);return row;
      });
      if(!claimed)return;
      const controller=new AbortController();this.controller=controller;const signal=controller.signal;
      const active=async()=>{
        const row=(await this.db.query("SELECT j.status,j.claimed_by,u.status AS user_status FROM jobs j JOIN users u ON u.id=j.user_id WHERE j.id=$1",[claimed.id])).rows[0];
        if(this.closed||signal.aborted||row?.status!=='running'||row.claimed_by!==this.instance||row.user_status!=='active'){controller.abort();throw new PipelineError('CANCELLED');}
      };
      const heartbeat=setInterval(()=>{void (async()=>{try{await active();await this.db.query("UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND status='running' AND claimed_by=$2",[claimed.id,this.instance]);}catch{controller.abort();}})();},1000);
      try{await this.advance(claimed,signal,active);}catch(error){
        const ambiguity=(await this.db.query("SELECT id,operation_key,status,failure_code,failure_phase,http_status,failure_detail FROM job_operations WHERE job_id=$1 AND status IN ('started','ambiguous') AND operation_key NOT LIKE '%:retired-%' ORDER BY started_at DESC LIMIT 1",[claimed.id])).rows[0];
        const notSent=(await this.db.query("SELECT operation_key,status,failure_code,failure_phase,http_status,failure_detail FROM job_operations WHERE job_id=$1 AND status='not_sent' AND operation_key NOT LIKE '%:retired-%' ORDER BY started_at DESC LIMIT 1",[claimed.id])).rows[0];
        const safeCodes=new Set(['SKILL_VALIDATION_FAILED','POSSIBLE_CHARGE','CHECKPOINT_MISMATCH','PROVIDER_SETTINGS_REQUIRED','SEARCH_REQUIRED','PROVIDER_INVALID_RESPONSE','SECRET_REFLECTION','AUTOMATIC_GATES_FAILED','LEGACY_JOB','OUTLINE_REQUIRED','CANCELLED']);
        const proposed=error instanceof Error&&'code' in error?String(error.code):'GENERATION_FAILED';
        const code=ambiguity?'POSSIBLE_CHARGE':safeCodes.has(proposed)||error instanceof SafeProviderError?proposed:'GENERATION_FAILED';
        const baseMessage=ambiguity?'调用可能已计费；已完成的数据包会保留，核对服务商用量后再恢复。':researchErrors[code]??(error instanceof SafeProviderError?error.message:'阶段执行未完成；已完成检查点和已采用版本均保留。请检查配置或研究资料后恢复。');
        const diagnostic=ambiguity||notSent?safeDiagnostic(ambiguity??notSent,error):error instanceof SafeProviderError?safeDiagnostic(null,error):'';
        let pageDiagnostic='';
        if(claimed.stage==='research'&&['RESEARCH_EVIDENCE_REQUIRED','UNSAFE_PROVIDER_HOST'].includes(code)){
          const current=(await this.db.query('SELECT checkpoint FROM jobs WHERE id=$1',[claimed.id])).rows[0]?.checkpoint;
          const failures=(current?.sources??[]).filter((source:any)=>source.retrievalStatus==='page_unavailable'&&/^[A-Z_]{2,60}$/.test(source.failureCode??''));
          const summaries=[...new Set(failures.map((source:any)=>`${source.failureCode}${Number.isInteger(source.failureHttpStatus)?` HTTP ${source.failureHttpStatus}`:''}`))].slice(0,4);
          if(summaries.length)pageDiagnostic=`来源网页抓取：${summaries.join('、')}`;
        }
        const validationDiagnostic=error instanceof SkillValidationError ? error.issues.slice(0,12).filter(issue=>/^[A-Z_]{2,60}$/.test(issue.code)&&/^\/[A-Za-z0-9_/-]{0,160}$/.test(issue.path)).map(issue=>`${issue.code} ${issue.path}`).join('；') : '';
        const details=[diagnostic,pageDiagnostic,validationDiagnostic].filter(Boolean).join('；');
        const message=details?`${baseMessage} ${details}。`:baseMessage;
        await this.db.query("UPDATE jobs SET status='failed',error_code=$1,error_message=$2,possible_charge=$3,lease_until=NULL,updated_at=now() WHERE id=$4 AND status='running' AND claimed_by=$5",[code,message,!!ambiguity,claimed.id,this.instance]);
      }finally{clearInterval(heartbeat);this.controller=undefined;}
    }catch{console.error('Generation worker temporarily unavailable');}finally{this.running=false;}
  }
  private async advance(job:any,signal:AbortSignal,active:()=>Promise<void>){
    if(job.schema_version!==2)throw new PipelineError('LEGACY_JOB');
    const trip=(await this.db.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2',[job.trip_id,job.user_id])).rows[0];
    const constraints=tripConstraintsSchema.parse(trip.constraints);
    const base=job.base_version_id?(await this.db.query('SELECT * FROM versions WHERE id=$1 AND trip_id=$2',[job.base_version_id,trip.id])).rows[0]:null;
    const needsModel=job.mode==='live'&&['outline','research'].includes(job.stage);
    const raw=needsModel?(await this.db.query('SELECT * FROM settings WHERE user_id=$1',[job.user_id])).rows[0]:null;
    const settings:ProviderSettings|null=raw?.key_cipher?{provider:raw.provider,baseUrl:raw.base_url,model:raw.model,apiKey:decryptApiKey(raw.key_cipher,job.user_id,this.config.encryptionSecret)}:null;
    if(needsModel&&!settings)throw new PipelineError('PROVIDER_SETTINGS_REQUIRED');
    const secrets=[settings?.apiKey,this.config.searchApiKey].filter((s):s is string=>!!s);
    const ledger=new OperationLedger(this.db,job.id,this.instance,job.resume_attempt,active);
    const runOperation=<T>(key:string,input:unknown,action:()=>Promise<T>)=>ledger.run(key.replace(new RegExp('^'+job.id+':\\d+:'),''),input,async()=>{const result=await action();assertNoSecrets(result,secrets);return result;});
    const workspace=await JobWorkspace.open(this.config.workRoot||'/tmp/travelfolio-jobs',job.user_id,job.id);
    const checkpoint:Checkpoint=job.checkpoint||{};checkpoint.completed??=[];checkpoint.startedAt??=new Date().toISOString();
    const record=async(stage:string,next:string,status='queued')=>{
      await active();checkpoint.completed=checkpoint.completed!.filter(x=>x.stage!==stage);checkpoint.completed.push({stage,status:'complete',updatedAt:new Date().toISOString()});
      assertNoSecrets(checkpoint,secrets);
      await this.db.transaction(async tx=>{
        const owned=(await tx.query('SELECT status,claimed_by FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
        if(owned?.status!=='running'||owned.claimed_by!==this.instance)throw new PipelineError('CANCELLED');
        await tx.query('UPDATE jobs SET checkpoint=$1,stage=$2,status=$3,lease_until=NULL,updated_at=now() WHERE id=$4',[JSON.stringify(checkpoint),next,status,job.id]);
        await tx.query('INSERT INTO job_events(id,job_id,stage,event) VALUES($1,$2,$3,\'completed\')',[randomUUID(),job.id,stage]);
      });
      await workspace.write('checkpoint.json',JSON.stringify(checkpoint,null,2));
    };
    if(job.stage==='outline'){
      const outline=job.mode==='demo'?fixtureOutline(constraints,job.request):await this.adapters.outline({constraints,current:base?.guide||base?.content||null,request:job.request,settings:settings!,operationKey:`${job.id}:${job.resume_attempt}:outline`,signal,runOperation});
      assertNoSecrets(outline,secrets);
      checkpoint.completed.push({stage:'outline',status:'complete',updatedAt:new Date().toISOString()});
      const version=job.outline_version+1,hash=boundOutlineHash(outline,job,constraints,version);
      await active();await this.db.query("UPDATE jobs SET outline=$1,outline_hash=$2,outline_version=$3,status='awaiting_outline',lease_until=NULL,checkpoint=$4,updated_at=now() WHERE id=$5 AND status='running' AND claimed_by=$6",[JSON.stringify(outline),hash,version,JSON.stringify(checkpoint),job.id,this.instance]);
      await workspace.write('outline.json',JSON.stringify({outline,hash,version},null,2));return;
    }
    if(!job.approved_at||!job.outline||job.approved_outline_hash!==job.outline_hash||boundOutlineHash(job.outline,job,constraints,job.outline_version)!==job.approved_outline_hash)throw new PipelineError('OUTLINE_REQUIRED');
    if(job.stage==='research'){
      if(!checkpoint.plan){
        const requested=(job.outline.changedPacks||[]).filter((id:PackId)=>PACK_IDS.includes(id));
        checkpoint.plan=base?.research_packs&&requested.length?planInvalidation(requested).packs:[...PACK_IDS];
        checkpoint.packs=base?.research_packs?{...base.research_packs}:{};
        for(const id of checkpoint.plan!)delete checkpoint.packs![id];
        const retainedSourceIds=referencedSources(checkpoint.packs);
        checkpoint.sources=base?.guide?.sources?base.guide.sources.filter((source:{id:string})=>retainedSourceIds.has(source.id)):[];checkpoint.evidenceByPack={};
      }
      const id=PACK_IDS.find(id=>checkpoint.plan!.includes(id)&&!checkpoint.packs?.[id]);
      if(id){
        if(job.mode==='demo'){
          const fixture=makeFixturePacks(constraints,job.request,job.outline);
          (checkpoint.packs as any)[id]=fixture[id];
        }else{
          if(!this.config.searchApiKey)throw new PipelineError('SEARCH_REQUIRED');
          // Evidence is searched/fetched independently for owning packs. Completed
          // evidence stays in the checkpoint; paid results stay in the ledger.
          checkpoint.evidenceByPack??={};
          // Old checkpoints may mark an all-failed collection as complete. No
          // model can have started without a retrieved page, so these can be
          // refreshed safely while keeping model inputs with evidence frozen.
          if(!checkpoint.evidenceByPack[id]||!checkpoint.sources?.some(source=>source.retrievalStatus==='page_retrieved')){
            const found=await this.adapters.evidence({packId:id,constraints,outline:job.outline,existingSources:checkpoint.sources as any,searchApiKey:this.config.searchApiKey,operationKey:`${job.id}:${job.resume_attempt}:evidence:${id}`,signal,runOperation},{officialHosts:this.config.officialHosts});
            checkpoint.sources=found.sources;checkpoint.evidenceByPack[id]=found.sources.some(source=>source.retrievalStatus==='page_retrieved');
            // Freeze source bytes/timestamps before starting the paid pack call.
            // A crash after model completion can reuse the identical input hash.
            assertNoSecrets(checkpoint,secrets);await active();
            await this.db.query("UPDATE jobs SET checkpoint=$1 WHERE id=$2 AND status='running' AND claimed_by=$3",[JSON.stringify(checkpoint),job.id,this.instance]);
          }
          if(!checkpoint.sources?.some(source=>source.retrievalStatus==='page_retrieved')){
            const failed=checkpoint.sources?.filter(source=>source.packIds?.includes(id)&&source.retrievalStatus==='page_unavailable')??[];
            throw new SafeProviderError(failed.length&&failed.every(source=>source.failureCode==='UNSAFE_PROVIDER_HOST')?'UNSAFE_PROVIDER_HOST':'RESEARCH_EVIDENCE_REQUIRED');
          }
          const pack=await this.adapters.research({packId:id,constraints,outline:job.outline,previousPacks:checkpoint.packs||{},evidence:checkpoint.sources as any,settings:settings!,operationKey:`${job.id}:${job.resume_attempt}:research:${id}`,signal,runOperation});
          (checkpoint.packs as any)[id]=pack;
        }
        await record(`research:${id}`,'research');return;
      }
      await record('research','assets');return;
    }
    if(job.stage==='assets'){
      if(job.mode==='demo')checkpoint.assets=[];
      else{
        const remaining=structuredClone(checkpoint.packs||{});const reusable:AssetEvidence[]=[];
        const visit=(value:unknown)=>{if(Array.isArray(value)){value.forEach(visit);return;}if(!value||typeof value!=='object')return;const place=value as any;
          if(typeof place.id==='string'&&Array.isArray(place.images))place.images=place.images.filter((image:any)=>{
            const receipt=(base?.guide?.assets||[]).find((a:AssetEvidence)=>a.kind==='place-image'&&a.placeId===place.id&&a.file===image.file&&a.sourceId===image.source_id&&a.sourcePage===image.source_page&&a.downloadUrl===image.download_url&&a.dataBase64&&a.sha256===sha256(Buffer.from(a.dataBase64,'base64')));
            if(receipt){
              const owner:PackId=place.type==='restaurant'?'places-food':place.type==='experience'?'places-experiences':['shop','souvenir'].includes(place.type)?'places-shopping':'places-core';
              // Identical bytes may remain useful, but a changed owning pack does
              // not inherit authority from an earlier human identity observation.
              reusable.push(checkpoint.plan?.includes(owner)?{...receipt,status:'downloaded_unreviewed',sourceIdentityBound:false,visuallyConfirmed:false,watermarkChecked:false,review:undefined,reason:'Owning place research changed; retained decoded bytes require a new identity/visual review.'}:receipt);return false;
            }return true;
          });else Object.values(place).forEach(visit);
        };visit(remaining);
        const acquired=await this.adapters.assets({packs:remaining,evidence:checkpoint.sources as any||[],signal},{officialHosts:this.config.officialHosts});
        checkpoint.assets=[...reusable,...acquired.assets] as AssetEvidence[];
      }
      await record('assets','maps');return;
    }
    if(job.stage==='maps'){
      // Preserve genuine base receipts only when itinerary/location inputs are unchanged.
      const affected=checkpoint.plan?.some(p=>['itinerary','places-core','places-food','places-experiences'].includes(p));
      const existing=!affected?base?.guide?.assets?.filter((a:AssetEvidence)=>a.kind==='route-map'&&a.dataBase64&&a.sha256===sha256(Buffer.from(a.dataBase64,'base64'))):[];
      if(existing?.length===checkpoint.packs?.itinerary?.length)checkpoint.assets!.push(...existing);
      else{
        const captured=await this.adapters.maps({packs:checkpoint.packs||{},sources:checkpoint.sources||[],signal,executablePath:this.config.browserExecutablePath});
        checkpoint.assets!.push(...captured.assets);
        await workspace.write('map-capture.json',JSON.stringify({failures:captured.failures,assets:captured.assets.map(({dataBase64:_,...receipt})=>receipt)},null,2));
      }
      await record('maps','compile');return;
    }
    if(job.stage==='compile'){
      checkpoint.compiled=compileGuide(checkpoint.packs as ResearchPacks,{mode:job.mode==='demo'?'fixture':'live',sources:checkpoint.sources||[],assets:checkpoint.assets||[],generatedAt:checkpoint.startedAt!});
      assertNoSecrets(checkpoint.compiled,secrets);await workspace.write('compiled-guide.json',JSON.stringify(checkpoint.compiled,null,2));await record('compile','validate');return;
    }
    if(job.stage==='validate'){
      let guide=checkpoint.compiled;if(!guide)throw new PipelineError('CHECKPOINT_MISMATCH');
      if(guide.qa.issues.some(issue=>issue.severity==='error'))throw new PipelineError('AUTOMATIC_GATES_FAILED');
      const html=renderGuideHtml(guide);assertNoSecrets(html,secrets);const hash=sha256(html);
      const browserQa=await this.adapters.browserQa({html,fingerprint:guide.qa.fingerprint,executablePath:this.config.browserExecutablePath,signal});
      assertNoSecrets(browserQa,secrets);await active();
      if(browserQa.artifactHash!==hash)throw new PipelineError('CHECKPOINT_MISMATCH');
      // Keep the tested HTML immutable. Acceptance is a separate certificate
      // bound to its exact bytes; do not rerender after an offline QA pass.
      guide=compileGuide(checkpoint.packs as ResearchPacks,{mode:job.mode==='demo'?'fixture':'live',sources:checkpoint.sources||[],assets:checkpoint.assets||[],generatedAt:checkpoint.startedAt!,qaEvidence:[browserQa.browser]});
      guide.qa=assessOfflineQa(guide,html,[browserQa.offline]).qa;checkpoint.compiled=guide;
      await workspace.write('browser-qa.json',JSON.stringify(browserQa,null,2));
      const content=toLegacyItinerary(guide);assertNoSecrets(content,secrets);
      await workspace.write('handbook.html',html);await workspace.write('artifact-receipt.json',JSON.stringify({sha256:hash,buildFingerprint:guide.qa.fingerprint,qa:guide.qa},null,2));
      await active();await this.db.transaction(async tx=>{
        const current=(await tx.query('SELECT status,claimed_by FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(current?.status!=='running'||current.claimed_by!==this.instance)throw new PipelineError('CANCELLED');
        await tx.query('SELECT id FROM trips WHERE id=$1 FOR UPDATE',[trip.id]);
        const next=(await tx.query('SELECT COALESCE(MAX(number),0)+1 AS number FROM versions WHERE trip_id=$1',[trip.id])).rows[0].number;
        const versionId=randomUUID();
        checkpoint.completed!.push({stage:'validate',status:'complete',updatedAt:new Date().toISOString()});
        await tx.query("INSERT INTO versions(id,trip_id,number,status,base_version_id,request,content,schema_version,guide,research_packs,artifact_html,artifact_hash,qa_status) VALUES($1,$2,$3,'candidate',$4,$5,$6,2,$7,$8,$9,$10,'pending')",[versionId,trip.id,next,job.base_version_id,job.request,JSON.stringify(content),JSON.stringify(guide),JSON.stringify(checkpoint.packs),html,hash]);
        await tx.query("UPDATE jobs SET status='succeeded',stage='candidate',version_id=$1,lease_until=NULL,checkpoint=$3,updated_at=now() WHERE id=$2",[versionId,job.id,JSON.stringify(checkpoint)]);
        await tx.query("INSERT INTO job_events(id,job_id,stage,event) VALUES($1,$2,'candidate','created')",[randomUUID(),job.id]);
      });return;
    }
    throw new PipelineError('CHECKPOINT_MISMATCH');
  }
}
