/**
 * data.js — Al-Qur'an data access layer.
 *
 * Three sources, each used for what it is best at:
 *   • data/surah.json            — bundled 114-surah index (instant, offline)
 *   • equran.id v2               — Kemenag RI translation, transliteration, murattal
 *   • api.quran.com v4           — Uthmani Arabic with tajwid rules embedded as tags
 *
 * Everything is memoised in localStorage so previously read surahs stay
 * available offline.
 */

const API = 'https://equran.id/api/v2';
const CDN = 'https://cdn.equran.id';
const TAJWID_API = 'https://api.quran.com/api/v4';

const CACHE_PREFIX = 'nur:surah:';
const TAFSIR_PREFIX = 'nur:tafsir:';
const TAJWID_PREFIX = 'nur:tajwid:';
const TAJWID_INDEX_KEY = 'nur:tajwidIndex';
const CACHE_INDEX_KEY = 'nur:cacheIndex';
const MAX_CACHED_SURAHS = 26;
// Tajwid payloads are much larger than translations, so they get a tighter cap.
const MAX_CACHED_TAJWID = 10;

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

function touchTajwidIndex(surah) {
  const idx = readJSON(TAJWID_INDEX_KEY) ?? [];
  const next = [surah, ...idx.filter((n) => n !== surah)];
  while (next.length > MAX_CACHED_TAJWID) {
    localStorage.removeItem(TAJWID_PREFIX + next.pop());
  }
  writeJSON(TAJWID_INDEX_KEY, next);
}

/* ── Tajwid ────────────────────────────────────────────────────────────── */

/**
 * Tajwid rule slugs used by the Quran Foundation tajweed script, grouped the way
 * the colours are grouped. Anything outside this list is never trusted.
 */
export const TAJWID_RULES = {
  ghunnah: { group: 'ghunnah', id: 'Ghunnah', note: 'Dengung 2 harakat pada نّ / مّ' },
  idgham_ghunnah: { group: 'ghunnah', id: 'Idgam Bigunnah', note: 'Nun/tanwin melebur dengan dengung' },
  ikhafa: { group: 'ghunnah', id: 'Ikhfa Hakiki', note: 'Nun/tanwin dibaca samar berdengung' },
  ikhafa_shafawi: { group: 'ghunnah', id: 'Ikhfa Syafawi', note: 'Mim sukun bertemu ba, berdengung' },
  iqlab: { group: 'ghunnah', id: 'Iqlab', note: 'Nun menjadi mim, berdengung' },
  idgham_wo_ghunnah: { group: 'idgham', id: 'Idgam Bilagunnah', note: 'Melebur tanpa dengung' },
  idgham_shafawi: { group: 'idgham', id: 'Idgam Mimi', note: 'Mim sukun melebur ke mim' },
  idgham_mutajanisayn: { group: 'idgham', id: 'Idgam Mutajanisain', note: 'Huruf sejenis makhrajnya melebur' },
  idgham_mutaqaribayn: { group: 'idgham', id: 'Idgam Mutaqaribain', note: 'Huruf berdekatan makhrajnya melebur' },
  qalaqah: { group: 'qalqalah', id: 'Qalqalah', note: 'Memantul pada ق ط ب ج د' },
  madda_normal: { group: 'madd-2', id: 'Mad Tabi\u2019i', note: 'Panjang 2 harakat' },
  madda_permissible: { group: 'madd-jaiz', id: 'Mad Jaiz Munfasil', note: 'Panjang 2, 4, atau 5 harakat' },
  madda_obligatory: { group: 'madd-wajib', id: 'Mad Wajib Muttasil', note: 'Panjang 4\u20135 harakat' },
  madda_necessary: { group: 'madd-lazim', id: 'Mad Lazim', note: 'Panjang 6 harakat' },
  ham_wasl: { group: 'silent', id: 'Hamzah Wasal', note: 'Tidak dibaca bila disambung' },
  slnt: { group: 'silent', id: 'Huruf Senyap', note: 'Tidak dibaca' },
  laam_shamsiyah: { group: 'silent', id: 'Lam Syamsiyah', note: 'Lam lebur ke huruf berikutnya' },
};

const TAJWEED_TAG = /<tajweed class=["']?([a-z_]+)["']?>([\s\S]*?)<\/tajweed>/g;

/**
 * Colour families, in legend order. Rules sharing a colour are grouped so the
 * legend teaches the palette instead of listing seventeen near-identical rows.
 */
export const TAJWID_GROUPS = [
  { key: 'ghunnah', label: 'Dengung (gunnah)', hint: 'Semua bacaan yang berdengung 2 harakat.' },
  { key: 'idgham', label: 'Idgam tanpa dengung', hint: 'Huruf melebur tanpa dengung.' },
  { key: 'qalqalah', label: 'Qalqalah', hint: 'Pantulan pada huruf qaf, ta, ba, jim, dal.' },
  { key: 'madd-2', label: 'Mad 2 harakat', hint: 'Panjang biasa (mad tabi\u2019i).' },
  { key: 'madd-jaiz', label: 'Mad 2\u20135 harakat', hint: 'Mad jaiz munfasil \u2014 boleh 2, 4, atau 5.' },
  { key: 'madd-wajib', label: 'Mad 4\u20135 harakat', hint: 'Mad wajib muttasil \u2014 harus 4 atau 5.' },
  { key: 'madd-lazim', label: 'Mad 6 harakat', hint: 'Mad lazim \u2014 harus 6 harakat.' },
  { key: 'silent', label: 'Tidak dibaca', hint: 'Huruf yang gugur ketika disambung.' },
];const END_SPAN = /<span class=["']?end["']?>[\s\S]*?<\/span>/g;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

// Angels' share: markup we did not recognise (an unknown tag, an extra attribute
// on a tajweed tag, a truncated tag, anything injected) is dropped rather than
// escaped, so it can neither execute nor show up as literal "<tajweed ...>" junk.
// Quranic text contains no angle brackets, so this cannot eat real content.
const dropUnknownTags = (s) => s.replace(/<[^>]*>?/g, '');

/**
 * Rebuild the API's markup from scratch instead of trusting it.
 *
 * The endpoint returns real HTML (`<tajweed class=...>`) which we deliberately do
 * not escape, so it must never be injected as-is. This walks the string, keeps
 * only `<tajweed>` wrappers whose class is a known rule, drops the ayah-number
 * span (the reader draws its own), and escapes everything else. The result is
 * therefore always: escaped text plus `<tajweed class="<known rule>">` wrappers.
 */
export function sanitizeTajweed(raw) {
  const text = String(raw ?? '').replace(END_SPAN, '');
  let out = '';
  let cursor = 0;
  const used = new Set();

  TAJWEED_TAG.lastIndex = 0;
  for (let m = TAJWEED_TAG.exec(text); m; m = TAJWEED_TAG.exec(text)) {
    const [full, rule, inner] = m;
    out += escapeHtml(dropUnknownTags(text.slice(cursor, m.index)));
    cursor = m.index + full.length;
    if (TAJWID_RULES[rule]) {
      used.add(rule);
      out += `<tajweed class="${rule}">${escapeHtml(dropUnknownTags(inner))}</tajweed>`;
    } else {
      out += escapeHtml(dropUnknownTags(inner));   // unknown rule → keep letters, drop tag
    }
  }
  out += escapeHtml(dropUnknownTags(text.slice(cursor)));

  return { html: out.trim(), rules: [...used] };
}

/** Strip the markup to get the plain Uthmani text. */
export const stripTajweed = (html) =>
  String(html ?? '').replace(/<\/?tajweed[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();

let tajwidIndex = null;

/**
 * Uthmani Arabic for one surah with tajwid rules embedded, plus the plain text and
 * the list of rules present. Indices are keyed by ayah number, never by position,
 * so it stays aligned with the translation even if an API drops an ayah.
 */
export async function getTajwid(nomor, { signal } = {}) {
  tajwidIndex ??= new Map();
  const cached = tajwidIndex.get(nomor) ?? readJSON(TAJWID_PREFIX + nomor);
  if (cached?.ayat?.length) {
    tajwidIndex.set(nomor, cached);
    return cached;
  }

  const res = await fetch(
    `${TAJWID_API}/quran/verses/uthmani_tajweed?chapter_number=${nomor}`,
    { signal, headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.verses) || !body.verses.length) {
    throw new Error('Respons tajwid tidak valid');
  }

  const rules = new Set();
  const ayat = body.verses.map((v) => {
    const { html, rules: found } = sanitizeTajweed(v.text_uthmani_tajweed);
    found.forEach((r) => rules.add(r));
    return {
      no: Number(String(v.verse_key).split(':')[1]),
      html,
      plain: stripTajweed(html),
    };
  }).sort((a, b) => a.no - b.no);

  const payload = { nomor, ayat, rules: [...rules] };
  tajwidIndex.set(nomor, payload);
  if (writeJSON(TAJWID_PREFIX + nomor, payload)) touchTajwidIndex(nomor);
  return payload;
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
  tajwidIndex?.clear();
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k?.startsWith(CACHE_PREFIX) || k?.startsWith(TAFSIR_PREFIX) || k?.startsWith(TAJWID_PREFIX)) {
      keys.push(k);
    }
  }
  keys.forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem(CACHE_INDEX_KEY);
  localStorage.removeItem(TAJWID_INDEX_KEY);
  return keys.length;
}
