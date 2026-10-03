import {createHash} from 'node:crypto';
export function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonicalJson(v)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
export const sha256=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export const hashObject=(value:unknown)=>sha256(canonicalJson(value));
export const boundOutlineHash=(outline:unknown,job:{request:string;base_version_id:string|null},constraints:unknown,version:number)=>hashObject({outline,request:job.request,baseVersionId:job.base_version_id,constraints,version});
