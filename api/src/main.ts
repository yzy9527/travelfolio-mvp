import {createApp} from './app';
import {loadConfig} from './config';
import {PgDatabase} from './db';
async function main(){
  const config=loadConfig();const db=new PgDatabase(config.databaseUrl);await db.query('SELECT 1');
  const app=await createApp(db,config);
  await app.listen(config.port,'0.0.0.0');console.log(`Travelfolio API listening on port ${config.port}`);
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await app.close();await db.close();};
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
}
main().catch(()=>{console.error('Startup failed: check required environment, database and migrations');process.exitCode=1;});

