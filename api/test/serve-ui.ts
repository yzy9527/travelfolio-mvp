// Test-only local harness. Not part of production compilation or Docker image.
import {createApp} from '../src/app';
import {GenerationWorker} from '../src/worker';
import {testDatabase,config,seedUser} from './helpers';
async function run(){
  const db=await testDatabase();const origin='http://127.0.0.1:5173';
  await seedUser(db,'ui-admin@example.test','admin');await seedUser(db,'ui-friend@example.test');
  const local={...config,appOrigin:origin};const app=await createApp(db,local);await app.listen(3000,'127.0.0.1');const worker=new GenerationWorker(db,local);worker.start();
  console.log('TEST-ONLY API ready at 127.0.0.1:3000 for origin '+origin);
  const stop=async()=>{await worker.stop();await app.close();await db.close();process.exit(0);};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}
run().catch(error=>{console.error(error);process.exitCode=1;});
