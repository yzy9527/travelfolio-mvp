import { safeUrl } from './utils'
export type ReviewableAsset = { id: string; kind: 'place-image' | 'route-map' | 'cover'; placeId?: string; day?: string; sourcePage: string; sha256: string; mime: string; dataBase64: string; bytes: number; status: string; width?: number; height?: number; reason?: string }
export type AssetObservation = { assetId: string; sha256: string; sourcePage: string; identity: true; visual: true; watermark: true; note: string }
export type AssetReviewRequest = { versionId: string; artifactHash: string; coverAssetId?: string; reviews: AssetObservation[] }
// Accept only immutable raster bytes, a matching MIME signature and exact SHA-256.
// Remote URLs, HTML and SVG can never become an <img> source in the review surface.
export async function verifiedAssetDataUrl(value: Record<string, unknown>): Promise<string | null> {
  if (typeof value.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.dataBase64) || value.dataBase64.length > 12_000_000 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) return null
  if (typeof value.id !== 'string' || !value.id || typeof value.sourcePage !== 'string' || !safeUrl(value.sourcePage)) return null
  if (!['place-image','route-map','cover'].includes(String(value.kind)) || typeof value.width !== 'number' || typeof value.height !== 'number' || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width <= 0 || value.height <= 0 || value.width > 10000 || value.height > 10000 || value.width * value.height > 40_000_000) return null
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(String(value.mime))) return null
  try {
    const decoded = atob(value.dataBase64)
    if (btoa(decoded) !== value.dataBase64 || decoded.length !== value.bytes) return null
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
    const signature = value.mime === 'image/png' ? bytes.length > 24 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v)
      : value.mime === 'image/jpeg' ? bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : value.mime === 'image/webp' ? bytes.length > 16 && decoded.slice(0,4) === 'RIFF' && decoded.slice(8,12) === 'WEBP'
      : bytes.length > 10 && /^GIF8[79]a$/.test(decoded.slice(0,6))
    if (!signature) return null
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('')
    return actual === value.sha256 ? `data:${value.mime};base64,${value.dataBase64}` : null
  } catch { return null }
}
