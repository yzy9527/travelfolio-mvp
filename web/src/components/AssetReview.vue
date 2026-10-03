<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Version } from '../lib/types'
import type { AssetReviewRequest, ReviewableAsset } from '../lib/assets'
import { verifiedAssetDataUrl } from '../lib/assets'
import { safeUrl } from '../lib/utils'
import Icon from './Icon.vue'
const props = defineProps<{ version: Version; busy: boolean; activeJob: boolean }>()
const emit = defineEmits<{ review: [request: AssetReviewRequest] }>()
type Row = { asset: ReviewableAsset; src: string; decoded: boolean; include: boolean; identity: boolean; visual: boolean; watermark: boolean; note: string; failure: string }
const rows = ref<Row[]>([])
const coverAssetId = ref('')
const validating = ref(false)
let epoch = 0
let mounted = false
const selected = computed(() => rows.value.filter(row => row.include))
const ready = (row: Row) => row.decoded && !!row.src && row.identity && row.visual && row.watermark && row.note.trim().length >= 10
const covers = computed(() => selected.value.filter(row => row.asset.kind === 'place-image' && ready(row)))
const canSubmit = computed(() => !props.busy && !props.activeJob && !validating.value && !!props.version.artifactHash && selected.value.length > 0 && selected.value.length <= 80 && selected.value.every(ready) && (!coverAssetId.value || covers.value.some(row => row.asset.id === coverAssetId.value)))
function label(asset: ReviewableAsset) {
  if (asset.kind === 'route-map') return `${asset.day || '每日'}路线地图`
  const places = props.version.guide?.profile.places
  const place = Array.isArray(places) ? places.find(item => item && typeof item === 'object' && item.id === asset.placeId) : undefined
  return place?.display_name || asset.placeId || (asset.kind === 'cover' ? '封面图片' : asset.id)
}
async function load() {
  const current = ++epoch; rows.value = []; coverAssetId.value = ''; validating.value = true
  const assets = props.version.guide?.assets || []
  for (const data of assets) {
    if (current !== epoch) return
    const src = await verifiedAssetDataUrl(data)
    if (current !== epoch) return
    rows.value.push({ asset: data as ReviewableAsset, src: src || '', decoded: false, include: false, identity: false, visual: false, watermark: false, note: '', failure: src ? '' : '缺少可安全显示的原始图片，或文件校验未通过。此素材不能提交视觉确认。' })
  }
  if (current === epoch) validating.value = false
}
function decoded(row: Row, event: Event) {
  const image = event.target as HTMLImageElement
  row.decoded = image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth === row.asset.width && image.naturalHeight === row.asset.height
  if (!row.decoded) row.failure = '图片解码或实际尺寸与素材记录不符，不能确认视觉检查'
}
function failed(row: Row) { row.decoded = false; row.include = false; row.failure = '图片解码或实际尺寸与素材记录不符，不能确认视觉检查' }
function submit() {
  if (!canSubmit.value) return
  emit('review', { versionId: props.version.id, artifactHash: props.version.artifactHash!, ...(coverAssetId.value ? { coverAssetId: coverAssetId.value } : {}), reviews: selected.value.map(row => ({ assetId: row.asset.id, sha256: row.asset.sha256, sourcePage: row.asset.sourcePage, identity: true, visual: true, watermark: true, note: row.note.trim() })) })
}
watch(() => `${props.version.id}:${props.version.artifactHash}`, () => { if (mounted) void load() })
watch(covers, () => { if (coverAssetId.value && !covers.value.some(row => row.asset.id === coverAssetId.value)) coverAssetId.value = '' })
onMounted(() => { mounted = true; void load() })
onBeforeUnmount(() => { epoch++ })
</script>
<template>
  <section v-if="version.status === 'candidate' && version.schemaVersion === 2" class="card asset-review-panel" aria-label="图片与地图逐项视觉检查">
    <div class="section-heading"><div><span class="eyebrow">LOOK AT THE ACTUAL ASSET</span><h3>图片与地图，逐项看过再确认</h3></div><span class="badge neutral">不会自动勾选</span></div>
    <p class="muted small">这里只显示经文件校验的内嵌图片。请打开来源，核对准确地点或路线、画面内容与水印；不确定的项目保持未选中。图片缺失或下载成功，都不等于视觉检查通过。</p>
    <p v-if="validating" class="muted small" role="status">正在验证素材文件与 SHA-256…</p>
    <p v-if="!validating && !rows.length" class="notice notice-amber">本版没有可供视觉检查的图片或地图，相关状态将保持待完成。</p>
    <form v-else @submit.prevent="submit">
      <div class="asset-contact-sheet"><article v-for="row in rows" :key="row.asset.id" class="asset-review-card">
        <h4>{{ label(row.asset) }}</h4><p class="muted tiny">{{ row.asset.kind }} · 保存状态 {{ row.asset.status || '未提供' }}</p>
        <img v-if="row.src" class="asset-review-thumbnail" :src="row.src" :alt="`${label(row.asset)}：待亲自检查的原始素材`" @load="decoded(row, $event)" @error="failed(row)"/>
        <p v-if="row.failure" class="inline-error">{{ row.failure }}</p>
        <details v-if="row.src" class="evidence-fold"><summary>放大查看完整图片</summary><div class="asset-full-image"><img :src="row.src" :alt="`${label(row.asset)}：完整原始素材`"/></div></details>
        <p v-if="safeUrl(row.asset.sourcePage || '')"><a :href="safeUrl(row.asset.sourcePage)!" target="_blank" rel="noopener noreferrer">打开并核对素材来源 ↗</a></p><p v-else class="muted small">缺少有效来源链接</p>
        <p class="artifact-fingerprint">{{ row.asset.id }} · SHA-256 {{ row.asset.sha256 || '缺失' }}</p>
        <label class="review-check"><input v-model="row.include" type="checkbox" :disabled="busy || activeJob || !row.decoded"/><span>将这张素材纳入本次检查记录</span></label>
        <fieldset :disabled="busy || activeJob || !row.include || !row.decoded"><legend>以下三项都需要你实际观察</legend>
          <label class="review-check"><input v-model="row.identity" type="checkbox"/><span>已核对来源与准确地点/分店或当天路线相符</span></label>
          <label class="review-check"><input v-model="row.visual" type="checkbox"/><span>已看清完整画面，图片主体或地图站点符合说明</span></label>
          <label class="review-check"><input v-model="row.watermark" type="checkbox"/><span>已检查水印、广告、遮挡与来源标注，未发现误导</span></label>
          <label>实际观察记录（至少 10 字）<textarea v-model="row.note" rows="3" minlength="10" maxlength="1000" :required="row.include" placeholder="记录地点/路线、画面主体和水印检查结论；无法确认的素材请不要勾选"/></label>
        </fieldset>
      </article></div>
      <label v-if="covers.length" class="asset-cover-choice">可选：用已检查的场所图片作为封面<select v-model="coverAssetId" :disabled="busy || activeJob"><option value="">保留现有封面选择</option><option v-for="row in covers" :key="row.asset.id" :value="row.asset.id">{{ label(row.asset) }} · {{ row.asset.id }}</option></select></label>
      <div v-if="rows.length" class="notice notice-blue"><Icon name="info"/><p>保存会保留旧文件，并用已有研究资料重新编译一个新的候选版本；不发起新的付费模型调用。新文件仍需独立预览、人工审阅和采用，未选择的素材保持原状态。</p></div>
      <p v-if="activeJob" class="muted small">请等待当前任务完成，再提交素材检查。</p>
      <button v-if="rows.length" class="button primary" :disabled="!canSubmit" type="submit">保存所选素材检查，重新编译候选（{{ selected.length }}）</button>
    </form>
  </section>
</template>
