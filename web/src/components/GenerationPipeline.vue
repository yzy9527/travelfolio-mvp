<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Job, Version } from '../lib/types'
import { dateTime, jobHeading, pipelineStages, requiresChargeAcknowledgment, requiresManualReview, stageNames } from '../lib/utils'
import Icon from './Icon.vue'
const props = defineProps<{ job: Job; busy: boolean; provider?: string; searchAvailable?: boolean; version?: Version }>()
const emit = defineEmits<{ cancel: []; approve: [approval: { jobId: string; outlineHash: string; outlineVersion: number }]; resume: [acknowledgePossibleCharge: boolean] }>()
const approved = ref(false)
const chargeAcknowledged = ref(false)
watch(() => `${props.job.id}:${props.job.status}:${props.job.outlineHash}:${props.job.outlineVersion}`, () => { approved.value = false; chargeAcknowledged.value = false })
const waiting = computed(() => props.job.status === 'awaiting_outline')
const interrupted = computed(() => ['failed', 'cancelled'].includes(props.job.status))
const chargeRisk = computed(() => requiresChargeAcknowledgment(props.job))
const canApprove = computed(() => waiting.value && props.job.outline && props.job.outlineHash && Number.isInteger(props.job.outlineVersion) && approved.value && !props.busy && (props.job.mode === 'demo' || props.searchAvailable === true))
const completedPacks = computed(() => props.job.checkpoints?.filter(checkpoint => checkpoint.stage.startsWith('research:') && checkpoint.status === 'complete') || [])
const reviewed = computed(() => props.job.status === 'succeeded' && props.version?.id === props.job.versionId && props.version.schemaVersion === 2 && !requiresManualReview(props.version))
const heading = computed(() => reviewed.value ? props.version?.status === 'adopted' ? '手册已审阅并采用，可下载 HTML' : '手册已审阅，等待采用' : jobHeading(props.job))
const completed = (stage: string) => stage === 'candidate' ? reviewed.value : props.job.checkpoints?.some(checkpoint => checkpoint.stage === stage && checkpoint.status === 'complete') === true
function approve() {
  if (!canApprove.value) return
  emit('approve', { jobId: props.job.id, outlineHash: props.job.outlineHash!, outlineVersion: props.job.outlineVersion! })
}
function resume() { if (props.job.status === 'failed' && !props.busy && (!chargeRisk.value || chargeAcknowledged.value)) emit('resume', chargeRisk.value && chargeAcknowledged.value) }
</script>
<template>
  <section class="card pipeline-panel" aria-label="手册制作进度">
    <div class="section-heading"><div><span class="eyebrow">OUTLINE → HANDBOOK → REVIEW</span><h3 role="status">{{ heading }}</h3></div><span class="badge" :class="job.mode === 'demo' ? 'amber' : 'neutral'">{{ job.mode === 'demo' ? '演示 · 无外部调用' : '真实生成' }}</span></div>
    <ol class="pipeline-stages" aria-label="已保存的执行阶段"><li v-for="(stage, index) in pipelineStages" :key="stage" :class="{ complete: completed(stage), current: job.stage === stage }" :aria-current="job.stage === stage ? 'step' : undefined"><span><Icon v-if="completed(stage)" name="check" :size="13"/><template v-else>{{ String(index + 1).padStart(2, '0') }}</template></span><strong>{{ stageNames[stage] }}</strong><small>{{ completed(stage) ? stage === 'candidate' ? '已审阅' : '已保存' : job.stage === stage ? waiting ? '等你确认' : interrupted ? '已停止' : job.status === 'queued' ? '等待执行' : job.status === 'succeeded' ? '待人工检查' : '处理中' : '尚未完成' }}</small></li></ol>
    <p v-if="completedPacks.length" class="muted small">已保存 {{ completedPacks.length }} 个研究资料包：{{ completedPacks.map(checkpoint => checkpoint.stage.replace('research:', '')).join('、') }}</p>
    <p class="muted small">这里只展示服务器已保存的实际状态，不估算完成百分比。关闭或刷新页面后可继续查看，当前已采用手册不会被任务替换。</p>
    <div v-if="waiting && job.outline" class="outline-review">
      <header><span class="eyebrow">REVIEW THE OUTLINE FIRST</span><h3>{{ job.outline.title }}</h3><p>{{ job.outline.summary }}</p></header>
      <div class="outline-days"><article v-for="(day, index) in job.outline.days" :key="day.date"><span class="outline-day-number">DAY {{ String(index + 1).padStart(2, '0') }}</span><div><small>{{ day.date }} · {{ day.pace }}</small><h4>{{ day.title }}</h4><p>{{ day.focus }}</p><p class="muted small">{{ day.areas.join(' → ') }}</p></div></article></div>
      <div class="outline-notes"><section v-if="job.outline.assumptions.length"><h4>本次规划的假设</h4><ul><li v-for="item in job.outline.assumptions" :key="item">{{ item }}</li></ul></section><section v-if="job.outline.openQuestions.length"><h4>尚待确认的信息</h4><ul><li v-for="item in job.outline.openQuestions" :key="item">{{ item }}</li></ul></section></div>
      <p v-if="job.outline.changedPacks.length" class="muted small">本次涉及的研究资料包：{{ job.outline.changedPacks.join('、') }}</p>
      <p class="artifact-fingerprint">大纲版本 {{ job.outlineVersion }} · SHA-256 {{ job.outlineHash }}</p>
      <div class="notice notice-blue"><Icon name="info"/><p>研究、素材、地图与完整手册尚未开始。{{ job.mode === 'live' ? `确认后将继续使用你配置的 ${provider || '模型'} 服务商及已配置的研究服务，可能产生新的 API 费用。` : '确认后才会编译演示手册；演示内容不是已核验的旅行建议。' }}如需改变路线，可先取消任务，再填写新的要求生成大纲。</p></div>
      <div v-if="job.mode === 'live' && !searchAvailable" class="notice notice-amber"><Icon name="info"/><p>尚未配置必需的 Brave Search 研究服务。请先由部署管理员配置，然后刷新本页，再确认完整手册生成。</p></div>
      <label class="review-check"><input v-model="approved" type="checkbox" :disabled="busy"/><span>我已检查这份大纲，同意按版本 {{ job.outlineVersion }} 继续制作完整手册{{ job.mode === 'live' ? '并接受后续 API 调用可能产生的费用' : '' }}</span></label>
      <div class="pipeline-actions"><button class="button secondary compact" :disabled="busy" @click="emit('cancel')">取消任务</button><button class="button primary" :disabled="!canApprove" @click="approve"><Icon name="check" :size="16"/>确认此大纲，生成完整手册</button></div>
    </div>
    <div v-else-if="job.status === 'failed'" class="pipeline-recovery">
      <p v-if="job.errorMessage" class="inline-error">{{ job.errorMessage }}</p><p v-if="job.errorCode" class="muted small">错误编号：{{ job.errorCode }}</p>
      <p>已完成阶段保留在服务器。恢复会从可用检查点继续；未保存的请求不会自动重试。</p>
      <div v-if="chargeRisk" class="notice notice-amber"><Icon name="info"/><div><strong>上次外部调用的结果可能不确定</strong><p>该请求可能已计费。重新执行缺失阶段可能再次计费；仅在你确认后恢复。</p><label class="review-check"><input v-model="chargeAcknowledged" type="checkbox" :disabled="busy"/><span>我了解上次调用可能已计费，并同意恢复时可能再次产生费用</span></label></div></div>
      <p v-else class="muted small">{{ job.mode === 'demo' ? '演示恢复不调用外部服务。' : '服务器未标记不确定的重复计费风险。尚未执行的外部步骤仍按服务商正常计费。' }}</p>
      <button class="button secondary" :disabled="busy || (chargeRisk && !chargeAcknowledged)" @click="resume">从检查点恢复任务</button>
    </div>
    <p v-else-if="job.status === 'cancelled'" class="muted small">此任务不会再继续。当前已采用手册不变；如需继续规划，请在下方填写新的要求并生成大纲。</p>
    <div v-else-if="job.status === 'queued' || job.status === 'running'" class="pipeline-actions"><span class="muted small">{{ job.mode === 'live' ? '取消无法撤回已经发出的外部请求，可能仍产生费用。' : '任务会保留已完成的检查点。' }}</span><button class="button secondary compact" :disabled="busy" @click="emit('cancel')">取消任务</button></div>
    <p class="pipeline-updated">服务器最后更新 {{ dateTime(job.updatedAt) }}</p>
  </section>
</template>
