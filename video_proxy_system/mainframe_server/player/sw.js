// Simple service worker: caches player assets and main page shell
const CACHE = 'player-cache-v1';
const ASSETS = [
  '/',
  '/player/player.css',
  '/player/player.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // only handle same-origin requests for assets listed
  if (ASSETS.includes(url.pathname) || url.pathname.startsWith('/player/')) {
    event.respondWith(caches.match(event.request).then(res => res || fetch(event.request)));
  }
});
