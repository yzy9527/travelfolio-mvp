import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { isGlobalIp, validateProviderBaseUrl, validatePublicHost, safeJsonRequest, SafeProviderError,
  type RequestFactory, type HostResolver } from '../src/safe-http';

const publicResolver: HostResolver = async () => [{ address: '8.8.8.8', family: 4 }];
const baseRequest = { baseUrl: 'https://provider.example.com/v1', path: 'chat/completions', body: { hello: 'world' }, timeoutMs: 1000 };
const errorCode = (code: string) => (error: unknown) => error instanceof SafeProviderError && error.code === code;
interface Fixture { status?: number; headers?: Record<string, string>; body?: string; neverEnd?: boolean; delayMs?: number }
function fakeRequest(fixture: Fixture = {}, inspect?: (options: RequestOptions) => void): RequestFactory {
  return (options, callback) => {
    inspect?.(options);
    const request = new EventEmitter() as ClientRequest;
    request.destroy = (() => { request.emit('fixture-destroyed'); return request; }) as ClientRequest['destroy'];
    request.end = (() => {
      queueMicrotask(() => {
        const response = new PassThrough() as unknown as IncomingMessage;
        response.statusCode = fixture.status ?? 200;
        response.headers = fixture.headers ?? {};
        callback(response);
        if (!response.destroyed && !fixture.neverEnd) {
          if (fixture.delayMs) setTimeout(() => response.end(fixture.body ?? '{"ok":true}'), fixture.delayMs);
          else response.end(fixture.body ?? '{"ok":true}');
        }
      });
      return request;
    }) as ClientRequest['end'];
    return request;
  };
}

test('rejects insecure URLs, credentials, query, fragments and alternate ports', () => {
  for (const url of ['http://example.com', 'ftp://example.com', 'https://name:secret@example.com',
    'https://example.com:8443', 'https://example.com/path?key=secret', 'https://example.com/path#fragment',
    'https://example.com/?', 'https://example.com/#', 'https://example.com\\@other.example', ' https://example.com', 'https://example.com\n']) {
    assert.throws(() => validateProviderBaseUrl(url), errorCode('INVALID_PROVIDER_URL'), url);
  }
  assert.equal(validateProviderBaseUrl('https://provider.example.com:443/v1').hostname, 'provider.example.com');
});

test('rejects non-global IPv4 including alternate and mapped encodings', () => {
  for (const ip of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.0.1', '192.0.0.1', '192.0.2.2', '192.88.99.1', '198.18.0.1', '198.51.100.2', '203.0.113.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isGlobalIp(ip), false, ip);
    assert.throws(() => validateProviderBaseUrl(`https://${ip}`), errorCode('UNSAFE_PROVIDER_HOST'), ip);
  }
  for (const host of ['2130706433', '0177.0.0.1', '0x7f000001', '127.1', 'localhost', 'localhost.', 'service.local', 'metadata.internal', '[::ffff:127.0.0.1]']) {
    assert.throws(() => validateProviderBaseUrl(`https://${host}`), errorCode('UNSAFE_PROVIDER_HOST'), host);
  }
  assert.equal(isGlobalIp('8.8.8.8'), true);
});

test('IPv6 permits public unicast and rejects reserved, local, documentation and transition ranges', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '3fff::1',
    '2001::1', '2001:2::1', '2002:7f00:1::1', '64:ff9b::7f00:1', '::ffff:8.8.8.8']) {
    assert.equal(isGlobalIp(ip), false, ip);
    assert.throws(() => validateProviderBaseUrl(`https://[${ip}]`), errorCode('UNSAFE_PROVIDER_HOST'), ip);
  }
  assert.equal(isGlobalIp('2606:4700:4700::1111'), true);
});

test('rejects every mixed, empty or family-mismatched DNS result before sending', async () => {
  for (const answers of [[], [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '169.254.169.254', family: 4 }], [{ address: '8.8.8.8', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }]]) {
    let sent = 0;
    await assert.rejects(safeJsonRequest(baseRequest, { resolveHost: async () => answers,
      request: fakeRequest({}, () => sent++) }), errorCode('UNSAFE_PROVIDER_HOST'));
    assert.equal(sent, 0);
  }
});

test('DNS failure is redacted and direct public literals need no resolver', async () => {
  await assert.rejects(validatePublicHost(new URL('https://provider.example.com'), async () => { throw new Error('secret raw DNS error'); }),
    (error: unknown) => error instanceof SafeProviderError && error.code === 'PROVIDER_DNS_FAILED' && !error.message.includes('secret'));
  assert.deepEqual(await validatePublicHost(new URL('https://8.8.8.8'), async () => { throw new Error('not called'); }), [{ address: '8.8.8.8', family: 4 }]);
});

test('pins checked IP against rebinding while preserving TLS hostname and avoiding socket reuse', async () => {
  let lookups = 0;
  const resolveHost: HostResolver = async () => (++lookups === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  let checked = false;
  const result = await safeJsonRequest(baseRequest, { resolveHost, request: fakeRequest({}, (options) => {
    assert.equal(options.hostname, 'provider.example.com');
    assert.equal(options.servername, 'provider.example.com');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.port, 443);
    assert.equal(options.path, '/v1/chat/completions');
    const lookup = options.lookup as Function;
    lookup('provider.example.com', {}, (error: unknown, ip: string, family: number) => {
      assert.equal(error, null); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4);
    });
    lookup('provider.example.com', { all: true }, (error: unknown, addresses: unknown) => {
      assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
    });
    checked = true;
  }) });
  assert.deepEqual(result, { ok: true });
  assert.equal(lookups, 1);
  assert.equal(checked, true);
});

test('all redirects fail without following or disclosing Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let attempts = 0;
    await assert.rejects(safeJsonRequest(baseRequest, { resolveHost: publicResolver,
      request: fakeRequest({ status, headers: { location: 'http://127.0.0.1/secret' } }, () => attempts++) }), errorCode('PROVIDER_REDIRECT'));
    assert.equal(attempts, 1);
  }
});

test('response size is bounded by declared bytes and actual streamed bytes', async () => {
  for (const fixture of [{ headers: { 'content-length': '100' } }, { body: 'x'.repeat(100) }]) {
    await assert.rejects(safeJsonRequest({ ...baseRequest, maxBytes: 20 }, { resolveHost: publicResolver, request: fakeRequest(fixture) }),
      errorCode('PROVIDER_RESPONSE_TOO_LARGE'));
  }
});

test('absolute timeout covers DNS and stalled bodies and does not start a late request', async () => {
  let sent = 0;
  let resolveDns!: (value: { address: string; family: number }[]) => void;
  const dns = new Promise<{ address: string; family: number }[]>((resolve) => { resolveDns = resolve; });
  await assert.rejects(safeJsonRequest({ ...baseRequest, timeoutMs: 10 }, { resolveHost: () => dns,
    request: fakeRequest({}, () => sent++) }), errorCode('PROVIDER_TIMEOUT'));
  resolveDns([{ address: '8.8.8.8', family: 4 }]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sent, 0);
  await assert.rejects(safeJsonRequest({ ...baseRequest, timeoutMs: 10 }, { resolveHost: publicResolver,
    request: fakeRequest({ neverEnd: true }) }), errorCode('PROVIDER_TIMEOUT'));
});

test('rejects non-JSON, compression and external errors without exposing secrets', async () => {
  await assert.rejects(safeJsonRequest(baseRequest, { resolveHost: publicResolver, request: fakeRequest({ body: 'upstream-secret-not-json' }) }),
    (error: unknown) => error instanceof SafeProviderError && error.code === 'PROVIDER_COMPLETION_JSON' && error.phase === 'response' && error.requestSent === true && !JSON.stringify(error).includes('upstream-secret'));
  await assert.rejects(safeJsonRequest(baseRequest, { resolveHost: publicResolver, request: fakeRequest({ headers: { 'content-encoding': 'gzip' } }) }), errorCode('PROVIDER_INVALID_RESPONSE'));
  await assert.rejects(safeJsonRequest(baseRequest, { resolveHost: publicResolver, request: () => { throw new Error('Bearer upstream-secret'); } }),
    (error: unknown) => error instanceof SafeProviderError && error.code === 'PROVIDER_UNAVAILABLE' && !JSON.stringify(error).includes('upstream-secret') && !('cause' in error));
});

test('provider status errors are generic and are never automatically retried', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMITED'], [500, 'PROVIDER_HTTP_ERROR']] as const) {
    let attempts = 0;
    await assert.rejects(safeJsonRequest(baseRequest, { resolveHost: publicResolver, request: fakeRequest({ status, body: 'API KEY SECRET' }, () => attempts++) }), errorCode(code));
    assert.equal(attempts, 1);
  }
});

test('safe transport reports only verified phase, status and whether a request may have been sent', async () => {
  await assert.rejects(safeJsonRequest(baseRequest,{resolveHost:async()=>[{address:'198.18.0.42',family:4}],request:()=>{assert.fail('no request')}}),
    (error:unknown)=>error instanceof SafeProviderError&&error.phase==='dns'&&error.requestSent===false&&error.httpStatus===undefined);
  await assert.rejects(safeJsonRequest(baseRequest,{resolveHost:publicResolver,request:fakeRequest({status:429,body:'secret'})}),
    (error:unknown)=>error instanceof SafeProviderError&&error.phase==='response'&&error.requestSent===true&&error.httpStatus===429&&
      !JSON.stringify(error).includes('secret'));
});

test('rejects relative path escapes and header injection without network activity', async () => {
  for (const path of ['//evil.example', '../secret', 'chat/completions?api_key=secret', 'https://evil.example', 'chat/../secret']) {
    await assert.rejects(safeJsonRequest({ ...baseRequest, path }), errorCode('INVALID_PROVIDER_URL'));
  }
  for (const headers of [{ host: '127.0.0.1' }, { authorization: 'Bearer secret\r\nHost: internal' }]) {
    await assert.rejects(safeJsonRequest({ ...baseRequest, headers }), errorCode('PROVIDER_SETTINGS_REQUIRED'));
  }
});


// Research GET tests also inject a transport; they never contact external hosts.
test('public page GET permits query strings, pins DNS, and enforces exact response content types', async () => {
  const { safeResourceRequest } = await import('../src/safe-http');
  const result = await safeResourceRequest({ url: 'https://public.example/venue?lang=zh', kind: 'page' }, {
    resolveHost: publicResolver, request: fakeRequest({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html>source</html>' }, (options) => {
      assert.equal(options.path, '/venue?lang=zh'); assert.equal(options.method, 'GET');
      assert.equal((options.headers as Record<string,string>).authorization, undefined);
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    }),
  });
  assert.equal(result.contentType, 'text/html'); assert.equal(result.bytes.toString(), '<html>source</html>');
  for (const type of ['application/json', 'image/svg+xml', 'application/octet-stream', '']) {
    await assert.rejects(safeResourceRequest({ url: 'https://public.example/image.png', kind: 'image' }, { resolveHost: publicResolver,
      request: fakeRequest({ headers: { 'content-type': type }, body: 'anything' }) }), errorCode('PROVIDER_INVALID_RESPONSE'));
  }
});

test('research GET rejects unsafe origins, private DNS, redirects, compression and unbounded bodies', async () => {
  const { safeResourceRequest } = await import('../src/safe-http');
  for (const url of ['http://public.example', 'https://name:secret@public.example', 'https://public.example:8443', 'https://public.example/#secret', 'https://127.0.0.1/']) {
    await assert.rejects(safeResourceRequest({ url, kind: 'page' }, { request: () => { assert.fail('must not send'); } }));
  }
  await assert.rejects(safeResourceRequest({ url: 'https://public.example', kind: 'page' }, { resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
    request: () => { assert.fail('must not send private DNS'); } }), errorCode('UNSAFE_PROVIDER_HOST'));
  for (const [fixture, code] of [
    [{ status: 302, headers: { location: 'https://127.0.0.1/secret' } }, 'PROVIDER_REDIRECT'],
    [{ headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' } }, 'PROVIDER_INVALID_RESPONSE'],
    [{ headers: { 'content-type': 'text/html' }, body: 'x'.repeat(200) }, 'PROVIDER_RESPONSE_TOO_LARGE'],
  ] as const) {
    await assert.rejects(safeResourceRequest({ url: 'https://public.example', kind: 'page', maxBytes: 100 }, { resolveHost: publicResolver, request: fakeRequest(fixture) }), errorCode(code));
  }
});

test('AbortSignal cancels before DNS and during a body without another request', async () => {
  const controller = new AbortController(); controller.abort(); let attempts = 0;
  await assert.rejects(safeJsonRequest({ ...baseRequest, signal: controller.signal }, { resolveHost: publicResolver, request: fakeRequest({}, () => attempts++) }), errorCode('PROVIDER_ABORTED'));
  assert.equal(attempts, 0);
  const active = new AbortController();
  const promise = safeJsonRequest({ ...baseRequest, signal: active.signal }, { resolveHost: publicResolver, request: fakeRequest({ neverEnd: true }, () => attempts++) });
  setTimeout(() => active.abort(), 5);
  await assert.rejects(promise, errorCode('PROVIDER_ABORTED')); assert.equal(attempts, 1);
});

test('only bounded safe idempotency tokens are sent', async () => {
  await safeJsonRequest({ ...baseRequest, headers: { 'idempotency-key': 'fixture_123' } }, { resolveHost: publicResolver, request: fakeRequest({}, (options) => {
    assert.equal((options.headers as Record<string,string>)['idempotency-key'], 'fixture_123');
  }) });
  for (const value of ['x\r\nAuthorization: secret','contains spaces','x'.repeat(129)]) {
    await assert.rejects(safeJsonRequest({ ...baseRequest, headers: { 'idempotency-key': value } }), errorCode('PROVIDER_SETTINGS_REQUIRED'));
  }
});
