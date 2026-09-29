(() => {
'use strict';

// ============ 基础 ============
const CFG = window.ADMIN_CONFIG || {};
const API = String(CFG.apiBase || '').replace(/\/+$/, '');
const REGIONS = ['普洱', '景迈山', '孟连', '昆明'];
const KINDS = ['吃', '喝', '逛', '玩', '拍'];
const REGION_SLUG = { '普洱': 'puer', '景迈山': 'jingmai', '孟连': 'menglian', '昆明': 'km' };
const DRAFT_KEY = 'yt-admin-draft-v1';
const SESSION_KEY = 'yt-admin-session';
const ACK_KEY = 'yt-admin-ack-v1';
const STATUS_TEXT = { published: '已发布', hidden: '已隐藏', draft: '草稿' };

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } },
};

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

// ============ 图片草稿（IndexedDB，只存还没发布的上传图片） ============
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      let r; try { r = indexedDB.open('yt-admin', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => r.result.createObjectStore('images');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('images', mode); const s = t.objectStore('images');
      const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
    });
  },
  put(k, v) { return this.tx('readwrite', s => s.put(v, k)); },
  get(k) { return this.tx('readonly', s => s.get(k)); },
  del(k) { return this.tx('readwrite', s => s.delete(k)); },
};
const imgCache = {};   // pendingImage key -> dataURL

// 手机照片压缩成 JPEG（最长边 1400）
function compressImage(file, max = 1400, q = 0.82) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => {
      const s = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * s); c.height = Math.round(im.naturalHeight * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', q));
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('这张图片读不了，换一张试试')); };
    im.src = url;
  });
}

// ============ 数据 ============
const S = {
  base: { places: [], notes: [], audit: { cover: [], region: [], duplicatePlaces: [] } },
  draft: store.get(DRAFT_KEY, { places: {}, removed: [], notes: {} }),
  ack: store.get(ACK_KEY, []),
  session: store.get(SESSION_KEY, ''),
  user: '',
  region: '普洱', q: '', editing: null, publishing: false,
};
const baseById = () => Object.fromEntries(S.base.places.map(p => [p.id, p]));

function allPlaces() {
  const removed = new Set(S.draft.removed);
  const out = S.base.places.filter(p => !removed.has(p.id)).map(p => S.draft.places[p.id] || p);
  const baseIds = new Set(S.base.places.map(p => p.id));
  for (const [id, p] of Object.entries(S.draft.places)) if (!baseIds.has(id) && !removed.has(id)) out.push(p);
  return out.sort((a, b) => (b.featured === true) - (a.featured === true) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}
// 返回副本：改动只通过 savePlace 进入草稿，不会误改原始数据
const getPlace = id => { const p = allPlaces().find(x => x.id === id); return p ? clone(p) : null; };
function allNotes() {
  const m = Object.fromEntries(S.base.notes.map(n => [n.id, n]));
  for (const [id, n] of Object.entries(S.draft.notes || {})) m[id] = n;
  return m;
}

function saveDraft() {
  const ok = store.set(DRAFT_KEY, S.draft);
  if (!ok) toast('本机空间不够，草稿没存上');
  renderFooter();
}
function savePlace(p) {
  const b = baseById()[p.id];
  if (b && same(stripDraft(p), b) && !p.cover?.pendingImage) delete S.draft.places[p.id];
  else S.draft.places[p.id] = clone(p);
  saveDraft();
}
const stripDraft = p => { const c = clone(p); if (c.cover) delete c.cover.pendingImage; return c; };

// 改动汇总（发布前给你看）
function changes() {
  const base = baseById(); const list = [];
  for (const [id, p] of Object.entries(S.draft.places)) {
    const b = base[id];
    if (!b) { list.push({ id, name: p.name, kind: 'new' }); continue; }
    const kinds = [];
    if (!same(p.cover, b.cover) || p.cover?.pendingImage) kinds.push('cover');
    if (p.primaryXhsLink !== b.primaryXhsLink || p.xhsKeyword !== b.xhsKeyword || !same(p.sourceNotes, b.sourceNotes)) kinds.push('xhs');
    if (p.mapKeyword !== b.mapKeyword) kinds.push('map');
    if (p.status !== b.status) kinds.push(p.status === 'hidden' ? 'hide' : 'show');
    if (p.featured !== b.featured || p.sortOrder !== b.sortOrder) kinds.push('order');
    const text = ['name', 'region', 'category', 'cardSubtitle', 'description', 'why', 'mustTry', 'bestTime', 'aliases'];
    if (text.some(k => !same(p[k], b[k]))) kinds.push('text');
    if (kinds.length) list.push({ id, name: p.name, kind: kinds });
  }
  for (const id of S.draft.removed) if (base[id]) list.push({ id, name: base[id].name, kind: 'delete' });
  // 线上还有没存进仓库的小红书封面、或没解析的短链：发布一次就能整理好
  const isShort = u => /xhslink\.(com|cn)\//.test(String(u || ''));
  const tidy = allPlaces().filter(p => (p.cover && p.cover.url && !p.cover.localPath && /xhscdn\.com|xiaohongshu\.com/.test(p.cover.url)) || isShort(p.primaryXhsLink)).length
    + Object.values(allNotes()).filter(n => isShort(n.url)).length;
  if (tidy) list.push({ id: '_tidy', name: '', kind: 'tidy', n: tidy });
  return list;
}
function changeSummary(list) {
  const c = { place: 0, cover: 0, xhs: 0, map: 0, hide: 0, show: 0, order: 0, new: 0, del: 0 };
  for (const x of list) {
    if (x.kind === 'tidy') { c.tidy = x.n; continue; }
    if (x.kind === 'new') c.new++; else if (x.kind === 'delete') c.del++;
    else { c.place++; for (const k of x.kind) if (k in c) c[k]++; }
  }
  const parts = [];
  if (c.new) parts.push(`新增 ${c.new} 个地点`);
  if (c.place) parts.push(`更新 ${c.place} 个地点`);
  if (c.cover) parts.push(`${c.cover} 个封面`);
  if (c.xhs) parts.push(`${c.xhs} 个小红书链接`);
  if (c.map) parts.push(`${c.map} 个地图关键词`);
  if (c.hide) parts.push(`隐藏 ${c.hide} 个`);
  if (c.show) parts.push(`恢复 ${c.show} 个`);
  if (c.order) parts.push(`调整 ${c.order} 个顺序`);
  if (c.del) parts.push(`删除 ${c.del} 个`);
  if (c.tidy) parts.push(`整理 ${c.tidy} 处封面图 / 短链接（存进仓库）`);
  return parts;
}

// ============ 小红书链接 ============
const noteIdOf = url => (String(url || '').match(/(?:item|explore)\/([0-9a-f]{24})/) || [])[1] || '';
const extractUrl = s => (String(s || '').match(/https?:\/\/[^\s，。、"'<>]+/) || [])[0] || '';
const normLink = url => noteIdOf(url) || String(url || '').split('?')[0];
const thumbOf = u => String(u).replace('/w/1080/', '/w/360/');

// ============ 需要处理 ============
function issues() {
  const ps = allPlaces(); const ack = new Set(S.ack); const out = { dupXhs: [], cover: [], confirm: [], dupPlace: [] };
  const byLink = {};
  for (const p of ps) if (p.primaryXhsLink) (byLink[normLink(p.primaryXhsLink)] ||= []).push(p);
  for (const [k, l] of Object.entries(byLink)) if (l.length > 1) out.dupXhs.push({ key: k, places: l });
  const auditCover = Object.fromEntries((S.base.audit.cover || []).map(a => [a.id, a]));
  for (const p of ps) {
    if (p.status === 'hidden') continue;
    const a = auditCover[p.id];
    if (!p.cover || p.cover.status === 'missing' || !(p.cover.localPath || p.cover.url)) { if (!ack.has('cover:' + p.id)) out.cover.push({ p, reason: '没有封面' }); }
    else if (a && (p.cover.localPath || '') === a.path && !p.cover.pendingImage && !ack.has('cover:' + p.id)) out.cover.push({ p, reason: a.reason });
    if (p.status === 'draft') out.confirm.push({ p, reason: '还是草稿，没有在前台显示' });
    else if (!REGIONS.includes(p.region)) out.confirm.push({ p, reason: `地区「${p.region}」不在路线里` });
  }
  for (const r of S.base.audit.region || []) {
    const p = ps.find(x => x.id === r.id);
    if (p && p.status !== 'hidden' && !ack.has('region:' + p.id)) out.confirm.push({ p, reason: r.reason });
  }
  for (const d of S.base.audit.duplicatePlaces || []) {
    const l = d.ids.map(id => ps.find(x => x.id === id)).filter(p => p && p.status !== 'hidden');
    if (l.length > 1 && !ack.has('dup:' + d.ids.join(','))) out.dupPlace.push({ places: l, reason: d.reason, key: 'dup:' + d.ids.join(',') });
  }
  return out;
}

// ============ 渲染：首页 ============
const coverSrc = p => {
  const c = p.cover || {};
  if (c.pendingImage) return imgCache[c.pendingImage] || '';
  if (c.localPath) return '../' + c.localPath;
  return c.url || '';
};
const hasCover = p => p.cover && p.cover.status !== 'missing' && !!coverSrc(p);

function placeCard(p) {
  const src = hasCover(p) ? coverSrc(p) : '';
  const edited = !!S.draft.places[p.id];
  const tags = [
    `<span class="a-tag ${p.status === 'published' ? 'pub' : p.status === 'hidden' ? 'hid' : 'draft'}">${STATUS_TEXT[p.status] || p.status}</span>`,
    p.featured ? '<span class="a-tag">置顶</span>' : '',
    !src ? '<span class="a-tag warn">无封面</span>' : '',
    edited ? '<span class="a-tag edit">未发布修改</span>' : '',
  ].join('');
  return `<article class="a-card">
    <button class="a-card-main" data-act="edit" data-id="${esc(p.id)}">
      <span class="a-thumb">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '无图'}</span>
      <span class="a-card-info">
        <span class="a-card-name">${esc(p.name)}</span>
        <span class="a-card-meta">${esc(p.region)} · ${esc((p.category || []).join(' / '))}</span>
        <span class="a-card-sub">${esc(p.cardSubtitle)}</span>
        <span class="a-tags">${tags}</span>
      </span>
    </button>
    <div class="a-card-actions">
      <button data-act="edit" data-id="${esc(p.id)}">编辑</button>
      <button data-act="cover" data-id="${esc(p.id)}">换图</button>
      <button data-act="toggle-hide" data-id="${esc(p.id)}">${p.status === 'hidden' ? '恢复' : '隐藏'}</button>
    </div>
  </article>`;
}

function renderHome() {
  const ps = allPlaces(); const is = issues();
  const issueRows = [
    is.dupXhs.length && ['dupXhs', `重复小红书链接`, `${is.dupXhs.length} 组`],
    is.cover.length && ['cover', '封面待处理', `${is.cover.length} 个`],
    is.confirm.length && ['confirm', '地点待确认', `${is.confirm.length} 个`],
    is.dupPlace.length && ['dupPlace', '可能重复的地点', `${is.dupPlace.length} 组`],
  ].filter(Boolean);
  $('#app').innerHTML = `
    <header class="a-top">
      <div><h1>管理旅行攻略</h1><p>${ps.length} 个地点 · 前台只显示「已发布」</p></div>
      ${API ? `<button class="a-login ${S.user ? 'on' : ''}" data-act="${S.user ? 'logout' : 'login'}">${S.user ? '已登录 ' + esc(S.user) : '登录 GitHub'}</button>` : ''}
    </header>
    ${API ? '' : '<div class="a-banner">发布服务还没接上：现在的修改都会存在这台手机上，设置好之后一键发布，不会丢。</div>'}
    <button class="a-primary" data-act="import">＋ 从小红书添加</button>
    <input class="a-search" id="q" type="search" enterkeyhint="search" placeholder="搜索地点……" value="${esc(S.q)}" autocomplete="off">
    <div class="a-section">需要处理</div>
    <div class="a-issues">${issueRows.length ? issueRows.map(([k, t, n]) =>
      `<button class="a-issue" data-act="issues" data-k="${k}"><span class="dot"></span><span class="txt">${t}</span><span class="n">${n}</span><span class="chev">›</span></button>`).join('')
      : '<div class="a-allgood">都处理好了 ✓</div>'}</div>
    <div id="listWrap"></div>`;
  renderList();
  renderFooter();
}
function renderList() {
  const ps = allPlaces(); const q = S.q.trim().toLowerCase();
  let list;
  if (q) list = ps.filter(p => [p.name, ...(p.aliases || []), p.cardSubtitle, p.region, ...(p.category || [])].join(' ').toLowerCase().includes(q));
  else if (S.region === '已隐藏') list = ps.filter(p => p.status === 'hidden');
  else if (S.region === '草稿') list = ps.filter(p => p.status === 'draft');
  else list = ps.filter(p => p.region === S.region && p.status !== 'hidden');
  const count = r => ps.filter(p => p.region === r && p.status !== 'hidden').length;
  const chips = [...REGIONS.map(r => [r, count(r)]), ['已隐藏', ps.filter(p => p.status === 'hidden').length], ['草稿', ps.filter(p => p.status === 'draft').length]]
    .filter(([r, n]) => REGIONS.includes(r) || n)
    .map(([r, n]) => `<button class="a-chip ${S.region === r && !q ? 'on' : ''}" data-act="region" data-r="${r}">${r}<small>${n}</small></button>`).join('');
  $('#listWrap').innerHTML = `
    <div class="a-section">${q ? `搜索「${esc(S.q)}」· ${list.length} 个` : '地点'}</div>
    ${q ? '' : `<div class="a-chips">${chips}</div>`}
    <div class="a-list">${list.length ? list.map(placeCard).join('') : '<div class="a-empty">这里还没有地点</div>'}</div>`;
}

function renderFooter() {
  let f = $('#footer');
  if (!f) { f = document.createElement('div'); f.id = 'footer'; f.className = 'a-footer'; document.body.appendChild(f); }
  const n = changes().length;
  f.innerHTML = `<div class="a-footer-inner">
    <div class="state">${n ? `<b>有 ${n} 项未发布修改</b>已保存到本机` : '<b>没有未发布的修改</b>和线上一致'}</div>
    <button class="a-btn red" data-act="publish" ${n && !S.publishing ? '' : 'disabled'}>${S.publishing ? '发布中…' : n ? `发布 ${n} 项` : '发布'}</button>
  </div>`;
}

// ============ 渲染：编辑页 ============
function field(label, key, p, opt = {}) {
  let v = p[key];
  if (Array.isArray(v)) v = v.join('、');
  const empty = !String(v || '').trim();
  return `<div class="a-field" data-field="${key}">
    <div class="lbl">${label}${opt.hint ? `<em>${opt.hint}</em>` : ''}</div>
    <button class="a-val ${empty ? 'ph' : ''}" data-act="inline" data-f="${key}" data-multi="${opt.multi ? 1 : ''}">${empty ? esc(opt.ph || '点这里填写') : esc(v)}</button>
  </div>`;
}

function renderEditor() {
  const p = getPlace(S.editing); if (!p) { closeEditor(); return; }
  const notes = allNotes(); const src = hasCover(p) ? coverSrc(p) : '';
  const regionList = allPlaces().filter(x => x.region === p.region);
  const idx = regionList.findIndex(x => x.id === p.id);
  const dupCount = p.primaryXhsLink ? allPlaces().filter(x => x.primaryXhsLink && normLink(x.primaryXhsLink) === normLink(p.primaryXhsLink)).length : 0;
  const coverMark = { verified: '实拍', location_only: '区域实拍' }[p.cover?.status] || '';
  let ed = $('#editor');
  if (!ed) { ed = document.createElement('div'); ed.id = 'editor'; ed.className = 'a-editor'; document.body.appendChild(ed); }
  const keepScroll = ed.scrollTop;
  ed.innerHTML = `<div class="a-editor-inner">
    <div class="a-ebar"><button class="a-back" data-act="back">‹ 返回</button><div class="t">${esc(p.name)}</div>
      <span class="a-tag ${p.status === 'published' ? 'pub' : p.status === 'hidden' ? 'hid' : 'draft'}">${STATUS_TEXT[p.status]}</span></div>
    <div class="a-cover">${src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : '<div class="none">暂无可靠封面</div>'}
      ${coverMark && src ? `<span class="mark">${coverMark}</span>` : ''}
      <button class="a-cover-btn" data-act="cover" data-id="${esc(p.id)}">更换封面</button></div>
    <div class="a-fields">
      ${field('地点名称', 'name', p)}
      <div class="a-field"><div class="lbl">地区</div><div class="a-seg">${REGIONS.map(r =>
        `<button class="${p.region === r ? 'on' : ''}" data-act="set-region" data-v="${r}">${r}</button>`).join('')}</div></div>
      <div class="a-field"><div class="lbl">类型<em>可以多选</em></div><div class="a-seg">${KINDS.map(k =>
        `<button class="${(p.category || []).includes(k) ? 'on' : ''}" data-act="toggle-kind" data-v="${k}">${k}</button>`).join('')}</div></div>
      ${field('一句话', 'cardSubtitle', p, { hint: '卡片上显示' })}
      ${field('详细介绍', 'description', p, { multi: true })}
      ${field('为什么值得去', 'why', p, { multi: true, ph: '可以不填' })}
      ${field('推荐', 'mustTry', p, { hint: '用「、」分开' })}
      ${field('适合什么时候去', 'bestTime', p)}
    </div>
    <div class="a-section">小红书</div>
    <div class="a-fields">
      <div class="a-field" data-field="primaryXhsLink">
        <div class="lbl">独立笔记链接<em>只讲这一家的笔记</em></div>
        <button class="a-val ${p.primaryXhsLink ? '' : 'ph'}" data-act="inline" data-f="primaryXhsLink">${p.primaryXhsLink ? esc(p.primaryXhsLink) : '没有 → 前台打开小红书搜索'}</button>
        ${dupCount > 1 ? `<div class="a-hint warn">⚠ 这个链接被 ${dupCount} 个地点使用</div>` : ''}
        ${p.primaryXhsLink ? `<div class="a-row"><button class="a-btn light" data-act="clear-primary">改成用搜索</button></div>` : ''}
      </div>
      ${field('小红书搜索关键词', 'xhsKeyword', p)}
      <div class="a-field"><div class="lbl">参考攻略<em>合集笔记放这里</em></div>
        <div class="a-notes">${(p.sourceNotes || []).map(id => notes[id]).filter(Boolean).map(n => `<div class="a-note">
          <span>${esc(n.title || '笔记')}${n.placeIds && n.placeIds.length > 1 ? ` · 合集 ${n.placeIds.length} 家` : ''}</span>
          ${p.primaryXhsLink === n.url ? '<span class="a-tag pub">主链接</span>' : `<button data-act="set-primary" data-note="${esc(n.id)}">设为主链接</button>`}
        </div>`).join('') || '<div class="a-hint">没有</div>'}</div></div>
    </div>
    <div class="a-section">百度地图</div>
    <div class="a-fields">${field('搜索关键词', 'mapKeyword', p, { hint: '点「百度地图」时搜这个' })}</div>
    <div class="a-section">显示</div>
    <div class="a-fields">
      <div class="a-field"><div class="a-row">
        <button class="a-btn light" data-act="toggle-feature">${p.featured ? '取消置顶' : '置顶'}</button>
        <button class="a-btn light" data-act="move" data-d="-1" ${idx <= 0 ? 'disabled' : ''}>上移</button>
        <button class="a-btn light" data-act="move" data-d="1" ${idx < 0 || idx >= regionList.length - 1 ? 'disabled' : ''}>下移</button>
      </div><div class="a-hint">在「${esc(p.region)}」里排第 ${idx + 1} / ${regionList.length}</div></div>
      <div class="a-field"><div class="a-row">
        ${p.status === 'hidden'
          ? '<button class="a-btn dark" data-act="toggle-hide-ed">恢复显示</button>'
          : p.status === 'draft' ? '<button class="a-btn dark" data-act="publish-draft">在前台显示</button><button class="a-btn light" data-act="toggle-hide-ed">隐藏</button>'
          : '<button class="a-btn light" data-act="toggle-hide-ed">隐藏这个地点</button>'}
      </div><div class="a-hint">隐藏后前台看不到，后台保留，随时能恢复。</div></div>
      <div class="a-field a-danger-zone" id="delzone"><button class="a-btn danger" data-act="ask-delete" style="width:100%">删除</button></div>
    </div>
  </div>`;
  ed.scrollTop = keepScroll;
}
function openEditor(id) { S.editing = id; renderEditor(); document.documentElement.style.overflow = 'hidden'; }
function closeEditor() {
  S.editing = null; const ed = $('#editor'); if (ed) ed.remove();
  document.documentElement.style.overflow = ''; renderHome();
}

// 点文字直接编辑
function startInline(btn) {
  const f = btn.dataset.f; const p = getPlace(S.editing); if (!p) return;
  let v = p[f]; if (Array.isArray(v)) v = v.join('、');
  const multi = btn.dataset.multi === '1' || String(v || '').length > 40;
  const el = document.createElement(multi ? 'textarea' : 'input');
  el.className = 'a-input'; el.value = v || ''; el.dataset.f = f;
  if (!multi) { el.type = f === 'primaryXhsLink' ? 'url' : 'text'; el.enterKeyHint = 'done'; }
  if (f === 'primaryXhsLink') el.placeholder = '粘贴小红书链接或分享文字';
  btn.replaceWith(el);
  const grow = () => { if (multi) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px'; } };
  el.addEventListener('input', grow); grow();
  el.addEventListener('keydown', e => { if (e.key === 'Enter' && !multi) { e.preventDefault(); el.blur(); } });
  el.addEventListener('blur', () => commitInline(el), { once: true });
  el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* url 输入框不支持 */ }
}
function commitInline(el) {
  const p = getPlace(S.editing); if (!p) return;
  const f = el.dataset.f; let v = el.value.trim();
  if (f === 'mustTry' || f === 'aliases') v = v.split(/[、，,\n]/).map(s => s.trim()).filter(Boolean);
  if (f === 'primaryXhsLink') { v = extractUrl(v) || null; if (el.value.trim() && !v) toast('没找到链接，请粘贴完整的小红书链接'); }
  if (f === 'name' && !v) { toast('地点名称不能为空'); renderEditor(); return; }
  if (!same(p[f], v)) { p[f] = v; savePlace(p); toast('已保存到本机', 1200); }
  if (f === 'primaryXhsLink') { setTimeout(renderEditor, 350); return; }   // 这一格有联动提示，稍后再重画
  const tmp = document.createElement('div'); tmp.innerHTML = field('', f, getPlace(S.editing), { multi: el.tagName === 'TEXTAREA' });
  el.replaceWith(tmp.querySelector('.a-val'));
  if (f === 'name') { const t = document.querySelector('.a-ebar .t'); if (t) t.textContent = v; }
}

// ============ 换封面 ============
let coverTarget = null; let coverPick = null;
function openCoverSheet(id) {
  coverTarget = id; coverPick = null;
  const p = getPlace(id); const notes = allNotes();
  const own = new Set(p.coverCandidates || []);
  const cands = []; const seen = new Set();
  const noteOf = u => (p.sourceNotes || []).map(id => notes[id]).find(n => n && (n.images || []).includes(u)) || { url: '', title: '', images: [] };
  for (const u of p.coverCandidates || []) if (!seen.has(u)) { seen.add(u); cands.push({ url: u, note: noteOf(u), own: true }); }
  for (const nid of p.sourceNotes || []) {
    const n = notes[nid]; if (!n) continue;
    (n.images || []).forEach(u => { if (!seen.has(u)) { seen.add(u); cands.push({ url: u, note: n, own: false }); } });
  }
  const ownN = cands.filter(c => c.own).length;
  const cur = hasCover(p) ? coverSrc(p) : '';
  openSheet(`<div class="grab"></div><h3>换封面</h3><p class="sub">${esc(p.name)}</p>
    <div class="a-cover" style="margin:0">${cur ? `<img src="${esc(cur)}" alt="" referrerpolicy="no-referrer">` : '<div class="none">暂无可靠封面</div>'}<span class="mark">当前封面</span></div>
    ${(() => {
      const pno = c => { const i = (c.note.images || []).indexOf(c.url); return i >= 0 ? 'P' + (i + 1) : ''; };
      const tile = (c, k) => `<button data-act="pick-cand" data-k="${k}">
        <img src="${esc(thumbOf(c.url))}" alt="" loading="lazy" referrerpolicy="no-referrer">
        ${c.url === p.cover?.url ? '<span class="badge">当前</span>' : pno(c) ? `<span class="badge pno">${pno(c)}</span>` : ''}</button>`;
      const ownHtml = cands.map((c, k) => c.own ? tile(c, k) : '').join('');
      // 其他图按笔记分组，附笔记原文（原文里常写「P3-4 是哪家」）
      const byNote = new Map();
      cands.forEach((c, k) => { if (!c.own) { const key = c.note.id || c.note.url; if (!byNote.has(key)) byNote.set(key, { note: c.note, tiles: [] }); byNote.get(key).tiles.push(tile(c, k)); } });
      const otherN = cands.length - ownN;
      const groupsHtml = [...byNote.values()].map(g => `<div class="a-notegrp">
          <div class="a-section" style="margin-top:14px">《${esc(g.note.title || '笔记')}》</div>
          ${g.note.desc ? `<details class="a-desc"><summary>看笔记原文（找 P 几是哪家）</summary><div>${esc(g.note.desc)}</div></details>` : ''}
          <div class="a-grid">${g.tiles.join('')}</div></div>`).join('');
      return (ownN ? `<div class="a-section">这家店的图（${ownN}）</div><div class="a-grid">${ownHtml}</div>` : '')
        + (otherN ? (ownN
          ? `<button class="a-btn light" style="width:100%;margin-top:10px" data-act="show-other-imgs">笔记里的其他图片（${otherN}）</button><div id="otherImgs" hidden>${groupsHtml}</div>`
          : groupsHtml) : '');
    })()}
    <div class="a-actions">
      <label class="a-btn dark a-file">从相册选择<input type="file" accept="image/*" data-act="upload"></label>
      <label class="a-btn light a-file">拍照<input type="file" accept="image/*" capture="environment" data-act="upload"></label>
      <button class="a-btn light" data-act="cover-url">粘贴图片链接</button>
      <label class="a-check"><input type="checkbox" id="coverExact" ${p.cover?.status !== 'location_only' ? 'checked' : ''}> 这张图确实是这家店 / 这个地点</label>
      <div class="a-hint">不勾选＝只能确认是这个区域，前台会标「区域实拍」。</div>
      <button class="a-btn red" data-act="cover-done" disabled id="coverDone">用这张</button>
      ${cur ? '<button class="a-btn light" data-act="cover-remove">不用封面（显示无图卡）</button>' : ''}
    </div>`);
  S.coverCands = cands;
}
function applyCover(cover) {
  const p = getPlace(coverTarget); if (!p) return;
  const exact = $('#coverExact') ? $('#coverExact').checked : true;
  p.cover = { ...cover, status: cover.status === 'missing' ? 'missing' : exact ? 'verified' : 'location_only' };
  savePlace(p); closeSheet(); toast('封面已换，发布后生效');
  if (S.editing) renderEditor(); else renderHome();
}
function setCoverPreview(src) {
  const box = $('#sheet .a-cover'); if (box) box.innerHTML = `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer"><span class="mark">新封面</span>`;
  const d = $('#coverDone'); if (d) d.disabled = false;
}

// ============ 底部弹层 ============
function openSheet(html) {
  const s = $('#sheet'); s.innerHTML = html; s.scrollTop = 0;
  s.classList.add('open'); s.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('open');
}
function closeSheet() {
  const s = $('#sheet'); s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); $('#scrim').classList.remove('open');
  S.importState = null;
}

// ============ 需要处理：详情 ============
function openIssues(k) {
  const is = issues(); let body = '';
  const row = (p, reason, extra = '') => `<div class="a-cand"><div class="top">
      ${hasCover(p) ? `<img src="${esc(coverSrc(p))}" alt="" referrerpolicy="no-referrer">` : ''}
      <div style="flex:1;min-width:0"><div class="nm">${esc(p.name)}</div><div class="mt">${esc(p.region)} · ${STATUS_TEXT[p.status]}</div>
      <div class="ds">${esc(reason)}</div></div></div>
      <div class="opt"><button data-act="edit" data-id="${esc(p.id)}">编辑</button>${extra}</div></div>`;
  if (k === 'dupXhs') {
    body = '<h3>重复小红书链接</h3><p class="sub">同一篇笔记被当成多个地点的主链接。合集建议改成「用搜索」，只放在参考攻略里。</p>' +
      is.dupXhs.map(g => `<div class="a-section">⚠ 该链接被 ${g.places.length} 个地点使用</div>` +
        g.places.map(p => row(p, p.primaryXhsLink, `<button data-act="clear-primary-id" data-id="${esc(p.id)}">改成用搜索</button>`)).join('')).join('');
  } else if (k === 'cover') {
    body = `<h3>封面待处理</h3><p class="sub">${is.cover.length} 个，点「换图」直接换；觉得没问题就点「没问题」。</p>` +
      is.cover.map(x => row(x.p, x.reason, `<button data-act="cover" data-id="${esc(x.p.id)}">换图</button><button data-act="ack" data-k="cover:${esc(x.p.id)}">没问题</button>`)).join('');
  } else if (k === 'confirm') {
    body = `<h3>地点待确认</h3><p class="sub">不对的可以改地区或隐藏。</p>` +
      is.confirm.map(x => row(x.p, x.reason, `<button data-act="toggle-hide" data-id="${esc(x.p.id)}">隐藏</button><button data-act="ack" data-k="region:${esc(x.p.id)}">没问题</button>`)).join('');
  } else if (k === 'dupPlace') {
    body = `<h3>可能重复的地点</h3><p class="sub">不需要的隐藏掉就行。</p>` +
      is.dupPlace.map(g => `<div class="a-section">${esc(g.reason)} · <button class="a-link" data-act="ack" data-k="${esc(g.key)}">不是重复</button></div>` +
        g.places.map(p => row(p, p.cardSubtitle, `<button data-act="toggle-hide" data-id="${esc(p.id)}">隐藏</button>`)).join('')).join('');
  }
  openSheet('<div class="grab"></div>' + body + '<div class="a-actions"><button class="a-btn light" data-act="close-sheet">关闭</button></div>');
  S.openIssue = k;
}

// ============ 登录与发布 ============
async function api(path, body) {
  if (!API) throw new Error('发布服务还没接上');
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(S.session ? { Authorization: 'Bearer ' + S.session } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await r.json(); } catch (e) { /* 非 JSON */ }
  if (r.status === 401) { S.session = ''; S.user = ''; store.del(SESSION_KEY); throw Object.assign(new Error('登录过期了，请重新登录 GitHub'), { auth: true }); }
  if (!r.ok || data.ok === false) throw new Error(data.error || `服务返回 ${r.status}`);
  return data;
}
function login() { location.href = `${API}/auth/login?return=${encodeURIComponent(location.href.split('#')[0])}`; }
async function checkSession() {
  if (!API || !S.session) return;
  try { const me = await api('/api/me'); S.user = me.login || ''; } catch (e) { S.user = ''; }
  if (!S.editing) renderHome();
}

function askPublish() {
  const list = changes(); if (!list.length) return;
  if (!API) {
    openSheet(`<div class="grab"></div><h3>还不能发布</h3><p class="sub">发布服务还没接上。</p>
      <div class="a-sum">这 ${list.length} 项修改已经存在这台手机上，不会丢。<br>发布服务设置好以后，回到这里点「发布」就行。</div>
      <div class="a-actions"><button class="a-btn light" data-act="close-sheet">知道了</button></div>`);
    return;
  }
  if (!S.session || !S.user) {
    openSheet(`<div class="grab"></div><h3>先登录 GitHub</h3><p class="sub">只有 linlinfangting-wq 能发布。修改会一直保存在本机。</p>
      <div class="a-actions"><button class="a-btn dark" data-act="login">用 GitHub 登录</button><button class="a-btn light" data-act="close-sheet">取消</button></div>`);
    return;
  }
  openSheet(`<div class="grab"></div><h3>发布 ${list.length} 项修改</h3><p class="sub">将更新：</p>
    <div class="a-sum">${changeSummary(list).map(esc).join('<br>')}</div>
    <div class="a-actions"><button class="a-btn red" data-act="do-publish">确认发布</button><button class="a-btn light" data-act="close-sheet">再看看</button></div>`);
}

async function doPublish() {
  if (S.publishing) return;
  S.publishing = true; renderFooter();
  openSheet(`<div class="grab"></div><h3>正在发布…</h3><p class="sub">上传图片和数据，请不要关掉页面。</p>`);
  try {
    const images = [];
    const places = allPlaces().map(p => {
      const c = clone(p);
      if (c.cover?.pendingImage) {
        const data = imgCache[c.cover.pendingImage];
        if (data) images.push({ path: c.cover.localPath, data: data.split(',')[1] });
        delete c.cover.pendingImage;
      }
      return c;
    });
    const notes = Object.values(allNotes()).map(n => ({ ...n, placeIds: places.filter(p => (p.sourceNotes || []).includes(n.id)).map(p => p.id) }))
      .filter(n => n.placeIds.length).sort((a, b) => a.id.localeCompare(b.id));
    const res = await api('/api/publish', { places, notes, images, summary: changeSummary(changes()).join('；') });
    for (const p of Object.values(S.draft.places)) if (p.cover?.pendingImage) { try { await idb.del(p.cover.pendingImage); } catch (e) { /* 忽略 */ } }
    S.base.places = res.places || places.map(stripDraft);
    S.base.notes = res.notes || notes;
    S.draft = { places: {}, removed: [], notes: {} }; saveDraft();
    S.publishing = false;
    openSheet(`<div class="grab"></div><h3>✓ 已发布</h3><p class="sub">GitHub Pages 大约 1 分钟后更新，原来的网址不变。${res.pending ? `<br>还有 ${res.pending} 张封面暂时用小红书原图显示，下次发布会自动存好。` : ''}</p>
      <div class="a-actions"><a class="a-btn dark a-file" href="${esc((CFG.siteUrl || '../') + '?v=' + Date.now())}" target="_blank" rel="noopener">打开旅行页面</a><button class="a-btn light" data-act="close-sheet">好</button></div>`);
  } catch (e) {
    S.publishing = false;
    openSheet(`<div class="grab"></div><h3>发布失败</h3><p class="sub">${esc(e.message)}</p>
      <div class="a-sum">修改已保存在本机，没有丢。</div>
      <div class="a-actions">${e.auth ? '<button class="a-btn dark" data-act="login">重新登录 GitHub</button>' : '<button class="a-btn red" data-act="do-publish">重试</button>'}
      <button class="a-btn light" data-act="close-sheet">稍后再说</button></div>`);
  }
  renderFooter(); if (S.editing) renderEditor(); else renderHome();
}

// ============ 智能导入 ============
function openImport() {
  S.importState = { step: 'input', files: [] };
  openSheet(`<div class="grab"></div><h3>从小红书添加</h3><p class="sub">一篇笔记里可能有好几家店，会一起识别出来，确认后才会加入。</p>
    <textarea class="a-input" id="impText" rows="3" placeholder="粘贴小红书链接或分享文字"></textarea>
    <div class="a-actions">
      <label class="a-btn light a-file" id="impFileLbl">上传截图 / 图片（可多选）<input type="file" accept="image/*" multiple data-act="imp-files"></label>
      <div class="a-hint" id="impFiles">小红书网页要登录才能看，服务器一般读不到笔记里的图。最准的做法：粘贴链接，再上传 3～9 张笔记截图（带店名、门头、菜单的那几张）。视频识别还没做，可以截几张关键画面上传。</div>
      <button class="a-btn red" data-act="imp-run">智能识别</button>
      <button class="a-btn light" data-act="new-blank">不识别，手动新建一个地点</button>
    </div>`);
}
async function runImport() {
  const text = ($('#impText') || {}).value || '';
  const url = extractUrl(text);
  const files = (S.importState || {}).files || [];
  if (!text.trim() && !files.length) { toast('先粘贴链接或上传图片'); return; }
  if (!API) { toast('发布服务还没接上，智能识别暂时用不了'); return; }
  if (!S.session || !S.user) { toast('先登录 GitHub'); login(); return; }
  const steps = [['读取笔记', 'run'], ['识别图片里的店名', 'todo'], ['整理地点、判断地区、去重', 'todo']];
  const draw = () => openSheet(`<div class="grab"></div><h3>正在识别…</h3><ul class="a-progress">${steps.map(([t, s]) =>
    `<li class="${s}">${s === 'done' ? '✓' : s === 'run' ? '●' : '○'} ${t}</li>`).join('')}</ul><p class="sub">图片多的话要十几秒到一分钟。</p>`);
  draw();
  try {
    const images = [];
    for (const f of files.slice(0, 12)) images.push(await compressImage(f, 1280, 0.8));
    steps[0][1] = 'done'; steps[1][1] = 'run'; draw();
    const existing = allPlaces().map(p => ({ id: p.id, name: p.name, region: p.region, aliases: p.aliases || [] }));
    const tick = setTimeout(() => { steps[1][1] = 'done'; steps[2][1] = 'run'; draw(); }, 6000);
    const res = await api('/api/analyze-note', { url, text, images, existing });
    clearTimeout(tick);
    S.importState = { step: 'result', res, files, uploads: images };
    renderImportResult();
  } catch (e) {
    openSheet(`<div class="grab"></div><h3>识别没成功</h3><p class="sub">${esc(e.message)}</p>
      <div class="a-actions"><button class="a-btn dark" data-act="import">重新试试</button><button class="a-btn light" data-act="close-sheet">关闭</button></div>`);
  }
}
function renderImportResult() {
  const st = S.importState; const res = st.res; const cands = res.candidates || [];
  st.pick = st.pick || cands.map(c => c.inRoute !== false && c.confidence !== 'low');
  st.mode = st.mode || cands.map(c => (c.existingId && getPlace(c.existingId) ? 'update' : 'new'));
  const imgUrl = i => (res.images || [])[i] || (st.uploads || [])[i - (res.images || []).length] || '';
  const n = st.pick.filter(Boolean).length;
  openSheet(`<div class="grab"></div><h3>识别到 ${cands.length} 个地点</h3>
    <p class="sub">${res.note && res.note.title ? '来自《' + esc(res.note.title) + '》· ' : ''}${esc(res.message || '')}</p>
    ${res.readStatus && res.readStatus !== 'full' ? '<div class="a-banner">这篇笔记没能完整读取，结果可能不全。可以上传截图再识别一次。</div>' : ''}
    ${cands.map((c, i) => {
      const ex = c.existingId && getPlace(c.existingId);
      const img = c.coverImageIndex != null ? imgUrl(c.coverImageIndex) : '';
      return `<div class="a-cand ${st.pick[i] ? '' : 'off'}"><div class="top">
        <input type="checkbox" data-act="imp-pick" data-i="${i}" ${st.pick[i] ? 'checked' : ''} aria-label="选择 ${esc(c.name)}">
        <div style="flex:1;min-width:0"><div class="nm">${esc(c.name)}</div>
          <div class="mt">${esc(c.region || '地区不确定')} · ${esc((c.category || []).join(' / '))}${c.inRoute === false ? ' · <b style="color:#B7791F">⚠ 不在当前路线</b>' : ''}${c.confidence === 'low' ? ' · 不太确定' : ''}</div>
          <div class="ds">${esc(c.cardSubtitle || '')}${(c.mustTry || []).length ? ' · ' + esc(c.mustTry.join(' / ')) : ''}</div></div>
        ${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer">` : ''}</div>
        ${ex ? `<div class="ds">可能已存在：${esc(ex.name)}</div><div class="opt">
          <button class="${st.mode[i] === 'update' ? 'on' : ''}" data-act="imp-mode" data-i="${i}" data-v="update">更新现有</button>
          <button class="${st.mode[i] === 'new' ? 'on' : ''}" data-act="imp-mode" data-i="${i}" data-v="new">仍然新增</button></div>` : ''}
      </div>`;
    }).join('') || '<div class="a-empty">没有识别到具体地点</div>'}
    <div class="a-actions"><button class="a-btn red" data-act="imp-add" ${n ? '' : 'disabled'}>添加 ${n} 个地点</button>
      <button class="a-btn light" data-act="close-sheet">取消</button></div>`);
}
async function addImported() {
  const st = S.importState; const res = st.res; const cands = res.candidates || [];
  const note = res.note && (res.note.url || res.note.title) ? res.note : null;
  let noteId = null;
  if (note) {
    const nid = noteIdOf(note.url);
    const same = Object.values(allNotes()).find(n => (nid && n.noteId === nid) || (note.url && n.url === note.url));
    noteId = same ? same.id : 'note-' + (nid || Date.now().toString(36));
    const exist = allNotes()[noteId];
    S.draft.notes[noteId] = { id: noteId, noteId: nid, title: note.title || '小红书笔记', url: note.url || '', source: 'xiaohongshu', likes: String(note.likes || ''), desc: note.desc || (exist && exist.desc) || '',
      placeIds: [], images: res.images || [], ...(exist ? { images: exist.images?.length ? exist.images : res.images || [] } : {}) };
  }
  const chosen = cands.map((c, i) => ({ c, i })).filter(x => st.pick[x.i]);
  const single = chosen.length === 1 && cands.length === 1;
  let added = 0, updated = 0;
  const maxOrder = Math.max(0, ...allPlaces().map(p => p.sortOrder || 0));
  for (const { c, i } of chosen) {
    const imgIdx = c.coverImageIndex;
    let cover = { url: '', localPath: '', source: '', sourceUrl: '', status: 'missing' };
    if (imgIdx != null && c.coverConfidence !== 'low') {
      const remote = (res.images || [])[imgIdx];
      const upIdx = imgIdx - (res.images || []).length;
      if (remote) cover = { url: remote, localPath: '', source: '小红书笔记', sourceUrl: note ? note.url : '', status: 'verified' };
      else if (st.uploads && st.uploads[upIdx]) {
        const key = 'img-' + Date.now().toString(36) + '-' + i; imgCache[key] = st.uploads[upIdx];
        try { await idb.put(key, st.uploads[upIdx]); } catch (e) { /* 仍可在本次会话发布 */ }
        cover = { url: '', localPath: '', source: '我上传的截图', sourceUrl: note ? note.url : '', status: 'verified', pendingImage: key };
      }
    }
    const ownImgs = (c.imageIndexes || []).map(k => (res.images || [])[k]).filter(Boolean);   // 只记笔记里的原图地址，上传的截图不记
    if (st.mode[i] === 'update' && c.existingId && getPlace(c.existingId)) {
      const p = getPlace(c.existingId);
      if (ownImgs.length) p.coverCandidates = [...new Set([...(p.coverCandidates || []), ...ownImgs])];
      if (noteId && !(p.sourceNotes || []).includes(noteId)) p.sourceNotes = [...(p.sourceNotes || []), noteId];
      for (const k of ['cardSubtitle', 'description', 'bestTime', 'mapKeyword', 'xhsKeyword']) if (!p[k] && c[k]) p[k] = c[k];
      if ((!p.mustTry || !p.mustTry.length) && c.mustTry) p.mustTry = c.mustTry;
      if ((!p.cover || p.cover.status === 'missing') && cover.status !== 'missing') { if (cover.pendingImage) cover.localPath = `assets/place-images/${p.id}-${Date.now().toString(36)}.jpg`; p.cover = cover; }
      p.aliases = [...new Set([...(p.aliases || []), ...(c.aliases || []), c.name].filter(a => a && a !== p.name))];
      savePlace(p); updated++;
    } else {
      const region = REGIONS.includes(c.region) ? c.region : '普洱';
      const id = `${REGION_SLUG[region]}-${Date.now().toString(36)}${i}`;
      if (cover.pendingImage) cover.localPath = `assets/place-images/${id}.jpg`;
      const p = {
        id, name: c.name, aliases: c.aliases || [], region, category: (c.category || []).filter(k => KINDS.includes(k)).slice(0, 2),
        cardSubtitle: c.cardSubtitle || '', description: c.description || '', why: c.why || '', mustTry: c.mustTry || [], bestTime: c.bestTime || '',
        cover, coverCandidates: ownImgs, primaryXhsLink: single && note && note.url ? note.url : null,
        xhsKeyword: c.xhsKeyword || `${region} ${c.name}`, mapKeyword: c.mapKeyword || c.name,
        sourceNotes: noteId ? [noteId] : [], status: REGIONS.includes(c.region) && c.inRoute !== false ? 'published' : 'draft',
        featured: false, sortOrder: maxOrder + (added + 1) * 10,
      };
      if (!p.category.length) p.category = ['逛'];
      S.draft.places[id] = p; added++;
    }
  }
  saveDraft(); closeSheet();
  toast(`已加入草稿：新增 ${added} 个${updated ? `，更新 ${updated} 个` : ''}，发布后生效`, 3000);
  renderHome();
}
function newBlank() {
  const id = `${REGION_SLUG[S.region] || 'puer'}-${Date.now().toString(36)}`;
  const region = REGIONS.includes(S.region) ? S.region : '普洱';
  S.draft.places[id] = { id, name: '新地点', aliases: [], region, category: ['吃'], cardSubtitle: '', description: '', why: '', mustTry: [], bestTime: '',
    cover: { url: '', localPath: '', source: '', sourceUrl: '', status: 'missing' }, primaryXhsLink: null, xhsKeyword: '', mapKeyword: '',
    sourceNotes: [], status: 'draft', featured: false, sortOrder: Math.max(0, ...allPlaces().map(p => p.sortOrder || 0)) + 10 };
  saveDraft(); closeSheet(); openEditor(id);
}

// ============ 事件 ============
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  const act = t.dataset.act; const id = t.dataset.id;
  if (t.tagName === 'INPUT' && t.type === 'file') return;          // 文件选择在 change 事件里处理
  if (t.tagName === 'INPUT' && t.type === 'checkbox' && act !== 'imp-pick') return;
  switch (act) {
    case 'region': S.region = t.dataset.r; renderList(); break;
    case 'edit': closeSheet(); openEditor(id); break;
    case 'back': closeEditor(); break;
    case 'inline': startInline(t); break;
    case 'cover': openCoverSheet(id); break;
    case 'toggle-hide': {
      const p = getPlace(id); p.status = p.status === 'hidden' ? 'published' : 'hidden'; savePlace(p);
      toast(p.status === 'hidden' ? `已隐藏「${p.name}」，发布后前台消失` : `已恢复「${p.name}」`);
      if (S.openIssue && $('#sheet').classList.contains('open')) openIssues(S.openIssue);
      if (S.editing) renderEditor(); else renderHome(); break;
    }
    case 'toggle-hide-ed': { const p = getPlace(S.editing); p.status = p.status === 'hidden' ? 'published' : 'hidden'; savePlace(p); renderEditor(); toast(p.status === 'hidden' ? '已隐藏，发布后前台消失' : '已恢复显示'); break; }
    case 'publish-draft': { const p = getPlace(S.editing); p.status = 'published'; savePlace(p); renderEditor(); toast('发布后会在前台显示'); break; }
    case 'set-region': { const p = getPlace(S.editing); p.region = t.dataset.v; savePlace(p); renderEditor(); break; }
    case 'toggle-kind': {
      const p = getPlace(S.editing); const k = t.dataset.v; const c = new Set(p.category || []);
      if (c.has(k)) { if (c.size === 1) { toast('至少保留一个类型'); break; } c.delete(k); } else c.add(k);
      p.category = KINDS.filter(x => c.has(x)); savePlace(p); renderEditor(); break;
    }
    case 'toggle-feature': { const p = getPlace(S.editing); p.featured = !p.featured; savePlace(p); renderEditor(); toast(p.featured ? '已置顶' : '已取消置顶'); break; }
    case 'move': {
      const p = getPlace(S.editing); const list = allPlaces().filter(x => x.region === p.region);
      const i = list.findIndex(x => x.id === p.id); const j = i + Number(t.dataset.d);
      if (j < 0 || j >= list.length) break;
      const q = clone(list[j]);
      if (p.featured !== q.featured) { toast('置顶的地点和普通地点之间不能直接交换'); break; }
      [p.sortOrder, q.sortOrder] = [q.sortOrder, p.sortOrder];
      if (p.sortOrder === q.sortOrder) p.sortOrder += Number(t.dataset.d);
      savePlace(p); savePlace(q); renderEditor(); break;
    }
    case 'clear-primary': { const p = getPlace(S.editing); p.primaryXhsLink = null; savePlace(p); renderEditor(); toast('前台改成打开小红书搜索'); break; }
    case 'clear-primary-id': { const p = getPlace(id); p.primaryXhsLink = null; savePlace(p); openIssues('dupXhs'); break; }
    case 'set-primary': { const p = getPlace(S.editing); const n = allNotes()[t.dataset.note]; if (n) { p.primaryXhsLink = n.url; savePlace(p); renderEditor(); toast('已设为主链接'); } break; }
    case 'ask-delete': {
      $('#delzone').innerHTML = `<div class="a-hint">确定删除？删除后发布就会从线上移除，只想不显示请用「隐藏」。</div>
        <div class="a-row"><button class="a-btn light" data-act="cancel-delete">取消</button><button class="a-btn danger" data-act="do-delete">确定删除</button></div>`; break;
    }
    case 'cancel-delete': renderEditor(); break;
    case 'do-delete': {
      const pid = S.editing; const inBase = !!baseById()[pid];
      delete S.draft.places[pid]; if (inBase && !S.draft.removed.includes(pid)) S.draft.removed.push(pid);
      saveDraft(); closeEditor(); toast('已删除，发布后生效'); break;
    }
    case 'issues': openIssues(t.dataset.k); break;
    case 'ack': S.ack = [...new Set([...S.ack, t.dataset.k])]; store.set(ACK_KEY, S.ack); openIssues(S.openIssue); renderHome(); break;
    case 'close-sheet': closeSheet(); if (!S.editing) renderHome(); break;
    case 'pick-cand': {
      const c = S.coverCands[Number(t.dataset.k)]; coverPick = { url: c.url, localPath: '', source: '小红书笔记', sourceUrl: c.note.url, status: 'verified' };
      document.querySelectorAll('.a-grid button').forEach(b => b.classList.toggle('on', b === t)); setCoverPreview(c.url); break;
    }
    case 'cover-url': {
      const box = document.createElement('div'); box.className = 'a-row';
      box.innerHTML = '<input class="a-input" id="coverUrlIn" type="url" placeholder="粘贴图片链接" style="margin:0">';
      t.replaceWith(box); const input = $('#coverUrlIn'); input.focus();
      input.addEventListener('change', () => { const u = extractUrl(input.value); if (!u) { toast('不是有效的图片链接'); return; }
        coverPick = { url: u, localPath: '', source: '网络图片', sourceUrl: u, status: 'verified' }; setCoverPreview(u); });
      break;
    }
    case 'show-other-imgs': { const g = $('#otherImgs'); if (g) { g.hidden = false; t.remove(); } break; }
    case 'cover-done': if (coverPick) applyCover(coverPick); break;
    case 'cover-remove': applyCover({ url: '', localPath: '', source: '', sourceUrl: '', status: 'missing' }); break;
    case 'publish': askPublish(); break;
    case 'do-publish': doPublish(); break;
    case 'login': login(); break;
    case 'logout': S.session = ''; S.user = ''; store.del(SESSION_KEY); renderHome(); toast('已退出'); break;
    case 'import': openImport(); break;
    case 'imp-run': runImport(); break;
    case 'imp-pick': S.importState.pick[Number(t.dataset.i)] = t.checked; renderImportResult(); break;
    case 'imp-mode': S.importState.mode[Number(t.dataset.i)] = t.dataset.v; renderImportResult(); break;
    case 'imp-add': addImported(); break;
    case 'new-blank': newBlank(); break;
    default: break;
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.act === 'upload' && t.files && t.files[0]) {
    try {
      const data = await compressImage(t.files[0]);
      const p = getPlace(coverTarget); const key = 'img-' + Date.now().toString(36);
      imgCache[key] = data;
      try { await idb.put(key, data); } catch (err) { toast('本机图片缓存不可用，请本次打开页面时就发布'); }
      coverPick = { url: '', localPath: `assets/place-images/${p.id}-${Date.now().toString(36)}.jpg`, source: '我上传的', sourceUrl: '', status: 'verified', pendingImage: key };
      setCoverPreview(data);
    } catch (err) { toast(err.message); }
  }
  if (t.dataset.act === 'imp-files' && t.files) {
    S.importState.files = [...t.files];
    const lbl = $('#impFiles'); if (lbl) lbl.textContent = `已选 ${t.files.length} 张图片`;
  }
});
document.addEventListener('input', e => { if (e.target.id === 'q') { S.q = e.target.value; renderList(); } });
$('#scrim').addEventListener('click', () => { closeSheet(); if (!S.editing) renderHome(); });

// iPhone 键盘：让底部按钮浮在键盘上方，输入框滚到可见位置
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.body.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px');
  };
  vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV);
}
document.addEventListener('focusin', e => {
  if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'file') setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

// ============ 启动 ============
async function boot() {
  const m = location.hash.match(/session=([^&]+)/);
  if (m) { S.session = decodeURIComponent(m[1]); store.set(SESSION_KEY, S.session); history.replaceState(null, '', location.pathname + location.search); }
  const get = (f, d) => fetch(`../data/${f}?t=${Date.now()}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : d).catch(() => d);
  const [places, notes, audit] = await Promise.all([get('places.json', null), get('notes.json', []), get('audit.json', {})]);
  if (!places) { $('#app').innerHTML = '<div class="a-loading">数据读取失败，请检查网络后刷新。<br>本机草稿不受影响。</div>'; return; }
  S.base = { places, notes, audit: { cover: [], region: [], duplicatePlaces: [], ...audit } };
  // 找回还没发布的上传图片
  for (const p of Object.values(S.draft.places)) {
    const k = p.cover && p.cover.pendingImage;
    if (k && !imgCache[k]) { try { const v = await idb.get(k); if (v) imgCache[k] = v; } catch (e) { /* 忽略 */ } }
  }
  renderHome();
  checkSession();
}
boot();
})();
