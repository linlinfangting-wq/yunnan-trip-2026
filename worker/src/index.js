// 云南旅行后台的发布服务（Cloudflare Worker）
// - GitHub 登录，只允许 ADMIN_LOGIN 这一个账号
// - /api/publish：服务端用 GITHUB_TOKEN 一次提交 places.json / notes.json / 图片
// - /api/analyze-note：读取小红书笔记 + 图片，用 Claude 识别里面的地点
// 所有密钥只在 Worker 的环境变量里，浏览器拿不到。
import Anthropic from '@anthropic-ai/sdk';

const REGIONS = ['普洱', '景迈山', '孟连', '昆明'];
const KINDS = ['吃', '喝', '逛', '玩', '拍'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------------- 工具 ----------------
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = o => b64url(enc.encode(JSON.stringify(o)));
const fromB64urlJson = s => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
function bufToB64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function sign(secret, payload) { const body = b64urlJson(payload); return `${body}.${await hmac(secret, body)}`; }
async function verify(secret, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || (await hmac(secret, body)) !== sig) return null;
  const p = fromB64urlJson(body);
  return p.exp && p.exp > Date.now() ? p : null;
}
const noteIdOf = url => (String(url || '').match(/(?:item|explore)\/([0-9a-f]{24})/) || [])[1] || '';

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (error, status = 400) => json({ ok: false, error }, status);

async function requireAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const s = await verify(env.SESSION_SECRET, auth.replace(/^Bearer\s+/i, ''));
  return s && s.u === env.ADMIN_LOGIN ? s : null;
}

// ---------------- GitHub 登录 ----------------
async function authLogin(req, env) {
  const url = new URL(req.url);
  const ret = url.searchParams.get('return') || '';
  if (!ret.startsWith(env.ALLOWED_ORIGIN + '/')) return new Response('返回地址不在允许范围内', { status: 400 });
  const state = await sign(env.SESSION_SECRET, { ret, exp: Date.now() + 10 * 60 * 1000 });
  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  gh.searchParams.set('scope', 'read:user');
  gh.searchParams.set('state', state);
  gh.searchParams.set('allow_signup', 'false');
  return Response.redirect(gh.toString(), 302);
}
async function authCallback(req, env) {
  const url = new URL(req.url);
  const st = await verify(env.SESSION_SECRET, url.searchParams.get('state'));
  if (!st) return new Response('登录已过期，请回到后台重新登录', { status: 400 });
  const tok = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code') }),
  }).then(r => r.json());
  if (!tok.access_token) return new Response('GitHub 登录失败，请重试', { status: 400 });
  const user = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'yunnan-trip-admin' } }).then(r => r.json());
  // 只用 GitHub 确认身份，拿到的用户 token 不保存
  if (user.login !== env.ADMIN_LOGIN) return new Response(`账号 ${user.login || ''} 没有权限修改这个旅行页面`, { status: 403 });
  const session = await sign(env.SESSION_SECRET, { u: user.login, exp: Date.now() + 30 * 24 * 3600 * 1000 });
  return Response.redirect(`${st.ret}#session=${encodeURIComponent(session)}`, 302);
}

// ---------------- 发布到 GitHub ----------------
async function gh(env, path, init = {}) {
  const r = await fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'yunnan-trip-admin', 'X-GitHub-Api-Version': '2022-11-28', ...(init.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status}: ${data.message || ''}`), { status: r.status });
  return data;
}
const blob = (env, content, encoding) => gh(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding }) }).then(d => d.sha);

const PLACE_KEYS = ['id', 'name', 'aliases', 'region', 'category', 'cardSubtitle', 'description', 'why', 'mustTry', 'bestTime', 'cover', 'primaryXhsLink', 'xhsKeyword', 'mapKeyword', 'sourceNotes', 'status', 'featured', 'sortOrder'];
const NOTE_KEYS = ['id', 'noteId', 'title', 'url', 'source', 'likes', 'placeIds', 'images'];
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
const IMG_PATH = /^assets\/place-images\/[a-z0-9-]+\.jpg$/;

async function resolveShortLink(url) {
  if (!/xhslink\.com/.test(url)) return url;
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = r.headers.get('Location');
    return loc && noteIdOf(loc) ? loc : url;
  } catch (e) { return url; }
}

async function publish(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.places) || !Array.isArray(body.notes)) return fail('数据格式不对');
  const places = body.places.map(p => pick(p, PLACE_KEYS));
  const ids = new Set();
  for (const p of places) {
    if (!p.id || !/^[a-z0-9-]+$/.test(p.id) || ids.has(p.id)) return fail(`地点 id 不合法或重复：${p.id}`);
    if (!p.name) return fail(`有地点没填名称：${p.id}`);
    ids.add(p.id);
  }
  const files = [];
  // 1) 手机上传的图片
  for (const im of body.images || []) {
    if (!IMG_PATH.test(im.path) || typeof im.data !== 'string') return fail(`图片路径不合法：${im.path}`);
    if (im.data.length > 8 * 1024 * 1024) return fail('单张图片太大');
    files.push({ path: im.path, sha: await blob(env, im.data, 'base64') });
  }
  // 2) 选了小红书图片做封面：服务端下载存进仓库，前台不依赖外链
  for (const p of places) {
    const c = p.cover || {};
    if (c.url && !c.localPath && /xhscdn\.com|xiaohongshu\.com/.test(c.url)) {
      try {
        const r = await fetch(c.url, { headers: { 'User-Agent': UA } });
        if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
          const path = `assets/place-images/${p.id}-${Date.now().toString(36)}.jpg`;
          files.push({ path, sha: await blob(env, bufToB64(await r.arrayBuffer()), 'base64') });
          p.cover = { ...c, localPath: path, url: '' };
        }
      } catch (e) { /* 下载失败就保留外链 */ }
    }
    if (p.primaryXhsLink) p.primaryXhsLink = await resolveShortLink(p.primaryXhsLink);
  }
  const notes = body.notes.map(n => pick(n, NOTE_KEYS));
  files.push({ path: 'data/places.json', sha: await blob(env, JSON.stringify(places, null, 2) + '\n', 'utf-8') });
  files.push({ path: 'data/notes.json', sha: await blob(env, JSON.stringify(notes, null, 2) + '\n', 'utf-8') });

  // 3) 一次提交；如果期间有别的提交，重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(env, `/git/ref/heads/${env.BRANCH}`);
    const head = await gh(env, `/git/commits/${ref.object.sha}`);
    const tree = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha })) }) });
    const msg = `后台发布：${String(body.summary || '更新攻略').slice(0, 200)}`;
    const commit = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message: msg, tree: tree.sha, parents: [ref.object.sha] }) });
    try {
      await gh(env, `/git/refs/heads/${env.BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
      return json({ ok: true, commit: commit.sha, places, notes });
    } catch (e) { if (attempt === 1 || e.status !== 422) throw e; }
  }
  return fail('发布冲突，请重试', 409);
}

// ---------------- 读取小红书笔记 ----------------
async function readNote(url) {
  const out = { ok: false, title: '', desc: '', images: [], likes: '', url, noteId: '' };
  if (!url) return out;
  try {
    const full = await resolveShortLink(url);
    out.url = full; out.noteId = noteIdOf(full);
    const r = await fetch(full, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
    const html = await r.text();
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*<\/script>/);
    if (!m) return out;
    const state = JSON.parse(m[1].replace(/\bundefined\b/g, 'null'));
    const map = state?.note?.noteDetailMap || {};
    const note = (map[out.noteId] || Object.values(map)[0] || {}).note;
    if (!note) return out;
    out.title = note.title || ''; out.desc = note.desc || '';
    out.likes = note.interactInfo?.likedCount || '';
    out.images = (note.imageList || []).map(i => {
      const u = i.urlDefault || i.url || '';
      const path = u.split('/').slice(5).join('/').split('!')[0];
      return path ? `https://ci.xiaohongshu.com/${path}?imageView2/2/w/1080/format/jpg` : '';
    }).filter(Boolean);
    out.ok = !!(out.title || out.desc || out.images.length);
  } catch (e) { /* 读不到就交给截图 */ }
  return out;
}

// ---------------- Claude 识别地点 ----------------
const CANDIDATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'aliases', 'region', 'inRoute', 'category', 'cardSubtitle', 'description', 'mustTry', 'bestTime', 'xhsKeyword', 'mapKeyword', 'confidence', 'existingId', 'coverImageIndex', 'coverConfidence', 'evidence'],
        properties: {
          name: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } },
          region: { type: 'string' }, inRoute: { type: 'boolean' },
          category: { type: 'array', items: { type: 'string', enum: KINDS } },
          cardSubtitle: { type: 'string' }, description: { type: 'string' }, mustTry: { type: 'array', items: { type: 'string' } },
          bestTime: { type: 'string' }, xhsKeyword: { type: 'string' }, mapKeyword: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          existingId: { type: ['string', 'null'] },
          coverImageIndex: { type: ['integer', 'null'] }, coverConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `你帮一个国庆去云南旅行的人整理小红书攻略。本次路线只有四个地区：${REGIONS.join('、')}（景迈山、孟连都属于普洱市，按具体地点填这三个名字之一；普洱市区＝思茅）。

从笔记的标题、正文和每一张图片（门头招牌、图片上的字、菜单、地址、地图截图）里找出具体的地点：店、市场、景点、村寨。一篇笔记可能有很多个地点，全部列出来。

规则：
- 只列能确定名字的具体地点。泛泛的"某某美食""一家咖啡店"不要列。
- region 填四个地区之一；如果地点在大理、丽江、西双版纳、景谷、其他城市或无法判断，region 填实际城市名，inRoute 填 false。
- 同一个地点的不同叫法（"魏氏""思茅魏氏豆汤米干"）合并成一条，别名放进 aliases。
- existing 列表里已经有的地点，existingId 填它的 id；没有就填 null。
- 介绍只写笔记里有依据的内容，不要编造营业时间、价格、菜品。cardSubtitle 是 8-16 字的一句话；description 两三句；mustTry 是笔记里推荐的菜或体验。
- xhsKeyword 用"地区 店名"，mapKeyword 用百度地图能搜到的店名。
- coverImageIndex：图片编号从 0 开始，按我给你的顺序。挑最能代表这家的图：清楚的店内空间、门头加环境、代表性菜品、地点代表景色。不要选人脸占满、模糊、聊天截图、地图截图、纯文字图、吃了一半的菜、看不出是这家的图。没有合适的就填 null。确定这张图就是这家时 coverConfidence 填 high。
- evidence 用一句话说明依据（例如"第3张图门头写着苏大妈烧烤"）。
- 不确定就把 confidence 设为 low，不要猜。`;

// 识别结果补齐字段（通义千问没有强制 JSON 结构，这里兜底）
const arr = v => Array.isArray(v) ? v.map(String) : v ? String(v).split(/[、，,]/).map(x => x.trim()).filter(Boolean) : [];
const lvl = v => ['high', 'medium', 'low'].includes(v) ? v : 'medium';
function normCandidate(c) {
  const region = String(c.region || '');
  const idx = Number.isInteger(c.coverImageIndex) ? c.coverImageIndex : (typeof c.coverImageIndex === 'string' && /^\d+$/.test(c.coverImageIndex) ? Number(c.coverImageIndex) : null);
  return {
    name: String(c.name).trim(), aliases: arr(c.aliases), region, inRoute: c.inRoute !== false && REGIONS.includes(region),
    category: arr(c.category).filter(k => KINDS.includes(k)), cardSubtitle: String(c.cardSubtitle || ''), description: String(c.description || ''),
    mustTry: arr(c.mustTry), bestTime: String(c.bestTime || ''), xhsKeyword: String(c.xhsKeyword || ''), mapKeyword: String(c.mapKeyword || ''),
    confidence: lvl(c.confidence), existingId: c.existingId ? String(c.existingId) : null,
    coverImageIndex: idx, coverConfidence: lvl(c.coverConfidence), evidence: String(c.evidence || ''),
  };
}
function parseJsonLoose(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('识别结果解析失败，请重试');
  return JSON.parse(t.slice(a, b + 1));
}

// 通义千问视觉模型（阿里云百炼，OpenAI 兼容接口）
async function askQwen(env, content) {
  const parts = content.map(c => c.type === 'text' ? { type: 'text', text: c.text }
    : { type: 'image_url', image_url: { url: c.source.type === 'url' ? c.source.url : `data:${c.source.media_type};base64,${c.source.data}` } });
  const base = (env.QWEN_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.QWEN_MODEL || 'qwen-vl-max',
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM + '\n\n' + JSON_SHAPE },
        { role: 'user', content: parts },
      ],
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`通义千问返回 ${r.status}：${(d.error && d.error.message) || d.message || ''}`.slice(0, 200));
  return parseJsonLoose(d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content);
}
const JSON_SHAPE = `只输出一个 JSON 对象，不要任何解释，格式：
{"candidates":[{"name":"店名","aliases":["别名"],"region":"普洱/景迈山/孟连/昆明 或实际城市","inRoute":true,"category":["吃/喝/逛/玩/拍 选1-2个"],"cardSubtitle":"8-16字一句话","description":"两三句介绍","mustTry":["推荐"],"bestTime":"适合什么时候去","xhsKeyword":"地区 店名","mapKeyword":"店名","confidence":"high/medium/low","existingId":"已有地点id或null","coverImageIndex":0,"coverConfidence":"high/medium/low","evidence":"一句话依据"}]}`;

// Claude（设置了 ANTHROPIC_API_KEY 且没设通义千问时使用）
async function askClaude(env, content) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: SYSTEM,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: CANDIDATE_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error('这篇内容没法识别，换一篇或上传截图试试');
  const textBlock = res.content.find(b => b.type === 'text');
  return parseJsonLoose(textBlock ? textBlock.text : '{}');
}

async function analyzeNote(req, env) {
  const body = await req.json().catch(() => ({}));
  const uploads = (body.images || []).filter(s => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 12);
  const note = await readNote(body.url);
  const text = [note.title && `标题：${note.title}`, note.desc && `正文：${note.desc}`, body.text && `用户粘贴的文字：${body.text}`].filter(Boolean).join('\n');
  const remote = note.images.slice(0, 18);
  if (!text && !remote.length && !uploads.length) return fail('没有可以识别的内容：笔记读不到，也没有上传图片');

  const content = [];
  remote.forEach((u, i) => { content.push({ type: 'text', text: `图片 ${i}` }); content.push({ type: 'image', source: { type: 'url', url: u } }); });
  uploads.forEach((d, j) => {
    const [head, data] = d.split(',');
    content.push({ type: 'text', text: `图片 ${remote.length + j}（用户上传）` });
    content.push({ type: 'image', source: { type: 'base64', media_type: (head.match(/data:(image\/[a-z]+)/) || [])[1] || 'image/jpeg', data } });
  });
  const existing = (body.existing || []).slice(0, 400).map(p => `${p.id}｜${p.name}｜${p.region}${p.aliases && p.aliases.length ? '｜' + p.aliases.join('/') : ''}`).join('\n');
  content.push({ type: 'text', text: `${text || '（没有文字，只看图片）'}\n\n已有地点（id｜名称｜地区｜别名）：\n${existing}` });

  if (!env.QWEN_API_KEY && !env.ANTHROPIC_API_KEY) return fail('智能识别还没设置好（缺少通义千问的 API key）');
  let parsed;
  try {
    parsed = env.QWEN_API_KEY ? await askQwen(env, content) : await askClaude(env, content);
  } catch (e) { return fail(e.message || '识别服务出错了，请重试'); }
  const cands = (parsed.candidates || []).filter(c => c && c.name).map(normCandidate);
  const readStatus = note.ok ? 'full' : body.url ? 'failed' : 'upload';
  return json({
    ok: true, readStatus,
    message: note.ok ? `读到正文和 ${remote.length} 张图` : body.url ? '无法完整读取这篇笔记（可能需要登录），只分析了你粘贴的文字和上传的图片' : `分析了 ${uploads.length} 张图片`,
    note: note.ok || body.url ? { title: note.title, url: note.url || body.url, noteId: note.noteId, likes: note.likes } : null,
    images: remote, candidates: cands,
  });
}

// ---------------- 路由 ----------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/auth/login') return authLogin(req, env);
      if (url.pathname === '/auth/callback') return authCallback(req, env);
      if (url.pathname.startsWith('/api/')) {
        const s = await requireAdmin(req, env);
        if (!s) return cors(env, fail('请先登录', 401));
        if (url.pathname === '/api/me' && req.method === 'GET') return cors(env, json({ ok: true, login: s.u }));
        if (url.pathname === '/api/publish' && req.method === 'POST') return cors(env, await publish(req, env));
        if (url.pathname === '/api/analyze-note' && req.method === 'POST') return cors(env, await analyzeNote(req, env));
      }
      return cors(env, fail('没有这个接口', 404));
    } catch (e) {
      return cors(env, fail(e.message || '服务出错了', 500));
    }
  },
};
