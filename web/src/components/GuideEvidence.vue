<script setup lang="ts">
import { computed } from 'vue'
import type { CompiledGuide } from '../lib/types'
import { safeUrl } from '../lib/utils'
const props = defineProps<{ guide: CompiledGuide }>()
const sources = computed(() => Array.isArray(props.guide.sources) ? props.guide.sources : [])
const assets = computed(() => Array.isArray(props.guide.assets) ? props.guide.assets : [])
const qa = computed(() => props.guide.qa || {})
const qaLabels: Record<string, string> = { content: '内容结构', research: '研究证据', media: '图片素材', maps: '路线地图', browser: '浏览器检查', offline: '离线可用性', status: '自动检查状态' }
const provenanceLabels: Record<string, string> = { upstreamCommit: '上游 Skill 提交', mode: '执行模式', outlineHash: '大纲校验值', profileHash: '目的地资料校验值', compilerVersion: '编译器版本', generatedAt: '编译时间', schemaVersion: '资料格式版本' }
function display(value: unknown): string { if (value == null) return '未提供'; if (typeof value === 'string') return value; return JSON.stringify(value) }
function title(item: Record<string, unknown>) { return String(item.title || item.name || item.id || item.placeId || item.place_id || '未命名记录') }
function url(item: Record<string, unknown>) { return safeUrl(String(item.url || item.sourceUrl || item.source_url || '')) }
const issues = computed(() => Array.isArray(qa.value.issues) ? qa.value.issues : qa.value.issues ? [qa.value.issues] : [])
</script>
<template>
  <section class="card evidence-panel" aria-label="研究证据、来源与质量状态">
    <div class="section-heading"><div><span class="eyebrow">EVIDENCE & LIMITS</span><h3>研究证据与尚未验证的部分</h3></div><span class="badge neutral">资料不等于事实核验</span></div>
    <p class="muted small">搜索摘要、模型输出、来源链接与机器校验各有边界。以下为本版保存的状态；缺失图片、底图或人工检查不会被默认为完成。</p>
    <dl class="quality-grid"><div v-for="(label, key) in qaLabels" :key="key"><dt>{{ label }}</dt><dd>{{ display(qa[key]) }}</dd></div></dl>
    <details v-if="issues.length" class="evidence-fold"><summary>待处理问题与限制 · {{ issues.length }} 项</summary><ul class="quality-issues"><li v-for="(issue, index) in issues" :key="index">{{ display(issue) }}</li></ul></details>
    <details class="evidence-fold"><summary>研究来源 · {{ sources.length }} 条</summary><p v-if="!sources.length" class="muted small">本版没有提供可追溯的研究证据。请在实际出行前查证官方信息。</p><div v-for="(item, index) in sources" :key="index" class="evidence-entry"><strong><a v-if="url(item)" :href="url(item)!" target="_blank" rel="noopener noreferrer">{{ title(item) }} ↗</a><span v-else>{{ title(item) }} · 无可用链接</span></strong><dl><template v-for="(value, key) in item" :key="key"><div v-if="!['title', 'name', 'url'].includes(String(key))"><dt>{{ key }}</dt><dd>{{ display(value) }}</dd></div></template></dl></div></details>
    <details class="evidence-fold"><summary>素材与坐标证据 · {{ assets.length }} 条</summary><p v-if="!assets.length" class="muted small">没有提供经过校验的素材。手册应保留清晰的缺失占位，不以装饰图片冒充地点实景。</p><div v-for="(item, index) in assets" :key="index" class="evidence-entry"><strong>{{ title(item) }}</strong><dl><template v-for="(value, key) in item" :key="key"><div v-if="!['data', 'dataUri', 'dataUrl', 'dataBase64', 'bytes', 'base64'].includes(String(key))"><dt>{{ key }}</dt><dd>{{ String(key).toLowerCase().includes('url') && typeof value === 'string' && value.startsWith('data:') ? '内嵌图片数据（不在此展开）' : display(value) }}</dd></div></template></dl></div></details>
    <details class="evidence-fold"><summary>生成溯源与版本记录</summary><dl class="provenance-list"><div v-for="(value, key) in guide.provenance" :key="key"><dt>{{ provenanceLabels[key] || key }}</dt><dd>{{ display(value) }}</dd></div></dl></details>
  </section>
</template>
