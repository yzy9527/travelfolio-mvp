import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,config,constraints,seedUser} from './helpers';
import {AppService} from '../src/service';
import {GenerationWorker} from '../src/worker';
import {encryptApiKey} from '../src/crypto';
import {SafeProviderError} from '../src/safe-http';
import {acquireEvidence} from '../src/skill/tools';
import {makeFixturePacks} from '../src/skill/fixtures';
import {tripDates} from '../src/schemas';

test('legacy failed evidence resumes page retrieval using cached searches, with specific errors and frozen successful evidence',async()=>{
  const db=await testDatabase();
  const cfg={...config,searchApiKey:'fixture-search-secret'};
  const service=new AppService(db,cfg);
  let searches=0,pages=0,models=0,blocked=true,modelBlocked=true;
  const worker=new GenerationWorker(db,cfg,{
    outline:async()=>({title:'Fixture',summary:'Fixture outline',days:tripDates(constraints.startDate,constraints.endDate).map(date=>({date,title:'Fixture day',focus:'Fixture',pace:'standard' as const,areas:['Fixture']})),assumptions:[],openQuestions:[],changedPacks:['framing']}),
    evidence:input=>acquireEvidence(input,{
      transport:async()=>{searches++;return {web:{results:[{title:constraints.destination+' source',url:'https://source.example/page'}]}};},
      pageTransport:async()=>{pages++;if(blocked)throw new SafeProviderError('UNSAFE_PROVIDER_HOST');return {bytes:Buffer.from('<p>Retrieved fixture facts</p>'),contentType:'text/html'};},
    }),
    research:async input=>{models++;if(modelBlocked)throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');return makeFixturePacks(constraints)[input.packId];},
  });
  try{
    const owner=await seedUser(db,'recovery@example.test');
    await db.query("INSERT INTO settings(user_id,provider,base_url,model,key_cipher) VALUES($1,'openai','https://api.openai.com/v1','fixture',$2)",[owner.id,encryptApiKey('fixture-model-secret',owner.id,cfg.encryptionSecret)]);
    const trip=(await service.createTrip(owner.id,constraints)).trip;
    const job=(await service.createJob(owner.id,trip.id,{mode:'live',request:'',idempotencyKey:randomUUID()})).job;
    const current=async()=>(await db.query('SELECT * FROM jobs WHERE id=$1',[job.id])).rows[0];
    await worker.tick();
    const outlined=(await service.getJob(owner.id,job.id)).job;
    await service.approveOutline(owner.id,job.id,{outlineHash:outlined.outlineHash,outlineVersion:outlined.outlineVersion});
    await worker.tick();
    let failed=await current();
    assert.equal(failed.error_code,'UNSAFE_PROVIDER_HOST');assert.match(failed.error_message,/Fake IP/);
    assert.equal(failed.possible_charge,false);assert.equal(searches,3);assert.equal(pages,1);assert.equal(models,0);
    assert.equal(failed.checkpoint.evidenceByPack.framing,false);
    // Reproduce the old persisted checkpoint, including its generic error code.
    await db.query("UPDATE jobs SET checkpoint=jsonb_set(checkpoint,'{evidenceByPack,framing}','true'::jsonb),error_code='GENERATION_FAILED' WHERE id=$1",[job.id]);
    await service.resumeJob(owner.id,job.id,{});await worker.tick();
    assert.equal((await current()).error_code,'UNSAFE_PROVIDER_HOST');assert.equal(searches,3);assert.equal(pages,2);assert.equal(models,0);
    blocked=false;
    await service.resumeJob(owner.id,job.id,{});await worker.tick();
    failed=await current();
    assert.equal(failed.error_code,'PROVIDER_INVALID_RESPONSE');assert.equal(searches,3);assert.equal(pages,3);assert.equal(models,1);
    assert.equal(failed.checkpoint.sources[0].retrievalStatus,'page_retrieved');
    assert.equal(failed.checkpoint.sources[0].failureCode,undefined);
    const frozen=JSON.stringify(failed.checkpoint.sources);
    modelBlocked=false;
    await service.resumeJob(owner.id,job.id,{});await worker.tick();
    const recovered=await current();
    assert.equal(recovered.status,'queued');assert.ok(recovered.checkpoint.packs.framing);
    assert.equal(JSON.stringify(recovered.checkpoint.sources),frozen);
    assert.equal(searches,3);assert.equal(pages,3);assert.equal(models,2);
    assert.equal((await db.query('SELECT count(*)::int n FROM job_operations WHERE job_id=$1',[job.id])).rows[0].n,3);
  }finally{await worker.stop();await db.close();}
});
