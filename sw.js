// Service worker : l'app et le fichier des rues fonctionnent hors ligne.
// Incrémentez VERSION à chaque mise à jour du site pour forcer le rafraîchissement.
const VERSION = 'v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'js/db.js', 'js/core.js', 'js/match.worker.js',
  'data/streets.json.gz', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/icon.svg',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];
const CACHED_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net', 'basemaps.cartocdn.com', 'tiles.basemaps.cartocdn.com',
  'tiles-a.basemaps.cartocdn.com', 'tiles-b.basemaps.cartocdn.com', 'tiles-c.basemaps.cartocdn.com', 'tiles-d.basemaps.cartocdn.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'tiles').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  // Le Worker Cloudflare (positions) n'est jamais mis en cache.
  if (!sameOrigin && !CACHED_HOSTS.includes(url.hostname)) return;
  const isTile = url.hostname.includes('basemaps.cartocdn.com') && !url.pathname.endsWith('style.json');
  e.respondWith(isTile ? tile(e.request) : staleWhileRevalidate(e.request, sameOrigin));
});

// Fichiers de l'app : réponse immédiate depuis le cache, mise à jour en arrière-plan.
async function staleWhileRevalidate(req, sameOrigin) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: sameOrigin });
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

// Tuiles du fond de carte : réseau d'abord, cache limité en secours hors ligne.
async function tile(req) {
  const cache = await caches.open('tiles');
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return (await cache.match(req)) || Response.error();
  }
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - 3000; i++) await cache.delete(keys[i]);
  trimming = false;
}
