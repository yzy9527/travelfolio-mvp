import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {PgDatabase} from './db';
import {credentialsSchema} from './schemas';
import {hashPassword} from './passwords';
async function main(){
  if(!process.stdin.isTTY)throw new Error('需要交互式终端；请使用 docker compose exec（不要加 -T）');
  if(!process.env.DATABASE_URL)throw new Error('请设置 DATABASE_URL');
  let muted=false;
  const out=new Writable({write(chunk,_enc,callback){if(!muted)process.stdout.write(chunk);callback();}});
  const rl=createInterface({input:process.stdin,output:out,terminal:true});
  const ask=(prompt:string,secret=false):Promise<string>=>new Promise(resolve=>{process.stdout.write(prompt);muted=secret;rl.question('',value=>{muted=false;if(secret)process.stdout.write('\n');resolve(value);});});
  let input:{email:string,password:string};
  try{
    const email=await ask('邮箱: ');const password=await ask('密码（至少 12 个字符，输入不回显）: ',true);const again=await ask('确认密码: ',true);
    if(password!==again)throw new Error('两次密码不一致');
    input=credentialsSchema.parse({email,password});
  }finally{rl.close();}
  const db=new PgDatabase(process.env.DATABASE_URL);
  try{
    const hash=await hashPassword(input.password);
    if(process.argv.includes('--reset')){
      const result=await db.transaction(async tx=>{const row=(await tx.query("UPDATE users SET password_hash=$1,status='active' WHERE email=$2 RETURNING id",[hash,input.email])).rows[0];if(!row)throw new Error('账户不存在');await tx.query('DELETE FROM sessions WHERE user_id=$1',[row.id]);return row;});
      if(result)console.log('密码已重置，旧登录会话已撤销；现有角色未改变');
    }else{await db.query("INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'admin')",[randomUUID(),input.email,hash]);console.log('管理员已创建；请登录并生成一次性邀请码');}
  }finally{await db.close();}
}
main().catch(()=>{console.error('操作失败：请检查终端、输入、数据库与邮箱是否已存在；重置现有账户请使用 --reset');process.exitCode=1;});
