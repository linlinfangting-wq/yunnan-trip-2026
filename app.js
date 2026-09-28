(() => {
'use strict';

// 沿用旧版的收藏存储名，已经点过的收藏不会丢
const FAV_KEY = 'yunnan-favorites-v4';
const REGIONS = ['全部', '普洱', '景迈山', '孟连', '昆明'];
const KINDS = ['全部', '吃', '喝', '逛', '玩', '拍'];
// 百度地图按城市搜索：景迈山、孟连都属于普洱市
const MAP_CITY = { '普洱': '普洱市', '景迈山': '普洱市', '孟连': '普洱市', '昆明': '昆明市' };
const MAG_BG = { '普洱': '#F4EFE7', '景迈山': '#EAF0E9', '孟连': '#EEF0F3', '昆明': '#F5F2EC' };
const EVENT_TAG = { flight: '航班', train: '高铁', car: '租车', hotel: '酒店', meal: '吃饭', free: '自由' };
const BAIDU_SRC = 'webapp.yunnantrip.planner';

const state = { trip: null, places: [], byId: {}, day: null, region: '全部', kind: '全部', q: '' };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 链接 ----------
const xhsUrl = kw => 'xhsdiscover://search/result?keyword=' + encodeURIComponent(kw);
// 有图片来源笔记时，直接打开那篇笔记
// 直接调起小红书 App 打开这篇笔记（Safari 里可用）；网页链接作备用
const xhsPlaceUrl = p => p.noteId ? 'xhsdiscover://item/' + p.noteId : xhsUrl(p.xhsKeyword);
const xhsWebUrl = p => p.noteId && p.xsecToken
  ? `https://www.xiaohongshu.com/discovery/item/${p.noteId}?xsec_token=${encodeURIComponent(p.xsecToken)}&xsec_source=pc_share`
  : '';
// 用百度地图官方网页调起接口（普通 https 链接），手机上会自动唤起百度地图 App
const placeUrl = (query, region) =>
  `https://api.map.baidu.com/place/search?query=${encodeURIComponent(query)}&region=${encodeURIComponent(MAP_CITY[region] || region)}&output=html&src=${BAIDU_SRC}`;
const routeUrl = r =>
  `https://api.map.baidu.com/direction?origin=${encodeURIComponent('name:' + r.from)}&destination=${encodeURIComponent('name:' + r.to)}` +
  `&mode=${r.mode}&region=${encodeURIComponent(MAP_CITY[r.region] || r.region)}&output=html&src=${BAIDU_SRC}`;

// ---------- 收藏 ----------
function getFav() {
  try { const v = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function setFav(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) { /* 隐私模式下存不了，页面照常用 */ }
}
const isFav = id => getFav().includes(id);
function toggleFav(id) {
  const list = getFav();
  setFav(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  const on = isFav(id);
  $$(`[data-heart="${CSS.escape(id)}"]`).forEach(b => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-label', on ? '取消收藏' : '收藏');
    b.classList.remove('pop'); void b.offsetWidth; if (on) b.classList.add('pop');
  });
  updateFavCount();
  if ($('#screen-fav').classList.contains('active')) renderFav();
}
function updateFavCount() {
  const n = getFav().filter(id => state.byId[id]).length;
  $('#favCount').textContent = n ? n : '';
}

const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3s-7.6-4.6-9.3-9.2C1.5 7.8 3.6 4.6 7 4.6c2 0 3.6 1.1 5 2.9 1.4-1.8 3-2.9 5-2.9 3.4 0 5.5 3.2 4.3 6.5-1.7 4.6-9.3 9.2-9.3 9.2z"/></svg>';
const heartBtn = id => {
  const on = isFav(id);
  return `<button class="heart ${on ? 'on' : ''}" data-heart="${esc(id)}" aria-label="${on ? '取消收藏' : '收藏'}"><span>${HEART_SVG}</span></button>`;
};

// ---------- 地点卡片 ----------
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return Math.abs(h); }
const RATIOS = [4 / 3, 5 / 4, 1, 4 / 3, 7 / 6];          // 高 / 宽
const ratioOf = p => RATIOS[hash(p.id) % RATIOS.length];
const hasPhoto = p => p.photoStatus === 'verified' || p.photoStatus === 'location_only';
const photoLabel = p => p.photoStatus === 'verified' ? '实拍' : '区域实拍';

function magInner(p) {
  return `<div class="region">${esc(p.region)} · ${esc(p.kind)}</div>
    <div class="mname">${esc(p.name)}</div>
    <div class="msub">${esc(p.subtitle)}</div>
    <div class="rule"></div>
    <a class="xhs" href="${esc(xhsUrl(p.xhsKeyword))}" data-stop>去小红书看实拍 ↗</a>`;
}

function cardHtml(p) {
  const r = ratioOf(p);
  if (hasPhoto(p)) {
    return `<article class="pcard" data-id="${esc(p.id)}">
      <div class="cover" style="padding-top:${(r * 100).toFixed(2)}%">
        <img src="${esc(p.src)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer" data-img="${esc(p.id)}">
        <span class="photomark">${photoLabel(p)}</span>
        ${heartBtn(p.id)}
      </div>
      <div class="body">
        <div class="name">${esc(p.name)}</div>
        <div class="sub">${esc(p.subtitle)}</div>
        <div class="meta">${esc(p.region)} · ${esc(p.kind)}</div>
      </div>
    </article>`;
  }
  return `<article class="pcard" data-id="${esc(p.id)}" style="background:${MAG_BG[p.region] || '#F3F3F0'}">
    <div class="mag" style="min-height:${Math.round(150 + r * 60)}px">${magInner(p)}</div>
    ${heartBtn(p.id)}
  </article>`;
}

// 图片加载失败（比如被防盗链拦截）→ 当作无图，换成杂志卡，不留破图
function onImgError(img) {
  const p = state.byId[img.dataset.img];
  if (!p || p.photoStatus === 'missing') return;
  p.photoStatus = 'missing'; p.imgFailed = true;
  $$(`.pcard[data-id="${CSS.escape(p.id)}"]`).forEach(el => { el.outerHTML = cardHtml(p); });
}

// 按“哪列更短放哪列”分两列，阅读顺序左右交替，像小红书
function renderMasonry(el, list) {
  const cols = [document.createElement('div'), document.createElement('div')];
  cols.forEach(c => c.className = 'col');
  const h = [0, 0];
  let html = ['', ''];
  for (const p of list) {
    const i = h[0] <= h[1] ? 0 : 1;
    html[i] += cardHtml(p);
    h[i] += hasPhoto(p) ? ratioOf(p) + 0.45 : 0.8 + ratioOf(p) * 0.35;
  }
  cols[0].innerHTML = html[0]; cols[1].innerHTML = html[1];
  el.replaceChildren(...cols);
}

// ---------- 发现 ----------
function renderChips() {
  const mk = (arr, cur, key) => arr.map(v =>
    `<button class="chip ${v === cur ? 'active' : ''}" data-${key}="${v}">${v}</button>`).join('');
  $('#regionChips').innerHTML = mk(REGIONS, state.region, 'region');
  $('#kindChips').innerHTML = mk(KINDS, state.kind, 'kind');
}
function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.places.filter(p =>
    (state.region === '全部' || p.region === state.region) &&
    (state.kind === '全部' || p.kind === state.kind) &&
    (!q || [p.name, p.subtitle, p.description, p.mustTry, p.why, p.region, p.kind].join(' ').toLowerCase().includes(q)));
}
function renderDiscover() {
  const list = filtered();
  const g = $('#discoverGrid');
  if (!list.length) {
    g.innerHTML = `<div class="empty">没有找到相关地点<br>换个关键词或筛选试试</div>`;
    return;
  }
  renderMasonry(g, list);
}

// ---------- 收藏夹 ----------
function renderFav() {
  const list = getFav().map(id => state.byId[id]).filter(Boolean);
  $('#favSummary').textContent = list.length ? `${list.length} 个地点` : '';
  const g = $('#favGrid');
  if (!list.length) {
    g.innerHTML = `<div class="empty">还没有收藏<br><button class="btn" data-goto="discover">去「发现」看看</button></div>`;
    return;
  }
  renderMasonry(g, list);
}

// ---------- 行程 ----------
function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function renderDayRow() {
  const today = localISO();
  $('#dayrow').innerHTML = state.trip.days.map(d =>
    `<button class="day ${d.id === state.day ? 'active' : ''} ${d.date === today ? 'today' : ''}" data-day="${d.id}">
      <b>${d.label}</b><span>${d.date === today ? '今天' : d.weekday}</span></button>`).join('');
}
function rentalDay(date) {
  const { pickup, return: ret } = state.trip.rental;
  if (date < pickup.date || date > ret.date) return null;
  const days = (s, e) => Math.round((new Date(e) - new Date(s)) / 864e5) + 1;
  return { n: days(pickup.date, date), total: days(pickup.date, ret.date) };
}
function renderDay() {
  const d = state.trip.days.find(x => x.id === state.day);
  const [, m, dd] = d.date.split('-').map(Number);
  const rent = rentalDay(d.date);
  const rental = state.trip.rental;

  const pills = [];
  if (d.stay) pills.push(`<span class="pill">今晚住 <b>${esc(d.stay.name)}</b></span>`);
  if (rent) pills.push(`<span class="pill">自驾 第 ${rent.n}/${rent.total} 天 · ${esc(rental.car)}</span>`);

  const events = d.events.map(e => `<div class="ev">
      <div class="t">${esc(e.time)}</div>
      <div><div class="title"><span class="tag">${EVENT_TAG[e.type] || ''}</span>${esc(e.title)}</div>
      ${e.detail ? `<div class="detail">${esc(e.detail)}</div>` : ''}</div>
    </div>`).join('');

  let routes;
  if (d.routes.length) {
    routes = d.routes.map(r => `<div class="route card-box">
        <div class="info"><div class="lbl">${esc(r.label)}</div>
        <div class="path">${esc(r.from)}<i>→</i>${esc(r.to)}</div></div>
        <a target="_blank" rel="noopener" class="btn" href="${esc(routeUrl(r))}">百度地图算路</a>
      </div>`).join('');
  } else {
    routes = `<div class="route-empty card-box"><span>今天不换城市，住 ${esc(d.stay.name)}</span>
      <a target="_blank" rel="noopener" class="btn light" href="${esc(placeUrl(d.stay.name, d.region))}">酒店位置 ↗</a></div>`;
  }

  $('#dayview').innerHTML = `
    <div class="dayhero">
      <div class="date">${m} 月 ${dd} 日 · ${d.weekday}</div>
      <h2>${esc(d.title)}</h2>
      <p>${esc(d.summary)}</p>
      ${pills.length ? `<div class="pills">${pills.join('')}</div>` : ''}
    </div>
    ${d.alert ? `<div class="alert">${esc(d.alert)}</div>` : ''}
    <div class="timeline card-box">${events}</div>
    <div class="section-label">今天主要移动</div>
    ${routes}
    <button class="godiscover card-box" data-discover-region="${esc(d.region)}">
      <div><strong>去发现${esc(d.region)}附近有什么</strong><span>吃饭、喝咖啡、逛市场、拍照</span></div>
      <div class="chev">›</div>
    </button>`;
}

// ---------- 详情 ----------
let lastFocus = null;
function openSheet(id) {
  const p = state.byId[id];
  if (!p) return;
  const hero = hasPhoto(p)
    ? `<div class="hero"><img src="${esc(p.src)}" alt="${esc(p.name)}" referrerpolicy="no-referrer" data-img="${esc(p.id)}">
        <span class="photomark">${photoLabel(p)}</span>
        ${p.sourceType ? `<span class="credit">${esc(p.sourceType)}${p.likes ? ' · ' + p.likes + ' 赞' : ''}</span>` : ''}`
    : `<div class="hero mag" style="background:${MAG_BG[p.region] || '#F3F3F0'}">
        <div class="region">${esc(p.region)} · ${esc(p.kind)}</div>
        <div class="mname">暂无可靠实拍</div>
        <div class="rule"></div>
        <a class="xhs" href="${esc(xhsUrl(p.xhsKeyword))}">去小红书看实拍 ↗</a>`;
  $('#sheetBody').innerHTML = `
    ${hero}
      <button class="close" data-close aria-label="关闭"><span>×</span></button>
      ${heartBtn(p.id)}
    </div>
    <div class="content">
      <h2>${esc(p.name)}</h2>
      <div class="subline">${esc(p.region)} · ${esc(p.kind)}</div>
      <p class="desc">${esc(p.description)}</p>
      <div class="blocks">
        ${p.why ? `<div class="block"><b>为什么值得去</b><div>${esc(p.why)}</div></div>` : ''}
        <div class="block"><b>推荐${p.kind === '喝' ? '喝什么' : p.kind === '吃' ? '吃什么' : '做什么'}</b><div>${esc(p.mustTry)}</div></div>
        <div class="block"><b>适合什么时候去</b><div>${esc(p.bestTime)}</div></div>
      </div>
      <div class="actions">
        <a class="btn xhs" href="${esc(xhsPlaceUrl(p))}">${p.noteId ? '看这篇笔记 ↗' : '小红书 ↗'}</a>
        <a target="_blank" rel="noopener" class="btn light" href="${esc(placeUrl(p.mapKeyword, p.region))}">百度地图 ↗</a>
      </div>
      ${xhsWebUrl(p) ? `<a class="weblink" target="_blank" rel="noopener" href="${esc(xhsWebUrl(p))}">打不开？用网页打开这篇笔记 ↗</a>` : ''}
      <div class="fallback"><span>点了没跳转？复制 <b>${esc(p.xhsKeyword)}</b> 到 App 里搜</span>
        <button class="copy" data-copy="${esc(p.xhsKeyword)}">复制</button></div>
    </div>`;
  const img = $('#sheetBody img[data-img]');
  if (img) img.addEventListener('error', () => { onImgError(img); openSheet(id); }, { once: true });
  lastFocus = document.activeElement;
  $('#sheet').scrollTop = 0;
  $('#sheet').classList.add('open'); $('#sheet').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  document.documentElement.style.overflow = 'hidden';
}
function closeSheet() {
  if (!$('#sheet').classList.contains('open')) return;
  $('#sheet').classList.remove('open'); $('#sheet').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('open');
  document.documentElement.style.overflow = '';
  if (lastFocus) lastFocus.focus({ preventScroll: true });
}

function copyText(btn) {
  const text = btn.dataset.copy;
  const done = () => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); };
  const fallback = () => {
    const b = btn.parentElement.querySelector('b');
    const r = document.createRange(); r.selectNodeContents(b);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    btn.textContent = '已选中，长按复制';
  };
  try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
}

// ---------- 导航 ----------
function goto(tab) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + tab));
  if (tab === 'discover') { renderChips(); renderDiscover(); }
  if (tab === 'fav') renderFav();
  window.scrollTo(0, 0);
}

// ---------- 事件（统一委托） ----------
document.addEventListener('click', e => {
  const t = e.target;
  const heart = t.closest('[data-heart]');
  if (heart) { e.stopPropagation(); toggleFav(heart.dataset.heart); return; }
  if (t.closest('[data-stop]')) return;                   // 卡片里的小红书链接，直接跳走
  if (t.closest('[data-close]')) { closeSheet(); return; }
  const cp = t.closest('[data-copy]');
  if (cp) { copyText(cp); return; }
  const tab = t.closest('.tab');
  if (tab) { goto(tab.dataset.tab); return; }
  const g = t.closest('[data-goto]');
  if (g) { goto(g.dataset.goto); return; }
  const day = t.closest('.day');
  if (day) { state.day = day.dataset.day; renderDayRow(); renderDay(); return; }
  const dr = t.closest('[data-discover-region]');
  if (dr) { state.region = dr.dataset.discoverRegion; state.kind = '全部'; state.q = ''; $('#search').value = ''; goto('discover'); return; }
  const rc = t.closest('[data-region]');
  if (rc) { state.region = rc.dataset.region; renderChips(); renderDiscover(); return; }
  const kc = t.closest('[data-kind]');
  if (kc) { state.kind = kc.dataset.kind; renderChips(); renderDiscover(); return; }
  const card = t.closest('.pcard');
  if (card) openSheet(card.dataset.id);
});
document.addEventListener('error', e => {
  if (e.target.tagName === 'IMG' && e.target.dataset.img && !e.target.closest('#sheet')) onImgError(e.target);
}, true);
$('#scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
$('#search').addEventListener('input', e => { state.q = e.target.value; renderDiscover(); });

// ---------- 数据加载 ----------
async function load() {
  const get = f => fetch(f, { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(f); return r.json(); });
  try {
    const [trip, places, images] = await Promise.all([
      get('data/trip.json'), get('data/places.json'), get('data/place-images.json')]);
    const imgById = Object.fromEntries(images.map(i => [i.placeId, i]));
    state.trip = trip;
    state.places = places.map(p => {
      const img = imgById[p.id] || {};
      const src = img.localPath || img.imageUrl || '';
      const status = src ? (img.photoStatus || 'missing') : 'missing';
      return { ...p, photoStatus: status, src, sourceType: img.sourceType || '', noteId: img.noteId || '', xsecToken: img.xsecToken || '', likes: img.likes || 0 };
    });
    state.byId = Object.fromEntries(state.places.map(p => [p.id, p]));
  } catch (err) {
    $('main').innerHTML = `<div class="loaderr">行程数据没有读取到。<br>如果是在电脑上直接双击打开的，浏览器会禁止读取 data 文件夹，请用网址打开。</div>`;
    return;
  }
  const today = localISO();
  state.day = (state.trip.days.find(d => d.date === today) || state.trip.days[0]).id;
  renderDayRow(); renderDay(); updateFavCount();
  const active = $('#dayrow .day.active');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
}
load();
})();
