import {Database} from './db';
import {reject} from './errors';
export async function rateLimit(db:Database,key:string,max:number,seconds:number){
  const now=new Date();const reset=new Date(now.getTime()+seconds*1000);
  const {rows}=await db.query(`INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,$2)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at <= $3 THEN 1 ELSE rate_limits.count+1 END,
    reset_at=CASE WHEN rate_limits.reset_at <= $3 THEN $2 ELSE rate_limits.reset_at END RETURNING count`,[key,reset,now]);
  if(rows[0].count>max)reject(429,'RATE_LIMIT','操作过于频繁，请稍后再试');
}
