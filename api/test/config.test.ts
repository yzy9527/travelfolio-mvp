import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config';
const base={DATABASE_URL:'postgresql://test@localhost/test',APP_ORIGIN:'https://travel.example.com',KEY_ENCRYPTION_SECRET:Buffer.alloc(32,8).toString('base64')};
test('deployment config has no default credentials and requires exact HTTPS origin',()=>{
  assert.equal(loadConfig(base).cookieSecure,true);assert.equal(loadConfig(base).demoEnabled,false);
  assert.equal(loadConfig({...base,WORKER_DNS_MODE:'cloudflare'}).dnsMode,'cloudflare');
  assert.throws(()=>loadConfig({...base,WORKER_DNS_MODE:'https://untrusted.example/dns-query'}));
  for(const values of [{...base,DATABASE_URL:undefined},{...base,APP_ORIGIN:undefined},{...base,KEY_ENCRYPTION_SECRET:undefined},{...base,KEY_ENCRYPTION_SECRET:'weak'},{...base,APP_ORIGIN:'https://travel.example.com/'},{...base,APP_ORIGIN:'http://travel.example.com'},{...base,SESSION_COOKIE_SECURE:'false'},{...base,APP_ORIGIN:'https://user:pw@travel.example.com'},{...base,PORT:'NaN'}])assert.throws(()=>loadConfig(values));
});
test('insecure cookies are possible only for an explicitly configured localhost HTTP development origin',()=>{
  const local={...base,APP_ORIGIN:'http://localhost:8080',SESSION_COOKIE_SECURE:'false'};
  assert.equal(loadConfig(local).cookieSecure,false);
  assert.throws(()=>loadConfig({...local,SESSION_COOKIE_SECURE:'true'}));
  assert.throws(()=>loadConfig({...local,APP_ORIGIN:'http://192.168.1.10:8080'}));
});
