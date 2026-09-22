/**
 * store.js — user preferences, bookmarks and reading history.
 * Everything lives in localStorage; there is no account and no server.
 */

const PREFS_KEY = 'nur:prefs';
const BM_KEY = 'nur:bookmarks';
const LAST_KEY = 'nur:lastRead';

export const DEFAULT_PREFS = {
  theme: 'dark',        // 'dark' | 'light' | 'auto'
  arabScale: 1,         // multiplier on the base Arabic font size
  trScale: 1,           // multiplier on the base translation font size
  showLatin: true,      // transliteration under each ayah
  showTafsir: false,    // inline tafsir under each ayah
  reciter: '05',
  autoplayNext: true,   // continue to the next ayah automatically
  loopAyah: false,
  stars: true,          // animated starfield
};

const listeners = new Set();

const readJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

/* ── Preferences ───────────────────────────────────────────────────────── */

let prefs = { ...DEFAULT_PREFS, ...readJSON(PREFS_KEY, {}) };

export const getPrefs = () => ({ ...prefs });

export function setPref(key, value) {
  if (prefs[key] === value) return prefs;
  prefs = { ...prefs, [key]: value };
  writeJSON(PREFS_KEY, prefs);
  listeners.forEach((fn) => fn(prefs, key));
  return prefs;
}

export function resetPrefs() {
  prefs = { ...DEFAULT_PREFS };
  writeJSON(PREFS_KEY, prefs);
  listeners.forEach((fn) => fn(prefs, '*'));
  return prefs;
}

export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── Theme ─────────────────────────────────────────────────────────────── */

const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

export const resolveTheme = (theme = prefs.theme) =>
  theme === 'auto' ? (prefersDark() ? 'dark' : 'light') : theme;

export function applyTheme() {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#04140f' : '#fbf7ec');
  return resolved;
}

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (prefs.theme === 'auto') {
    applyTheme();
    listeners.forEach((fn) => fn(prefs, 'theme'));
  }
});

/* ── Bookmarks ─────────────────────────────────────────────────────────── */

let bookmarks = readJSON(BM_KEY, []);

export const getBookmarks = () => [...bookmarks];

export const isBookmarked = (surah, ayah) =>
  bookmarks.some((b) => b.surah === surah && b.ayah === ayah);

/** Add or remove a bookmark. Returns `true` when the ayah ended up saved. */
export function toggleBookmark(entry) {
  const exists = isBookmarked(entry.surah, entry.ayah);
  bookmarks = exists
    ? bookmarks.filter((b) => !(b.surah === entry.surah && b.ayah === entry.ayah))
    : [{ ...entry, ts: Date.now() }, ...bookmarks];
  writeJSON(BM_KEY, bookmarks);
  listeners.forEach((fn) => fn(prefs, 'bookmarks'));
  return !exists;
}

export function removeBookmark(surah, ayah) {
  bookmarks = bookmarks.filter((b) => !(b.surah === surah && b.ayah === ayah));
  writeJSON(BM_KEY, bookmarks);
  listeners.forEach((fn) => fn(prefs, 'bookmarks'));
}

/* ── Reading history ───────────────────────────────────────────────────── */

export const getLastRead = () => readJSON(LAST_KEY, null);

export function setLastRead(entry) {
  writeJSON(LAST_KEY, { ...entry, ts: Date.now() });
}
