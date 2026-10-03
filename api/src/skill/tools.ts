/** Controlled research tools. Only fixed searches, their returned pages, and images
 * declared by trusted official pages can be requested. No model tool execution. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import {destinationSearchScope,relevantSearchResult,researchSearchTopics,researchSearchDestination} from './search-scope';
import { type TripConstraints, tripConstraintsSchema } from '../schemas';
import { SafeProviderError, safeJsonRequest, safeResourceRequest, validatePublicResourceUrl,
  type SafeJsonRequest, type SafeResourceRequest, type SafeResourceResponse } from '../safe-http';
import type { PackId, ResearchPacks, SourceEvidence, AssetEvidence } from './types';

export type RunOperation = <T>(key: string, input: unknown, action: () => Promise<T>) => Promise<T>;
export interface ResearchDependencies {
  /** Trusted server/test injection only; never derive dependencies from an HTTP request. */
  transport?: (request: SafeJsonRequest) => Promise<unknown>;
  pageTransport?: (request: SafeResourceRequest) => Promise<SafeResourceResponse>;
  now?: () => Date;
  /** Operator-reviewed official hosts. Model text, redirects, and search ranking cannot add one. */
  officialHosts?: readonly string[];
}
export interface PageEntity {
  name: string; latitude?: number; longitude?: number; address?: string;
  rating?: number; reviewCount?: number;
}
export interface PageMetadata { title: string; description: string; imageUrls: string[]; entities: PageEntity[] }
export interface ResearchEvidence extends SourceEvidence {
  packIds: PackId[];
  discoveredBy: 'brave_search';
  evidenceEpoch?: string;
  query: string;
  retrievalStatus: 'snippet_only' | 'page_retrieved' | 'page_unavailable';
  authority: 'operator_verified_official' | 'unclassified';
  pageRetrievedAt?: string;
  contentHash?: string;
  contentType?: string;
  text?: string;
  metadata?: PageMetadata;
  failureCode?: string;
  failurePhase?: 'dns' | 'connect' | 'tls' | 'response';
  failureHttpStatus?: number;
}
export interface ResearchFailure { operation: 'search' | 'page' | 'image'; code: string; sourceId?: string; placeId?: string }
export interface EvidenceResult {
  sources: ResearchEvidence[];
  status: 'disabled' | 'retrieved' | 'partial' | 'empty' | 'failed';
  queries: string[];
  failures: ResearchFailure[];
}
export interface EvidenceInput {
  packId: PackId; constraints: TripConstraints;
  outline?: { days: { areas: string[] }[] };
  existingSources?: ResearchEvidence[];
  searchApiKey?: string;
  operationKey: string;
  signal?: AbortSignal;
  runOperation: RunOperation;
}
export const RESEARCH_LIMITS = Object.freeze({ searchesPerPack: 3, resultsPerSearch: 10, pagesPerPack: 12,
  sourcesPerBuild: 120, pageBytes: 600_000, pageTextCharacters: 5_000, imageBytes: 3_000_000,
  imageDownloadsPerBuild: 48, imagesPerPlace: 2, maxTotalImageBytes: 36_000_000,
  imagePixels: 16_000_000, decodedImageBytes: 512_000, maxTotalDecodedImageBytes: 8_000_000 });

const searchSchema = z.object({ web: z.object({ results: z.array(z.object({
  title: z.string().max(5000), url: z.string().max(4096), description: z.string().max(20000).optional(),
})).max(100) }).optional() });
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stamp = (deps: ResearchDependencies) => (deps.now?.() ?? new Date()).toISOString();
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new SafeProviderError('PROVIDER_ABORTED'); }
export function safeFailure(error: unknown): string { return error instanceof SafeProviderError ? error.code : 'PROVIDER_UNAVAILABLE'; }
export function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const variants = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')]))];
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length) {
    if (++count > 100_000) return true;
    const item = pending.pop();
    if (typeof item === 'string') { if (variants.some((secret) => item.includes(secret))) return true; }
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (variants.some((secret) => key.includes(secret))) return true;
      pending.push(child);
    }
  }
  return false;
}
function cleanUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    url.hash = '';
    return validatePublicResourceUrl(url.toString()).toString();
  } catch { return null; }
}
function official(url: string, hosts: readonly string[] = []): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return hosts.some((entry) => host === entry.toLowerCase().replace(/\.$/, ''));
}
function entities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (match) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
    if (named[match.toLowerCase()]) return named[match.toLowerCase()];
    const value = match[2].toLowerCase() === 'x' ? parseInt(match.slice(3, -1), 16) : Number(match.slice(2, -1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ' ';
  });
}
function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0; let count = 0;
  while (i < tag.length && count < 64) {
    while (i < tag.length && !/[A-Za-z_:]/.test(tag[i])) i++;
    const start = i;
    while (i < tag.length && /[\w:-]/.test(tag[i])) i++;
    const name = tag.slice(start, i).toLowerCase();
    while (i < tag.length && /\s/.test(tag[i])) i++;
    if (tag[i] !== '=') continue;
    i++; while (i < tag.length && /\s/.test(tag[i])) i++;
    let value = '';
    if (tag[i] === '"' || tag[i] === "'") {
      const quote = tag[i++]; const end = tag.indexOf(quote, i);
      if (end < 0) break;
      value = tag.slice(i, end); i = end + 1;
    } else {
      const start = i; while (i < tag.length && !/[\s>]/.test(tag[i])) i++;
      value = tag.slice(start, i);
    }
    if (name.length <= 100) { attrs[name] = entities(value); count++; }
  }
  return attrs;
}
/** Passive bounded metadata parser. Scripts/styles/forms are never evaluated. */
export function inspectSourcePage(bytes: Buffer, contentType: string, url: string): { text: string; metadata: PageMetadata } {
  if (bytes.length > RESEARCH_LIMITS.pageBytes || !['text/html', 'application/xhtml+xml', 'text/plain'].includes(contentType)) {
    throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
  }
  const html = bytes.toString('utf8');
  const metadata: PageMetadata = { title: '', description: '', imageUrls: [], entities: [] };
  if (contentType === 'text/plain') return { text: html.slice(0, RESEARCH_LIMITS.pageTextCharacters), metadata };
  const addImage = (value: unknown) => {
    if (typeof value !== 'string' || metadata.imageUrls.length >= 12) return;
    const candidate = cleanUrl(value, url);
    if (candidate && !metadata.imageUrls.includes(candidate)) metadata.imageUrls.push(candidate);
  };
  let traversed = 0;
  const visit = (node: unknown, depth = 0) => {
    if (++traversed > 1200 || depth > 10 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node.slice(0, 100)) visit(child, depth + 1); return; }
    const value = node as Record<string, unknown>;
    const images = Array.isArray(value.image) ? value.image : [value.image];
    for (const item of images.slice(0, 12)) addImage(typeof item === 'string' ? item : (item as Record<string, unknown> | null)?.url);
    if (typeof value.name === 'string' && metadata.entities.length < 24) {
      const geo = value.geo as Record<string, unknown> | undefined;
      const numericCoordinate = (value: unknown) => typeof value === 'number' ? value :
        typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,12})?$/.test(value.trim()) ? Number(value) : NaN;
      const latitude = numericCoordinate(geo?.latitude);
      const longitude = numericCoordinate(geo?.longitude);
      const rating = value.aggregateRating as Record<string, unknown> | undefined;
      const record: PageEntity = { name: value.name.slice(0, 300) };
      if (Number.isFinite(latitude) && Math.abs(latitude) <= 90 && Number.isFinite(longitude) && Math.abs(longitude) <= 180 && geo?.latitude != null && geo?.longitude != null) {
        record.latitude = latitude; record.longitude = longitude;
      }
      const addr = value.address;
      if (typeof addr === 'string') record.address = addr.slice(0, 600);
      else if (addr && typeof addr === 'object') record.address = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry'].map((k) => (addr as Record<string, unknown>)[k]).filter((v) => typeof v === 'string').join(', ').slice(0, 600);
      if (typeof rating?.ratingValue === 'number' && rating.ratingValue >= 0 && rating.ratingValue <= 5) record.rating = rating.ratingValue;
      if (typeof rating?.reviewCount === 'number' && Number.isInteger(rating.reviewCount) && rating.reviewCount >= 0) record.reviewCount = rating.reviewCount;
      if (record.latitude !== undefined || record.address || record.rating !== undefined) metadata.entities.push(record);
    }
    for (const child of Object.values(value).slice(0, 80)) visit(child, depth + 1);
  };
  // A monotonic scanner avoids quadratic backtracking on malformed/unclosed
  // script tags. Every byte is visited at most a bounded number of times.
  const lower = html.toLowerCase();
  const textParts: string[] = []; let textLength = 0; let cursor = 0; let imageTags = 0;
  const addText = (value: string) => {
    if (textLength >= RESEARCH_LIMITS.pageTextCharacters * 3) return;
    const part = value.slice(0, RESEARCH_LIMITS.pageTextCharacters * 3 - textLength);
    textParts.push(part); textLength += part.length;
  };
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open < 0) { addText(html.slice(cursor)); break; }
    addText(html.slice(cursor, open));
    if (lower.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4); if (end < 0) break;
      cursor = end + 3; continue;
    }
    const close = html.indexOf('>', open + 1); if (close < 0) break;
    cursor = close + 1;
    // Oversized tags are ignored instead of entering any regex/parser.
    if (close - open > 10000) continue;
    const raw = html.slice(open + 1, close);
    const name = /^\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw)?.[1].toLowerCase();
    if (!name) continue;
    if (['script', 'style', 'noscript', 'svg', 'form', 'title'].includes(name)) {
      const end = lower.indexOf(`</${name}`, cursor); if (end < 0) break;
      const closeEnd = html.indexOf('>', end); if (closeEnd < 0) break;
      const body = html.slice(cursor, end); cursor = closeEnd + 1;
      if (name === 'script' && body.length <= 100_000 && attributes(raw).type?.toLowerCase() === 'application/ld+json') {
        try { visit(JSON.parse(body)); } catch { /* Invalid structured metadata is not evidence. */ }
      }
      if (name === 'title' && !metadata.title) metadata.title = entities(body.slice(0, 1200)).replace(/[<>]/g, '').trim().slice(0, 300);
      continue;
    }
    if (name === 'meta') {
      const attr = attributes(raw); const property = (attr.property ?? attr.name ?? '').toLowerCase();
      if (['description', 'og:description'].includes(property) && !metadata.description) metadata.description = (attr.content ?? '').slice(0, 1000);
      if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image'].includes(property)) addImage(attr.content);
    } else if (name === 'img' && imageTags++ < 80) {
      const attr = attributes(raw); addImage(attr.src ?? attr['data-src']);
    }
  }
  const text = entities(textParts.join(' ')).replace(/\s+/g, ' ').trim().slice(0, RESEARCH_LIMITS.pageTextCharacters);
  return { text, metadata };
}

export async function acquireEvidence(input: EvidenceInput, deps: ResearchDependencies = {}): Promise<EvidenceResult> {
  const constraints = tripConstraintsSchema.parse(input.constraints);
  const scope = destinationSearchScope(constraints.destination);
  const topics = researchSearchTopics(input.packId, scope);
  if (!topics) throw new SafeProviderError('INVALID_CONSTRAINTS');
  throwIfAborted(input.signal);
  const sources = (input.existingSources ?? []).filter((source) => source.discoveredBy === 'brave_search' && Array.isArray(source.packIds) && ['snippet_only', 'page_retrieved', 'page_unavailable'].includes(source.retrievalStatus)).filter(source => source.retrievalStatus === 'page_retrieved' || relevantSearchResult(scope, { title: source.title, url: source.url, description: source.excerpt })).slice(0, RESEARCH_LIMITS.sourcesPerBuild).map((source) => ({ ...source, packIds: [...source.packIds] }));
  const result: EvidenceResult = { sources, status: 'disabled', queries: [], failures: [] };
  if (!input.searchApiKey) return result;
  if (input.searchApiKey.length > 4096 || /[\x00-\x1f\x7f]/.test(input.searchApiKey)) throw new SafeProviderError('PROVIDER_SETTINGS_REQUIRED');
  const apiKey = input.searchApiKey;
  const evidenceEpoch = input.operationKey.split(':')[0];
  const byUrl = new Map(sources.filter((source) => source.evidenceEpoch === evidenceEpoch).map((source) => [source.url, source]));
  const chosen: ResearchEvidence[] = [];
  for (const [index, topic] of topics.slice(0, RESEARCH_LIMITS.searchesPerPack).entries()) {
    throwIfAborted(input.signal);
    // Minimized fixed queries: no party, budget, departure, preference, or change-request text.
    const target = input.packId==='places-core'&&index>0 ? scope.regionalDestination??scope.destination : researchSearchDestination(input.packId,scope);
    const q = `${target} ${topic}`.replace(/[\r\n]/g, ' ').slice(0, 500);
    result.queries.push(q);
    try {
      // New policy has its own ledger namespace: old English searches must not
      // collide with localized queries or be silently reused as equivalent.
      const searchKey = `${input.operationKey}:search:destination-v4:${index}`;
      const found = await input.runOperation(searchKey, { kind: 'brave_search', policy: 'destination-v4', query: q, country: scope.country, search_lang: scope.search_lang, count: RESEARCH_LIMITS.resultsPerSearch }, async () => {
        const raw = await (deps.transport ?? safeJsonRequest)({ baseUrl: 'https://api.search.brave.com', path: 'res/v1/web/search', method: 'POST',
          headers: { 'x-subscription-token': apiKey, 'idempotency-key': digest(searchKey) },
          body: { q, country: scope.country, search_lang: scope.search_lang, count: RESEARCH_LIMITS.resultsPerSearch, safesearch: 'moderate', operators: false, spellcheck: false }, signal: input.signal, timeoutMs: 15_000, maxBytes: 500_000 });
        const parsed = searchSchema.safeParse(raw);
        if (!parsed.success || containsSecret(parsed.data, [apiKey])) throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
        return (parsed.data.web?.results ?? []).slice(0, RESEARCH_LIMITS.resultsPerSearch);
      });
      for (const item of found) {
        const url = cleanUrl(item.url);
        if (!url || !item.title.trim() || containsSecret(item, [apiKey]) || !relevantSearchResult(scope, item)) continue;
        let source = byUrl.get(url);
        if (!source && sources.length < RESEARCH_LIMITS.sourcesPerBuild) {
          source = { id: `src-${digest(`${evidenceEpoch}:${url}`).slice(0, 20)}`, url, title: item.title.trim().slice(0, 300), retrievedAt: stamp(deps),
            excerpt: (item.description ?? '').slice(0, 1800), packIds: [input.packId], discoveredBy: 'brave_search', evidenceEpoch, query: q,
            retrievalStatus: 'snippet_only', authority: official(url, deps.officialHosts) ? 'operator_verified_official' : 'unclassified' };
          sources.push(source); byUrl.set(url, source);
        }
        if (!source) continue;
        if (!source.packIds.includes(input.packId)) source.packIds.push(input.packId);
        if (!chosen.some((candidate) => candidate.id === source!.id)) chosen.push(source);
      }
    } catch (error) {
      throwIfAborted(input.signal);
      result.failures.push({ operation: 'search', code: safeFailure(error) });
      // Stop the whole pack after a possibly billed/ambiguous call. Do not run more paid calls.
      throw error instanceof SafeProviderError ? error : new SafeProviderError('PROVIDER_UNAVAILABLE');
    }
  }
  if (!chosen.length) throw new SafeProviderError('RESEARCH_NO_RELEVANT_SOURCES');
  let next = 0;
  const work = chosen.slice(0, RESEARCH_LIMITS.pagesPerPack).filter((source) => source.retrievalStatus !== 'page_retrieved');
  const blockedHosts = new Set<string>();
  const fetchOne = async () => {
    for (;;) {
      const source = work[next++]; if (!source) return;
      throwIfAborted(input.signal);
      const host = new URL(source.url).hostname;
      if (blockedHosts.has(host)) { source.retrievalStatus = 'page_unavailable'; source.failureCode = 'HOST_RATE_LIMITED'; continue; }
      try {
        const response = await (deps.pageTransport ?? safeResourceRequest)({ url: source.url, kind: 'page', signal: input.signal,
          timeoutMs: 12_000, maxBytes: RESEARCH_LIMITS.pageBytes });
        const inspected = inspectSourcePage(response.bytes, response.contentType, source.url);
        if (containsSecret(inspected, [apiKey])) throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
        source.text = inspected.text; source.metadata = inspected.metadata; source.contentHash = digest(response.bytes);
        source.pageRetrievedAt = stamp(deps); source.contentType = response.contentType; source.retrievalStatus = 'page_retrieved';
        delete source.failureCode;
        delete source.failurePhase;
        delete source.failureHttpStatus;
      } catch (error) {
        throwIfAborted(input.signal);
        source.retrievalStatus = 'page_unavailable'; source.failureCode = safeFailure(error);
        source.failurePhase = error instanceof SafeProviderError ? error.phase : undefined;
        source.failureHttpStatus = error instanceof SafeProviderError ? error.httpStatus : undefined;
        if (source.failureCode === 'PROVIDER_RATE_LIMITED') blockedHosts.add(host);
        result.failures.push({ operation: 'page', sourceId: source.id, code: source.failureCode });
      }
    }
  };
  await Promise.all([fetchOne(), fetchOne()]);
  result.status = chosen.length ? (result.failures.length || chosen.some((source) => source.retrievalStatus !== 'page_retrieved') ? 'partial' : 'retrieved') : result.failures.length ? 'failed' : 'empty';
  return result;
}

export interface AssetReceipt extends AssetEvidence {
  status: 'downloaded_unreviewed' | 'pending' | 'failed';
  sourceIdentityBound: false; visuallyConfirmed: false; watermarkChecked: false;
  downloadSha256?: string; downloadBytes?: number;
}
export interface AssetResult { assets: AssetReceipt[]; failures: ResearchFailure[] }
export interface AssetInput { packs: Partial<ResearchPacks>; evidence: ResearchEvidence[]; signal?: AbortSignal }
/** Header dimensions are a safety/metadata check, never a full image decode or visual review. */
export function imageDimensions(data: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg' && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length && offset < 128_000) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1]; offset += 2;
      if (marker === 0xd9 || marker === 0xda) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) return null;
      const length = data.readUInt16BE(offset); if (length < 2 || offset + length > data.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 8) return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  if (mime === 'image/webp' && data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.toString('ascii', 12, 16) === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (data.toString('ascii', 12, 16) === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Decode untrusted raster data, then remove metadata and re-encode a bounded static preview.
 * Constructor/timeout policy follows https://sharp.pixelplumbing.com/security/ .
 * A successful decode does not prove subject identity, licensing or visual quality.
 */
export async function decodeRaster(bytes: Buffer, contentType: string, signal?: AbortSignal): Promise<{ data: Buffer; width: number; height: number; mime: 'image/webp' }> {
  throwIfAborted(signal);
  const formats: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };
  const magic = contentType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    contentType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    contentType === 'image/webp' ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' : false;
  if (!formats[contentType] || !magic || bytes.length > RESEARCH_LIMITS.imageBytes) throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
  const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: RESEARCH_LIMITS.imagePixels, sequentialRead: true, pages: 1, animated: false });
  const abort = () => pipeline.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const metadata = await pipeline.metadata();
    throwIfAborted(signal);
    if (metadata.format !== formats[contentType] || !metadata.width || !metadata.height || metadata.width < 160 || metadata.height < 120 ||
        metadata.width > 10000 || metadata.height > 10000 || metadata.width * metadata.height > RESEARCH_LIMITS.imagePixels ||
        (metadata.pages ?? 1) !== 1) throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
    const decoded = await pipeline.rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    throwIfAborted(signal);
    if (decoded.data.length > RESEARCH_LIMITS.decodedImageBytes || !decoded.info.width || !decoded.info.height) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
    return { data: decoded.data, width: decoded.info.width, height: decoded.info.height, mime: 'image/webp' };
  } catch (error) {
    throwIfAborted(signal);
    throw error instanceof SafeProviderError ? error : new SafeProviderError('PROVIDER_INVALID_RESPONSE');
  } finally { signal?.removeEventListener('abort', abort); pipeline.destroy(); }
}

export async function acquireAssets(input: AssetInput, deps: ResearchDependencies = {}): Promise<AssetResult> {
  const result: AssetResult = { assets: [], failures: [] };
  const byId = new Map(input.evidence.map((source) => [source.id, source]));
  const places: Record<string, unknown>[] = [];
  const walk = (value: unknown, depth = 0) => {
    if (depth > 8 || !value || typeof value !== 'object' || places.length >= 100) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) walk(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && Array.isArray(record.images)) places.push(record);
    else for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(input.packs);
  const seen = new Map<string, { sha256: string; bytes: number; mime: 'image/webp'; width: number; height: number; dataBase64: string; downloadSha256: string; downloadBytes: number }>();
  let totalBytes = 0; let totalDecodedBytes = 0; let downloads = 0;
  const blockedImageHosts = new Set<string>();
  for (const place of places) {
    for (const declaration of (place.images as unknown[]).slice(0, RESEARCH_LIMITS.imagesPerPlace)) {
      throwIfAborted(input.signal);
      const image = declaration && typeof declaration === 'object' ? declaration as Record<string, unknown> : {};
      const ids = Array.isArray(place.source_ids) ? place.source_ids.filter((id): id is string => typeof id === 'string') : [];
      const source = ids.map((id) => byId.get(id)).find((item) => item?.url === image.source_page) ??
        (typeof image.source_id === 'string' && ids.includes(image.source_id) ? byId.get(image.source_id) : undefined);
      const url = typeof image.download_url === 'string' ? cleanUrl(image.download_url) : null;
      const placeId = String(place.id).slice(0, 120);
      const receipt: AssetReceipt = { id: `asset-${digest(`${placeId}:${url ?? 'missing'}`).slice(0, 20)}`, placeId, sourceId: source?.id ?? '',
        sourcePage: source?.url ?? '', downloadUrl: url ?? '', file: typeof image.file === 'string' ? image.file : '', kind: 'place-image', status: 'pending', reason: 'No trusted official-page image candidate is available.', sourceIdentityBound: false, visuallyConfirmed: false, watermarkChecked: false };
      result.assets.push(receipt);
      // Exact source page provenance is mandatory. Neither model flags nor an official-looking hostname authorizes a fetch.
      if (!source || source.retrievalStatus !== 'page_retrieved' || source.authority !== 'operator_verified_official' ||
          !official(source.url, deps.officialHosts) || !url || !source.metadata?.imageUrls.includes(url)) continue;
      if (/\b(gettyimages|shutterstock|alamy|dreamstime|istockphoto)\b/i.test(new URL(url).hostname)) {
        receipt.reason = 'Commercial stock-preview hosts are not accepted.'; continue;
      }
      if (blockedImageHosts.has(new URL(url).hostname)) { receipt.reason = 'HOST_RATE_LIMITED'; continue; }
      const cached = seen.get(url);
      if (cached) { Object.assign(receipt, cached, { status: 'downloaded_unreviewed', reason: 'Retrieved bytes cached; identity, license and visual review are still required.' }); continue; }
      if (downloads >= RESEARCH_LIMITS.imageDownloadsPerBuild || totalBytes >= RESEARCH_LIMITS.maxTotalImageBytes || totalDecodedBytes >= RESEARCH_LIMITS.maxTotalDecodedImageBytes) { receipt.reason = 'The bounded image download budget was reached.'; continue; }
      downloads++;
      try {
        const response = await (deps.pageTransport ?? safeResourceRequest)({ url, kind: 'image', signal: input.signal, timeoutMs: 12_000,
          maxBytes: Math.min(RESEARCH_LIMITS.imageBytes, RESEARCH_LIMITS.maxTotalImageBytes - totalBytes) });
        if (response.bytes.length > RESEARCH_LIMITS.imageBytes || totalBytes + response.bytes.length > RESEARCH_LIMITS.maxTotalImageBytes) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
        totalBytes += response.bytes.length;
        const decoded = await decodeRaster(response.bytes, response.contentType, input.signal);
        if (totalDecodedBytes + decoded.data.length > RESEARCH_LIMITS.maxTotalDecodedImageBytes) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
        totalDecodedBytes += decoded.data.length;
        const details = { sha256: digest(decoded.data), bytes: decoded.data.length, mime: decoded.mime, width: decoded.width, height: decoded.height,
          dataBase64: decoded.data.toString('base64'), downloadSha256: digest(response.bytes), downloadBytes: response.bytes.length };
        seen.set(url, details);
        Object.assign(receipt, details, { status: 'downloaded_unreviewed', reason: 'Decoded and re-encoded raster preview; identity, license and visual review are still required.' });
        // Only decoded/re-encoded raster bytes enter private artifacts. Never raw remote HTML/SVG or model input.

      } catch (error) {
        throwIfAborted(input.signal);
        receipt.status = 'failed'; receipt.reason = safeFailure(error);
        if (safeFailure(error) === 'PROVIDER_RATE_LIMITED') blockedImageHosts.add(new URL(url).hostname);
        result.failures.push({ operation: 'image', sourceId: source.id, placeId, code: safeFailure(error) });
      }
    }
  }
  return result;
}
