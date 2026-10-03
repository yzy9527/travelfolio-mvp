import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { isGlobalIp, type HostResolver, type ResolvedAddress } from './safe-http';

export type DnsResolutionMode = 'system' | 'cloudflare' | 'google';
const PROVIDERS = {
  cloudflare: { host: 'cloudflare-dns.com', path: '/dns-query', ips: ['1.1.1.1', '1.0.0.1'] },
  google: { host: 'dns.google', path: '/resolve', ips: ['8.8.8.8', '8.8.4.4'] },
} as const;
const MAX_ANSWER_BYTES = 64_000;
const MAX_CACHE_ENTRIES = 512;
const MAX_CNAME_HOPS = 8;
// Stay below validatePublicHost's 5-second DNS guard, including failover and CNAMEs.
const RESOLUTION_BUDGET_MS = 4_500;
const PRIMARY_ATTEMPT_MS = 1_200;
const BACKUP_ATTEMPT_MS = 3_000;
type DnsRecord = { name: string; type: number; TTL: number; data: string };
type DnsReply = { Status: number; TC?: boolean; Question: { name: string; type: number }[]; Answer?: DnsRecord[] };
type DnsQuery = (name: string, type: 1 | 28, signal: AbortSignal, deadlineAt: number) => Promise<DnsReply>;
type DnsRequestFactory = (options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest;

export function parseDnsResolutionMode(value: string | undefined): DnsResolutionMode {
  if (value === undefined || value === '' || value === 'system') return 'system';
  if (value === 'cloudflare' || value === 'google') return value;
  throw new Error('WORKER_DNS_MODE must be system, cloudflare, or google');
}

function cleanName(value: string): string {
  const name = value.toLowerCase().replace(/\.$/, '');
  if (name.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(name) ||
      name.split('.').some((part) => part.length > 63 || part.startsWith('-') || part.endsWith('-'))) {
    throw new Error('Invalid DNS name');
  }
  return name;
}

/** The DoH hostname is never resolved through the system DNS or this resolver. */
async function queryDoh(mode: Exclude<DnsResolutionMode, 'system'>, name: string, type: 1 | 28,
  signal: AbortSignal, deadlineAt: number, requestFactory: DnsRequestFactory): Promise<DnsReply> {
  const provider = PROVIDERS[mode];
  const path = `${provider.path}?name=${encodeURIComponent(name)}&type=${type === 1 ? 'A' : 'AAAA'}`;
  for (const [index, ip] of provider.ips.entries()) {
    const remaining = deadlineAt - Date.now();
    if (signal.aborted || remaining <= 0) break;
    const timeoutMs = Math.min(index === 0 ? PRIMARY_ATTEMPT_MS : BACKUP_ATTEMPT_MS, remaining);
    try {
      return await new Promise<DnsReply>((resolve, reject) => {
        let settled = false;
        let request: ClientRequest | undefined;
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        const fail = () => {
          if (settled) return;
          settled = true; cleanup(); request?.destroy(); reject(new Error('Trusted DNS unavailable'));
        };
        const abort = () => fail();
        const timer = setTimeout(fail, timeoutMs);
        timer.unref();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { fail(); return; }
        const options: RequestOptions = {
          protocol: 'https:', hostname: provider.host, servername: provider.host, port: 443, path,
          method: 'GET', agent: false, rejectUnauthorized: true,
          headers: { accept: 'application/dns-json', 'accept-encoding': 'identity' },
          lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (lookupOptions?.all) callback(null, [{ address: ip, family: 4 }]);
            else callback(null, ip, 4);
          }) as RequestOptions['lookup'],
        };
        try {
          request = requestFactory(options, (response) => {
            const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            if (response.statusCode !== 200 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' ||
                !['application/dns-json', 'application/json'].includes(contentType)) {
              response.destroy(); fail(); return;
            }
            const chunks: Buffer[] = []; let size = 0;
            response.on('data', (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > MAX_ANSWER_BYTES) { response.destroy(); fail(); } else chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DnsReply;
                settled = true; cleanup(); resolve(parsed);
              } catch { fail(); }
            });
            response.on('error', fail);
            response.on('aborted', fail);
          });
          request.on('error', fail);
          request.end();
        } catch { fail(); }
      });
    } catch { /* Try only the next pinned address of the selected trusted provider. */ }
  }
  throw new Error('Trusted DNS unavailable');
}

export function createTrustedDnsResolver(mode: Exclude<DnsResolutionMode, 'system'>,
  queryOverride?: DnsQuery,
  /** Test-only transport injection; deployed callers cannot select a DoH endpoint. */
  requestFactory: DnsRequestFactory = httpsRequest): HostResolver {
  const query: DnsQuery = queryOverride ?? ((name, type, signal, deadlineAt) =>
    queryDoh(mode, name, type, signal, deadlineAt, requestFactory));
  const cache = new Map<string, { addresses: ResolvedAddress[]; expires: number }>();
  const pending = new Map<string, Promise<ReadonlyArray<ResolvedAddress>>>();
  const resolveUncached = async (hostname: string, signal: AbortSignal, deadlineAt: number): Promise<{ addresses: ResolvedAddress[]; ttl: number }> => {
    let name = cleanName(hostname); const seen = new Set<string>(); let ttl = 300;
    for (let hop = 0; hop < MAX_CNAME_HOPS; hop++) {
      if (seen.has(name)) throw new Error('DNS CNAME loop');
      seen.add(name);
      if (signal.aborted || Date.now() >= deadlineAt) throw new Error('Trusted DNS timed out');
      const replies = await Promise.all([query(name, 1, signal, deadlineAt), query(name, 28, signal, deadlineAt)]);
      const addresses: ResolvedAddress[] = [];
      let nextName: string | undefined;
      for (const [index, reply] of replies.entries()) {
        const requestedType = index === 0 ? 1 : 28;
        if (!reply || reply.TC || ![0, 3].includes(reply.Status) || !Array.isArray(reply.Question) ||
            reply.Question.length !== 1 || cleanName(reply.Question[0].name) !== name || reply.Question[0].type !== requestedType ||
            reply.Answer !== undefined && !Array.isArray(reply.Answer)) throw new Error('Invalid trusted DNS response');
        if (reply.Status === 3) continue;
        const records = reply.Answer ?? [];
        const chain = new Set<string>([name]);
        for (let step = 0; step < MAX_CNAME_HOPS; step++) {
          const cname = records.find((record) => record.type === 5 && chain.has(cleanName(record.name)) &&
            !chain.has(cleanName(record.data)));
          if (!cname) break;
          const alias = cleanName(cname.data); chain.add(alias); nextName = alias;
          ttl = Math.min(ttl, validTtl(cname.TTL));
        }
        for (const record of records) {
          if (!record || typeof record !== 'object' || typeof record.name !== 'string' || typeof record.data !== 'string') throw new Error('Invalid trusted DNS record');
          if (record.type !== 1 && record.type !== 28) continue;
          if (!chain.has(cleanName(record.name))) continue;
          const family = record.type === 1 ? 4 : 6;
          if (isIP(record.data) !== family || !isGlobalIp(record.data)) throw new Error('Invalid trusted DNS address');
          ttl = Math.min(ttl, validTtl(record.TTL));
          addresses.push({ address: record.data, family });
        }
      }
      if (addresses.length) return { addresses: [...new Map(addresses.map((item) => [`${item.family}:${item.address}`, item])).values()], ttl };
      if (!nextName) throw new Error('Trusted DNS returned no addresses');
      name = nextName;
    }
    throw new Error('DNS CNAME chain too long');
  };
  return (hostname) => {
    const name = cleanName(hostname); const now = Date.now();
    const saved = cache.get(name);
    if (saved && saved.expires > now) return Promise.resolve(saved.addresses.map((item) => ({ ...item })));
    const existing = pending.get(name);
    if (existing) return existing;
    const controller = new AbortController();
    const deadlineAt = Date.now() + RESOLUTION_BUDGET_MS;
    let timeout!: NodeJS.Timeout;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('Trusted DNS timed out')); }, RESOLUTION_BUDGET_MS);
      timeout.unref();
    });
    const task = Promise.race([resolveUncached(name, controller.signal, deadlineAt), timedOut]).then(({ addresses, ttl }) => {
      cache.delete(name);
      cache.set(name, { addresses, expires: Date.now() + Math.max(1, Math.min(300, ttl)) * 1000 });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      return addresses;
    }).finally(() => { clearTimeout(timeout); controller.abort(); pending.delete(name); });
    pending.set(name, task);
    return task;
  };
}

function validTtl(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error('Invalid DNS TTL');
  return value;
}
