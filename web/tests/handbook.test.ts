import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ViteDevServer } from 'vite'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import type { Constraints, Version } from '../src/lib/types'
let server: ViteDevServer
let Handbook: Component
const constraints: Constraints = {destination:'京都',departure:'上海',startDate:'2026-10-10',endDate:'2026-10-10',people:2,budget:1000,currency:'CNY',preferences:'慢节奏',exclusions:''}
function fixture(mode: 'demo'|'live_search'|'not_live_verified' = 'demo'): Version {
 return {id:'version-1',number:1,status:'candidate',baseVersionId:null,createdAt:'2026-09-30T08:00:00Z',request:'',content:{title:'京都漫游',summary:'慢一点，看见更多',days:[{date:'2026-10-10',title:'城市漫步',summary:'沿河出发',activities:[{time:'10:00',title:'咖啡馆',description:'享受一杯咖啡',location:'鸭川',transport:'步行',estimatedCost:50,bookingNote:'请提前核实营业时间',sourceIds:['s1','s2']}]}],budget:[{category:'餐饮',amount:1200,note:'整团估算'}],packing:['雨伞'],notes:['留足交通时间'],sources:[{id:'s1',title:'参考资料',url:'https://example.com/source',retrievedAt:'2026-09-30T08:00:00Z'},{id:'s2',title:'无效来源',url:'javascript:alert(1)',retrievedAt:'2026-09-30T08:00:00Z'}],verification:{mode,notice:'请自行确认重要信息',researchedAt:null}}}
}
before(async()=>{server=await createServer({server:{middlewareMode:true,hmr:false,watch:null},logLevel:'silent'}); Handbook=(await server.ssrLoadModule('/src/components/Handbook.vue')).default})
after(async()=>{await server?.close()})
async function render(version=fixture()){return renderToString(createSSRApp(Handbook,{version,constraints}))}
describe('actual handbook component rendering',()=>{
 it('renders route, budget, packing and source evidence',async()=>{const html=await render();for(const text of ['京都漫游','城市漫步','咖啡馆','雨伞','留足交通时间','参考资料','https://example.com/source'])assert.ok(html.includes(text));assert.ok(html.includes('google.com/maps/search/'));assert.ok(html.includes('target="_blank"'));assert.ok(html.includes('rel="noopener noreferrer"'))})
 it('escapes model output and drops unsafe source URLs',async()=>{const data=fixture();data.content.title='<img src=x onerror=alert(1)>';data.content.days[0].activities[0].description='<script>alert(1)</script>';const html=await render(data);assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('无效来源（链接不可用）'))})
 it('clearly labels demo as fictional and unsuitable for travel',async()=>{const html=await render();assert.ok(html.includes('演示手册 · 虚构内容，不可用于实际出行'));assert.ok(html.includes('当前估算高于预算'))})
 it('labels live search as evidence rather than verified inventory',async()=>{const html=await render(fixture('live_search'));assert.ok(html.includes('已参考搜索资料 · 重要信息仍需核实'));assert.ok(html.includes('营业时间、价格、天气、交通及票务库存请以官方信息为准'))})
 it('labels model-only results as unverified',async()=>{const html=await render(fixture('not_live_verified'));assert.ok(html.includes('AI 规划草案 · 未经实时核验'))})
})
