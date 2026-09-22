/**
 * verify-render.mjs — executes the real app modules against a minimal DOM shim
 * and asserts on the markup they actually generate.
 *
 *   node tools/verify-render.mjs
 *
 * This is not a browser: it verifies the JavaScript runtime path (module graph,
 * routing, data flow, template output) rather than CSS layout or paint.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const fail = (m) => { failures += 1; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);
const check = (label, cond, detail = '') =>
  (cond ? pass(label) : fail(`${label}${detail ? ` — ${detail}` : ''}`));

/* ── Minimal DOM ───────────────────────────────────────────────────────── */

const registry = new Map();

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    _html: '',
    _text: '',
    hidden: false,
    value: '',
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    parentElement: null,
    children: [],
    files: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, force) {
        const on = force === undefined ? !this._s.has(c) : force;
        on ? this._s.add(c) : this._s.delete(c);
        return on;
      },
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    setAttribute(k, v) { this.dataset[`attr:${k}`] = String(v); },
    getAttribute(k) { return this.dataset[`attr:${k}`] ?? null; },
    removeAttribute(k) { delete this.dataset[`attr:${k}`]; },
    addEventListener() {}, removeEventListener() {},
    append(...n) { this.children.push(...n); },
    appendChild(n) { this.children.push(n); return n; },
    insertAdjacentHTML(_pos, h) { this._html += h; },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    closest: () => null,
    focus() {}, blur() {}, click() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getContext: () => null,   // no 2D canvas in Node → starfield self-disables
    width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    scrollIntoView() {},
  };
  return el;
}

const listeners = new Map();

globalThis.document = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  activeElement: null,
  title: '',
  querySelector(sel) {
    if (!registry.has(sel)) registry.set(sel, makeEl());
    return registry.get(sel);
  },
  querySelectorAll: () => [],
  getElementById(id) { return this.querySelector(`#${id}`); },
  createElement: (t) => makeEl(t),
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener() {},
};
globalThis.document.documentElement.dataset = {};

globalThis.window = {
  innerHeight: 900,
  scrollY: 0,
  scrollTo() {},
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
};
globalThis.IntersectionObserver = globalThis.window.IntersectionObserver;
globalThis.location = { hash: '' };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

class AudioStub {
  constructor() { this.preload = ''; this.currentTime = 0; this.duration = 0; this.paused = true; this.src = ''; }
  addEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() {}
}
globalThis.Audio = AudioStub;

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const indexJSON = readFileSync(resolve(ROOT, 'data/surah.json'), 'utf8');

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('data/surah.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(indexJSON) };
  }
  const nomor = Number(u.split('/').pop());
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
        deskripsi: 'Surat ini terdiri atas 4 ayat.',
        audioFull: { '05': `https://cdn.equran.id/audio-full/Misyari-Rasyid-Al-Afasi/${String(nomor).padStart(3, '0')}.mp3` },
        ayat: [
          { nomorAyat: 1, teksArab: 'قُلْ هُوَ اللّٰهُ اَحَدٌ', teksLatin: 'Qul huwallāhu aḥad(un).', teksIndonesia: 'Katakanlah, Dialah Allah Yang Maha Esa.', audio: {} },
          { nomorAyat: 2, teksArab: 'اَللّٰهُ الصَّمَدُ', teksLatin: 'Allāhuṣ-ṣamad(u).', teksIndonesia: 'Allah tempat meminta segala sesuatu.', audio: {} },
          { nomorAyat: 3, teksArab: 'لَمْ يَلِدْ وَلَمْ يُوْلَدْ', teksLatin: 'Lam yalid wa lam yūlad.', teksIndonesia: 'Dia tidak beranak dan tidak diperanakkan.', audio: {} },
          { nomorAyat: 4, teksArab: 'وَلَمْ يَكُنْ لَّهٗ كُفُوًا اَحَدٌ', teksLatin: 'Wa lam yakul lahū kufuwan aḥad(un).', teksIndonesia: 'Tidak ada sesuatu pun yang setara dengan-Nya.', audio: {} },
        ],
      },
    }),
  };
};

/* ── Run the app ───────────────────────────────────────────────────────── */

const errors = [];
process.on('uncaughtException', (e) => errors.push(e));
process.on('unhandledRejection', (e) => errors.push(e));

const el = (sel) => document.querySelector(sel);
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
};
const emit = (type) => (listeners.get(type) ?? []).forEach((fn) => fn({ type }));

console.log('\nRuntime render verification');

try {
  await import('../assets/js/app.js');
} catch (err) {
  fail(`importing app.js threw: ${err.stack}`);
}

if (errors.length) {
  errors.forEach((e) => fail(`uncaught during boot: ${e?.stack ?? e}`));
  errors.length = 0;
}

/* ── Home view ─────────────────────────────────────────────────────────── */

const gridReady = await waitFor(() => el('#surahGrid')._html.includes('surah-card'));
check('boot() renders the surah grid', gridReady);

const grid = el('#surahGrid')._html;
const cardCount = (grid.match(/class="surah-card io-reveal"/g) ?? []).length;
check('all 114 surah cards rendered', cardCount === 114, `got ${cardCount}`);
check('each card has exactly one route key', (grid.match(/data-nomor="/g) ?? []).length === 114);
check('cards carry a data-nomor route key', grid.includes('data-nomor="114"'));
check('cards show the Arabic name', grid.includes('الفاتحة') && grid.includes('الناس'));
check('cards mark revelation place', grid.includes('tag--makkah') && grid.includes('tag--madinah'));
check('no unescaped interpolation leaked', !/\$\{/.test(grid));

const chips = el('#quickChips')._html;
check('quick-pick chips rendered', (chips.match(/class="chip"/g) ?? []).length === 8);

check('hijri date rendered', el('#hijriText')._text.length > 4, el('#hijriText')._text);
check('hero mandala built', el('#mandala')._html.includes('<svg') && el('#mandala')._html.includes('polygon'));
check('result counter set', /surat/.test(el('#resultCount')._text), el('#resultCount')._text);

const settings = el('#settingsBody')._html;
check('settings drawer rendered', settings.includes('data-theme-opt="dark"') && settings.includes('data-toggle="stars"'));
check('settings lists all reciters', (settings.match(/<option value="/g) ?? []).length === 6);

/* ── Reader view ───────────────────────────────────────────────────────── */

location.hash = '#/surat/112';
emit('hashchange');

const ayahReady = await waitFor(() => el('#ayahList')._html.includes('data-ayah="4"'));
check('navigating to #/surat/112 renders the ayah list', ayahReady);

const head = el('#readerHead')._html;
check('surah header rendered', head.includes('Al-Ikhlas') && head.includes('الإخلاص'));
check('header shows ayah count and meaning', head.includes('4 ayat') && head.includes('Ikhlas'));
check('header exposes play/tafsir actions',
  head.includes('data-act="play-surah"') && head.includes('data-act="open-tafsir"'));

const ayahs = el('#ayahList')._html;
const ayahCount = (ayahs.match(/class="ayah io-reveal"/g) ?? []).length;
check('all 4 ayahs rendered', ayahCount === 4, `got ${ayahCount}`);
check('basmalah shown for surah 112', ayahs.includes('class="bismillah"'));
check('Arabic text present', ayahs.includes('قُلْ هُوَ اللّٰهُ اَحَدٌ'));
check('Indonesian translation present', ayahs.includes('Allah tempat meminta segala sesuatu.'));
check('transliteration present', ayahs.includes('Qul huwallāhu aḥad(un).'));
check('ayah numbers use Arabic-Indic digits', ayahs.includes('>١<') && ayahs.includes('>٤<'));
check('per-ayah actions wired', ['play-ayah', 'copy', 'bookmark', 'tafsir']
  .every((a) => ayahs.includes(`data-act="${a}"`)));
check('arabic block is marked RTL', ayahs.includes('lang="ar" dir="rtl"'));

const foot = el('#readerFoot')._html;
check('prev/next surah navigation rendered', foot.includes('#/surat/111') && foot.includes('#/surat/113'));

check('document title follows the route', document.title.includes('Al-Ikhlas'), document.title);
check('reader toolbar revealed', el('#readerToolbar').hidden === false);
check('loading overlay hidden after render', el('#loader').hidden === true);

/* ── Bookmarks view ────────────────────────────────────────────────────── */

location.hash = '#/markah';
emit('hashchange');
await new Promise((r) => setTimeout(r, 60));
check('bookmarks view renders empty state', el('#bmList')._html.includes('empty-note'));

/* ── Failure summary ───────────────────────────────────────────────────── */

if (errors.length) {
  errors.forEach((e) => fail(`uncaught runtime error: ${e?.message ?? e}`));
} else {
  pass('no uncaught errors or unhandled rejections');
}

console.log(`\n${failures === 0 ? 'RUNTIME RENDER CHECKS PASSED' : `${failures} RUNTIME CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
