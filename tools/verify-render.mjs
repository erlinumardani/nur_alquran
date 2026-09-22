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

/** Extract the simple-selector parts the app actually uses. */
function parseSel(sel) {
  const classes = [...sel.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)]
    .map((m) => [m[1].replace(/^data-/, ''), m[2]]);
  const id = sel.match(/#([\w-]+)/)?.[1] ?? null;
  return { classes, attrs, id };
}

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    _html: '',
    _text: '',
    _id: null,
    _attrs: {},
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
    addEventListener(type, fn) {
      (this._on ??= {})[type] = (this._on[type] ?? []).concat(fn);
    },
    removeEventListener() {},
    /** Test hook: invoke handlers registered on this element. */
    _fire(type, ev = {}) {
      (this._on?.[type] ?? []).forEach((fn) => fn({ type, target: this, ...ev }));
    },
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
    if (!registry.has(sel)) {
      const el = makeEl();
      const { classes, attrs, id } = parseSel(sel);
      // Seed the stub from the selector so later querySelectorAll calls and
      // `el.dataset.*` reads behave like the real element would.
      classes.forEach((c) => el.classList.add(c));
      el._id = id;
      for (const [k, v] of attrs) {
        el._attrs[k] = v;
        el.dataset[k] = v;
      }
      registry.set(sel, el);
    }
    return registry.get(sel);
  },
  querySelectorAll(sel) {
    const want = parseSel(sel);
    return [...registry.values()].filter((el) => {
      if (want.id && el._id !== want.id) return false;
      if (!want.classes.every((c) => el.classList.contains(c))) return false;
      return want.attrs.every(([k, v]) => (v === undefined ? k in el._attrs : el._attrs[k] === v));
    });
  },
  getElementById(id) { return this.querySelector(`#${id}`); },
  createElement: (t) => makeEl(t),
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
  removeEventListener() {},
};
globalThis.document.documentElement.dataset = {};

const scrollCalls = [];
globalThis.window = {
  innerHeight: 900,
  scrollY: 0,
  scrollTo(arg) { scrollCalls.push(arg); },
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

/** Every Audio element created, so prefetching is observable. */
const audioInstances = [];

/** Audio element stub that actually raises the events the Player listens for. */
class AudioStub {
  constructor() {
    this.preload = '';
    this.currentTime = 0;
    this.duration = 180;
    this.paused = true;
    this.ended = false;
    this.src = '';
    this._on = {};
    audioInstances.push(this);
  }
  addEventListener(type, fn) { (this._on[type] ??= []).push(fn); }
  _fire(type) { (this._on[type] ?? []).forEach((fn) => fn({ type })); }
  /** Simulate the media reaching its end, as the browser would. */
  fireEnded() { this.ended = true; this.paused = true; this._fire('ended'); }
  /**
   * Mirrors a real browser starting playback, which fires:
   *   play → waiting (buffering) → playing (resumed)
   * The trailing buffering events carry no notion of "playing" and used to
   * reset the play/pause icon mid-playback.
   */
  play() {
    this.paused = false;
    this.ended = false;
    this._fire('play');
    this._fire('waiting');
    this._fire('playing');
    return Promise.resolve();
  }
  pause() { if (this.paused) return; this.paused = true; this._fire('pause'); }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  setAttribute() {}
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

/* ── Play / pause transport ────────────────────────────────────────────── */

const app = globalThis.window.__nur;
check('app internals exposed for testing', !!app?.player && !!app?.state);

/** Simulate a click on a delegated container, as the browser would. */
const tap = (containerSel, dataset) =>
  document.querySelector(containerSel)._fire('click', {
    target: { closest: () => ({ dataset }) },
  });

const btnPlay = el('#btnPlay');
const heroPlay = el('#heroPlay');
const heroLabel = el('#heroPlayLabel');
const card1 = () => document.querySelector('.ayah[data-ayah="1"]');

// Static markup: both glyphs must be present for the swap to be possible.
const indexHtml = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
check('player button ships play + pause glyphs',
  /id="btnPlay"[\s\S]{0,400}?icon--play[\s\S]{0,200}?icon--pause/.test(indexHtml));
check('ayah badge ships play + pause glyphs',
  /class="ayah__no pp"[\s\S]*?icon--play[\s\S]*?icon--pause/.test(ayahs));
check('hero button ships play + pause glyphs and a label',
  /id="heroPlay"[\s\S]*?icon--play[\s\S]*?icon--pause[\s\S]*?id="heroPlayLabel"/.test(head));

// 1. Play an ayah.
tap('#ayahList', { act: 'play-ayah', ayah: '1' });
const started = await waitFor(() => app.state.activeAyah === 1 && app.player.playing);
check('clicking an ayah badge starts playback', started);

check('player button switches to the pause glyph', btnPlay.classList.contains('is-playing'));
check('ayah badge switches to the pause glyph', card1().classList.contains('is-playing'));
// Playing one ayah is playing this surah's recitation, so the hero button
// consistently offers to pause it (there is only one audio mode now).
check('hero button also offers to pause while an ayah plays',
  heroPlay.classList.contains('is-playing'));

// 2. Click the same ayah again → pause.
tap('#ayahList', { act: 'play-ayah', ayah: '1' });
const paused = await waitFor(() => !app.player.playing);
check('clicking the same ayah again pauses', paused);
check('player button returns to the play glyph', !btnPlay.classList.contains('is-playing'));
check('ayah badge returns to the play glyph', !card1().classList.contains('is-playing'));

// 3. Click again → resume (not restart).
const t0 = app.player.track;
tap('#ayahList', { act: 'play-ayah', ayah: '1' });
check('clicking again resumes the same track',
  await waitFor(() => app.player.playing) && app.player.track === t0);

// 4. Player transport button toggles both ways.
tap('#btnPlay', {});
check('player button pauses', await waitFor(() => !app.player.playing));
check('play/pause class cleared on the button', !btnPlay.classList.contains('is-playing'));
tap('#btnPlay', {});
check('player button resumes', await waitFor(() => app.player.playing));
check('play/pause class applied on the button', btnPlay.classList.contains('is-playing'));

// 4b. Regression: starting playback emits play → waiting → playing. The trailing
//     buffering events must not flip the icon back to "play" while audio runs.
check('a play burst leaves the button showing the pause icon',
  app.player.playing === true && btnPlay.classList.contains('is-playing'));
check('pause/resume cycles keep the pause icon (full browser event order)',
  await (async () => {
    for (let i = 0; i < 3; i += 1) {
      tap('#btnPlay', {});
      if (!await waitFor(() => !app.player.playing)) return false;
      tap('#btnPlay', {});
      if (!await waitFor(() => app.player.playing)) return false;
      if (!btnPlay.classList.contains('is-playing')) return false;
      if (!card1().classList.contains('is-playing')) return false;
    }
    return true;
  })());

// 4c. The same burst must not desync the ayah badge.
tap('#ayahList', { act: 'play-ayah', ayah: '2' });
await waitFor(() => app.state.activeAyah === 2 && app.player.playing);
check('second ayah badge shows the pause icon',
  document.querySelector('.ayah[data-ayah="2"]').classList.contains('is-playing'));
check('first ayah badge released the pause icon',
  !card1().classList.contains('is-playing'));

// 5. The murattal button focuses ayah 1 and then follows the recitation.
const cur = (n) => document.querySelector(`.ayah[data-ayah="${n}"]`);
const focused = () => app.state.activeAyah;

/** The same reset the player's close button performs, to start this block clean. */
function resetTransport() {
  app.player.stop();
  app.state.queue = null;
  app.state.activeAyah = null;
  scrollCalls.length = 0;
}

resetTransport();
tap('#readerHead', { act: 'play-surah' });
const heroOn = await waitFor(() => focused() === 1 && app.player.playing);
check('hero button starts the murattal at the first ayah', heroOn);
check('starting the murattal scrolls the view', scrollCalls.length > 0,
  `${scrollCalls.length} scroll call(s)`);
check('the first ayah is highlighted', cur(1).classList.contains('is-active'));
check('the first ayah shows the pause glyph', cur(1).classList.contains('is-playing'));
check('hero button switches to the pause glyph', heroPlay.classList.contains('is-playing'));
check('hero button label becomes "Jeda murottal"',
  heroLabel.textContent === 'Jeda murottal', heroLabel.textContent);
const transport = () => audioInstances[0];
check('the next ayah is prefetched', audioInstances.some((a) => a.src.endsWith('/112002.mp3')),
  audioInstances.map((a) => a.src).join(' | '));

// Finishing ayah 1 must advance, re-focus and re-scroll to ayah 2.
scrollCalls.length = 0;
transport().fireEnded();
check('the recitation advances to the next ayah',
  await waitFor(() => focused() === 2 && app.player.playing));
check('advancing scrolls the view again', scrollCalls.length > 0);
check('ayah 2 is highlighted', cur(2).classList.contains('is-active'));
check('ayah 2 shows the pause glyph', cur(2).classList.contains('is-playing'));
check('ayah 1 released the highlight',
  !cur(1).classList.contains('is-active') && !cur(1).classList.contains('is-playing'));

// And it keeps going, all the way to the last ayah, then stops cleanly.
for (const n of [3, 4]) {
  transport().fireEnded();
  if (!await waitFor(() => focused() === n)) break;
}
check('the chain reaches the last ayah', focused() === 4, String(focused()));
transport().fireEnded();
check('the chain stops at the end of the surah', await waitFor(() => !app.player.playing));
check('the highlight clears when the surah finishes', focused() === null, String(focused()));

// Pausing and resuming must not yank the reader back to the top.
scrollCalls.length = 0;
tap('#readerHead', { act: 'play-surah' });
await waitFor(() => focused() === 1 && app.player.playing);
scrollCalls.length = 0;
tap('#readerHead', { act: 'play-surah' });
check('hero button pauses the murattal', await waitFor(() => !app.player.playing));
check('pausing does not scroll again', scrollCalls.length === 0);
tap('#readerHead', { act: 'play-surah' });
check('hero button resumes the murattal', await waitFor(() => app.player.playing));
check('resuming does not scroll again', scrollCalls.length === 0);
check('resuming keeps the pause glyph on the hero button', heroPlay.classList.contains('is-playing'));

tap('#readerHead', { act: 'play-surah' });
check('hero button returns to the play glyph when paused',
  await waitFor(() => !app.player.playing) && !heroPlay.classList.contains('is-playing'));
check('hero button label returns to "Putar murottal"',
  heroLabel.textContent === 'Putar murottal', heroLabel.textContent);

// 5b. Tapping ayah 1's badge while the murattal runs jumps the chain there.
tap('#readerHead', { act: 'play-surah' });
await waitFor(() => app.player.playing);
tap('#ayahList', { act: 'play-ayah', ayah: '3' });
check('tapping an ayah badge jumps the chain to that ayah',
  await waitFor(() => focused() === 3 && app.player.playing));
check('the jumped-to ayah owns the pause glyph', cur(3).classList.contains('is-playing'));

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
