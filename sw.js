// オフラインでも前回の画面が開けるようにするサービスワーカー
const VERSION = 'v1';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/util.js', 'js/chart.js', 'js/indicators.js', 'js/github.js', 'js/symbols.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = url.pathname.includes('/data/');
  // データ・画面ともにネットワーク優先、つながらないときはキャッシュ
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        const key = isData ? url.origin + url.pathname : e.request;
        caches.open(VERSION).then((c) => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(isData ? url.origin + url.pathname : e.request, { ignoreSearch: true }))
  );
});
