/** Controlled still-map capture, adapted from the pinned Skill's route-capture-page.js.
 * MapLibre code is installed locally; every HTTP byte comes through the pinned-DNS
 * guard. There is no unrestricted browser network, model JS, or screenshot fabrication. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';
import { safeResourceRequest, SafeProviderError, type SafeResourceRequest, type SafeResourceResponse } from '../safe-http';
import { decodeRaster, throwIfAborted, type ResearchEvidence } from './tools';
import type { AssetEvidence, Place, ResearchPacks, SourceEvidence } from './types';

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const MAP_LIMITS = Object.freeze({ days: 14, stopsPerDay: 20, requestsPerDay: 180, requestsPerBuild: 1100,
  bytesPerResource: 2_000_000, bytesPerDay: 24_000_000, bytesPerBuild: 120_000_000,
  resourceTimeoutMs: 10_000, dayTimeoutMs: 50_000, screenshotBytes: 3_000_000 });
export interface MapCaptureInput {
  packs: Partial<ResearchPacks>; sources: SourceEvidence[]; signal?: AbortSignal;
  /** Trusted server configuration only. Never bind this to an API request field. */
  executablePath?: string;
}
export interface MapCaptureDependencies {
  resourceTransport?: (request: SafeResourceRequest) => Promise<SafeResourceResponse>;
  /** Test/server dependency injection; model and HTTP payloads cannot supply browser factories. */
  launch?: (options: LaunchOptions) => Promise<Browser>;
}
export interface MapFailure { day: string; code: string }
export interface MapCaptureResult { assets: AssetEvidence[]; failures: MapFailure[] }
interface MapStop { placeId: string; name: string; latitude: number; longitude: number; number: number; sourceId: string; sourceUrl: string }
export function allowedMapUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'tiles.openfreemap.org' &&
    !url.username && !url.password && (!url.port || url.port === '443') && !url.hash && value.length <= 2048; } catch { return false; }
}
function collectPlaces(packs: Partial<ResearchPacks>): Map<string, Place> {
  return new Map([...(packs['places-core']?.sights ?? []), ...(packs['places-core']?.support ?? []), ...(packs['places-shopping']?.shops ?? []),
    ...(packs['places-shopping']?.souvenirs ?? []), ...(packs['places-experiences'] ?? []), ...(packs['places-food'] ?? [])].map((place) => [place.id, place]));
}
/** Every scheduled pin must have a real source binding; one bad pin blocks that day's capture. */
export function sourceBoundMapStops(day: NonNullable<ResearchPacks['itinerary']>[number], packs: Partial<ResearchPacks>, sources: SourceEvidence[]): MapStop[] | null {
  const places = collectPlaces(packs); const sourceById = new Map(sources.map((source) => [source.id, source]));
  if (!day.stops.length || day.stops.length > MAP_LIMITS.stopsPerDay) return null;
  const result: MapStop[] = [];
  for (const [index, stop] of day.stops.entries()) {
    const place = places.get(stop.place_id); const coordinate = place?.coordinate_source; const source = coordinate && sourceById.get(coordinate.source_id);
    if (!place || typeof place.latitude !== 'number' || !Number.isFinite(place.latitude) || Math.abs(place.latitude) > 85 ||
      typeof place.longitude !== 'number' || !Number.isFinite(place.longitude) || Math.abs(place.longitude) > 180 ||
      !source || source.url !== coordinate!.url || !place.source_ids.includes(source.id)) return null;
    const evidence = source as Partial<ResearchEvidence>;
    const norm = (name: string) => name.toLowerCase().replace(/[\s\p{P}]/gu, '');
    const names = [place.local_name, place.display_name, place.english_name].filter((name): name is string => typeof name === 'string').map(norm);
    if (evidence.retrievalStatus !== 'page_retrieved' || !evidence.contentHash || !evidence.metadata?.entities.some((entity) =>
      names.includes(norm(entity.name)) && entity.latitude === place.latitude && entity.longitude === place.longitude)) return null;
    result.push({ placeId: place.id, name: place.display_name.slice(0, 80), latitude: place.latitude, longitude: place.longitude,
      number: index + 1, sourceId: source.id, sourceUrl: source.url });
  }
  return result;
}
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; connect-src https://tiles.openfreemap.org; img-src data: blob:; font-src data:"><style>
*{box-sizing:border-box}body{margin:0;background:#faf6ed;color:#183f3a;font-family:Arial,sans-serif}h1{height:56px;font-size:24px;margin:0;padding:14px 24px;overflow:hidden}#map{position:relative;width:1400px;height:940px}.label{position:absolute;padding:7px 10px;border-radius:6px;background:#fffdf7;border:1px solid #28594f;font-size:20px;line-height:1.2;max-width:300px;box-shadow:0 2px 5px #0003}.pin{position:absolute;width:12px;height:12px;margin:-6px;border-radius:50%;background:#b87346;border:2px solid white}footer{height:54px;padding:10px 24px;font-size:16px;line-height:1.4}</style></head><body><h1 id="heading"></h1><div id="map"></div><footer>© OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors<br>虚线仅连接行程站点，不代表实际道路导航；区域坐标可能近似</footer></body></html>`;
// This is reviewed, static application code. Never concatenate external source text into it.
const CAPTURE_SCRIPT = `(() => {
  const input=window.CAPTURE_INPUT,host=document.getElementById('map');
  window.CAPTURE_STATE={status:'loading'};
  document.getElementById('heading').textContent=input.title;
  const fail=()=>{window.CAPTURE_STATE={status:'failed'};};
  const timer=setTimeout(fail,45000);
  try {
    const map=new maplibregl.Map({container:host,style:'${MAP_STYLE_URL}',center:[input.stops[0].longitude,input.stops[0].latitude],zoom:14,interactive:false,attributionControl:false,preserveDrawingBuffer:true});
    map.on('error',()=>{clearTimeout(timer);fail();});
    map.on('load',()=>{
      if(window.CAPTURE_STATE.status==='failed')return;
      const points=input.stops.map(s=>[s.longitude,s.latitude]);
      const bounds=new maplibregl.LngLatBounds(points[0],points[0]);points.forEach(p=>bounds.extend(p));
      map.fitBounds(bounds,{padding:150,maxZoom:17,duration:0});
      if(points.length>1){map.addSource('route',{type:'geojson',data:{type:'Feature',properties:{},geometry:{type:'LineString',coordinates:points}}});map.addLayer({id:'route',type:'line',source:'route',paint:{'line-color':'#b87346','line-width':4,'line-dasharray':[2,2]}});}
      map.once('idle',async()=>{
        if(window.CAPTURE_STATE.status==='failed')return;
        try {
          await document.fonts.ready;
          if(!map.areTilesLoaded()||!map.isStyleLoaded())throw Error();
          const boxes=[],pixels=points.map(p=>map.project(p));
          const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','1400');svg.setAttribute('height','940');svg.style.cssText='position:absolute;inset:0;pointer-events:none';host.appendChild(svg);
          input.stops.forEach((stop,i)=>{
            const p=pixels[i],label=document.createElement('div');label.className='label';label.textContent=stop.number+' · '+stop.name;label.style.visibility='hidden';host.appendChild(label);
            const w=label.offsetWidth,h=label.offsetHeight,candidates=[];
            for(let y=12;y<host.clientHeight-h-12;y+=24)for(let x=12;x<host.clientWidth-w-12;x+=28){
              if(boxes.some(b=>!(x+w+10<b.x||b.x+b.w+10<x||y+h+10<b.y||b.y+b.h+10<y))||pixels.some(q=>q.x>x-12&&q.x<x+w+12&&q.y>y-12&&q.y<y+h+12))continue;
              const ex=Math.max(x,Math.min(p.x,x+w)),ey=Math.max(y,Math.min(p.y,y+h));candidates.push({x,y,w,h,ex,ey,d:Math.hypot(ex-p.x,ey-p.y)});
            }
            candidates.sort((a,b)=>a.d-b.d);if(!candidates.length)throw Error();const b=candidates[0];boxes.push(b);label.style.left=b.x+'px';label.style.top=b.y+'px';label.style.visibility='visible';
            const line=document.createElementNS(svg.namespaceURI,'line');[['x1',p.x],['y1',p.y],['x2',b.ex],['y2',b.ey],['stroke','#28594f'],['stroke-width','2']].forEach(v=>line.setAttribute(v[0],v[1]));svg.appendChild(line);
            const pin=document.createElement('div');pin.className='pin';pin.style.left=p.x+'px';pin.style.top=p.y+'px';host.appendChild(pin);
          });
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          clearTimeout(timer);window.CAPTURE_STATE={status:'ready',labels:boxes.length,tiles_loaded:true,zoom:map.getZoom()};
        }catch{clearTimeout(timer);fail();}
      });
    });
  }catch{clearTimeout(timer);fail();}
})()`;
function receipt(day: string, stops: MapStop[] | null): AssetEvidence {
  return { id: `route-map-${day}`, kind: 'route-map', day, sourceId: stops?.[0]?.sourceId ?? '', sourcePage: stops?.[0]?.sourceUrl ?? '',
    downloadUrl: MAP_STYLE_URL, file: `assets/map-${day}.webp`, status: 'pending', sourceIdentityBound: false, visuallyConfirmed: false,
    watermarkChecked: false, reason: 'Map capture has not completed. Online navigation links remain available; no offline screenshot coverage is claimed.' };
}

export async function captureRouteMaps(input: MapCaptureInput, deps: MapCaptureDependencies = {}): Promise<MapCaptureResult> {
  throwIfAborted(input.signal);
  const days = (input.packs.itinerary ?? []).slice(0, MAP_LIMITS.days);
  const result: MapCaptureResult = { assets: [], failures: [] };
  const tasks = days.map((day) => ({ day, stops: sourceBoundMapStops(day, input.packs, input.sources) }));
  for (const task of tasks) {
    const asset = receipt(task.day.date, task.stops); result.assets.push(asset);
    if (!task.stops) { asset.reason = 'Source-bound coordinates are missing for one or more stops; no map was drawn from guessed geography.'; result.failures.push({ day: task.day.date, code: 'MAP_COORDINATES_REQUIRED' }); }
  }
  if (!tasks.some((task) => task.stops)) return result;
  if (input.executablePath && (!isAbsolute(input.executablePath) || /[\x00-\x1f\x7f]/.test(input.executablePath))) {
    for (const asset of result.assets.filter((asset) => !result.failures.some((failure) => failure.day === asset.day))) { asset.reason = 'A valid absolute server-configured browser executable is required.'; result.failures.push({ day: asset.day!, code: 'MAP_BROWSER_CONFIGURATION' }); }
    return result;
  }
  let browser: Browser | undefined;
  let script: string; let style: string;
  try {
    // Package-resolved trusted local bundle only; never fetch script URLs from the map style.
    [script, style] = await Promise.all([readFile(require.resolve('maplibre-gl/dist/maplibre-gl.js'), 'utf8'), readFile(require.resolve('maplibre-gl/dist/maplibre-gl.css'), 'utf8')]);
    browser = await (deps.launch ?? ((options: LaunchOptions) => chromium.launch(options)))({ ...(input.executablePath ? { executablePath: input.executablePath } : {}),
      headless: true, chromiumSandbox: true, timeout: 15_000 });
  } catch {
    for (const asset of result.assets.filter((asset) => !result.failures.some((failure) => failure.day === asset.day))) { asset.reason = 'The sandboxed browser could not start. No map screenshot was produced; check server browser installation and sandbox support.'; result.failures.push({ day: asset.day!, code: 'MAP_BROWSER_UNAVAILABLE' }); }
    return result;
  }
  const stopBrowser = () => { void browser?.close().catch(() => undefined); };
  input.signal?.addEventListener('abort', stopBrowser, { once: true });
  const cache = new Map<string, SafeResourceResponse>(); let cacheBytes = 0; let totalRequests = 0; let totalBytes = 0;
  try {
    for (const [index, task] of tasks.entries()) {
      if (!task.stops) continue;
      throwIfAborted(input.signal);
      const asset = result.assets[index]; let requests = 0; let bytes = 0; let tiles = 0; let failed = false;
      const resources = new Map<string, { url: string; sha256: string; mime: string }>();
      let activeFetches = 0; const waiting: (() => void)[] = [];
      const acquireSlot = async () => { if (activeFetches < 4) { activeFetches++; return; } await new Promise<void>((resolve) => waiting.push(resolve)); };
      const releaseSlot = () => { const next = waiting.shift(); if (next) next(); else activeFetches--; };
      const context = await browser.newContext({ viewport: { width: 1400, height: 1050 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
      const controller = new AbortController(); const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { failed = true; controller.abort(); void context.close().catch(() => undefined); }, MAP_LIMITS.dayTimeoutMs);
      try {
        await context.route('**/*', async (route) => {
          const request = route.request(); const url = request.url();
          if (request.method() !== 'GET' || !allowedMapUrl(url) || ++requests > MAP_LIMITS.requestsPerDay || ++totalRequests > MAP_LIMITS.requestsPerBuild || failed) {
            failed = true; await route.abort().catch(() => undefined); return;
          }
          await acquireSlot();
          try {
            if (failed || controller.signal.aborted) throw new SafeProviderError('PROVIDER_ABORTED');
            let resource = cache.get(url);
            if (!resource) {
              resource = await (deps.resourceTransport ?? safeResourceRequest)({ url, kind: 'map', signal: controller.signal,
                maxBytes: MAP_LIMITS.bytesPerResource, timeoutMs: MAP_LIMITS.resourceTimeoutMs });
              if (resource.bytes.length > MAP_LIMITS.bytesPerResource || !['application/json','application/x-protobuf','application/protobuf','application/vnd.mapbox-vector-tile','application/octet-stream','image/png','image/jpeg','image/webp'].includes(resource.contentType)) throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
              totalBytes += resource.bytes.length;
              if (totalBytes > MAP_LIMITS.bytesPerBuild) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
              while (cacheBytes + resource.bytes.length > 12_000_000 && cache.size) { const oldest = cache.keys().next().value!; cacheBytes -= cache.get(oldest)!.bytes.length; cache.delete(oldest); }
              cache.set(url, resource); cacheBytes += resource.bytes.length;
            }
            resources.set(url, { url, sha256: createHash('sha256').update(resource.bytes).digest('hex'), mime: resource.contentType });
            bytes += resource.bytes.length;
            if (bytes > MAP_LIMITS.bytesPerDay) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
            if (/\/(?:\d+\/){2}\d+(?:\.(?:pbf|mvt))?(?:\?|$)/.test(new URL(url).pathname)) tiles++;
            await route.fulfill({ status: 200, contentType: resource.contentType, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: resource.bytes });
          } catch { failed = true; controller.abort(); await route.abort().catch(() => undefined); }
          finally { releaseSlot(); }
        });
        const page = await context.newPage(); page.setDefaultTimeout(MAP_LIMITS.dayTimeoutMs);
        await page.setContent(HTML); await page.addStyleTag({ content: style }); await page.addScriptTag({ content: script });
        await page.evaluate(`window.CAPTURE_INPUT=${JSON.stringify({ title: `${task.day.date} · ${task.day.theme}`, stops: task.stops }).replace(/</g, '\\u003c')}`);
        await page.evaluate(CAPTURE_SCRIPT);
        await page.waitForFunction('window.CAPTURE_STATE && window.CAPTURE_STATE.status !== "loading"', null, { timeout: 47_000 });
        const state = await page.evaluate('window.CAPTURE_STATE') as { status: string; labels?: number; tiles_loaded?: boolean };
        if (failed || state.status !== 'ready' || !state.tiles_loaded || state.labels !== task.stops.length || tiles < 1) throw new SafeProviderError('PROVIDER_INVALID_RESPONSE');
        const screenshot = await page.screenshot({ type: 'png', fullPage: false, timeout: 10_000 });
        if (screenshot.length > MAP_LIMITS.screenshotBytes) throw new SafeProviderError('PROVIDER_RESPONSE_TOO_LARGE');
        const decoded = await decodeRaster(screenshot, 'image/png', input.signal);
        Object.assign(asset, { status: 'downloaded_unreviewed', sha256: createHash('sha256').update(decoded.data).digest('hex'),
          mime: decoded.mime, bytes: decoded.data.length, width: decoded.width, height: decoded.height, dataBase64: decoded.data.toString('base64'),
          capture: { styleUrl: MAP_STYLE_URL, routeHash: createHash('sha256').update(JSON.stringify({ date: task.day.date, stops: task.stops })).digest('hex'),
            sourceIds: [...new Set(task.stops.map((stop) => stop.sourceId))], resources: [...resources.values()], capturedAt: new Date().toISOString(),
            viewport: { width: 1400, height: 1050 }, ...(typeof browser.version === 'function' ? { browserVersion: browser.version() } : {}) },
          reason: 'Real MapLibre/OpenFreeMap basemap captured with source-bound stop coordinates. Dashed lines connect stops, not road routing. Visual review is still required.' });
      } catch {
        throwIfAborted(input.signal);
        asset.status = 'failed'; asset.reason = 'The real basemap did not load or capture within its safety budget. No substitute screenshot was created; use online navigation links.';
        result.failures.push({ day: task.day.date, code: 'MAP_CAPTURE_FAILED' });
      } finally { clearTimeout(timer); controller.abort(); input.signal?.removeEventListener('abort', abort); await context.close().catch(() => undefined); }
    }
  } finally { input.signal?.removeEventListener('abort', stopBrowser); await browser.close().catch(() => undefined); }
  return result;
}
