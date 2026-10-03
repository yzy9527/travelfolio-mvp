<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Constraints, Version } from '../lib/types'
import { mapUrl, money, safeUrl } from '../lib/utils'
import Icon from './Icon.vue'
const props = defineProps<{ version: Version; constraints: Constraints }>()
const dayIndex = ref(0)
watch(() => props.version.id, () => { dayIndex.value = 0 })
const content = computed(() => props.version.content)
const total = computed(() => content.value.budget.reduce((sum, row) => sum + row.amount, 0))
const selectedDay = computed(() => content.value.days[dayIndex.value])
const source = (id: string) => content.value.sources.find(row => row.id === id)
</script>
<template>
  <div class="handbook">
    <div class="notice" :class="content.verification.mode === 'demo' ? 'notice-amber' : 'notice-blue'">
      <Icon name="info"/><div><strong>{{ content.verification.mode === 'demo' ? '演示手册 · 虚构内容，不可用于实际出行' : content.verification.mode === 'live_search' ? '已参考搜索资料 · 重要信息仍需核实' : 'AI 规划草案 · 未经实时核验' }}</strong><p>{{ content.verification.notice }}</p><p>营业时间、价格、天气、交通及票务库存请以官方信息为准。预算为估算，不代表预订或报价。</p></div>
    </div>
    <div class="handbook-intro"><span class="eyebrow">YOUR TRAVEL HANDBOOK</span><h2>{{ content.title }}</h2><p>{{ content.summary }}</p></div>
    <div class="handbook-grid">
      <section class="card itinerary">
        <div class="section-heading"><div><span class="eyebrow">DAY BY DAY</span><h3>把日子交给风景</h3></div><span class="muted small">{{ content.days.length }} 天行程</span></div>
        <div class="day-tabs" role="tablist" aria-label="每日行程"><button v-for="(day, index) in content.days" :id="`day-tab-${index}`" :key="day.date" class="day-tab" :class="{ selected: dayIndex === index }" role="tab" :aria-selected="dayIndex === index" aria-controls="day-panel" @click="dayIndex = index"><span>DAY {{ String(index + 1).padStart(2, '0') }}</span><small>{{ day.date.slice(5).replace('-', '.') }}</small></button></div>
        <div v-if="selectedDay" id="day-panel" role="tabpanel" :aria-labelledby="`day-tab-${dayIndex}`" class="day-content"><h3>{{ selectedDay.title }}</h3><p class="muted day-summary">{{ selectedDay.summary }}</p>
          <div class="timeline"><article v-for="(activity, index) in selectedDay.activities" :key="index" class="activity"><div class="timeline-marker"></div><div class="activity-time">{{ activity.time }}</div><div class="activity-main"><div class="activity-title"><h4>{{ activity.title }}</h4><span class="cost-pill">约 {{ money(activity.estimatedCost, constraints.currency) }}</span></div><p>{{ activity.description }}</p><div class="activity-meta"><a :href="mapUrl(`${constraints.destination} ${activity.location}`)" target="_blank" rel="noopener noreferrer"><Icon name="pin" :size="14"/>{{ activity.location }}<Icon name="external" :size="12"/></a><span v-if="activity.transport"><Icon name="route" :size="14"/>{{ activity.transport }}</span></div><p v-if="activity.bookingNote" class="booking-note"><Icon name="info" :size="14"/>{{ activity.bookingNote }}</p><div v-if="activity.sourceIds.length" class="source-inline"><template v-for="id in activity.sourceIds" :key="id"><a v-if="source(id) && safeUrl(source(id)!.url)" :href="safeUrl(source(id)!.url)!" target="_blank" rel="noopener noreferrer">搜索依据：{{ source(id)!.title }} ↗</a></template></div></div></article></div>
          <div class="map-note"><Icon name="pin"/><span>点击地点可打开地图搜索。路线为建议，请在出发前确认距离与实际交通。</span></div>
        </div>
      </section>
      <aside class="handbook-aside">
        <section class="card budget-card"><div class="section-heading"><div><span class="eyebrow">TRAVEL BUDGET</span><h3>心里有一本账</h3></div><Icon name="wallet"/></div><p class="budget-total">{{ money(total, constraints.currency) }}</p><p class="muted small">全体 {{ constraints.people }} 人预估总支出 / 预算 {{ money(constraints.budget, constraints.currency) }}</p><div class="budget-bar"><span v-for="(row,index) in content.budget" :key="index" :style="{ flex: Math.max(row.amount, 0.1), background: ['#215c55','#689488','#b7cfc0','#d8b87a','#e4d9c1'][index % 5] }"></span></div><div v-for="(row,index) in content.budget" :key="index" class="budget-row"><div><span class="legend-dot" :style="{background: ['#215c55','#689488','#b7cfc0','#d8b87a','#e4d9c1'][index % 5]}"></span>{{ row.category }}<small>{{ row.note }}</small></div><strong>{{ money(row.amount, constraints.currency) }}</strong></div><p v-if="total > constraints.budget" class="over-budget">当前估算高于预算，可补充“降低住宿或交通成本”重新规划。</p></section>
        <section class="card packing-card"><span class="eyebrow">READY, SET, GO</span><h3>出发前的小清单</h3><label v-for="(item,index) in content.packing" :key="`${version.id}-${index}`" class="packing-item"><input type="checkbox"/><span>{{ item }}</span></label><p class="muted tiny">勾选仅供当前页面临时使用</p></section>
      </aside>
    </div>
    <section v-if="content.notes.length" class="card notes-card"><Icon name="compass" :size="28"/><div><h3>留一点余地，旅行更从容</h3><ul><li v-for="(note,index) in content.notes" :key="index">{{ note }}</li></ul></div></section>
    <section class="sources-section"><div class="section-heading"><div><span class="eyebrow">SOURCES & UNCERTAINTY</span><h3>信息从哪里来</h3></div><span class="muted small">{{ content.sources.length }} 条搜索资料</span></div><p v-if="!content.sources.length" class="muted">本版没有可引用的实时搜索资料。请自行核实官方交通、景区与酒店信息。</p><div v-else class="sources-grid"><div v-for="item in content.sources" :key="item.id" class="source-card"><Icon name="external"/><div><a v-if="safeUrl(item.url)" :href="safeUrl(item.url)!" target="_blank" rel="noopener noreferrer">{{ item.title }}</a><span v-else>{{ item.title }}（链接不可用）</span><small>检索日期 {{ item.retrievedAt.slice(0,10) }} · 仅作参考依据</small></div></div></div></section>
  </div>
</template>
