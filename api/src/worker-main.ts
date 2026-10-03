import {loadConfig} from './config';
import {PgDatabase} from './db';
import {GenerationWorker} from './worker';
import {configureDefaultHostResolver} from './safe-http';
import {createTrustedDnsResolver} from './trusted-dns';
async function main(){
  const config=loadConfig();if(config.dnsMode!=='system')configureDefaultHostResolver(createTrustedDnsResolver(config.dnsMode));
  const db=new PgDatabase(config.databaseUrl);await db.query('SELECT 1');
  const worker=new GenerationWorker(db,config);worker.start();console.log('Travelfolio worker started');
  let closing=false;const stop=async()=>{if(closing)return;closing=true;await worker.stop();await db.close();};
  process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
}
main().catch(()=>{console.error('Worker startup failed: check configuration and migrations');process.exitCode=1;});
