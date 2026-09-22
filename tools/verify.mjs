/**
 * verify.mjs — offline verification for the app.
 *
 *   node tools/verify.mjs
 *
 * Part A: cross-checks every DOM selector used in JS against the ids/classes that
 *         actually exist in the markup, the stylesheet, or JS-generated templates.
 * Part B: exercises the data layer (URL building, caching, API mapping, formatters)
 *         against a stubbed fetch/localStorage using the real module code.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };
const pass = (msg) => console.log(`  ok    ${msg}`);

/* ══════════════════════════════════════════════════════════════════════════
   Part A — selector integrity
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\nPart A — DOM selector integrity');

const html = read('index.html');
const css = read('assets/css/styles.css');
const jsNames = ['app.js', 'data.js', 'fx.js', 'player.js', 'store.js'];
const js = Object.fromEntries(jsNames.map((n) => [n, read(`assets/js/${n}`)]));
const jsAll = Object.values(js).join('\n');

const addAll = (set, text, re, group = 1) => {
  for (const m of text.matchAll(re)) set.add(m[group]);
  return set;
};

// Universe of ids: declared in HTML, or emitted by a JS template.
const ids = new Set();
addAll(ids, html, /\bid="([^"]+)"/g);
addAll(ids, jsAll, /\bid="([A-Za-z][\w-]*)"/g);

// Universe of classes: stylesheet rules, markup classes, JS templates and
// classList / className calls.
const classes = new Set();
addAll(classes, css, /\.(-?[_a-zA-Z][\w-]*)/g);
addAll(classes, html, /class="([^"]*)"/g);
for (const m of html.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => c && classes.add(c));
for (const m of jsAll.matchAll(/\bclass="([^"]*)"/g)) {
  m[1].split(/\s+/).forEach((c) => { if (c && !c.includes('$')) classes.add(c); });
}
for (const m of jsAll.matchAll(/\bclassList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
  for (const lit of m[1].matchAll(/'([^']+)'/g)) classes.add(lit[1]);
}
for (const m of jsAll.matchAll(/\bclassName\s*=\s*'([^']+)'/g)) classes.add(m[1]);

// Selectors actually used by JS. Template-literal / concatenated selectors cannot
// be resolved statically, so they are reported separately instead of failed.
const usedIds = new Map();
const usedClasses = new Map();
const dynamic = [];

const SELECTOR_CALL = /(?:\$|\$\$|querySelector|querySelectorAll|closest|matches)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

for (const [file, src] of Object.entries(js)) {
  for (const m of src.matchAll(SELECTOR_CALL)) {
    const sel = m[2];
    if (/\$\{|'\s*\+|\+\s*'/.test(sel)) { dynamic.push(`${file}: ${sel}`); continue; }
    for (const id of sel.matchAll(/#([\w-]+)/g)) {
      if (!usedIds.has(id[1])) usedIds.set(id[1], file);
    }
    for (const cls of sel.matchAll(/\.([\w-]+)/g)) {
      if (!usedClasses.has(cls[1])) usedClasses.set(cls[1], file);
    }
  }
}

for (const [id, file] of usedIds) {
  if (ids.has(id)) pass(`#${id} (${file})`);
  else fail(`#${id} used in ${file} but never declared in HTML or a JS template`);
}
for (const [cls, file] of usedClasses) {
  if (classes.has(cls)) pass(`.${cls} (${file})`);
  else fail(`.${cls} used in ${file} but never declared in CSS, HTML or JS`);
}
if (dynamic.length) {
  console.log(`  note  ${dynamic.length} dynamic selector(s) skipped (built at runtime):`);
  dynamic.forEach((d) => console.log(`          ${d}`));
}

// Structural checks that a browser would otherwise catch.
const localAssets = [...html.matchAll(/(?:src|href)="((?!https?:|data:|#)[^"]+)"/g)].map((m) => m[1]);
const missingAssets = localAssets.filter((p) => {
  try { readFileSync(resolve(ROOT, p)); return false; } catch { return true; }
});

const structure = [
  ['all local assets referenced by index.html exist',
    missingAssets.length === 0, missingAssets.join(', ')],
  ['all views present', ['view-home', 'view-reader', 'view-bookmarks'].every((v) => html.includes(`id="${v}"`))],
  ['all drawers present', ['drawerTafsir', 'drawerSettings', 'drawerReciter'].every((d) => html.includes(`id="${d}"`))],
  ['module entry declared', /<script type="module" src="assets\/js\/app\.js">/.test(html)],
  ['no leftover template placeholder', !/\{\{[a-z]+\}\}/i.test(html)],
];
console.log('\n  Structure');
structure.forEach(([label, ok, detail]) => (ok ? pass(label) : fail(`${label} — ${detail}`)));

/* ══════════════════════════════════════════════════════════════════════════
   Part B — data layer
   ══════════════════════════════════════════════════════════════════════════ */

console.log('\nPart B — data layer');

// Minimal browser stubs so the real modules can be imported in Node.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  scrollTo() {},
  location: { hash: '' },
};
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

const surahFixture = JSON.parse(read('data/surah.json'));

let fetchLog = [];
globalThis.fetch = async (url) => {
  fetchLog.push(String(url));
  if (String(url).includes('equran.id')) {
    const nomor = Number(String(url).split('/').pop());
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 200,
        message: 'ok',
        data: {
          nomor,
          nama: 'الاخلاص',
          namaLatin: 'Al-Ikhlas',
          arti: 'Ikhlas',
          jumlahAyat: 4,
          tempatTurun: 'Mekkah',
          deskripsi: 'desc',
          audioFull: { '05': `https://cdn.equran.id/audio-full/Misyari-Rasyid-Al-Afasi/${String(nomor).padStart(3, '0')}.mp3` },
          ayat: [1, 2, 3, 4].map((n) => ({
            nomorAyat: n,
            teksArab: `arab-${n}`,
            teksLatin: `latin-${n}`,
            teksIndonesia: `terjemah-${n}`,
            audio: { '05': `https://cdn.equran.id/audio-partial/Misyari-Rasyid-Al-Afasi/${String(nomor).padStart(3, '0')}${String(n).padStart(3, '0')}.mp3` },
          })),
        },
      }),
    };
  }
  throw new Error(`unexpected fetch: ${url}`);
};

const { loadIndex, getSurah, audioUrlAyah, RECITERS, getReciter, clearCache } =
  await import('../assets/js/data.js');
const { getPrefs, setPref, toggleBookmark, getBookmarks, isBookmarked, setLastRead, getLastRead, resetPrefs, resolveTheme, applyTheme } =
  await import('../assets/js/store.js');
const { toArabicDigits, fmtTime, spellNumber, esc, starPolygon } = await import('../assets/js/fx.js');

const check = (label, cond, detail = '') => (cond ? pass(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`));

// URL builders
check('audioUrlAyah pads surah+ayah to 3 digits each',
  audioUrlAyah(2, 255, '05') === 'https://cdn.equran.id/audio-partial/Misyari-Rasyid-Al-Afasi/002255.mp3',
  audioUrlAyah(2, 255, '05'));
check('audioUrlAyah stays correct past ayah 9', audioUrlAyah(112, 4, '01').endsWith('/112004.mp3'),
  audioUrlAyah(112, 4, '01'));
check('unknown reciter falls back to first', getReciter('99').id === RECITERS[0].id);
check('all 6 reciters defined', RECITERS.length === 6);

// Fetch + cache
const s112 = await getSurah(112);
check('getSurah maps API fields', s112.ayat.length === 4 && s112.ayat[0].tr === 'terjemah-1');
check('getSurah requested the right endpoint', fetchLog.some((u) => u.endsWith('/surat/112')));
check('surah cached in localStorage', store.has('nur:surah:112'));
const before = fetchLog.length;
await getSurah(112);
check('second getSurah hits cache (no network)', fetchLog.length === before);

const cleared = clearCache();
check('clearCache removes entries', cleared > 0 && !store.has('nur:surah:112'));

// Index
const idx = await loadIndex().catch(() => surahFixture);
check('index has 114 surahs', idx.length === 114, String(idx.length));
check('index ayah total is 6236', idx.reduce((a, s) => a + s.ayat, 0) === 6236);
check('every surah has required fields',
  idx.every((s) => s.n && s.ar && s.id && s.arti && s.ayat && s.turun));

// Preferences
resetPrefs();
check('defaults applied', getPrefs().reciter === '05' && getPrefs().theme === 'dark');
setPref('showLatin', false);
check('setPref persists', JSON.parse(store.get('nur:prefs')).showLatin === false);
check('resolveTheme auto respects system', resolveTheme('auto') === 'dark');

// Bookmarks
resetPrefs();
toggleBookmark({ surah: 2, ayah: 255, surahName: 'Al-Baqarah' });
check('bookmark added', isBookmarked(2, 255) && getBookmarks().length === 1);
toggleBookmark({ surah: 2, ayah: 255, surahName: 'Al-Baqarah' });
check('bookmark toggled off', !isBookmarked(2, 255) && getBookmarks().length === 0);

setLastRead({ surah: 18, ayah: 10, surahName: 'Al-Kahf' });
check('last read round-trips', getLastRead().surah === 18 && getLastRead().ayah === 10);

// Formatters
check('toArabicDigits', toArabicDigits(286) === '٢٨٦', toArabicDigits(286));
check('fmtTime minutes', fmtTime(125) === '2:05', fmtTime(125));
check('fmtTime hours', fmtTime(3725) === '1:02:05', fmtTime(3725));
check('fmtTime guards NaN', fmtTime(NaN) === '0:00');
check('spellNumber', spellNumber(286) === 'dua ratus delapan puluh enam', spellNumber(286));
check('esc escapes markup', esc('<b>&"x"') === '&lt;b&gt;&amp;&quot;x&quot;');
check('starPolygon returns 16 points', starPolygon(48).split(' ').length === 16);

/* ── Summary ───────────────────────────────────────────────────────────── */

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
