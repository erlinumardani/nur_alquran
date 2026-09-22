/**
 * data.js — Al-Qur'an data access layer.
 *
 * Strategy: the 114-surah index ships with the app (data/surah.json) so the home
 * screen renders instantly and works offline. Ayah text + translation and tafsir
 * come from the equran.id v2 API (Kemenag RI text) and are memoised in
 * localStorage so previously read surahs stay available offline.
 */

const API = 'https://equran.id/api/v2';
const CDN = 'https://cdn.equran.id';

const CACHE_PREFIX = 'nur:surah:';
const TAFSIR_PREFIX = 'nur:tafsir:';
const CACHE_INDEX_KEY = 'nur:cacheIndex';
const MAX_CACHED_SURAHS = 26;

/** Available murattal. Keys match the API's audio map keys. */
export const RECITERS = [
  { id: '05', slug: 'Misyari-Rasyid-Al-Afasi', name: 'Misyari Rasyid Al-Afasi' },
  { id: '01', slug: 'Abdullah-Al-Juhany', name: 'Abdullah Al-Juhany' },
  { id: '02', slug: 'Abdul-Muhsin-Al-Qasim', name: 'Abdul-Muhsin Al-Qasim' },
  { id: '03', slug: 'Abdurrahman-as-Sudais', name: 'Abdurrahman as-Sudais' },
  { id: '04', slug: 'Ibrahim-Al-Dossari', name: 'Ibrahim Al-Dossari' },
  { id: '06', slug: 'Yasser-Al-Dosari', name: 'Yasser Al-Dosari' },
];

export const getReciter = (id) => RECITERS.find((r) => r.id === id) ?? RECITERS[0];

const pad3 = (n) => String(n).padStart(3, '0');

/**
 * Per-ayah murattal URL. The CDN path is deterministic, so a URL can be built
 * without fetching the surah first — which is what makes prefetching the next
 * ayah possible.
 */
export const audioUrlAyah = (surah, ayah, reciterId) =>
  `${CDN}/audio-partial/${getReciter(reciterId).slug}/${pad3(surah)}${pad3(ayah)}.mp3`;

/* ── localStorage helpers ──────────────────────────────────────────────── */

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // quota exceeded or storage disabled
  }
}

function touchCacheIndex(surah) {
  const idx = readJSON(CACHE_INDEX_KEY) ?? [];
  const next = [surah, ...idx.filter((n) => n !== surah)];
  while (next.length > MAX_CACHED_SURAHS) {
    localStorage.removeItem(CACHE_PREFIX + next.pop());
  }
  writeJSON(CACHE_INDEX_KEY, next);
}

/* ── Bundled index ─────────────────────────────────────────────────────── */

let indexPromise = null;

/** The 114-surah index (number, names, ayah count, revelation, summary). */
export function loadIndex() {
  indexPromise ??= fetch('data/surah.json', { cache: 'force-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      indexPromise = null; // allow a retry on the next navigation
      throw new Error(`Gagal memuat daftar surat: ${err.message}`);
    });
  return indexPromise;
}

/* ── Network ───────────────────────────────────────────────────────────── */

async function apiFetch(path, signal) {
  const res = await fetch(`${API}${path}`, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.code !== 200 || !body.data) throw new Error(body?.message || 'Respons tidak valid');
  return body.data;
}

/* ── Surah payload ─────────────────────────────────────────────────────── */

const memo = new Map();

/**
 * Ayah text, transliteration, Indonesian translation and audio for one surah.
 * Served from memory → localStorage → network, in that order.
 */
export async function getSurah(nomor, { signal } = {}) {
  const cached = memo.get(nomor) ?? readJSON(CACHE_PREFIX + nomor);
  if (cached?.ayat?.length) {
    memo.set(nomor, cached);
    return cached;
  }

  const data = await apiFetch(`/surat/${nomor}`, signal);

  const payload = {
    nomor: data.nomor,
    nama: data.nama,
    namaLatin: data.namaLatin,
    arti: data.arti,
    jumlahAyat: data.jumlahAyat,
    tempatTurun: data.tempatTurun,
    deskripsi: data.deskripsi,
    ayat: data.ayat.map((a) => ({
      no: a.nomorAyat,
      arab: a.teksArab,
      latin: a.teksLatin,
      tr: a.teksIndonesia,
      audio: a.audio ?? {},
    })),
  };

  memo.set(nomor, payload);
  if (writeJSON(CACHE_PREFIX + nomor, payload)) touchCacheIndex(nomor);
  return payload;
}

/** Kemenag tafsir for one surah, keyed by ayah number. */
export async function getTafsir(nomor, { signal } = {}) {
  const cached = memo.get('tafsir:' + nomor) ?? readJSON(TAFSIR_PREFIX + nomor);
  if (cached?.length) {
    memo.set('tafsir:' + nomor, cached);
    return cached;
  }

  const data = await apiFetch(`/tafsir/${nomor}`, signal);
  const list = (data.tafsir ?? []).map((t) => ({ no: t.ayat, teks: t.teks }));

  memo.set('tafsir:' + nomor, list);
  writeJSON(TAFSIR_PREFIX + nomor, list);
  return list;
}

/** Wipe locally cached text (used by the settings drawer). */
export function clearCache() {
  memo.clear();
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k?.startsWith(CACHE_PREFIX) || k?.startsWith(TAFSIR_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem(CACHE_INDEX_KEY);
  return keys.length;
}
