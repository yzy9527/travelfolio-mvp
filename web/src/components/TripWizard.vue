<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Constraints } from '../lib/types'
import { dayCount, money, validateConstraints } from '../lib/utils'
import Icon from './Icon.vue'
const props = defineProps<{ busy: boolean; userId: string }>()
const emit = defineEmits<{ create: [constraints: Constraints]; close: [] }>()
const step = ref(1)
const error = ref('')
const key = `travelfolio:draft:${props.userId}`
const form = reactive<Constraints>({ destination: '', departure: '', startDate: '', endDate: '', people: 2, budget: 8000, currency: 'CNY', preferences: '', exclusions: '' })
try { const saved = sessionStorage.getItem(key); if (saved) Object.assign(form, JSON.parse(saved)) } catch { /* Draft storage is optional. */ }
const stop = watch(form, () => { try { sessionStorage.setItem(key, JSON.stringify(form)) } catch { /* Browser storage can be disabled. */ } })
onBeforeUnmount(stop)
const days = computed(() => dayCount(form.startDate, form.endDate))
const steps = ['去哪里', '和谁出发', '你的旅行方式', '出发前确认']
const interests = ['美食探索', '自然风景', '历史人文', '艺术与设计', '慢节奏', '亲子友好', '城市漫步', '小众路线']
function selectInterest(value: string) { const list = form.preferences.split('、').filter(Boolean); form.preferences = list.includes(value) ? list.filter(item => item !== value).join('、') : [...list, value].join('、') }
function next() {
  error.value = ''
  if (step.value === 1 && (!form.destination.trim() || !form.departure.trim() || days.value < 1 || days.value > 14 || !form.startDate || !form.endDate)) { error.value = '请填写出发地、目的地及 1 至 14 天的完整日期'; return }
  if (step.value === 2 && (!Number.isInteger(form.people) || form.people < 1 || form.people > 20 || !Number.isFinite(form.budget) || form.budget <= 0)) { error.value = '请填写 1 至 20 人和大于 0 的总预算'; return }
  step.value++
}
function submit() { error.value = validateConstraints(form) || ''; if (!error.value) emit('create', { ...form }) }
defineExpose({ clearDraft: () => { try { sessionStorage.removeItem(key) } catch {} } })
</script>
<template>
  <section class="wizard-wrap"><div class="page-topline"><button class="text-button" @click="emit('close')"><span>←</span> 我的旅行</button><span class="muted small">草稿暂存在当前浏览器标签页</span></div><header class="page-heading"><span class="eyebrow">A NEW CHAPTER</span><h1>下一程，从一个想法开始</h1><p>说说你期待的旅行，剩下的我们一起理清楚。</p></header>
  <div class="wizard-layout"><aside class="wizard-steps"><div v-for="(label,index) in steps" :key="label" class="wizard-step" :class="{current: step === index+1, complete: step > index+1}"><span class="step-number"><Icon v-if="step > index+1" name="check" :size="16"/><template v-else>{{ String(index+1).padStart(2,'0') }}</template></span><div><small>STEP {{ index+1 }}</small><strong>{{ label }}</strong></div></div><div class="wizard-tip"><Icon name="compass" :size="30"/><p>不必计划每一分钟，<br/>也能安心走向未知。</p></div></aside>
  <form class="card wizard-form" @submit.prevent="step < 4 ? next() : submit()"><div class="wizard-form-top"><span class="eyebrow">{{ String(step).padStart(2,'0') }} / 04</span><h2>{{ ['先选一个心动的地方','给旅行一个舒服的范围','怎样的旅程让你开心？','一切就绪，准备翻开新一页'][step-1] }}</h2></div>
  <div v-if="step === 1" class="form-step"><label>目的地<span class="required">*</span><div class="input-icon"><Icon name="pin"/><input v-model="form.destination" maxlength="120" placeholder="例如：京都、日本，或云南大理" required autocomplete="off"/></div></label><label>从哪里出发<span class="required">*</span><input v-model="form.departure" maxlength="120" placeholder="例如：上海" required/></label><div class="form-grid"><label>出发日期<span class="required">*</span><input v-model="form.startDate" type="date" required/></label><label>返程日期<span class="required">*</span><input v-model="form.endDate" type="date" :min="form.startDate" required/></label></div><p class="field-note"><Icon name="calendar" :size="15"/>{{ days > 0 && days <= 14 ? `共 ${days} 天，包括出发与返程当天` : '支持 1 至 14 天的旅行计划' }}</p></div>
  <div v-else-if="step === 2" class="form-step"><label>同行人数<span class="required">*</span><div class="number-control"><button type="button" aria-label="减少人数" :disabled="form.people <= 1" @click="form.people--">−</button><input v-model.number="form.people" type="number" min="1" max="20" required aria-label="同行人数"/><span>人</span><button type="button" aria-label="增加人数" :disabled="form.people >= 20" @click="form.people++">+</button></div></label><label>整趟旅行的总预算<span class="required">*</span><div class="budget-input"><select v-model="form.currency" aria-label="预算币种"><option value="CNY">CNY ¥</option><option value="USD">USD $</option><option value="EUR">EUR €</option><option value="JPY">JPY ¥</option><option value="GBP">GBP £</option><option value="HKD">HKD $</option></select><input v-model.number="form.budget" type="number" min="1" max="10000000" step="1" required aria-label="总预算"/></div></label><div class="soft-box"><Icon name="wallet"/><div><strong>这是所有同行人的合计预算</strong><p>含交通、住宿、餐饮与活动。约 {{ money(form.budget / Math.max(form.people,1),form.currency) }} / 人，AI 会据此分配建议。</p></div></div></div>
  <div v-else-if="step === 3" class="form-step"><div><label class="label">旅行偏好 <span class="optional">可多选，也可自由填写</span></label><div class="interest-chips"><button v-for="interest in interests" :key="interest" type="button" class="interest-chip" :class="{selected: form.preferences.split('、').includes(interest)}" :aria-pressed="form.preferences.split('、').includes(interest)" @click="selectInterest(interest)">{{ interest }}<Icon v-if="form.preferences.split('、').includes(interest)" name="check" :size="13"/></button></div></div><label>还有什么期待？<textarea v-model="form.preferences" rows="3" maxlength="2000" placeholder="例如：每天留一段咖啡馆时光，喜欢当地小店，不想早起"/></label><label>不想要什么？<textarea v-model="form.exclusions" rows="3" maxlength="2000" placeholder="例如：不安排高强度徒步、购物团，避开过于拥挤的景点"/></label><p class="field-note">不必填写证件、住址或其他敏感个人信息。</p></div>
  <div v-else class="form-step"><div class="review-destination"><Icon name="pin" :size="28"/><div><small>{{ form.departure }} 出发</small><h3>{{ form.destination }}</h3></div></div><dl class="review-list"><div><dt>旅行日期</dt><dd>{{ form.startDate }} → {{ form.endDate }} · {{ days }} 天</dd></div><div><dt>同行与预算</dt><dd>{{ form.people }} 人 · {{ money(form.budget,form.currency) }} 总预算</dd></div><div><dt>旅行偏好</dt><dd>{{ form.preferences || '暂未填写，安排均衡行程' }}</dd></div><div><dt>避开事项</dt><dd>{{ form.exclusions || '无特别要求' }}</dd></div></dl><div class="notice notice-blue"><Icon name="info"/><p>先创建旅行，再选择演示或真实 AI 生成行程大纲。你确认大纲后，才会开展研究与八章手册编译；手册还需人工审阅与单独采用。真实调用会把旅行信息发给你配置的服务商，可能产生 API 费用。</p></div></div>
  <p v-if="error" class="inline-error" role="alert">{{ error }}</p><div class="wizard-actions"><button v-if="step > 1" type="button" class="button secondary" :disabled="busy" @click="step--; error = ''">上一步</button><span v-else></span><button type="submit" class="button primary" :disabled="busy">{{ busy ? '正在创建…' : step < 4 ? '下一步' : '创建我的旅行' }}<Icon v-if="!busy" name="arrow" :size="18"/></button></div></form></div></section>
</template>

