import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

const MESSAGES = {
  INVALID_PROVIDER_URL: 'The provider endpoint must use public HTTPS on port 443 without credentials, a query, or a fragment.',
  UNSAFE_PROVIDER_HOST: 'The provider endpoint is not an allowed public network address.',
  PROVIDER_DNS_FAILED: 'The provider endpoint could not be resolved.',
  PROVIDER_TIMEOUT: 'The external service timed out. A request may already have incurred a charge; retry only when ready.',
  PROVIDER_UNAVAILABLE: 'The external service could not be reached.',
  PROVIDER_ABORTED: 'The external request was cancelled. A submitted request may already have incurred a charge.',
  PROVIDER_REDIRECT: 'The external service redirected the request. Redirects are not allowed.',
  PROVIDER_AUTH: 'The external service rejected its configured credentials.',
  PROVIDER_RATE_LIMITED: 'The external service is rate limited. No automatic retry was attempted.',
  PROVIDER_HTTP_ERROR: 'The external service rejected the request. Check the configured endpoint and model.',
  PROVIDER_RESPONSE_TOO_LARGE: 'The external service response exceeded the allowed size.',
  PROVIDER_INVALID_RESPONSE: 'The external service did not return a valid JSON response.',
  PROVIDER_COMPLETION_ENVELOPE: 'The model response did not contain a valid completion envelope.',
  PROVIDER_COMPLETION_TRUNCATED: 'The model stopped at its output limit before completing the response.',
  PROVIDER_COMPLETION_FILTERED: 'The model response was stopped by its content filter.',
  PROVIDER_COMPLETION_STOP_REASON: 'The model stopped without completing a normal answer.',
  PROVIDER_COMPLETION_REFUSAL: 'The model declined to produce the requested output.',
  PROVIDER_COMPLETION_EMPTY: 'The model returned an empty final answer.',
  PROVIDER_COMPLETION_JSON: 'The model final answer was not valid JSON.',
  PROVIDER_RESULT_ENVELOPE: 'The model JSON did not contain exactly one result field.',
  PROVIDER_OUTLINE_SCHEMA: 'The model outline did not match the required structure.',
  PROVIDER_RESEARCH_SCHEMA: 'The model research pack did not match the required structure.',
  PROVIDER_RESPONSE_SECRET: 'The model response contained a configured credential and was rejected.',
  PROVIDER_REQUEST_TOO_LARGE: 'The generation request exceeded the allowed size.',
  PROVIDER_SETTINGS_REQUIRED: 'Save a provider, model, and API key before using live generation.',
  RESEARCH_EVIDENCE_REQUIRED: 'Research needs at least one successfully retrieved source page before another model call.',
  RESEARCH_NO_RELEVANT_SOURCES: 'Search returned no sources matching the trip destination. Specify a more precise city and province or country before starting a new trip.',
  INVALID_CONSTRAINTS: 'Trip constraints must describe a valid trip of at most 14 days.',
  INVALID_ITINERARY: 'The model did not return a valid itinerary. No automatic retry was attempted.',
  ITINERARY_BUDGET_EXCEEDED: 'The generated itinerary exceeded the trip budget. No automatic retry was attempted.',
  ITINERARY_DATE_MISMATCH: 'The generated itinerary did not match the requested trip dates.',
  ENCRYPTION_CONFIGURATION: 'The server encryption key must be a canonical base64-encoded 32-byte value.',
  KEY_ENCRYPTION_FAILED: 'The API key could not be encrypted.',
  KEY_DECRYPTION_FAILED: 'The saved API key could not be decrypted. Save the key again or contact the administrator.',
} as const;
export type SafeProviderErrorCode = keyof typeof MESSAGES;
export interface SafeErrorDetail { phase?: 'dns' | 'connect' | 'tls' | 'response'; httpStatus?: number; requestSent?: boolean; validationDetail?: string }

/** Never attach an upstream error, URL, response, headers, or key to this error. */
export class SafeProviderError extends Error {
  readonly code: SafeProviderErrorCode;
  readonly phase?: SafeErrorDetail['phase'];
  readonly httpStatus?: number;
  readonly requestSent?: boolean;
  /** Only a bounded schema path/code, never response content or upstream text. */
  readonly validationDetail?: string;
  constructor(code: SafeProviderErrorCode, detail: SafeErrorDetail = {}) {
    super(MESSAGES[code]);
    this.name = 'SafeProviderError';
    this.code = code;
    this.phase = detail.phase;
    this.httpStatus = detail.httpStatus;
    this.requestSent = detail.requestSent;
    this.validationDetail = typeof detail.validationDetail === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(detail.validationDetail) ? detail.validationDetail : undefined;
  }
}

const BLOCKED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map((cidr) => ipaddr.parseCIDR(cidr));
const BLOCKED_V6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20']
  .map((cidr) => ipaddr.parseCIDR(cidr));

/** Conservative global-address policy: IPv6 transition/mapped ranges are also rejected. */
export function isGlobalIp(address: string): boolean {
  try {
    if (!isIP(address)) return false;
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv4') {
      return !BLOCKED_V4.some(([network, prefix]) => parsed.match(network, prefix));
    }
    if (!parsed.match(ipaddr.parse('2000::'), 3)) return false;
    return !BLOCKED_V6.some(([network, prefix]) => parsed.match(network, prefix));
  } catch { return false; }
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/** Syntactic and literal-IP validation. Every actual request additionally validates DNS. */
export function validateProviderBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || baseUrl.trim() !== baseUrl || /[\x00-\x20\x7f\\]/.test(baseUrl)) {
      throw new Error();
    }
    url = new URL(baseUrl);
    // Checking the raw delimiters also rejects empty `?` and `#` suffixes.
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        /[?#]/.test(baseUrl) || /^https:\/\/[^/]*@/i.test(baseUrl) || (url.port && url.port !== '443')) throw new Error();
  } catch { throw new SafeProviderError('INVALID_PROVIDER_URL'); }
  const hostname = hostnameOf(url).toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/.test(hostname) ||
      (!isIP(hostname) && (!hostname.includes('.') || hostname.length > 253))) {
    throw new SafeProviderError('UNSAFE_PROVIDER_HOST');
  }
  if (isIP(hostname) && !isGlobalIp(hostname)) throw new SafeProviderError('UNSAFE_PROVIDER_HOST', {phase:'dns',requestSent:false});
  return url;
}

export interface ResolvedAddress { address: string; family: number }
export type HostResolver = (hostname: string) => Promise<ReadonlyArray<ResolvedAddress>>;
export type RequestFactory = (options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest;
export interface HttpDependencies {
  resolveHost?: HostResolver;
  /** Test-only constructor injection; never accepts client-supplied options. */
  request?: RequestFactory;
}
function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
}
let defaultResolver: HostResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });
/** Called once during Worker startup; request callers cannot select or replace DNS. */
export function configureDefaultHostResolver(resolver: HostResolver): void { defaultResolver = resolver; }

export async function validatePublicHost(url: URL, resolveHost: HostResolver = defaultResolver): Promise<ResolvedAddress[]> {
  // Revalidate: callers cannot bypass restrictions by providing a manually mutated URL.
  const checked = validateProviderBaseUrl(url.toString());
  const hostname = hostnameOf(checked).replace(/\.$/, '');
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  let addresses: ReadonlyArray<ResolvedAddress>;
  try {
    addresses = await new Promise<ReadonlyArray<ResolvedAddress>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SafeProviderError('PROVIDER_TIMEOUT', {phase:'dns',requestSent:false})), 5_000);
      // DNS cannot be cancelled by Node's OS lookup, but no network request can
      // proceed after this promise times out. The timer must not keep a server alive.
      timer.unref();
      Promise.resolve().then(() => resolveHost(hostname)).then(
        (value) => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); reject(new SafeProviderError('PROVIDER_DNS_FAILED', {phase:'dns',requestSent:false})); },
      );
    });
  } catch (error) {
    throw error instanceof SafeProviderError ? error : new SafeProviderError('PROVIDER_DNS_FAILED', {phase:'dns',requestSent:false});
  }
  if (!addresses.length || addresses.some(({ address, family }) =>
    !isGlobalIp(address) || isIP(address) !== family)) {
    throw new SafeProviderError('UNSAFE_PROVIDER_HOST', {phase:'dns',requestSent:false});
  }
  return addresses.map(({ address, family }) => ({ address, family }));
}

export interface SafeJsonRequest {
  baseUrl: string;
  /** Relative endpoint only, e.g. chat/completions; never a user-provided URL. */
  path: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** A public source may contain a query, but never credentials, fragments, or a non-HTTPS origin. */
export function validatePublicResourceUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) {
    throw new SafeProviderError('INVALID_PROVIDER_URL');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new SafeProviderError('INVALID_PROVIDER_URL'); }
  if (url.hash || value.includes('#') || url.username || url.password) throw new SafeProviderError('INVALID_PROVIDER_URL');
  validateProviderBaseUrl(url.origin);
  return url;
}

export interface SafeResourceRequest {
  url: string;
  /** The caller selects the allowlist; no response type is ever inferred from its URL. */
  kind: 'page' | 'image' | 'map';
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface SafeResourceResponse { bytes: Buffer; contentType: string; }

/** Bounded GET using the same pinned-DNS/TLS guard as model requests. Redirects are rejected. */
export async function safeResourceRequest(input: SafeResourceRequest, deps: HttpDependencies = {}): Promise<SafeResourceResponse> {
  const target = validatePublicResourceUrl(input.url);
  const allowed = input.kind === 'page' ? ['text/html', 'application/xhtml+xml', 'text/plain'] : input.kind === 'map' ?
    ['application/json', 'application/x-protobuf', 'application/protobuf', 'application/vnd.mapbox-vector-tile', 'application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'] : ['image/jpeg', 'image/png', 'image/webp'];
  return requestBytes(target, {
    method: 'GET', headers: { accept: allowed.join(', '), 'accept-encoding': 'identity' },
    timeoutMs: boundedLimit(input.timeoutMs, 12_000, 30_000),
    maxBytes: boundedLimit(input.maxBytes, input.kind === 'page' ? 600_000 : 3_000_000, input.kind === 'page' ? 1_000_000 : 4_000_000),
    allowedTypes: allowed, signal: input.signal,
  }, deps);
}

/**
 * One request only. DNS resolution is checked in full, then the selected IP is pinned
 * by lookup. A new socket is used, TLS still verifies the original hostname, and no
 * proxy environment variables or redirect handling are involved.
 */
export async function safeJsonRequest(input: SafeJsonRequest, deps: HttpDependencies = {}): Promise<unknown> {
  const base = validateProviderBaseUrl(input.baseUrl);
  if (!/^[a-zA-Z0-9_/-]+$/.test(input.path) || input.path.startsWith('/') || input.path.includes('..')) {
    throw new SafeProviderError('INVALID_PROVIDER_URL');
  }
  const target = new URL(`${base.toString().replace(/\/+$/, '')}/${input.path}`);
  const timeoutMs = boundedLimit(input.timeoutMs, 90_000, 120_000);
  const maxBytes = boundedLimit(input.maxBytes, 1_000_000, 2_000_000);
  let body: string | undefined;
  try { if (input.body !== undefined) body = JSON.stringify(input.body); }
  catch { throw new SafeProviderError('PROVIDER_REQUEST_TOO_LARGE'); }
  if (body && Buffer.byteLength(body) > 512_000) throw new SafeProviderError('PROVIDER_REQUEST_TOO_LARGE');
  const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'identity' };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!['authorization', 'x-subscription-token', 'idempotency-key'].includes(name.toLowerCase()) ||
        typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value) || value.length > 8192 ||
        (name.toLowerCase() === 'idempotency-key' && !/^[a-zA-Z0-9_-]{1,128}$/.test(value))) {
      throw new SafeProviderError('PROVIDER_SETTINGS_REQUIRED');
    }
    headers[name.toLowerCase()] = value;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const result = await requestBytes(target, { method: input.method ?? 'POST', headers, body, timeoutMs, maxBytes, signal: input.signal }, deps);
  try { return JSON.parse(result.bytes.toString('utf8')); }
  catch { throw new SafeProviderError(input.path === 'chat/completions' ? 'PROVIDER_COMPLETION_JSON' : 'PROVIDER_INVALID_RESPONSE', {phase:'response',requestSent:true}); }
}

interface WireRequest {
  method: 'GET' | 'POST'; headers: Record<string, string>; body?: string;
  timeoutMs: number; maxBytes: number; signal?: AbortSignal; allowedTypes?: string[];
}
function requestBytes(target: URL, input: WireRequest, deps: HttpDependencies): Promise<SafeResourceResponse> {
  if (input.signal?.aborted) return Promise.reject(new SafeProviderError('PROVIDER_ABORTED', {requestSent:false}));
  return new Promise<SafeResourceResponse>((resolve, reject) => {
    let settled = false;
    let sent = false;
    let phase: SafeErrorDetail['phase'] = 'dns';
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    const wireError = (code: SafeProviderErrorCode, httpStatus?: number) => new SafeProviderError(code, {phase,httpStatus,requestSent:sent});
    const abort = () => finish(wireError('PROVIDER_ABORTED'));
    const finish = (error?: SafeProviderError, value?: SafeResourceResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else resolve(value!);
    };
    // Absolute deadline includes DNS, TLS handshake, headers and complete body.
    const timer = setTimeout(() => finish(wireError('PROVIDER_TIMEOUT')), input.timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) { abort(); return; }
    void validatePublicHost(new URL(target.origin), deps.resolveHost).then((addresses) => {
      if (settled) return;
      const selected = addresses[0];
      phase = 'connect';
      const hostname = hostnameOf(target);
      const options: RequestOptions = {
        protocol: 'https:', hostname, port: 443,
        path: target.pathname + target.search, method: input.method, headers: input.headers,
        agent: false, rejectUnauthorized: true,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all) callback(null, [{ address: selected.address, family: selected.family }]);
          else callback(null, selected.address, selected.family);
        }) as RequestOptions['lookup'],
      };
      try {
        request = (deps.request ?? httpsRequest)(options, (incoming) => {
          response = incoming;
          phase = 'response';
          if (settled) { incoming.destroy(); return; }
          const status = incoming.statusCode ?? 0;
          if (status >= 300 && status < 400) return finish(wireError('PROVIDER_REDIRECT', status));
          if (status === 401 || status === 403) return finish(wireError('PROVIDER_AUTH', status));
          if (status === 429) return finish(wireError('PROVIDER_RATE_LIMITED', status));
          if (status < 200 || status >= 300) return finish(wireError('PROVIDER_HTTP_ERROR', status));
          if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
            return finish(wireError('PROVIDER_INVALID_RESPONSE', status));
          }
          const contentType = String(incoming.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (input.allowedTypes && !input.allowedTypes.includes(contentType)) return finish(wireError('PROVIDER_INVALID_RESPONSE', status));
          const declared = Number(incoming.headers['content-length']);
          if (Number.isFinite(declared) && declared > input.maxBytes) return finish(wireError('PROVIDER_RESPONSE_TOO_LARGE', status));
          let size = 0;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += data.length;
            if (size > input.maxBytes) return finish(wireError('PROVIDER_RESPONSE_TOO_LARGE', status));
            chunks.push(data);
          });
          incoming.on('end', () => {
            if (!settled) finish(undefined, { bytes: Buffer.concat(chunks), contentType });
          });
          incoming.on('error', () => finish(wireError('PROVIDER_UNAVAILABLE', status)));
          incoming.on('aborted', () => finish(wireError('PROVIDER_UNAVAILABLE', status)));
        });
        request.on('error', (error: NodeJS.ErrnoException) => {
          phase = /^(?:CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(error.code ?? '') ? 'tls' : 'connect';
          finish(wireError('PROVIDER_UNAVAILABLE'));
        });
        sent = true;
        request.end(input.body);
      } catch { finish(wireError('PROVIDER_UNAVAILABLE')); }
    }).catch((error: unknown) => finish(error instanceof SafeProviderError ? error : new SafeProviderError('PROVIDER_UNAVAILABLE')));
  });
}
