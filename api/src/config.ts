import {parseDnsResolutionMode,type DnsResolutionMode} from './trusted-dns';
export interface Config { databaseUrl:string; appOrigin:string; cookieSecure:boolean; encryptionSecret:string; demoEnabled:boolean; searchApiKey?:string; port:number; workRoot?:string; searchConfigured?:boolean; officialHosts?:string[]; browserExecutablePath?:string; dnsMode:DnsResolutionMode; }
export function loadConfig(env:NodeJS.ProcessEnv=process.env):Config {
  const origin = env.APP_ORIGIN;
  if (!origin) throw new Error('APP_ORIGIN is required');
  const url = new URL(origin);
  if(url.origin !== origin || url.username || url.password) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin, without a trailing slash');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol !== 'https:' && !(url.protocol==='http:'&&local)) throw new Error('Public deployments require HTTPS');
  const cookieSecure=env.SESSION_COOKIE_SECURE !== 'false';
  if(!cookieSecure && !(local&&url.protocol==='http:')) throw new Error('Insecure cookies only allowed on HTTP localhost');
  if(url.protocol==='http:'&&cookieSecure) throw new Error('Local HTTP needs SESSION_COOKIE_SECURE=false');
  const secret=env.KEY_ENCRYPTION_SECRET||'';
  if(!/^[A-Za-z0-9+/]{43}=$/.test(secret)||Buffer.from(secret,'base64').length!==32||Buffer.from(secret,'base64').toString('base64')!==secret) throw new Error('KEY_ENCRYPTION_SECRET must be 32 random bytes in base64');
  if(!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid PORT');
  const browserExecutablePath=env.CHROMIUM_PATH||undefined;if(browserExecutablePath&&(!browserExecutablePath.startsWith('/')||/[\x00-\x1f\x7f]/.test(browserExecutablePath)))throw new Error('CHROMIUM_PATH must be an absolute trusted executable path');
  return {browserExecutablePath,databaseUrl:env.DATABASE_URL,appOrigin:origin,cookieSecure,encryptionSecret:secret,demoEnabled:env.DEMO_ENABLED==='true',searchApiKey:env.BRAVE_SEARCH_API_KEY||undefined,port,workRoot:env.WORK_ROOT||'/tmp/travelfolio-jobs',searchConfigured:env.BRAVE_SEARCH_CONFIGURED==='true',officialHosts:(env.RESEARCH_OFFICIAL_HOSTS||'').split(',').map(h=>h.trim().toLowerCase()).filter(h=>/^[a-z0-9.-]+$/.test(h)),dnsMode:parseDnsResolutionMode(env.WORKER_DNS_MODE)};
}
