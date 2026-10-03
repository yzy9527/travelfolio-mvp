import { tripDates, type TripConstraints } from '../schemas';
import type { CheckItem, ItineraryDay, LanguageGroup, Place, ResearchPacks } from './types';

/** Synthetic deterministic contract fixture. NEVER fall back to this in live mode. */
export function makeFixturePacks(c: TripConstraints, request = '', outline?: unknown): ResearchPacks {
  const dates = tripDates(c.startDate, c.endDate), source = 'https://fixture.invalid/research';
  const makePlace = (type: Place['type'], i: number): Place => ({
    id: `${type}-${i}`, type, display_name: `合成${type}${i}`, local_name: `Synthetic ${type} ${i}`,
    description: '这是用于验证完整手册结构的合成测试记录，不对应真实场所，不能作为实际旅行建议。', area: `合成区域${i % 3 + 1}`, map_query: `Synthetic fixture ${type} ${i}`, source_url: source, source_ids: ['fixture-source'],
    latitude: 10 + i * .002, longitude: 20 + i * .002, coordinate_source: { source_id: 'fixture-source', url: source, precision: 'area', note: '纯合成测试坐标，不是真实地点定位，不可用于导航。' },
    hours: '未核实；合成场所没有真实营业时间', closed_days: '待确认，不能据此认定每日营业', duration_minutes: 60,
    best_time: '合成时间窗口，仅用于排版测试', practical_tip: '这是合成参观说明，请勿据此安排实际出行。', price_note: '无真实报价，所有数字仅用于测试',
    interest_tags: ['城市', '文化', '美食', ...(c.preferences ? [c.preferences.slice(0, 300)] : [])], images: [],
  });
  const sights = Array.from({ length: 8 }, (_, i) => makePlace('sight', i + 1));
  const shops = Array.from({ length: 3 }, (_, i) => makePlace('shop', i + 1));
  const souvenirs = Array.from({ length: 4 }, (_, i) => ({ ...makePlace('souvenir', i + 1), why_buy: '演示商品购买理由，不代表真实推荐。', best_for: '仅适合测试购买建议卡片。', where_to_buy: '合成店铺，没有实际购买渠道。', buying_tip: '没有实际包装或海关依据，请勿购买。', text_only_reason: 'Synthetic fixture intentionally uses text-only products; no live image search was performed.' }));
  const kinds = ['culture', 'craft', 'wellness'] as const;
  const experiences = Array.from({ length: 6 }, (_, i) => ({ ...makePlace('experience', i + 1), experience_type: kinds[Math.floor(i / 2)], route_fit: '合成区域内活动选择，不能推断实际交通或营业可行性。' }));
  const restaurants = Array.from({ length: 10 }, (_, i) => ({ ...makePlace('restaurant', i + 1), cuisine: ['合成地方菜', '合成海鲜', '合成面食', '合成邻里料理'][i % 4], venue_type: i < 6 ? '合成独立餐厅' : '合成连锁分店', signature_dishes: '示例菜一 · 示例菜二（非真实菜单）', per_person: '待确认；无真实报价', ...(i >= 6 ? { chain_evidence: '合成连锁说明，不声称现实中有多个分店。' } : {}) }));
  const outlineDays = outline && typeof outline === 'object' && Array.isArray((outline as {days?: unknown}).days) ? (outline as {days: {title?: string; focus?: string}[]}).days : [];
  const itinerary: ItineraryDay[] = dates.map((date, i) => {
    const sight = sights[i % 8], food = restaurants[i % 6], shop = shops[i % 3];
    return { date, area: sight.area, theme: outlineDays[i]?.title ? `合成演示 · ${outlineDays[i].title}`.slice(0, 300) : `第${i + 1}天合成路线`, summary: `${sight.display_name}、${food.display_name}和${shop.display_name}用于完整日程测试；全部为虚构场所。${outlineDays[i]?.focus ? '提纲演示要求：' + outlineDays[i].focus : ''}`.slice(0, 4000),
      periods: { morning: { title: sight.display_name, description: `上午展示${sight.display_name}的合成参观顺序，之后留出休息与转场缓冲。` }, afternoon: { title: food.display_name, description: `在${food.display_name}展示午餐时段，再前往${shop.display_name}，不声称是真实路线。` }, evening: { title: '休息与确认', description: `合成区域${i % 3 + 1}晚间不增加额外场所，展示次日信息确认与返程缓冲。` } },
      stops: [sight, food, shop].map((p, si) => ({ place_id: p.id, arrival_time: ['09:00', '12:00', '15:00'][si], dwell_minutes: 60, transport_mode: si ? 'walking' : 'arrival', transfer_minutes: si ? 20 : 0, distance_km: si ? 1 : 0, distance_basis: 'unconfirmed', estimated_cost: '未核实；纯演示', practical_note: `在${p.display_name}展示入口、参观或用餐顺序，实际场所并不存在，请勿照此出行。`, time_guard: `${['10:00', '13:00', '16:00'][si]}前结束合成活动，演示20分钟排队上限。`, rationale: '仅测试跨模块引用、时间校验与手册组件，不能作旅行依据。' })),
      fallback: `若遇天气或体力问题，本测试日取消${shop.display_name}，在合成休息区结束。这是演示决策卡片，不提供真实避雨地点。`,
      shopping_advice: { title: `${shop.display_name}合成浏览`, description: `在${shop.display_name}预留30分钟测试购物界面，展示合成礼物信息。价格、商品与库存没有查证，请勿按演示记录购物。` },
      photo_advice: { title: `${sight.display_name}摄影测试`, lighting: `第${i + 1}天合成侧光场景，不是实际日照预报。`, suitable_shots: [`${sight.display_name}前景与纵深演示`, `${shop.display_name}橱窗构图演示`], portrait_tip: '用合成场景说明人物与通道关系；现实摄影请尊重隐私。', outfit_advice: { women: '轻便上衣与长裤、舒适鞋用于展示搭配字段；不构成当地季节建议。', men: '薄外套与长裤、舒适鞋用于展示搭配字段；可按个人风格互换。', practical_note: '没有获取天气信息，真实出行需依据当地预报调整衣物。' }, shooting_plan: [{ time: '09:30', title: `${sight.display_name}手机场景`, note: '手机用1×镜头、腰部高度构图，人物站一侧，点按主体调整曝光；仅展示技巧字段。' }, { time: '15:30', title: `${shop.display_name}相机场景`, note: '相机以35–50mm、f/5.6和1/125秒作为教学示例；不要挡住通道，实际场景未核验。' }] },
    };
  });
  const prepNames = ['证件有效期', '支付方式', '通信方案', '个人常用物品', '行程备份', '紧急联系人', '步行鞋', '天气与衣层', '充电线', '转换插头', '防雨用品', '饮水容器', '随身包', '洗漱用品', '纸质地址', '离线资料', '交通时间', '餐厅营业', '体验预约', '入住时间', '返程缓冲', '行李限制', '无障碍需求', '实际费用', '停业公告', '排队规则', '同行集合', '补给休息', '最后班次', '餐食限制', '参观入口', '退改规则', '现金额度', '网络覆盖', '集合地点', '日落时刻', '拍摄规范', '寄存位置', '备用路线', '失物查询', '机场到达', '行程核对'];
  const checks: CheckItem[] = prepNames.slice(0, Math.max(24, dates.length * 3)).map((title, i) => ({ title: `合成检查：${title}`, priority: i < 6 ? '必须' : i < 20 ? '建议' : '随缘', note: `这是${title}的合成清单。没有查证目的地事实，请根据真实资料逐项确认。` }));
  const groupNames = ['交通与定位', '点餐与口味', '住宿沟通', '支付与购物', '问候与求助'];
  const localGroups: LanguageGroup[] = groupNames.map((title, gi) => ({ title, items: Array.from({ length: 5 }, (_, i) => ({ term: `Synthetic term ${gi + 1}-${i + 1}`, meaning: `合成词条${gi + 1}-${i + 1}；不是当地语言翻译`, reading: `synthetic reading ${gi + 1}-${i + 1}` })) }));
  const categories = ['weather', 'culture', 'transport', 'safety', 'payment'] as const;
  return {
    framing: { destination: c.destination, display_name: c.destination, country: 'Synthetic fixture country', year: c.startDate.slice(0, 4), trip: { start_date: c.startDate, end_date: c.endDate, days: dates.length, rhythm: 'standard', travelers: String(c.people), interests: c.preferences ? [c.preferences.slice(0, 300)] : [], constraints: [c.exclusions, request].filter(Boolean).map(s => s.slice(0, 300)), quality_mode: 'standard', currency: c.currency, budget: c.budget }, cover: { kicker: 'SYNTHETIC CONTRACT FIXTURE', title: '合成手册演示', summary: '完整八模块合成测试手册。全部场所、坐标、价格和语言条目均为测试内容，未进行实时检索或实际出行核验。', image: '', tags: ['合成演示', '不可用于出行'] }, transport: { status: 'pending', legs: [] }, stays: [{ status: 'pending', place_id: null, check_in: null, check_out: null, notes: '住宿待确认，演示不编造旅馆。' }], map_delivery: 'screenshots', render_bindings_file: 'render-bindings.json' },
    'places-core': { sights, support: [] }, 'places-shopping': { shops, souvenirs }, 'places-experiences': experiences, 'places-food': restaurants, itinerary,
    'modules-discovery': { shopping: [{ title: '合成购物区', subtitle: '商场与店铺', items: shops.map(p => ({ place_id: p.id })) }], experiences: kinds.map((kind, i) => ({ title: ['文化与艺术', '手工与学习', '放松与恢复'][i], subtitle: '合成活动，未实际研究', experience_types: [kind], items: experiences.filter(x => x.experience_type === kind).map(p => ({ place_id: p.id })) })), experience_mode: 'standard' },
    'modules-practical': { food: { menu_guide: { kicker: '合成菜单指南', title: '练习阅读点餐信息', intro: '演示初次访客菜单阅读指南的完整形态，不能代替实际目的地的点餐知识。', cards: ['菜品与份量', '套餐与费用', '忌口与沟通', '排队与预约'].map(title => ({ title, note: `合成指南展示${title}的信息结构；没有检索当地规则或真实餐厅菜单，出行时请向实际门店核实。` })) }, menu_primer: groupNames.map((name, i) => ({ term: `Synthetic menu ${i + 1}`, meaning: `${name}合成菜单表达`, note: '该词条不是真实翻译，不能用来点餐。' })), local_snacks: Array.from({ length: 4 }, (_, i) => ({ name: `合成小吃${i + 1}`, local_name: `Synthetic snack ${i + 1}`, description: '合成口味与质地说明，仅测试小吃卡片。', why_try: '演示食物介绍与餐厅推荐的区别。', where_to_find: '没有真实销售地点，不可购买。' })), dedicated_trip: restaurants.slice(0, 6).map(p => ({ place_id: p.id })), reliable_chains: restaurants.slice(6).map(p => ({ place_id: p.id })) }, preparation: { essentials: checks.slice(0, 16), confirm_ahead: checks.slice(16) } },
    'modules-language-notes': { language: { local_label: '合成词条示范', locale: 'en', keyword_groups: structuredClone(localGroups), phrase_groups: structuredClone(localGroups), english_keyword_groups: structuredClone(localGroups), english_phrase_groups: groupNames.map((title, gi) => ({ title, items: Array.from({ length: 5 }, (_, i) => ({ sentence: `Synthetic example sentence ${gi + 1}-${i + 1}.`, meaning: '合成英语例句，仅作版式验证，不是实际沟通建议。' })) })) }, travel_notes: categories.map((category, i) => ({ category, title: ['天气与衣物', '文化与礼仪', '交通与换乘', '安全与求助', '支付与费用'][i], summary: '这是合成测试说明，没有检索真实目的地规则。实际出行前请使用官方资料作出相应决定。', items: ['核对当前情况', '选择实际方案', '确认例外条件', '保留备用安排'].map(title => ({ title, priority: '建议', note: `这条${title}记录测试完整的本地贴士组件，没有查证真实目的地事实。出行时请使用可靠来源核实，并根据实际情况调整安排。` })) })) },
  };
}
