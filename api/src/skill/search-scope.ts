import type {PackId} from './types';

// Deterministic hints, not a geocoder. Unknown Chinese place names use the
// requested China default; unknown Latin names use global English search.
const REGIONS = [
  ['CN','中国','China|中国|中华人民共和国'],
  ['JP','Japan','日本|Japan'], ['KR','South Korea','韩国|韓國|South Korea'],
  ['TW','台灣','台湾|台灣|Taiwan'], ['HK','香港','香港|Hong Kong'],
  ['ALL','Macao','澳门|澳門|Macao|Macau'],
  ['GB','United Kingdom','英国|英國|United Kingdom|UK'],
  ['US','United States','美国|美國|United States|USA'],
  ['FR','France','法国|法國|France'], ['DE','Germany','德国|德國|Germany'],
  ['IT','Italy','意大利|義大利|Italy'], ['ES','Spain','西班牙|Spain'],
  ['PT','Portugal','葡萄牙|Portugal'], ['CH','Switzerland','瑞士|Switzerland'],
  ['AT','Austria','奥地利|奧地利|Austria'], ['NL','Netherlands','荷兰|荷蘭|Netherlands'],
  ['BE','Belgium','比利时|比利時|Belgium'], ['SE','Sweden','瑞典|Sweden'],
  ['NO','Norway','挪威|Norway'], ['DK','Denmark','丹麦|丹麥|Denmark'],
  ['FI','Finland','芬兰|芬蘭|Finland'], ['CA','Canada','加拿大|Canada'],
  ['AU','Australia','澳大利亚|澳大利亞|澳洲|Australia'], ['NZ','New Zealand','新西兰|紐西蘭|New Zealand'],
  ['SG','Singapore','新加坡|Singapore'], ['MY','Malaysia','马来西亚|馬來西亞|Malaysia'],
  ['TH','Thailand','泰国|泰國|Thailand'], ['ID','Indonesia','印度尼西亚|印尼|Indonesia'],
  ['IN','India','印度|India'], ['PH','Philippines','菲律宾|菲律賓|Philippines'],
  ['ALL','Vietnam','越南|Vietnam'], ['ALL','Cambodia','柬埔寨|Cambodia'],
  ['ALL','Laos','老挝|寮國|Laos'], ['ALL','Nepal','尼泊尔|尼泊爾|Nepal'],
  ['ALL','United Arab Emirates','阿联酋|阿聯酋|United Arab Emirates|UAE'],
  ['ALL','Iceland','冰岛|冰島|Iceland'], ['ALL','Greece','希腊|希臘|Greece'],
  ['TR','Turkey','土耳其|Turkey|Türkiye'], ['MX','Mexico','墨西哥|Mexico'],
  ['BR','Brazil','巴西|Brazil'], ['ZA','South Africa','南非|South Africa'],
] as const;

// Explicit aliases provide context without inventing a province for unknown names.
const PLACES = [
  ['CN','北京','北京|Beijing|Peking'], ['CN','上海','上海|Shanghai'],
  ['CN','天津','天津|Tianjin'], ['CN','重庆','重庆|重慶|Chongqing'],
  ['CN','四川 成都','成都|Chengdu'], ['CN','云南 大理','大理|Dali'],
  ['CN','云南 丽江','丽江|麗江|Lijiang'], ['CN','云南 昆明','昆明|Kunming'],
  ['CN','浙江 杭州','杭州|Hangzhou'], ['CN','江苏 苏州','苏州|蘇州|Suzhou'],
  ['CN','浙江 台州 温岭','温岭|溫嶺|Wenling'],
  ['CN','江苏 南京','南京|Nanjing'], ['CN','广东 广州','广州|廣州|Guangzhou'],
  ['CN','广东 深圳','深圳|Shenzhen'], ['CN','陕西 西安','西安|Xi’an|Xi\'an|Xian'],
  ['CN','福建 厦门','厦门|廈門|Xiamen'], ['CN','广西 桂林','桂林|Guilin'],
  ['CN','海南 三亚','三亚|三亞|Sanya'], ['CN','山东 青岛','青岛|青島|Qingdao'],
  ['CN','湖北 武汉','武汉|武漢|Wuhan'], ['CN','湖南 长沙','长沙|長沙|Changsha'],
  ['CN','四川 九寨沟','九寨沟|九寨溝|Jiuzhaigou'],
  ['JP','Kyoto','京都|Kyoto'], ['JP','Tokyo','东京|東京|Tokyo'],
  ['JP','Osaka','大阪|Osaka'], ['JP','Hokkaido','北海道|Hokkaido'],
  ['JP','Okinawa','冲绳|沖縄|沖繩|Okinawa'], ['JP','Nara','奈良|Nara'],
  ['KR','Seoul','首尔|首爾|Seoul'], ['KR','Jeju','济州|濟州|Jeju'],
  ['TW','台北','台北|臺北|Taipei'], ['TW','高雄','高雄|Kaohsiung'],
  ['GB','London','伦敦|倫敦|London'], ['FR','Paris','巴黎|Paris'],
  ['US','New York','纽约|紐約|New York'], ['US','San Francisco','旧金山|舊金山|San Francisco'],
  ['US','Los Angeles','洛杉矶|洛杉磯|Los Angeles'], ['IT','Rome','罗马|羅馬|Rome'],
  ['TH','Bangkok','曼谷|Bangkok'], ['TH','Chiang Mai','清迈|清邁|Chiang Mai'],
  ['TH','Phuket','普吉|Phuket'], ['ID','Bali','巴厘岛|峇里島|Bali'],
  ['AU','Sydney','悉尼|雪梨|Sydney'], ['AU','Melbourne','墨尔本|墨爾本|Melbourne'],
  ['ALL','Dubai','迪拜|杜拜|Dubai'], ['ALL','Reykjavik','雷克雅未克|Reykjavik'],
] as const;
const PROVINCES='河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆';
// Brave's country enum is smaller than ISO 3166. Unsupported regions retain
// their place context while using ALL, never an invalid API country value.
const SEARCH_COUNTRIES=new Set('AR AU AT BE BR CA CL DK FI FR DE HK IN ID IT JP KR MY MX NL NZ NO CN PL PT PH RU SA ZA ES SE CH TW TR GB US ALL'.split(' '));
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase();
function mentions(text:string,term:string):boolean {
  const value=normalize(text),needle=normalize(term);
  if(/[\u3400-\u9fff]/.test(needle))return value.includes(needle);
  const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`,'i').test(value);
}
export interface SearchScope { country:string; search_lang:'zh-hans'|'zh-hant'|'en'; destination:string; terms:string[]; regionalDestination?:string }
export function destinationSearchScope(destination:string):SearchScope {
  const places=PLACES.filter(row=>row[2].split('|').some(alias=>mentions(destination,alias)));
  const regionMatches=REGIONS.flatMap(row=>row[2].split('|').filter(alias=>mentions(destination,alias)).map(alias=>({row,alias})));
  // 印度尼西亚 must not also count as 印度. Prefer the longer matching name.
  const explicit=[...new Set(regionMatches.filter(match=>!regionMatches.some(other=>other.row!==match.row&&other.alias.length>match.alias.length&&mentions(other.alias,match.alias))).map(match=>match.row))];
  const countries=[...new Set([...explicit.map(row=>row[0]),...places.map(row=>row[0])])];
  const country=countries.length===1?countries[0]:countries.length>1?'ALL':/[\u3400-\u9fff]/.test(destination)?'CN':'ALL';
  const search_lang=country==='CN'?'zh-hans':country==='TW'||country==='HK'||explicit.some(row=>row[1]==='Macao')?'zh-hant':'en';
  const regions=REGIONS.filter(row=>countries.includes(row[0])&&row[0]!=='ALL');
  const context=[...places.map(row=>row[1]),...regions.map(row=>row[1]),...explicit.map(row=>row[1])];
  if(country==='CN'&&!context.includes('中国'))context.push('中国');
  // Remove broad country/province labels only when a more specific place remains.
  let local=destination;
  for(const row of explicit)for(const alias of row[2].split('|'))local=local.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),' ');
  if(country==='CN')local=local.replace(new RegExp(`(?:${PROVINCES})(?:省|自治区)?`,'g'),' ');
  const terms=places.length?places.flatMap(row=>row[2].split('|')):local.split(/[,，、;；/\n→]+/).map(s=>s.trim().replace(/(?:旅游|旅行|自由行|攻略)$/,'').trim().replace(/^(.{2,})[市县区]$/,'$1')).filter(s=>s.length>=2);
  const fallback=explicit.length?explicit.flatMap(row=>row[2].split('|')):[destination.trim()];
  return {country:SEARCH_COUNTRIES.has(country)?country:'ALL',search_lang,destination:[destination,...new Set(context)].join(' ').replace(/[\r\n]/g,' ').slice(0,300),terms:terms.length?terms:fallback,regionalDestination:places.length===1?places[0][1]:undefined};
}
export function researchSearchDestination(packId:PackId,scope:SearchScope):string {
  return ['places-shopping','places-food','modules-discovery','modules-practical','modules-language-notes'].includes(packId) ? scope.regionalDestination??scope.destination : scope.destination;
}
/** A relevance hint only: matching text never confers official-source authority. */
export function relevantSearchResult(scope:SearchScope,item:{title:string;url:string;description?:string}):boolean {
  let path='';try{const url=new URL(item.url);path=decodeURIComponent(url.hostname+url.pathname).replace(/[-_]/g,' ');}catch{/* Invalid URLs are rejected by safe-http. */}
  return scope.terms.some(term=>mentions(`${item.title} ${item.description??''} ${path}`,term));
}

const CHINESE_QUERIES:Record<PackId,readonly string[]>={
  framing:['文旅局 官方 旅游指南 公共交通','旅游季节 游客须知 实用信息','机场 火车站 公共交通 官方'],
  'places-core':['博物馆 地标 官方 参观指南','景区 公园 门票 地址 官方','景点 开放时间 位置 文旅'],
  'places-shopping':['本地商店 非遗 手工艺 地址','特色伴手礼 特产 官方','商场 市场 购物指南'],
  'places-experiences':['文化体验 手工课程 预约 地址','自然体验 徒步 活动 官方','演出 文化中心 参观 预约'],
  'places-food':['本地餐厅 菜单 地址 招牌菜','地方特色菜 餐馆 菜单','本地餐饮 连锁 门店 官方'],
  itinerary:['公共交通 路线 时刻表 官方','景点 开放时间 无障碍','文旅 步行 游览路线'],
  'modules-discovery':['本地手工艺 购物指南','文化体验 游客指南','特色伴手礼 购买指南'],
  'modules-practical':['地方美食 特色菜 菜单','旅游 实用信息 支付','预约 游览 准备清单'],
  'modules-language-notes':['旅游 礼仪 安全 官方','当地语言 方言 常用语','旅游 季节 天气 支付 交通 提醒'],
};

const ENGLISH_QUERIES: Record<PackId, readonly string[]> = {
  framing: ['official tourism visitor guide transport', 'official visitor season practical information', 'official airport public transport tourism'],
  'places-core': ['official museums landmarks visitor information', 'official attractions gardens temples tickets address', 'tourism official sights opening hours location'],
  'places-shopping': ['official local shops crafts address', 'official local souvenirs product catalogue', 'official shopping department store local market'],
  'places-experiences': ['official cultural experience workshop booking address', 'official guided nature wellness activity', 'official performance cultural centre visitor'],
  'places-food': ['official local restaurant menu address specialties', 'official restaurant regional cuisine branch menu', 'official local restaurant chain shop list'],
  itinerary: ['official public transport route timetable', 'official attraction opening hours accessibility', 'official tourism walking route visitor advice'],
  'modules-discovery': ['official local craft shopping guide', 'official cultural experience visitor guide', 'official souvenirs buying guide'],
  'modules-practical': ['official local food specialty menu guide', 'official tourism practical travel payment', 'official visitor reservation preparation checklist'],
  'modules-language-notes': ['official tourism visitor etiquette safety', 'official tourism language local phrase guide', 'official tourism seasonal weather payment transport advice'],
};

export function researchSearchTopics(packId:PackId,scope:SearchScope):readonly string[]{
  return scope.search_lang === 'en' ? ENGLISH_QUERIES[packId] : CHINESE_QUERIES[packId];
}
