// 离线缓存：山里信号差时，打开过的页面、行程、地点和封面照样能看
// - 页面文件和数据：优先联网拿最新的，4 秒没拿到就用手机上存的
// - 图片：先用手机上存的，没有再联网
// - 后台 /admin/ 和发布服务不走缓存
const VERSION = 'yt-v2';
const SHELL = VERSION + '-shell';
const IMAGES = 'yt-images';            // 图片缓存不跟版本走，升级时不用重新下载封面
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'data/trip.json', 'data/places.json', 'data/notes.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== IMAGES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const scopePath = () => new URL(self.registration.scope).pathname;
// 去掉 ?v= 这类防缓存参数，同一个文件只存一份
const keyOf = url => { const u = new URL(url); u.search = ''; return u.toString(); };

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  const key = keyOf(req.url);
  try {
    const res = await Promise.race([
      // 按网址重新请求并绕过浏览器缓存（导航请求本身不能改参数），发布后马上拿到新版本
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    if (req.mode === 'navigate') { const home = await cache.match(keyOf(new URL('index.html', self.registration.scope).toString())); if (home) return home; }
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(IMAGES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req.url, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const base = scopePath();
  if (url.origin === self.location.origin) {
    if (!url.pathname.startsWith(base) || url.pathname.startsWith(base + 'admin/')) return;
    if (url.pathname.startsWith(base + 'assets/')) { e.respondWith(cacheFirst(req)); return; }
    e.respondWith(networkFirst(req));
    return;
  }
  if (/(^|\.)xhscdn\.com$|^ci\.xiaohongshu\.com$/.test(url.hostname) && req.destination === 'image') e.respondWith(cacheFirst(req));
});

// 页面告诉我们有哪些封面：空闲时一张张存下来（已经存过的跳过）
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'warm' || !Array.isArray(e.data.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(IMAGES);
    for (const u of e.data.urls) {
      try {
        if (await cache.match(u)) continue;
        const res = await fetch(u, u.startsWith(self.location.origin) ? {} : { mode: 'no-cors', referrerPolicy: 'no-referrer' });
        if (res.ok || res.type === 'opaque') await cache.put(u, res);
      } catch (err) { /* 这张没存上就算了，下次再试 */ }
    }
  })());
});
