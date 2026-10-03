import {Pool, PoolClient} from 'pg';
export interface Result<T=any> {rows:T[];rowCount?:number|null;}
export interface Queryable {query<T=any>(sql:string,params?:any[]):Promise<Result<T>>;}
export interface Database extends Queryable {transaction<T>(fn:(tx:Queryable)=>Promise<T>):Promise<T>;close():Promise<void>;}
export class PgDatabase implements Database {
  private pool:Pool;
  constructor(connectionString:string) {this.pool=new Pool({connectionString,max:10,connectionTimeoutMillis:10000,idleTimeoutMillis:30000}); this.pool.on('error',()=>{console.error('Database connection failed');});}
  async query<T=any>(sql:string,params:any[]=[]):Promise<Result<T>> {const result=await this.pool.query(sql,params);return {rows:result.rows as T[],rowCount:result.rowCount};}
  async transaction<T>(fn:(tx:Queryable)=>Promise<T>):Promise<T> {
    const client:PoolClient=await this.pool.connect();
    try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async close(){await this.pool.end();}
}
