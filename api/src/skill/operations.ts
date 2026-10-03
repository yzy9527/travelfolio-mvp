import {randomUUID} from 'node:crypto';
import {Database} from '../db';
import {hashObject} from './hash';
import {SafeProviderError} from '../safe-http';
export class PipelineError extends Error {constructor(readonly code:string){super(code);}}
export class OperationLedger {
  constructor(private db:Database,private jobId:string,private instance:string,private attempt:number,private ensureActive:()=>Promise<void>){}
  async run<T>(operationKey:string,input:unknown,action:()=>Promise<T>):Promise<T>{
    if(!/^[a-zA-Z0-9:_.-]{1,220}$/.test(operationKey))throw new PipelineError('INVALID_OPERATION');
    const inputHash=hashObject(input);
    // Reuse the latest successful operation regardless of retry generation. Input
    // hashes bind every cache entry to the actual profile, sources and model.
    const cache=(await this.db.query("SELECT result,input_hash FROM job_operations WHERE job_id=$1 AND operation_key=$2 AND status='completed'",[this.jobId,operationKey])).rows[0];
    if(cache){if(cache.input_hash!==inputHash)throw new PipelineError('CHECKPOINT_MISMATCH');await this.ensureActive();return cache.result as T;}
    await this.ensureActive();
    const operationId=randomUUID();
    await this.db.transaction(async tx=>{
      const job=(await tx.query('SELECT status,claimed_by,resume_attempt FROM jobs WHERE id=$1 FOR UPDATE',[this.jobId])).rows[0];
      if(job?.status!=='running'||job.claimed_by!==this.instance||job.resume_attempt!==this.attempt)throw new PipelineError('CANCELLED');
      const prior=(await tx.query('SELECT id,status,input_hash FROM job_operations WHERE job_id=$1 AND operation_key=$2 FOR UPDATE',[this.jobId,operationKey])).rows[0];
      if(prior?.status==='not_sent'){
        await tx.query("UPDATE job_operations SET operation_key=operation_key||':retired-'||$1 WHERE id=$2 AND status='not_sent'",[operationId,prior.id]);
      }else if(prior)throw new PipelineError(prior.status==='completed'?'CHECKPOINT_RACE':'POSSIBLE_CHARGE');
      await tx.query("INSERT INTO job_operations(id,job_id,operation_key,input_hash,status) VALUES($1,$2,$3,$4,'started')",[operationId,this.jobId,operationKey,inputHash]);
    });
    try{
      const result=await action();
      // The adapter validates and strips secret reflection before a result reaches
      // this boundary. The ledger never writes requests, headers or credentials.
      const serialized=JSON.stringify(result);if(serialized.length>8_000_000)throw new PipelineError('RESULT_TOO_LARGE');
      const written=await this.db.query("UPDATE job_operations SET status='completed',result=$1,completed_at=now() WHERE id=$2 AND job_id=$3 AND status='started'",[serialized,operationId,this.jobId]);
      if(written.rowCount!==1)throw new PipelineError('POSSIBLE_CHARGE');
      await this.ensureActive();return result;
    }catch(error){
      const safe=error instanceof SafeProviderError?error:null;
      const status=safe?.requestSent===false?'not_sent':'ambiguous';
      await this.db.query("UPDATE job_operations SET status=$1,failure_code=$2,failure_phase=$3,http_status=$4,failure_detail=$5,completed_at=now() WHERE id=$6 AND job_id=$7 AND status='started'",
        [status,safe?.code??null,safe?.phase??null,safe?.httpStatus??null,safe?.validationDetail??null,operationId,this.jobId]);
      throw error;
    }
  }
}
