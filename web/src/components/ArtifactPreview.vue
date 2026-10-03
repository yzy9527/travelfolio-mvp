<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ReviewChecks, Version } from '../lib/types'
import { ApiError, fetchArtifact, matchesArtifactHash } from '../lib/api'
import { dateTime, requiresManualReview } from '../lib/utils'
import Icon from './Icon.vue'
const props = defineProps<{ tripId: string; version: Version; busy: boolean }>()
const emit = defineEmits<{ review: [review: { versionId: string; artifactHash: string; checks: ReviewChecks; note: string }]; error: [error: unknown] }>()
const html = ref('')
const loading = ref(false)
const failure = ref('')
const viewport = ref<'desktop' | 'mobile'>('desktop')
const checks = reactive<ReviewChecks>({ desktop: false, mobile: false, content: false, maps: false })
const note = ref('')
const loadedHash = ref('')
let mounted = false
let epoch = 0
let controller: AbortController | undefined
const needsReview = computed(() => requiresManualReview(props.version))
const canReview = computed(() => props.version.status === 'candidate' && needsReview.value && !props.busy && !loading.value && html.value && loadedHash.value === props.version.artifactHash && Object.values(checks).every(Boolean) && note.value.trim().length >= 10)
const labels: Record<keyof ReviewChecks, string> = { desktop: '已在桌面预览检查八个章节、导航和 Trip Mode 交互', mobile: '已在移动预览检查排版、折叠内容与每日路线', content: '已审阅内容、来源和缺失项，没有把未核验资料当作已核实事实', maps: '已逐日检查地图和路线；缺失底图、坐标与距离限制已如实说明' }
async function load() {
  const current = ++epoch
  controller?.abort(); controller = new AbortController()
  html.value = ''; loadedHash.value = ''; failure.value = ''; note.value = ''; Object.assign(checks, { desktop: false, mobile: false, content: false, maps: false }); loading.value = true
  const tripId = props.tripId; const versionId = props.version.id; const hash = props.version.artifactHash
  try {
    if (!hash) throw new Error('本版缺少手册文件校验值，无法开启预览或人工审阅')
    const result = await fetchArtifact(tripId, versionId, controller.signal)
    if (current !== epoch) return
    if (!await matchesArtifactHash(result, hash)) throw new Error('手册文件与版本校验值不一致，请刷新版本后重试')
    if (current !== epoch) return
    html.value = result; loadedHash.value = hash
  } catch (error) { if (current === epoch) { failure.value = error instanceof Error ? error.message : '无法读取手册文件'; if (error instanceof ApiError && error.status === 401) emit('error', error) } }
  finally { if (current === epoch) loading.value = false }
}
function review() { if (canReview.value) emit('review', { versionId: props.version.id, artifactHash: loadedHash.value, checks: { ...checks }, note: note.value.trim() }) }
watch(() => `${props.tripId}:${props.version.id}:${props.version.artifactHash}`, () => { if (mounted) void load() })
onMounted(() => { mounted = true; void load() })
onBeforeUnmount(() => { epoch++; controller?.abort() })
</script>
<template>
  <section class="card artifact-panel" aria-label="完整手册预览与人工审阅">
    <div class="section-heading"><div><span class="eyebrow">THE COMPLETE HANDBOOK</span><h3>八章手册 · 安全预览</h3></div><span class="badge" :class="needsReview ? 'amber' : 'green'">{{ needsReview ? '人工审阅未完成' : '本文件已人工审阅' }}</span></div>
    <p class="muted small">01 每日行程 · 02 景点 · 03 购物 · 04 体验 · 05 美食 · 06 行前准备 · 07 语言 · 08 在地须知</p>
    <p class="muted small">预览只执行手册内固定交互，不能访问账号、应用页面或网络。外部来源可在上方研究证据中打开。自动检查不能替代你对内容、地图和真实浏览器显示的检查。</p>
    <div class="preview-controls" aria-label="预览尺寸"><button class="button secondary compact" :class="{ selected: viewport === 'desktop' }" :aria-pressed="viewport === 'desktop'" @click="viewport = 'desktop'">桌面预览 · 1180px</button><button class="button secondary compact" :class="{ selected: viewport === 'mobile' }" :aria-pressed="viewport === 'mobile'" @click="viewport = 'mobile'">移动预览 · 390px</button><button class="text-button" :disabled="loading || busy" @click="load">重新加载预览</button></div>
    <div v-if="loading" class="loading-card" role="status"><div class="spinner"></div><p>正在读取并校验本版手册文件…</p></div>
    <div v-else-if="failure" class="notice notice-error" role="alert"><Icon name="info"/><p>{{ failure }}。人工审阅和采用保持锁定。</p></div>
    <div v-else-if="html" class="artifact-scroll"><iframe :key="loadedHash" class="artifact-frame" :class="viewport" :srcdoc="html" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="`第 ${version.number} 版完整旅行手册预览`" :width="viewport === 'desktop' ? 1180 : 390" height="760"></iframe></div>
    <p class="artifact-fingerprint">手册 SHA-256 {{ version.artifactHash || '缺失' }}</p>
    <form v-if="version.status === 'candidate' && needsReview" class="manual-review" @submit.prevent="review">
      <h4>亲自检查后，再保存审阅结果</h4><p class="muted small">勾选表示你实际完成了检查。保存仅记录本文件的人工审阅，之后仍需单独点击“采用这一版”。文件变更后必须重新审阅。</p>
      <label v-for="(label, key) in labels" :key="key" class="review-check"><input v-model="checks[key]" type="checkbox" :disabled="busy || !html"/><span>{{ label }}</span></label>
      <label>审阅记录（至少 10 字）<textarea v-model="note" rows="3" maxlength="2000" minlength="10" :disabled="busy || !html" required placeholder="记录实际检查的交互、内容与地图缺失项；不要把未验证项目写为通过"/></label>
      <button class="button primary" :disabled="!canReview" type="submit"><Icon name="check" :size="16"/>保存人工审阅记录</button>
    </form>
    <div v-else-if="version.review" class="saved-review"><strong>人工审阅记录 · {{ dateTime(version.review.reviewedAt) }}</strong><p>{{ version.review.note }}</p><p v-if="version.review.acceptance === 'preview_only'" class="muted small">此记录仅确认已审阅预览。尚未完成的研究、图片、地图与自动浏览器验收仍然保留原状态。</p><p class="muted small">审阅结果仅绑定此文件。采用版本是独立操作；当前采用版本不会因审阅而改变。</p></div>
  </section>
</template>
