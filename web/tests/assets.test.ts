import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifiedAssetDataUrl } from '../src/lib/assets'
const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const bytes=Buffer.from(base64,'base64')
const asset=()=>({id:'image-1',kind:'place-image',sourcePage:'https://example.org/place',sha256:createHash('sha256').update(bytes).digest('hex'),mime:'image/png',dataBase64:base64,bytes:bytes.length,width:1,height:1})
describe('contact-sheet embedded raster validation',()=>{
  it('creates a data URL only for exact hash-matching raster bytes',async()=>assert.equal(await verifiedAssetDataUrl(asset()),`data:image/png;base64,${base64}`))
  for(const [name,patch] of Object.entries({hash:{sha256:'f'.repeat(64)},mime:{mime:'image/jpeg'},bytes:{bytes:123},source:{sourcePage:'javascript:alert(1)'},credentials:{sourcePage:'https://user:secret@example.org/photo'},svg:{mime:'image/svg+xml'},raw:{dataBase64:'https://example.org/image.png'},canonical:{dataBase64:base64+' '},dimensions:{width:100000},kind:{kind:'model-photo'}}))it(`rejects unsafe or mismatched ${name}`,async()=>assert.equal(await verifiedAssetDataUrl({...asset(),...patch}),null))
  it('does not let model HTML masquerade as an image even with a matching hash',async()=>{
    const data=Buffer.from('<svg><script>alert(1)</script></svg>')
    assert.equal(await verifiedAssetDataUrl({...asset(),mime:'image/png',dataBase64:data.toString('base64'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}),null)
  })
})
