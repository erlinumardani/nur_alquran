/**
 * sw.js — service worker for Nūr al-Qur'ān.
 *
 * The goal is a Quran reader that keeps working without a connection. Two
 * decisions matter more than the rest:
 *
 *  1. The app shell is **network-first**. The filenames here carry no content
 *     hash, so a cache-first shell could pin a stale app.js against a fresh
 *     index.html and break the page in ways that are hard to diagnose. Going to
 *     the network first means an online reader always gets a consistent, current
 *     build, and the cache is only the offline fallback.
 *
 *  2. There is deliberately **no skipWaiting()**. Activating a new worker while
 *     an old page is still open would let the new worker serve assets the loaded
 *     page never expected. Updates land on the next launch instead — which, for
 *     an installed app, is simply reopening it.
 */

const VERSION = 'nur-v2';
const SHELL = `${VERSION}-shell`;
const FONTS = `${VERSION}-fonts`;
const API = `${VERSION}-api`;
const AUDIO = `${VERSION}-audio`;

const KEEP = new Set([SHELL, FONTS, API, AUDIO]);

/** Ayah recordings are cached as they are played, so the list is bounded. */
const AUDIO_LIMIT = 60;

/** App shell: everything needed to boot the reader with no network. */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/styles.css',
  './assets/js/app.js',
  './assets/js/data.js',
  './assets/js/fx.js',
  './assets/js/player.js',
  './assets/js/store.js',
  './data/surah.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
];

/* ── Install ───────────────────────────────────────────────────────────── */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not addAll: one 404 would otherwise abort the whole install
    // and leave the app with no offline support at all.
    await Promise.all(SHELL_FILES.map((url) => cache.add(url).catch(() => null)));
  })());
});

/* ── Activate ──────────────────────────────────────────────────────────── */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)));
    // Let the browser start using this worker for in-scope navigations without
    // reloading the page: it only affects requests made from now on.
    await self.clients.claim();
  })());
});

/* ── Strategies ────────────────────────────────────────────────────────── */

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    // Only cache successful, same-policy responses; an opaque error page would
    // otherwise be replayed offline.
    if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const shell = await caches.open(SHELL);
      const page = await shell.match(fallbackUrl);
      if (page) return page;
    }
    return offlineResponse();
  }
}

async function cacheFirst(request, cacheName, { limit } = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      await cache.put(request, fresh.clone()).catch(() => {});
      if (limit) await trim(cache, limit);
    }
    return fresh;
  } catch {
    // A failed fetch must not reject `respondWith`: that surfaces as an
    // unhandled rejection in the worker. Returning a real response keeps the
    // failure clean and diagnosable. One cause worth knowing about: this worker
    // inherits the site CSP, so every origin it re-fetches must be listed in
    // connect-src or the request is refused before it leaves the browser.
    return offlineResponse();
  }
}

/* -- Media --------------------------------------------------------------- */

/**
 * Audio gets its own strategy because media elements request byte ranges, and a
 * 206 partial response cannot be stored by the Cache API. Cross-origin media is
 * also fetched in `no-cors` mode, which makes the response opaque: its body
 * cannot be read, so it cannot be sliced either.
 *
 * So the recording is fetched exactly as the element asked, and whatever comes
 * back is stored under the plain URL (later range requests for the same ayah
 * then find it). Entries the Cache API refuses are skipped quietly � playback
 * is unaffected either way, because the network response is what is returned.
 *
 * `fetch(request)` must pass the original request through. Rebuilding it from
 * `request.url` defaults to `cors` mode, and if the CDN sends no CORS headers
 * the request fails outright instead of playing.
 */
async function mediaStrategy(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request.url);
  if (cached) return cached;

  try {
    const fresh = await fetch(request);
    // `ok` is false for an opaque response (status 0), which is still worth
    // keeping, so both are accepted.
    if (fresh.ok || fresh.type === 'opaque') {
      await cache.put(request.url, fresh.clone()).catch(() => {});
      await trim(cache, limit);
    }
    return fresh;
  } catch {
    // Offline, or refused by CSP: let the element fail, but cleanly.
    return offlineResponse();
  }
}
function offlineResponse() {
  return new Response('Sumber ini belum tersimpan untuk dibaca offline.', {
    status: 504,
    statusText: 'Offline',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Drop the oldest entries once a cache grows past its limit. */
async function trim(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

/* ── Fetch routing ─────────────────────────────────────────────────────── */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch the worker script itself, and leave anything exotic (extensions,
  // browser internals) alone.
  if (url.pathname.endsWith('/sw.js')) return;
  if (!url.protocol.startsWith('http')) return;

  // Navigations: always try the network so a deploy is picked up immediately.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, './index.html'));
    return;
  }

  if (url.origin === self.location.origin) {
    // Code and data change between releases; icons and fonts do not.
    if (/\.(?:js|css|json|webmanifest)$/.test(url.pathname)) {
      event.respondWith(networkFirst(request, SHELL));
    } else {
      event.respondWith(cacheFirst(request, SHELL));
    }
    return;
  }

  // Translations, tafsir and tajwid: cached so a read surah stays readable.
  if (url.hostname === 'equran.id' || url.hostname === 'api.quran.com') {
    event.respondWith(networkFirst(request, API));
    return;
  }

  // Murattal: keep what has been played, bounded.
  if (url.hostname === 'cdn.equran.id') {
    event.respondWith(mediaStrategy(request, AUDIO, AUDIO_LIMIT));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request, FONTS));
  }
});
