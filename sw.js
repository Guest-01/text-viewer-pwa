// Service Worker: 앱 셸 캐시(네트워크 우선, 오프라인 시 캐시) + 정적 자산(폰트) 캐시 우선 + Web Share Target 처리
const VERSION = 'v1';
const CACHE = `tv-${VERSION}`;
const SHARED_CACHE = 'tv-shared';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/encoding.js',
  './js/text.js',
  './js/reader.js',
  './js/ui.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './fonts/noto-serif-kr-2350-v1.woff2',
  './fonts/noto-serif-kr-2350-bold-v1.woff2',
  './fonts/pretendard-2350-regular-v1.woff2',
  './fonts/pretendard-2350-bold-v1.woff2',
];
// 파일명에 버전이 붙어 내용이 바뀌지 않는 자산: 캐시에 있으면 네트워크에 묻지 않는다.
const IMMUTABLE = /\/fonts\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tv-') && k !== CACHE && k !== SHARED_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // 내비게이션은 앱 셸(index.html)로 응답
  const isNav = req.mode === 'navigate';
  const key = isNav ? new Request(new URL('./index.html', self.location.href).href) : req;
  event.respondWith(networkFirst(key));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return new Response('오프라인 상태이며 캐시된 자원이 없습니다.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function handleShare(req) {
  const home = new URL('./', self.location.href).href;
  try {
    const fd = await req.formData();
    const files = fd.getAll('file').filter((f) => f && typeof f.arrayBuffer === 'function');
    const cache = await caches.open(SHARED_CACHE);
    const stamp = Date.now();
    let n = 0;
    for (const file of files) {
      const name = file.name || `공유된 텍스트 ${stamp}.txt`;
      await cache.put(
        new Request(`${home}shared/${stamp}-${n++}`),
        new Response(await file.arrayBuffer(), { headers: { 'X-File-Name': encodeURIComponent(name) } }),
      );
    }
    if (!files.length) {
      const text = [fd.get('title'), fd.get('text'), fd.get('url')].filter(Boolean).join('\n');
      if (text) {
        const title = (fd.get('title') || `공유된 텍스트 ${new Date(stamp).toLocaleString('ko-KR')}`) + '.txt';
        await cache.put(
          new Request(`${home}shared/${stamp}-0`),
          new Response(new TextEncoder().encode(text), { headers: { 'X-File-Name': encodeURIComponent(title) } }),
        );
      }
    }
  } catch (err) {
    console.error('share-target 처리 실패', err);
  }
  return Response.redirect(`${home}?shared=1`, 303);
}
