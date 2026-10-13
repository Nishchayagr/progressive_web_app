'use strict';

/*
 * Two caches:
 *  - CACHE_NAME: the app shell. Bump CACHE_VERSION whenever you change any
 *    app file (index.html, style.css, app.js, manifest.json, icons, this file).
 *  - AI_CACHE: MediaPipe's library, WASM files and face model (large, ~35 MB).
 *    Named after the MediaPipe version, so app updates don't re-download it.
 */
const CACHE_VERSION = 'v5';
const CACHE_NAME = `attendance-${CACHE_VERSION}`;

// Keep in sync with MEDIAPIPE_VERSION in app.js.
const MEDIAPIPE_VERSION = '0.10.35';
const AI_CACHE = `attendance-ai-${MEDIAPIPE_VERSION}`;

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
  './app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Everything the face check needs offline. MediaPipe picks one WASM variant at
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

/* ------------------------------------------------------------------
 * Install: only the small app shell is required.
 * The big MediaPipe files download in the background (see "message" below),
 * so a slow connection can never stop the app from installing.
 * ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove old caches (including old MediaPipe versions) and take control.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('attendance-') && key !== CACHE_NAME && key !== AI_CACHE)
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
    (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/'))
  );
}

// Always fetch with CORS so the stored copy works for scripts, modules and fetch().
function fetchCors(url) {
  return fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
}

// Downloads any missing MediaPipe file into AI_CACHE. Returns how many are cached.
let aiJob = null;
function ensureAiCached() {
  if (!aiJob) {
    aiJob = (async () => {
      const cache = await caches.open(AI_CACHE);
      let cached = 0;
      for (const url of AI_URLS) { // one at a time, to be kind to mobile connections
        try {
          if (await cache.match(url, { ignoreVary: true })) { cached++; continue; }
          const response = await fetchCors(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await cache.put(url, response);
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
      if (client) client.postMessage({ type: 'AI_CACHE_STATUS', cached, total: AI_URLS.length });
    })
  );
});

// Cache-first. Anything MediaPipe loads that wasn't pre-cached is stored on first use.
async function aiAssetResponse(request) {
  const cache = await caches.open(AI_CACHE);
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
