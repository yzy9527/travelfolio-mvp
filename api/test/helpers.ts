import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {Database,Queryable,Result} from '../src/db';
import {migrate} from '../src/migrate';
import {Config} from '../src/config';
import {hashPassword} from '../src/passwords';
export async function testDatabase():Promise<Database>{
  const engine=new PGlite();
  const wrap=(q:any):Queryable=>({async query<T=any>(sql:string,params:any[]=[]):Promise<Result<T>>{
    // PGlite requires exec for schema files with multiple statements.
    if(!params.length&&sql.includes(';')){const results=await q.exec(sql);const last=results[results.length-1];return {rows:(last?.rows||[]) as T[],rowCount:last?.affectedRows};}
    const result=await q.query(sql,params);return {rows:result.rows as T[],rowCount:result.affectedRows};
  }});
  const db:Database={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx))),close:()=>engine.close()};
  await migrate(db);return db;
}
export const config:Config={databaseUrl:'test-only',appOrigin:'http://localhost:5173',cookieSecure:false,encryptionSecret:Buffer.alloc(32,7).toString('base64'),demoEnabled:true,port:3000,dnsMode:'system'};
export const constraints={destination:'示例目的地',departure:'上海',startDate:'2026-10-01',endDate:'2026-10-03',people:2,budget:4000,currency:'CNY',preferences:'城市漫步',exclusions:'不爬山'};
export async function seedUser(db:Database,email:string,role:'admin'|'user'='user'){const id=randomUUID();await db.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)",[id,email,await hashPassword('Test-only-password-2026'),role]);return {id,email,role};}
