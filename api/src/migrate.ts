import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {Database,PgDatabase} from './db';
export async function migrate(db:Database) {
  await db.transaction(async tx=>{
    // A dedicated transaction advisory lock serializes migrators across processes.
    await tx.query('SELECT pg_advisory_xact_lock(74183001)');
    await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done=new Set((await tx.query('SELECT name FROM schema_migrations')).rows.map(r=>r.name));
    const dir=path.resolve(__dirname,'../migrations');
    for(const file of (await readdir(dir)).filter(x=>/^\d+.*\.sql$/.test(x)).sort()) {
      if(done.has(file))continue;
      await tx.query(await readFile(path.join(dir,file),'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);
    }
  });
}
if(require.main===module){
  const url=process.env.DATABASE_URL;if(!url){console.error('DATABASE_URL is required');process.exit(1);}
  const db=new PgDatabase(url);migrate(db).then(()=>console.log('Database migrations complete')).catch(()=>{console.error('Migration failed; check database availability and migration compatibility');process.exitCode=1;}).finally(()=>db.close());
}
