import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
const params={N:32768,r:8,p:1,maxmem:64*1024*1024};
function derive(password:string,salt:string):Promise<Buffer>{return new Promise((resolve,reject)=>scryptCallback(password,salt,64,params,(error,key)=>error?reject(error):resolve(key)));}
export async function hashPassword(password:string){const salt=randomBytes(16).toString('hex');return `scrypt$${salt}$${(await derive(password,salt)).toString('hex')}`;}
export async function verifyPassword(password:string,hash:string){const [kind,salt,digest]=hash.split('$');if(kind!=='scrypt'||!salt||!digest)return false;const key=await derive(password,salt);const expected=Buffer.from(digest,'hex');return key.length===expected.length&&timingSafeEqual(key,expected);}
export const token=()=>randomBytes(32).toString('base64url');
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function sameSecret(a:string,b:string){const x=Buffer.from(a);const y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
