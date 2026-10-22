'use strict';

/*
 * Two caches:
 *  - CACHE_NAME: the app shell. Bump CACHE_VERSION whenever you change any
 *    app file (index.html, style.css, app.js, manifest.json, icons, this file).
 *  - AI_CACHE: MediaPipe's library, WASM files and face model (large, ~35 MB).
 *  - FACE_CACHE: the Face ID library and models (Human, ~15 MB).
 *    Both are named after their library version, so app updates don't re-download them.
 */
const CACHE_VERSION = 'v7';
const CACHE_NAME = `attendance-${CACHE_VERSION}`;

// Keep in sync with MEDIAPIPE_VERSION in app.js.
const MEDIAPIPE_VERSION = '0.10.35';
const AI_CACHE = `attendance-ai-${MEDIAPIPE_VERSION}`;

// Keep in sync with HUMAN_VERSION in faceid.js.
const HUMAN_VERSION = '3.3.6';
const FACE_CACHE = `attendance-face-${HUMAN_VERSION}`;
const HUMAN_BASE = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}`;
const HUMAN_MODELS = ['blazeface', 'facemesh', 'iris', 'faceres', 'antispoof', 'liveness'];

const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Everything the app needs to run offline.
const PRECACHE_URLS = [
  './',
  './index.html',
  './dashboard.html',
  './style.css',
  './auth.js',
  './login.js',
  './faceid.js',
  './app.js',
  './manifest.json'
];

// Nice to have, but a missing icon must never stop the app from installing.
const OPTIONAL_URLS = [
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// Everything the face check needs offline from MediaPipe. It picks one WASM variant at
// runtime based on the device, so all of them are cached.
// (Each .wasm is about 10 MB. Remove the "nosimd" pair if you only support recent browsers.)
const AI_URLS = [
  `${MP_BASE}/vision_bundle.mjs`,
  `${MP_BASE}/wasm/vision_wasm_internal.js`,
  `${MP_BASE}/wasm/vision_wasm_internal.wasm`,
  `${MP_BASE}/wasm/vision_wasm_module_internal.js`,
  `${MP_BASE}/wasm/vision_wasm_module_internal.wasm`,
  `${MP_BASE}/wasm/vision_wasm_nosimd_internal.js`,
  `${MP_BASE}/wasm/vision_wasm_nosimd_internal.wasm`,
  FACE_MODEL_URL
];

// Everything downloaded in the background. A "model" is a .json file plus the
// weight files it points to, which are found by reading the .json.
const ASSETS = [
  ...AI_URLS.map((url) => ({ url, cache: AI_CACHE, kind: 'file' })),
  { url: `${HUMAN_BASE}/dist/human.esm.js`, cache: FACE_CACHE, kind: 'file' },
  ...HUMAN_MODELS.map((name) => ({ url: `${HUMAN_BASE}/models/${name}.json`, cache: FACE_CACHE, kind: 'model' }))
];

/* ------------------------------------------------------------------
 * Install: only the small app shell is required.
 * The big MediaPipe files download in the background (see "message" below),
 * so a slow connection can never stop the app from installing.
 * ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(async (cache) => {
        await cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })));
        await Promise.allSettled(OPTIONAL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      })
      .then(() => self.skipWaiting())
  );
});

// Activate: remove old caches (including old MediaPipe versions) and take control.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('attendance-') && key !== CACHE_NAME && key !== AI_CACHE && key !== FACE_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------------
 * MediaPipe files
 * ------------------------------------------------------------------ */
function isAiAsset(url) {
  return (
    (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@mediapipe/tasks-vision@')) ||
    (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@vladmandic/human@')) ||
    (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/'))
  );
}

function cacheNameFor(url) {
  return url.includes('/npm/@vladmandic/human@') ? FACE_CACHE : AI_CACHE;
}

// Always fetch with CORS so the stored copy works for scripts, modules and fetch().
function fetchCors(url) {
  return fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
}

async function cacheFile(cache, url) {
  if (await cache.match(url, { ignoreVary: true })) return;
  const response = await fetchCors(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await cache.put(url, response);
}

// A Face ID model is a .json file plus the weight files it lists: cache them all.
async function cacheModel(cache, jsonUrl) {
  await cacheFile(cache, jsonUrl);
  const manifest = await (await cache.match(jsonUrl, { ignoreVary: true })).json();
  const shards = (manifest.weightsManifest || []).flatMap((group) => group.paths || []);
  for (const path of shards) await cacheFile(cache, new URL(path, jsonUrl).href);
}

// Downloads anything missing. Returns how many of the ASSETS are fully cached.
let aiJob = null;
function ensureAiCached() {
  if (!aiJob) {
    aiJob = (async () => {
      let cached = 0;
      for (const asset of ASSETS) { // one at a time, to be kind to mobile connections
        try {
          const cache = await caches.open(asset.cache);
          if (asset.kind === 'model') await cacheModel(cache, asset.url);
          else await cacheFile(cache, asset.url);
          cached++;
        } catch (err) {
          // Offline or file missing: leave it uncached; the next visit retries.
        }
      }
      return cached;
    })().finally(() => { aiJob = null; });
  }
  return aiJob;
}

// The page asks for the download once the worker is active, and gets a status back.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'PRECACHE_AI') return;
  const client = event.source;
  event.waitUntil(
    ensureAiCached().then((cached) => {
      if (client) client.postMessage({ type: 'AI_CACHE_STATUS', cached, total: ASSETS.length });
    })
  );
});

// Cache-first. Anything these libraries load that wasn't pre-cached is stored on first use.
async function aiAssetResponse(request) {
  const cache = await caches.open(cacheNameFor(request.url));
  const cached = await cache.match(request.url, { ignoreVary: true });
  if (cached) return cached;

  const response = await fetchCors(request.url);
  if (response.ok) cache.put(request.url, response.clone());
  return response;
}

/* ------------------------------------------------------------------
 * Fetch: cache-first for the app shell and the MediaPipe files.
 * ------------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (isAiAsset(url)) {
    event.respondWith(aiAssetResponse(request));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Page navigations (login page or dashboard): serve the cached page, and
  // fall back to the login page if the requested page isn't cached.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match(request, { ignoreSearch: true })
        .then((cached) => cached || fetch(request))
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;

      // Not cached yet: fetch it, and keep a copy for next time.
      return fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => new Response('Offline and not cached.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain' }
        }));
    })
  );
});
