import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrustedDnsResolver,parseDnsResolutionMode} from '../src/trusted-dns';
import {validatePublicHost,SafeProviderError} from '../src/safe-http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ClientRequest,IncomingMessage} from 'node:http';
import type {RequestOptions} from 'node:https';

type Reply = {Status:number;Question:{name:string;type:number}[];Answer?:{name:string;type:number;TTL:number;data:string}[]};
const reply=(name:string,type:1|28,answers:Reply['Answer']=[]):Reply=>({Status:0,Question:[{name,type}],Answer:answers});
const cname=(name:string,data:string)=>({name,type:5,TTL:20,data});
const address=(name:string,type:1|28,data:string)=>({name,type,TTL:20,data});

function dohTransport(backup:'reply'|'hang', calls:{ip:string;name:string;type:1|28;destroyed:boolean}[]){
  return (options:RequestOptions,listener:(response:IncomingMessage)=>void):ClientRequest=>{
    assert.equal(options.hostname,'cloudflare-dns.com');
    assert.equal(options.servername,'cloudflare-dns.com');
    assert.equal(options.rejectUnauthorized,true);
    assert.equal(options.agent,false);
    let ip='';
    (options.lookup as Function)('cloudflare-dns.com',{},(_error:unknown,address:string)=>{ip=address;});
    const target=new URL(`https://cloudflare-dns.com${options.path}`);
    const name=target.searchParams.get('name')!;
    const type=target.searchParams.get('type')==='A'?1:28;
    const call={ip,name,type:type as 1|28,destroyed:false};calls.push(call);
    const request=new EventEmitter() as ClientRequest;
    request.destroy=(()=>{call.destroyed=true;return request;}) as ClientRequest['destroy'];
    request.end=(()=>{
      if(ip==='1.1.1.1'||backup==='hang')return request;
      queueMicrotask(()=>{
        if(call.destroyed)return;
        const response=new PassThrough() as unknown as IncomingMessage;
        response.statusCode=200;response.headers={'content-type':'application/dns-json'};
        listener(response);
        const answers=name==='gs.ctrip.com'?[cname(name,'edge.example.net.')]:
          type===1?[address(name,1,'23.205.214.165')]:[address(name,28,'2606:4700:4700::1111')];
        response.end(JSON.stringify(reply(name,type,answers)));
      });
      return request;
    }) as ClientRequest['end'];
    return request;
  };
}

test('trusted DoH validates both families and a CDN CNAME chain, then caches bounded answers',async()=>{
  let queries=0;
  const query=async(name:string,type:1|28)=>{
    queries++;
    if(name==='gs.ctrip.com')return reply(name,type,[cname(name,'edge.example.net.')]);
    return reply(name,type,type===1?[address(name,1,'23.205.214.165')]:[address(name,28,'2606:4700:4700::1111')]);
  };
  const resolver=createTrustedDnsResolver('cloudflare',query);
  const [first,second]=await Promise.all([validatePublicHost(new URL('https://gs.ctrip.com'),resolver),validatePublicHost(new URL('https://gs.ctrip.com'),resolver)]);
  assert.deepEqual(first,[{address:'23.205.214.165',family:4},{address:'2606:4700:4700::1111',family:6}]);
  assert.deepEqual(second,first);
  assert.equal(queries,4);
  await validatePublicHost(new URL('https://gs.ctrip.com'),resolver);
  assert.equal(queries,4);
});

test('trusted DoH rejects Fake IP, private addresses, malformed replies and resolver failure before connect',async()=>{
  for(const ip of ['198.18.0.42','127.0.0.1','10.0.0.1']){
    const resolver=createTrustedDnsResolver('cloudflare',async(name,type)=>reply(name,type,type===1?[address(name,1,ip)]:[]));
    await assert.rejects(validatePublicHost(new URL('https://gs.ctrip.com'),resolver),(error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_DNS_FAILED'&&error.requestSent===false);
  }
  for(const query of [
    async(name:string,type:1|28)=>reply('wrong.example',type,[address(name,1,'8.8.8.8')]),
    async(name:string,type:1|28)=>reply(name,type,[cname(name,name)]),
    async(_name:string,_type:1|28):Promise<Reply>=>{throw Error('upstream secret');},
  ]){
    const resolver=createTrustedDnsResolver('cloudflare',query);
    await assert.rejects(validatePublicHost(new URL('https://gs.ctrip.com'),resolver),(error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_DNS_FAILED'&&!error.message.includes('secret'));
  }
});

test('DNS mode is an explicit built-in choice',()=>{
  assert.equal(parseDnsResolutionMode(undefined),'system');
  assert.equal(parseDnsResolutionMode('cloudflare'),'cloudflare');
  assert.equal(parseDnsResolutionMode('google'),'google');
  for(const mode of ['https://evil.example/dns-query','1.2.3.4','auto'])assert.throws(()=>parseDnsResolutionMode(mode));
});

test('real DoH transport failover fits inside validatePublicHost across A, AAAA and CNAME hops',{timeout:6_000},async(t)=>{
  // The mocked request has no socket to keep Node alive while unref'ed DNS timers run.
  const pendingSocket=setInterval(()=>{},6_000);t.after(()=>clearInterval(pendingSocket));
  const calls:{ip:string;name:string;type:1|28;destroyed:boolean}[]=[];
  const resolver=createTrustedDnsResolver('cloudflare',undefined,dohTransport('reply',calls));
  const started=Date.now();
  const answers=await validatePublicHost(new URL('https://gs.ctrip.com'),resolver);
  assert.deepEqual(answers,[{address:'23.205.214.165',family:4},{address:'2606:4700:4700::1111',family:6}]);
  assert.ok(Date.now()-started<5_000,'backup must finish before the public-host DNS timeout');
  assert.equal(calls.filter(call=>call.ip==='1.1.1.1'&&call.destroyed).length,4);
  assert.equal(calls.filter(call=>call.ip==='1.0.0.1').length,4);
  assert.deepEqual(new Set(calls.map(call=>call.name)),new Set(['gs.ctrip.com','edge.example.net']));
});

test('all pinned DoH addresses hanging ends within the outer DNS budget without system fallback',{timeout:6_000},async(t)=>{
  const pendingSocket=setInterval(()=>{},6_000);t.after(()=>clearInterval(pendingSocket));
  const calls:{ip:string;name:string;type:1|28;destroyed:boolean}[]=[];
  const resolver=createTrustedDnsResolver('cloudflare',undefined,dohTransport('hang',calls));
  const started=Date.now();
  await assert.rejects(validatePublicHost(new URL('https://gs.ctrip.com'),resolver),
    (error:unknown)=>error instanceof SafeProviderError&&error.code==='PROVIDER_DNS_FAILED'&&error.requestSent===false);
  assert.ok(Date.now()-started<5_000,'all DoH attempts must finish before the public-host guard');
  assert.equal(calls.length,4);
  assert.ok(calls.every(call=>call.destroyed),'every timed-out HTTPS request must be destroyed');
  assert.deepEqual(new Set(calls.map(call=>call.ip)),new Set(['1.1.1.1','1.0.0.1']));
});
