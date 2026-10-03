import test from 'node:test';
import assert from 'node:assert/strict';
import {destinationSearchScope,relevantSearchResult,researchSearchTopics,researchSearchDestination} from '../src/skill/search-scope';
import {acquireEvidence,type RunOperation,type ResearchEvidence} from '../src/skill/tools';
import {SafeProviderError,type SafeJsonRequest} from '../src/safe-http';
import {constraints} from './helpers';
import {hashObject} from '../src/skill/hash';
import {PACK_IDS} from '../src/skill/types';

test('specific Wenling hike retains city evidence without admitting neighbouring cities',()=>{
  const scope=destinationSearchScope('浙江温岭水桶岙');
  assert.ok(relevantSearchResult(scope,{title:'温岭市特产介绍',url:'https://example.com/local'}));
  assert.ok(relevantSearchResult(scope,{title:'水桶岙徒步',description:'浙江温岭山海线路',url:'https://example.com/hike'}));
  assert.equal(relevantSearchResult(scope,{title:'温州市非物质文化遗产',url:'https://example.com/wenzhou'}),false);
  assert.equal(relevantSearchResult(scope,{title:'杭州特色伴手礼',url:'https://example.com/hangzhou'}),false);
  assert.match(researchSearchDestination('places-core',scope),/水桶岙/);
  assert.equal(researchSearchDestination('places-shopping',scope),'浙江 台州 温岭');
});

test('domestic searches default to China and Chinese with known province/city context',()=>{
  for(const destination of ['北京','云南大理','Chengdu','四川省乐山市','示例目的地']){
    const scope=destinationSearchScope(destination);
    assert.equal(scope.country,'CN');assert.equal(scope.search_lang,'zh-hans');assert.match(scope.destination,/中国/);
    for(const pack of PACK_IDS){assert.equal(researchSearchTopics(pack,scope).length,3);assert.match(researchSearchTopics(pack,scope)[0],/[\u3400-\u9fff]/);}
  }
  assert.match(destinationSearchScope('大理').destination,/云南/);
  assert.ok(relevantSearchResult(destinationSearchScope('四川省乐山市'),{title:'乐山旅游指南',url:'https://tourism.example/page'}));
});

test('overseas destinations select their region, not China; unsupported and multi-country regions use ALL',()=>{
  for(const [destination,country,language,context] of [
    ['京都、日本','JP','en','Kyoto'],['巴黎，法国','FR','en','Paris'],
    ['台北','TW','zh-hant','台北'],['香港','HK','zh-hant','香港'],
    ['巴厘岛，印度尼西亚','ID','en','Bali'],
    ['曼谷，泰国','ALL','en','Bangkok'],['新加坡','ALL','en','Singapore'],
    ['东京、首尔','ALL','en','Tokyo'],['Unknown City','ALL','en','Unknown City'],
  ]){const scope=destinationSearchScope(destination);assert.equal(scope.country,country);assert.equal(scope.search_lang,language);assert.ok(scope.destination.includes(context));}
});

test('relevance uses destination aliases, not foreign-domain or Chinese-domain blanket bans',()=>{
  const scope=destinationSearchScope('云南大理');
  assert.ok(relevantSearchResult(scope,{title:'大理古城旅游',url:'https://travel.example/page'}));
  assert.ok(relevantSearchResult(scope,{title:'Dali visitor guide',url:'https://travel.example/page'}));
  assert.ok(relevantSearchResult(scope,{title:'Visitor guide',url:'https://travel.example/dali/guide'}));
  assert.equal(relevantSearchResult(scope,{title:'日本旅游指南',url:'https://www.japan.travel/en/us/'}),false);
  assert.equal(relevantSearchResult(scope,{title:'云南昆明旅游',url:'https://example.cn/guide'}),false);
  assert.equal(relevantSearchResult(scope,{title:'Dallas visitor guide',url:'https://example.com/dallas'}),false);
  assert.equal(relevantSearchResult(scope,{title:'Unknown',url:'https://example.com/page?q=大理'}),false);
  assert.ok(relevantSearchResult(destinationSearchScope('京都'),{title:'Kyoto guide',url:'https://www.japan.travel/en/kyoto/'}));
});

test('localized transport filters unrelated results before fetching, keeps credentials and private trip details out of queries',async()=>{
  const requests:SafeJsonRequest[]=[];const fetched:string[]=[];const records:unknown[]=[];
  const result=await acquireEvidence({packId:'framing',constraints:{...constraints,destination:'云南大理'},searchApiKey:'fixture-secret',operationKey:'job:0:evidence:framing',runOperation:async(key,input,action)=>{records.push({key,input});return action();}}, {
    transport:async request=>{requests.push(request);return {web:{results:[
      {title:'Japan travel',url:'https://www.japan.travel/en/us/'},
      {title:'云南大理旅游指南',url:'https://tourism.example/dali'},
      {title:'纽约公共交通',url:'https://nyc.example/transport'},
    ]}};},
    pageTransport:async request=>{fetched.push(request.url);return {contentType:'text/html',bytes:Buffer.from('<p>大理旅游资料</p>')};},
  });
  assert.deepEqual(fetched,['https://tourism.example/dali']);assert.equal(result.sources.length,1);
  assert.equal(result.sources[0].authority,'unclassified');
  for(const request of requests){const body=request.body as any;assert.equal(body.country,'CN');assert.equal(body.search_lang,'zh-hans');assert.equal(body.operators,false);assert.equal(body.spellcheck,false);assert.match(body.q,/云南大理/);assert.equal(body.q.includes(constraints.departure),false);assert.equal(body.q.includes(constraints.preferences),false);}
  assert.equal(JSON.stringify(records).includes('fixture-secret'),false);
});

test('no relevant results fail clearly without fetching or silently using unrelated pages',async()=>{
  let searches=0;
  await assert.rejects(acquireEvidence({packId:'framing',constraints:{...constraints,destination:'北京'},searchApiKey:'fixture-secret',operationKey:'job:0:evidence:framing',runOperation:async(_key,_input,action)=>action()}, {
    transport:async()=>{searches++;return {web:{results:[{title:'Japan travel',url:'https://www.japan.travel/en/us/'}]}};},
    pageTransport:async()=>{assert.fail('unrelated results must never be fetched');},
  }),(error:unknown)=>error instanceof SafeProviderError&&error.code==='RESEARCH_NO_RELEVANT_SOURCES');
  assert.equal(searches,3);
});

test('new search policy avoids old ledger hashes and reuses its own paid results on explicit resume',async()=>{
  const cache=new Map<string,{hash:string;result:any}>();
  for(let i=0;i<3;i++)cache.set(`evidence:framing:search:${i}`,{hash:'legacy-english-hash',result:[{title:'Japan travel',url:'https://www.japan.travel/en/us/'}]});
  const runOperation:RunOperation=async(key,input,action)=>{
    const stable=key.replace(/^job:\d+:/,'');const saved=cache.get(stable);
    if(saved){assert.equal(saved.hash,hashObject(input));return saved.result;}
    const result=await action();cache.set(stable,{hash:hashObject(input),result});return result;
  };
  let searches=0,pages=0;const deps={transport:async()=>{searches++;return {web:{results:[{title:'北京旅游',url:'https://tourism.example/beijing'}]}};},pageTransport:async()=>{pages++;throw new SafeProviderError('UNSAFE_PROVIDER_HOST');}};
  const input={packId:'framing' as const,constraints:{...constraints,destination:'北京'},searchApiKey:'fixture-secret',runOperation};
  const first=await acquireEvidence({...input,operationKey:'job:0:evidence:framing'},deps);
  const stale={...first.sources[0],id:'legacy-unrelated',url:'https://www.japan.travel/en/us/',title:'Japan travel',excerpt:'',packIds:['framing']} as ResearchEvidence;
  const second=await acquireEvidence({...input,operationKey:'job:1:evidence:framing',existingSources:[stale,...first.sources]},deps);
  assert.equal(searches,3);assert.equal(pages,2);assert.equal(cache.size,6);
  assert.equal(second.sources.length,1);assert.equal(second.sources[0].url,'https://tourism.example/beijing');
});
