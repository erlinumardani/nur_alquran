/**
 * app.js — application shell: routing, views, audio orchestration, interaction.
 */

import {
  loadIndex, getSurah, getTafsir, clearCache,
  RECITERS, getReciter, audioUrlAyah,
} from './data.js';

import {
  DEFAULT_PREFS, getPrefs, setPref, resetPrefs, applyTheme, resolveTheme,
  getBookmarks, isBookmarked, toggleBookmark, removeBookmark,
  getLastRead, setLastRead, onPrefsChange,
} from './store.js';

import {
  $, $$, esc, toast, observeReveals, initStarfield, buildMandala,
  renderHijriDate, toArabicDigits, fmtTime, starPolygon,
} from './fx.js';

import { Player } from './player.js';

/* ══════════════════════════════════════════════════════════════════════════
   State
   ══════════════════════════════════════════════════════════════════════════ */

const state = {
  index: [],
  filter: 'all',
  query: '',
  nomor: null,
  surah: null,
  tafsir: null,
  loadingSurah: false,
  queue: null,          // { nomor, ayah } — the ayah chain currently playing
  activeAyah: null,
  abort: null,
};

const player = new Player();
let starfield = null;
let spy = null;
let spyTimer = null;
let tafsirSpy = null;

const BISMILLAH = 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ';

/** Surahs whose first ayah already is the basmalah, or that omit it entirely. */
const NO_BISMILLAH = new Set([1, 9]);

const BADGE_48 = starPolygon(48, 8, 0.46, 0.2, 22.5);
const BADGE_44 = starPolygon(44, 8, 0.46, 0.2, 22.5);

/* ══════════════════════════════════════════════════════════════════════════
   Boot
   ══════════════════════════════════════════════════════════════════════════ */

async function boot() {
  applyTheme();
  buildMandala($('#mandala'));
  starfield = initStarfield();
  renderHijriDate($('#hijriText'));

  bindGlobalUI();
  bindPlayerUI();
  renderSettings();
  bindRouter();

  try {
    state.index = await loadIndex();
  } catch (err) {
    toast(err.message, '⚠');
    $('#surahGrid').innerHTML =
      `<p class="empty-note">Gagal memuat daftar surat.<br>${esc(err.message)}</p>`;
    return;
  }

  renderQuickChips();
  renderSurahGrid();

  onPrefsChange(() => {
    applyTextScales();
    renderSettings();
    renderBookmarks();
  });

  route();
}

/* ══════════════════════════════════════════════════════════════════════════
   Router
   ══════════════════════════════════════════════════════════════════════════ */

function bindRouter() {
  window.addEventListener('hashchange', route);
  $$('[data-nav="home"]').forEach((el) =>
    el.addEventListener('click', () => {
      if (location.hash === '' || location.hash === '#/') route();
    }),
  );
}

function showView(id) {
  $$('.view').forEach((v) => v.classList.toggle('view--active', v.id === id));
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [seg, a, b] = hash.split('/');

  if (seg === 'surat' && a) {
    await openSurah(Number(a), b ? Number(b) : null);
    return;
  }
  if (seg === 'markah') {
    showView('view-bookmarks');
    renderBookmarks();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  showView('view-home');
  document.title = 'Nūr al-Qur\u2019ān — Al-Qur\u2019an & Terjemahan Bahasa Indonesia';
  updateReadProgress();
}

/* ══════════════════════════════════════════════════════════════════════════
   Home view
   ══════════════════════════════════════════════════════════════════════════ */

const QUICK_PICKS = [1, 2, 18, 36, 55, 67, 78, 112];

function renderQuickChips() {
  const host = $('#quickChips');
  host.innerHTML = QUICK_PICKS.map((n) => {
    const s = state.index[n - 1];
    if (!s) return '';
    return `<button class="chip" type="button" data-nomor="${s.n}">
      ${esc(s.id)}<span class="chip__ar">${esc(s.ar)}</span>
    </button>`;
  }).join('');
}

function matches(s, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    s.id.toLowerCase().includes(needle) ||
    s.arti.toLowerCase().includes(needle) ||
    s.en.toLowerCase().includes(needle) ||
    String(s.n) === needle.trim() ||
    s.ar.includes(q)
  );
}

function filteredIndex() {
  return state.index.filter(
    (s) => (state.filter === 'all' || s.turun === state.filter) && matches(s, state.query),
  );
}

function renderSurahGrid() {
  const grid = $('#surahGrid');
  const list = filteredIndex();

  $('#resultCount').textContent = state.query || state.filter !== 'all'
    ? `${list.length} surat ditemukan`
    : '114 surat · 30 juz';

  $('#emptyState').hidden = list.length > 0;

  grid.innerHTML = list.map((s, i) => `
    <button class="surah-card io-reveal" type="button" data-nomor="${s.n}" style="--i:${i % 14}">
      <span class="surah-card__no" aria-hidden="true">
        <svg viewBox="0 0 48 48"><polygon points="${BADGE_48}"/></svg>
        <span>${s.n}</span>
      </span>
      <span class="surah-card__body">
        <span class="surah-card__name">${esc(s.id)}</span>
        <span class="surah-card__meta">
          <span class="tag tag--${s.turun === 'Madinah' ? 'madinah' : 'makkah'}">${s.turun === 'Madinah' ? 'Madaniyah' : 'Makkiyah'}</span>
          <span>${s.ayat} ayat</span>
          <span class="sep">·</span>
          <span>${esc(s.arti)}</span>
        </span>
      </span>
      <span class="surah-card__ar" lang="ar" dir="rtl">${esc(s.ar)}</span>
    </button>
  `).join('');

  observeReveals(grid);
}

/* ══════════════════════════════════════════════════════════════════════════
   Reader view
   ══════════════════════════════════════════════════════════════════════════ */

function skeletonAyahs(count = 6) {
  return Array.from({ length: count }, () =>
    '<div class="skeleton sk-ayah" aria-hidden="true"></div>').join('');
}

async function openSurah(nomor, ayah = null) {
  if (!state.index.length) await loadIndex().then((d) => { state.index = d; }).catch(() => {});

  showView('view-reader');
  state.nomor = nomor;
  state.activeAyah = null;
  applyTextScales();

  const meta = state.index[nomor - 1];
  renderSurahHead(meta ?? { n: nomor, id: `Surat ${nomor}`, ar: '', ayat: 0, arti: '', turun: '', desc: '' });
  $('#readerFoot').hidden = true;

  document.title = `${meta ? meta.id : `Surat ${nomor}`} — Nūr al-Qur\u2019ān`;

  // Load text (cached surahs resolve synchronously-ish and skip the skeleton).
  const list = $('#ayahList');
  if (state.surah?.nomor !== nomor) {
    state.surah = null;
    state.tafsir = null;
    list.innerHTML = skeletonAyahs();
    $('#loader').hidden = false;
    $('#loaderText').textContent = `Memuat ${meta?.id ?? `surat ${nomor}`}…`;
  }

  state.abort?.abort();
  state.abort = new AbortController();

  try {
    const data = await getSurah(nomor, { signal: state.abort.signal });
    state.surah = data;
    renderAyahs(data);
    renderSurahFoot(data);
    syncPlaybackUI(player.playing);
    if (ayah) scrollToAyah(ayah, { smooth: false });
    else window.scrollTo({ top: 0, behavior: 'auto' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    list.innerHTML = `
      <p class="empty-note">
        Gagal memuat ayat. Periksa koneksi internet lalu coba lagi.<br>
        <small>${esc(err.message)}</small>
      </p>
      <div style="text-align:center;padding-bottom:2rem">
        <button class="btn btn--primary" type="button" id="retrySurah">Coba lagi</button>
      </div>`;
    $('#retrySurah')?.addEventListener('click', () => openSurah(nomor, ayah));
  } finally {
    $('#loader').hidden = true;
  }
}

function renderSurahHead(s) {
  $('#readerHead').innerHTML = `
    <div class="surah-hero">
      <div class="surah-hero__badge">
        <span class="surah-hero__no">Surat ke-${s.n} · ${s.turun === 'Madinah' ? 'Madaniyah' : 'Makkiyah'}</span>
      </div>
      <p class="surah-hero__arabic" lang="ar" dir="rtl">${esc(s.arLong || s.ar)}</p>
      <h2 class="surah-hero__latin" id="readerTitle">${esc(s.id)}</h2>
      <div class="surah-hero__row">
        <span class="pill">${s.ayat} ayat</span>
        <span class="pill">Artinya: ${esc(s.arti)}</span>
        <span class="pill">Surat ke-${s.n} dari 114</span>
      </div>
      ${s.desc ? `<p class="surah-hero__desc" id="surahDesc">${esc(s.desc)}</p>
        <button class="surah-hero__more" id="surahMore" type="button">Selengkapnya</button>` : ''}
      <div class="surah-hero__actions">
        <button class="btn btn--primary pp" type="button" data-act="play-surah" id="heroPlay">
          <svg viewBox="0 0 24 24" class="icon icon--play" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>
          <svg viewBox="0 0 24 24" class="icon icon--pause" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>
          <span id="heroPlayLabel">Putar murottal</span>
        </button>
        <button class="btn" type="button" data-act="open-tafsir">
          <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M4 5h7a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H4zM20 5h-7a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h7z"/></svg>
          Baca tafsir
        </button>
        <button class="btn" type="button" data-act="toggle-bookmark-surah">
          <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>
          Tandai ayat 1
        </button>
      </div>
    </div>`;

  const desc = $('#surahDesc');
  const more = $('#surahMore');
  if (desc && more) {
    // Only offer the toggle when the text is actually clipped.
    if (desc.scrollHeight <= desc.clientHeight + 4) more.hidden = true;
    more.addEventListener('click', () => {
      const open = desc.classList.toggle('is-open');
      more.textContent = open ? 'Sembunyikan' : 'Selengkapnya';
    });
  }

  $('#readerToolbar').hidden = false;
}

function renderAyahs(data) {
  const showLatin = getPrefs().showLatin;
  const showTafsir = getPrefs().showTafsir;
  const bismillah = NO_BISMILLAH.has(data.nomor) ? '' :
    `<p class="bismillah" lang="ar" dir="rtl">${BISMILLAH}</p>`;

  $('#ayahList').innerHTML = bismillah + data.ayat.map((a, i) => `
    <article class="ayah io-reveal" id="ayah-${a.no}" data-ayah="${a.no}" style="--i:${Math.min(i, 12)}">
      <div class="ayah__rail">
        <button class="ayah__no pp" type="button" data-act="play-ayah" data-ayah="${a.no}"
                aria-label="Putar ayat ${a.no}">
          <svg class="ayah__no-badge" viewBox="0 0 44 44" aria-hidden="true"><polygon points="${BADGE_44}"/></svg>
          <span class="ayah__no-num">${toArabicDigits(a.no)}</span>
          <svg viewBox="0 0 24 24" class="icon ayah__no-icon icon--play" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>
          <svg viewBox="0 0 24 24" class="icon ayah__no-icon icon--pause" aria-hidden="true"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>
        </button>
        <div class="ayah__acts">
          <button class="act" type="button" data-act="copy" data-ayah="${a.no}" aria-label="Salin ayat ${a.no}" data-tip="Salin">
            <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
          </button>
          <button class="act${isBookmarked(data.nomor, a.no) ? ' is-on' : ''}" type="button"
                  data-act="bookmark" data-ayah="${a.no}" aria-label="Tandai ayat ${a.no}" data-tip="Tandai">
            <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>
          </button>
          <button class="act" type="button" data-act="tafsir" data-ayah="${a.no}" aria-label="Tafsir ayat ${a.no}" data-tip="Tafsir">
            <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M4 5h7a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H4zM20 5h-7a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h7z"/></svg>
          </button>
        </div>
      </div>
      <div class="ayah__body">
        <p class="ayah__arab" lang="ar" dir="rtl">${esc(a.arab)}<span class="end-mark">${toArabicDigits(a.no)}</span></p>
        <p class="ayah__latin"${showLatin ? '' : ' hidden'}>${esc(a.latin)}</p>
        <p class="ayah__tr">${esc(a.tr)}</p>
        ${showTafsir ? '<div class="ayah__tafsir" data-auto="1"></div>' : ''}
      </div>
    </article>
  `).join('');

  applyTextScales();
  observeReveals($('#ayahList'));
  startScrollSpy();
  updateReadProgress();

  if (showTafsir) autoFillTafsir();
}

function renderSurahFoot(data) {
  const prev = state.index[data.nomor - 2];
  const next = state.index[data.nomor];
  const foot = $('#readerFoot');
  foot.hidden = false;
  foot.innerHTML = `
    ${prev ? `<a class="foot-nav" href="#/surat/${prev.n}">
        <small>Surat sebelumnya</small><strong>${esc(prev.id)} · ${esc(prev.arti)}</strong></a>` : '<span></span>'}
    ${next ? `<a class="foot-nav foot-nav--next" href="#/surat/${next.n}">
        <small>Surat berikutnya</small><strong>${esc(next.id)} · ${esc(next.arti)}</strong></a>` : '<span></span>'}`;
}

function applyTextScales() {
  const p = getPrefs();
  const root = document.documentElement;
  root.style.setProperty('--arab-size', `${(2.05 * p.arabScale).toFixed(2)}rem`);
  root.style.setProperty('--tr-size', `${(1 * p.trScale).toFixed(2)}rem`);
}

function scrollToAyah(no, { smooth = true } = {}) {
  const el = $(`#ayah-${no}`);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 130;
  window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

/* ── Scroll spy → "lanjutkan bacaan" ───────────────────────────────────── */

function startScrollSpy() {
  spy?.disconnect();
  let pending = null;

  spy = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible || !state.surah) return;

      pending = Number(visible.target.dataset.ayah);
      clearTimeout(spyTimer);
      spyTimer = setTimeout(() => {
        if (!pending) return;
        const meta = state.index[state.surah.nomor - 1];
        setLastRead({
          surah: state.surah.nomor,
          ayah: pending,
          surahName: meta?.id ?? '',
        });
      }, 1200);
    },
    { rootMargin: '-120px 0px -60% 0px', threshold: 0 },
  );

  $$('.ayah').forEach((el) => spy.observe(el));
}

/* ══════════════════════════════════════════════════════════════════════════
   Tafsir
   ══════════════════════════════════════════════════════════════════════════ */

async function loadTafsirInto(nomor) {
  if (state.tafsir?.nomor === nomor) return state.tafsir.list;
  const list = await getTafsir(nomor);
  state.tafsir = { nomor, list };
  return list;
}

async function openTafsir(ayahNo = null) {
  const nomor = state.surah?.nomor ?? state.nomor;
  if (!nomor) return;

  const body = $('#tafsirBody');
  const meta = state.index[nomor - 1];
  $('#tafsirSub').textContent = `${meta?.id ?? ''} · Tafsir Kemenag RI`;
  body.innerHTML = '<div class="skeleton" style="height:180px"></div>';

  openDrawer('drawerTafsir');

  try {
    const list = await loadTafsirInto(nomor);
    const items = ayahNo ? list.filter((t) => t.no === ayahNo) : list;

    if (!items.length) {
      body.innerHTML = '<p class="empty-note">Tafsir tidak tersedia untuk bagian ini.</p>';
      return;
    }

    const hero = ayahNo && state.surah
      ? (() => {
          const a = state.surah.ayat.find((x) => x.no === ayahNo);
          return a ? `<div class="tafsir-hero">
              <p class="tafsir-hero__ar" lang="ar" dir="rtl">${esc(a.arab)}</p>
              <p class="tafsir-hero__tr">${esc(a.tr)}</p>
            </div>` : '';
        })()
      : '';

    body.innerHTML = hero + items.map((t) => {
      const ayah = state.surah?.ayat.find((x) => x.no === t.no);
      return `<section class="tafsir-item">
        <span class="tafsir-item__head">Ayat ${t.no}${ayah ? ` · ${esc(ayah.latin.slice(0, 46))}${ayah.latin.length > 46 ? '…' : ''}` : ''}</span>
        ${String(t.teks).split(/\n{2,}/).map((p) => `<p class="tafsir-item__text">${esc(p.trim())}</p>`).join('')}
      </section>`;
    }).join('');
    body.scrollTop = 0;
  } catch (err) {
    body.innerHTML = `<p class="empty-note">Gagal memuat tafsir.<br><small>${esc(err.message)}</small></p>`;
  }
}

/** Inline tafsir panel for a single ayah card. */
async function toggleInlineTafsir(ayahNo) {
  const card = $(`#ayah-${ayahNo}`);
  const panel = card?.querySelector('.ayah__tafsir');
  if (!panel) return;

  if (!panel.hidden && panel.dataset.loaded) {
    panel.hidden = true;
    return;
  }

  panel.hidden = false;
  if (panel.dataset.loaded) return;

  const nomor = state.nomor;
  panel.innerHTML = '<span class="ayah__note">Memuat tafsir…</span>';
  try {
    const list = await loadTafsirInto(nomor);
    if (state.nomor !== nomor) return;
    const item = list.find((t) => t.no === ayahNo);
    fillTafsirPanel(panel, ayahNo, item?.teks);
  } catch (err) {
    panel.innerHTML = `<span class="ayah__note">Gagal memuat tafsir: ${esc(err.message)}</span>`;
  }
}

function fillTafsirPanel(panel, ayahNo, teks) {
  panel.innerHTML = teks
    ? `<strong>Tafsir · Ayat ${ayahNo}</strong>${
        String(teks).split(/\n{2,}/).map((p) => `<p>${esc(p.trim())}</p>`).join('')}`
    : '<strong>Tafsir</strong><p>Tafsir untuk ayat ini tidak tersedia.</p>';
  panel.dataset.loaded = '1';
}

/**
 * With the inline-tafsir preference on, every ayah gets a panel. Filling all of
 * them up front would bloat the DOM for long surahs, so panels are filled only
 * as they scroll into view (one shared fetch per surah).
 */
async function autoFillTafsir() {
  const nomor = state.nomor;
  const panels = $$('.ayah__tafsir[data-auto]');
  if (!panels.length) return;

  try {
    const list = await loadTafsirInto(nomor);
    if (state.nomor !== nomor) return;
    const byAyah = new Map(list.map((t) => [t.no, t.teks]));

    tafsirSpy?.disconnect();
    tafsirSpy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const no = Number(entry.target.closest('.ayah')?.dataset.ayah);
          fillTafsirPanel(entry.target, no, byAyah.get(no));
          tafsirSpy.unobserve(entry.target);
        });
      },
      { rootMargin: '260px 0px' },
    );
    panels.forEach((p) => tafsirSpy.observe(p));
  } catch {
    panels.forEach((p) => {
      p.innerHTML = '<span class="ayah__note">Tafsir tidak dapat dimuat.</span>';
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Audio orchestration
   ══════════════════════════════════════════════════════════════════════════ */

async function playAyah(nomor, ayahNo) {
  const data = state.surah?.nomor === nomor ? state.surah : await getSurah(nomor);
  state.surah = data;
  const reciter = getPrefs().reciter;
  const ayah = data.ayat.find((a) => a.no === ayahNo);
  const meta = state.index[nomor - 1];

  state.queue = { nomor, ayah: ayahNo };

  await player.load({
    url: ayah?.audio?.[reciter] || audioUrlAyah(nomor, ayahNo, reciter),
    surah: nomor,
    ayah: ayahNo,
    title: `${meta?.id ?? ''} : ${ayahNo}`,
    sub: `${getReciter(reciter).name} · murottal per ayat`,
  });

  // Focus the ayah being recited, then warm up the next one.
  setActiveAyah(ayahNo);
  syncPlaybackUI(player.playing);   // the `play` event may have fired before this
  warmNextAyah(data, ayahNo, reciter);
}

/**
 * Play the surah from its first ayah and keep going, so the reader follows the
 * recitation ayah by ayah.
 *
 * A single full-surah MP3 would be gapless, but one continuous file carries no
 * timing data — there is no reliable way to know which ayah is being recited, so
 * the highlight could not follow. Chaining the per-ayah murattal keeps the text
 * and the recitation exactly in step, and prefetching hides the joins.
 */
async function startMurattal() {
  const q = state.queue;
  if (q?.nomor === state.nomor && player.track) {
    await player.toggle();   // already streaming this surah → pause / resume
    return;
  }
  await playAyah(state.nomor, 1);
}

/** Preload the following ayah so continuous murattal has no audible gap. */
function warmNextAyah(data, ayahNo, reciter) {
  if (!getPrefs().autoplayNext || getPrefs().loopAyah) return;
  const next = data.ayat.find((a) => a.no === ayahNo + 1);
  if (!next) return;
  player.prefetch(next.audio?.[reciter] || audioUrlAyah(data.nomor, ayahNo + 1, reciter));
}

function setActiveAyah(no) {
  state.activeAyah = no;
  $$('.ayah').forEach((el) => el.classList.remove('is-active', 'is-playing'));

  if (!no) return;
  const card = $(`.ayah[data-ayah="${no}"]`);
  card?.classList.add('is-active');
  card?.classList.toggle('is-playing', player.playing);
  card?.querySelector('.ayah__no')?.setAttribute('aria-current', 'true');
  scrollToAyah(no);
}

/** Reflect the transport state on the ayah badge, the player button and the hero button. */
function syncPlaybackUI(playing) {
  $('#btnPlay').classList.toggle('is-playing', playing);
  $('#equalizer').classList.toggle('is-on', playing);
  $('#player').classList.toggle('is-playing', playing);
  $('#btnPlay').setAttribute('aria-label', playing ? 'Jeda' : 'Putar');

  if (state.activeAyah) {
    const card = $(`.ayah[data-ayah="${state.activeAyah}"]`);
    card?.classList.toggle('is-playing', playing);
    card?.querySelector('.ayah__no')?.setAttribute(
      'aria-label',
      `${playing ? 'Jeda' : 'Putar'} ayat ${state.activeAyah}`,
    );
  }

  // The hero button mirrors whichever transport belongs to the surah on screen.
  const onSurah = state.queue?.nomor === state.nomor && playing;
  const hero = $('#heroPlay');
  if (hero) {
    hero.classList.toggle('is-playing', !!onSurah);
    const label = $('#heroPlayLabel');
    if (label) label.textContent = onSurah ? 'Jeda murottal' : 'Putar murottal';
  }
}

async function stepAyah(delta) {
  const q = state.queue;
  if (!q) return;
  const data = state.surah;
  if (!data) return;

  const target = (q.ayah ?? 1) + delta;
  if (target < 1 || target > data.ayat.length) {
    if (target > data.ayat.length) toast('Telah sampai akhir surat', '۞');
    return;
  }
  await playAyah(q.nomor, target);
}

/* ── Player UI wiring ──────────────────────────────────────────────────── */

function bindPlayerUI() {
  const bar = $('#player');
  const progress = $('#playerProgress');

  $('#btnLoop').classList.toggle('is-on', getPrefs().loopAyah);
  $('#btnToggleLatin').classList.toggle('is-on', getPrefs().showLatin);
  $('#btnToggleTafsir').classList.toggle('is-on', getPrefs().showTafsir);

  player.on('track', (track) => {
    bar.hidden = !track;
    document.body.classList.toggle('has-player', !!track);
    if (!track) return;
    $('#playerTitle').textContent = track.title;
    $('#playerSub').textContent = track.sub ?? '';
    $('#playerReciter').textContent = getReciter(getPrefs().reciter).name;
    $$('.ayah').forEach((el) => el.classList.remove('is-playing'));
  });

  player.on('state', ({ playing, buffering } = {}) => {
    // Prefer the element's own state over the event payload: buffering events
    // also arrive here, and reading a missing `playing` as false would flip the
    // icon back to "play" while audio is playing.
    syncPlaybackUI(typeof playing === 'boolean' ? playing : player.playing);
    if (buffering) $('#playerSub').textContent = 'Menyangga…';
    else if (player.track) $('#playerSub').textContent = player.track.sub ?? '';
  });

  player.on('time', ({ fraction, label }) => {
    progress.style.setProperty('--p', `${(fraction * 100).toFixed(2)}%`);
    progress.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    $('#playerTime').textContent = label;
    $('#playerElapsed').textContent = fmtTime(player.currentTime);
  });

  player.on('ended', async () => {
    const q = state.queue;
    if (!q) return;

    if (getPrefs().loopAyah) {
      await playAyah(q.nomor, q.ayah);
      return;
    }
    // Advancing re-focuses and re-scrolls, so the reader follows the recitation.
    const last = state.surah?.ayat.length ?? 0;
    if (getPrefs().autoplayNext && q.ayah < last) {
      await playAyah(q.nomor, q.ayah + 1);
    } else {
      setActiveAyah(null);
      toast('Murottal selesai', '۞');
    }
  });

  player.on('error', (err) => toast(err.message ?? 'Audio gagal diputar', '⚠'));

  player.bindMediaSession({
    onPlay: () => player.play(),
    onPause: () => player.pause(),
    onStop: () => player.stop(),
    onPrev: () => stepAyah(-1),
    onNext: () => stepAyah(1),
  });

  // Progress scrubbing (pointer + keyboard).
  const seekFromEvent = (ev) => {
    const rect = progress.getBoundingClientRect();
    const x = (ev.touches?.[0]?.clientX ?? ev.clientX) - rect.left;
    player.seek(x / rect.width);
  };
  let scrubbing = false;
  progress.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    progress.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  progress.addEventListener('pointermove', (e) => scrubbing && seekFromEvent(e));
  progress.addEventListener('pointerup', (e) => {
    scrubbing = false;
    progress.releasePointerCapture?.(e.pointerId);
  });
  progress.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { player.skip(5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { player.skip(-5); e.preventDefault(); }
  });

  $('#btnPlay').addEventListener('click', () => player.toggle());
  $('#btnBack10').addEventListener('click', () => player.skip(-5));
  $('#btnFwd10').addEventListener('click', () => player.skip(5));
  $('#btnPrevAyah').addEventListener('click', () => stepAyah(-1));
  $('#btnNextAyah').addEventListener('click', () => stepAyah(1));

  $('#btnLoop').addEventListener('click', (e) => {
    const on = !getPrefs().loopAyah;
    setPref('loopAyah', on);
    e.currentTarget.classList.toggle('is-on', on);
    toast(on ? 'Ulangi ayat aktif' : 'Ulangi dimatikan', '↻');
  });

  $('#btnClosePlayer').addEventListener('click', () => {
    player.stop();
    state.queue = null;
    setActiveAyah(null);
  });

  $('#btnReciter').addEventListener('click', () => {
    openDrawer('drawerReciter');
    renderReciterList();
  });
}

function renderReciterList() {
  const current = getPrefs().reciter;
  $('#reciterBody').innerHTML = RECITERS.map((r) => `
    <button class="set-row" type="button" data-reciter="${r.id}"
            style="width:100%;text-align:left;border-radius:var(--radius-sm);padding-inline:.6rem">
      <span class="set-row__label">
        <strong>${esc(r.name)}</strong>
        <small>${r.id === current ? 'Sedang dipilih' : 'Pilih qari ini'}</small>
      </span>
      <span class="act${r.id === current ? ' is-on' : ''}">
        <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="m5 13 4 4L19 7"/></svg>
      </span>
    </button>
  `).join('');
}

function chooseReciter(id) {
  setPref('reciter', id);
  $('#playerReciter').textContent = getReciter(id).name;
  renderReciterList();
  closeDrawers();
  toast(`Qari: ${getReciter(id).name}`, '♪');

  const q = state.queue;
  if (!q) return;
  playAyah(q.nomor, q.ayah);
}

/* ══════════════════════════════════════════════════════════════════════════
   Bookmarks view
   ══════════════════════════════════════════════════════════════════════════ */

function renderBookmarks() {
  const last = getLastRead();
  const list = getBookmarks();

  $('#bmCount').textContent = list.length;
  const badge = $('#bmBadge');
  badge.textContent = list.length;
  badge.hidden = list.length === 0;

  $('#lastReadCard').innerHTML = last
    ? `<a class="bm-card" href="#/surat/${last.surah}/${last.ayah}">
        <span class="bm-card__top">
          <span class="bm-card__surah">${esc(last.surahName || `Surat ${last.surah}`)} · Ayat ${last.ayah}</span>
          <span class="bm-card__surah">${esc(timeAgo(last.ts))}</span>
        </span>
        <span class="bm-card__tr">Ketuk untuk melanjutkan bacaan dari ayat terakhir yang kamu lihat.</span>
      </a>`
    : '<p class="empty-note">Belum ada riwayat bacaan. Buka salah satu surat untuk mulai membaca.</p>';

  $('#bmList').innerHTML = list.length
    ? list.map((b) => `
      <a class="bm-card" href="#/surat/${b.surah}/${b.ayah}">
        <span class="bm-card__top">
          <span class="bm-card__surah">${esc(b.surahName || `Surat ${b.surah}`)} : ${b.ayah}</span>
          <span class="bm-card__surah">${esc(timeAgo(b.ts))}</span>
        </span>
        <span class="bm-card__ar" lang="ar" dir="rtl">${esc(b.arab ?? '')}</span>
        <span class="bm-card__tr">${esc(b.tr ?? '')}</span>
        <button class="bm-card__del" type="button" data-del="${b.surah}:${b.ayah}" aria-label="Hapus markah">
          <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </a>`).join('')
    : '<p class="empty-note">Belum ada ayat yang ditandai. Ketuk ikon markah pada ayat mana pun.</p>';
}

/** "baru saja" / "12 menit lalu" / "3 hari lalu" / a date for anything older. */
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'baru saja';
  if (mins < 60) return `${mins} menit lalu`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} hari lalu`;
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ══════════════════════════════════════════════════════════════════════════
   Settings drawer
   ══════════════════════════════════════════════════════════════════════════ */

function renderSettings() {
  const p = getPrefs();
  const theme = resolveTheme();

  $('#settingsBody').innerHTML = `
    <p class="set-section">Tampilan</p>
    <div class="set-row" style="flex-direction:column;align-items:stretch;gap:.6rem">
      <span class="set-row__label"><strong>Tema</strong><small>Pilih suasana membaca</small></span>
      <div class="theme-picker">
        ${['dark', 'light', 'auto'].map((t) => `
          <button class="theme-opt${p.theme === t ? ' is-on' : ''}" type="button" data-theme-opt="${t}">
            ${t === 'dark' ? 'Gelap' : t === 'light' ? 'Terang' : 'Otomatis'}
          </button>`).join('')}
      </div>
    </div>

    <div class="set-row">
      <span class="set-row__label"><strong>Ukuran huruf Arab</strong><small>${Math.round(p.arabScale * 100)}%</small></span>
      <div class="stepper">
        <button type="button" data-scale="arab" data-delta="-0.05" aria-label="Perkecil">−</button>
        <output>${(2.05 * p.arabScale).toFixed(2)}rem</output>
        <button type="button" data-scale="arab" data-delta="0.05" aria-label="Perbesar">+</button>
      </div>
    </div>

    <div class="set-row">
      <span class="set-row__label"><strong>Ukuran terjemahan</strong><small>${Math.round(p.trScale * 100)}%</small></span>
      <div class="stepper">
        <button type="button" data-scale="tr" data-delta="-0.05" aria-label="Perkecil">−</button>
        <output>${(1 * p.trScale).toFixed(2)}rem</output>
        <button type="button" data-scale="tr" data-delta="0.05" aria-label="Perbesar">+</button>
      </div>
    </div>

    <div class="set-row">
      <span class="set-row__label"><strong>Animasi bintang</strong><small>Latar langit bergerak</small></span>
      <button class="switch" role="switch" aria-checked="${p.stars}" data-toggle="stars" aria-label="Animasi bintang"></button>
    </div>

    <p class="set-section">Bacaan</p>
    <div class="set-row">
      <span class="set-row__label"><strong>Transliterasi latin</strong><small>Tampilkan bacaan latin</small></span>
      <button class="switch" role="switch" aria-checked="${p.showLatin}" data-toggle="showLatin" aria-label="Transliterasi latin"></button>
    </div>
    <div class="set-row">
      <span class="set-row__label"><strong>Tafsir ringkas</strong><small>Panel tafsir di bawah ayat</small></span>
      <button class="switch" role="switch" aria-checked="${p.showTafsir}" data-toggle="showTafsir" aria-label="Tafsir ringkas"></button>
    </div>
    <div class="set-row">
      <span class="set-row__label"><strong>Lanjut otomatis</strong><small>Putar ayat berikutnya</small></span>
      <button class="switch" role="switch" aria-checked="${p.autoplayNext}" data-toggle="autoplayNext" aria-label="Lanjut otomatis"></button>
    </div>
    <div class="set-row">
      <span class="set-row__label"><strong>Qari murottal</strong><small>Suara pembaca</small></span>
      <select class="select" id="setReciter">
        ${RECITERS.map((r) => `<option value="${r.id}"${r.id === p.reciter ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
    </div>

    <p class="set-section">Penyimpanan</p>
    <div class="set-row">
      <span class="set-row__label"><strong>Hapus cache bacaan</strong><small>Terjemahan &amp; tafsir tersimpan lokal</small></span>
      <button class="btn btn--ghost" type="button" id="btnClearCache">Bersihkan</button>
    </div>
    <div class="set-row">
      <span class="set-row__label"><strong>Setel ulang pengaturan</strong><small>Kembalikan ke bawaan</small></span>
      <button class="btn btn--ghost" type="button" id="btnResetPrefs">Setel ulang</button>
    </div>

    <p class="empty-note" style="padding-top:1.4rem">
      Sumber teks &amp; terjemahan: <strong>Kemenag RI</strong> via equran.id · Murottal: cdn.equran.id<br>
      Tema saat ini: ${theme === 'dark' ? 'Gelap' : 'Terang'}
    </p>`;
}

function bindSettingsEvents() {
  const body = $('#settingsBody');

  body.addEventListener('click', (e) => {
    const themeOpt = e.target.closest('[data-theme-opt]');
    if (themeOpt) {
      setPref('theme', themeOpt.dataset.themeOpt);
      applyTheme();
      renderSettings();
      return;
    }

    const scaleBtn = e.target.closest('[data-scale]');
    if (scaleBtn) {
      const key = scaleBtn.dataset.scale === 'arab' ? 'arabScale' : 'trScale';
      const next = Math.min(1.8, Math.max(0.7, getPrefs()[key] + Number(scaleBtn.dataset.delta)));
      setPref(key, Math.round(next * 100) / 100);
      return;
    }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      const on = !getPrefs()[key];
      setPref(key, on);
      if (key === 'stars') starfield?.setEnabled(on);
      if (key === 'showLatin') $$('.ayah__latin').forEach((el) => (el.hidden = !on));
      if (key === 'showTafsir') refreshTafsirPanels(on);
      return;
    }

    if (e.target.closest('#btnClearCache')) {
      const n = clearCache();
      toast(`${n} entri cache dihapus`, '⌫');
      return;
    }

    if (e.target.closest('#btnResetPrefs')) {
      resetPrefs();
      applyTheme();
      applyTextScales();
      starfield?.setEnabled(getPrefs().stars);
      renderSettings();
      $$('.ayah__latin').forEach((el) => (el.hidden = !getPrefs().showLatin));
      refreshTafsirPanels(getPrefs().showTafsir);
      toast('Pengaturan disetel ulang', '↺');
    }
  });

  body.addEventListener('change', (e) => {
    if (e.target.id === 'setReciter') chooseReciterFromSettings(e.target.value);
  });
}

function chooseReciterFromSettings(id) {
  setPref('reciter', id);
  $('#playerReciter').textContent = getReciter(id).name;
  toast(`Qari: ${getReciter(id).name}`, '♪');
}

function refreshTafsirPanels(on) {
  $$('.ayah__body').forEach((b) => {
    const existing = b.querySelector('.ayah__tafsir');
    if (on && !existing) {
      const div = document.createElement('div');
      div.className = 'ayah__tafsir';
      div.dataset.auto = '1';
      b.append(div);
    } else if (!on && existing) {
      existing.remove();
    }
  });
  if (on && state.nomor) autoFillTafsir();
}

/* ══════════════════════════════════════════════════════════════════════════
   Drawers
   ══════════════════════════════════════════════════════════════════════════ */

let openDrawerEl = null;

function openDrawer(id) {
  closeDrawers();
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  openDrawerEl = el;
  el.querySelector('button, [href], input, select')?.focus({ preventScroll: true });
}

function closeDrawers() {
  if (!openDrawerEl) return;
  openDrawerEl.classList.remove('is-open');
  openDrawerEl.setAttribute('aria-hidden', 'true');
  openDrawerEl = null;
  $('#scrim').hidden = true;
}

/* ══════════════════════════════════════════════════════════════════════════
   Command palette
   ══════════════════════════════════════════════════════════════════════════ */

let cmdCursor = 0;

function cmdMatches(q) {
  if (!q) return state.index.slice(0, 8);
  return state.index.filter((s) => matches(s, q)).slice(0, 40);
}

function renderCmdResults() {
  const q = $('#cmdInput').value.trim();
  const list = cmdMatches(q);
  cmdCursor = Math.min(cmdCursor, Math.max(list.length - 1, 0));

  $('#cmdResults').innerHTML = list.length
    ? list.map((s, i) => `
      <button class="cmd__item${i === cmdCursor ? ' is-cursor' : ''}" type="button" data-nomor="${s.n}">
        <span class="cmd__item-no">${s.n}</span>
        <span class="cmd__item-body">
          <strong>${esc(s.id)}</strong>
          <small>${s.ayat} ayat · ${s.turun === 'Madinah' ? 'Madaniyah' : 'Makkiyah'} · ${esc(s.arti)}</small>
        </span>
        <span class="cmd__item-ar" lang="ar" dir="rtl">${esc(s.ar)}</span>
      </button>`).join('')
    : '<p class="empty-note">Tidak ada surat yang cocok.</p>';
}

function openCmd() {
  $('#cmdPalette').hidden = false;
  $('#cmdInput').value = '';
  cmdCursor = 0;
  renderCmdResults();
  $('#cmdInput').focus();
}

function closeCmd() {
  $('#cmdPalette').hidden = true;
}

/* ══════════════════════════════════════════════════════════════════════════
   Global UI
   ══════════════════════════════════════════════════════════════════════════ */

function bindGlobalUI() {
  // Top bar
  $('#btnTheme').addEventListener('click', () => {
    const next = resolveTheme() === 'dark' ? 'light' : 'dark';
    setPref('theme', next);
    applyTheme();
    renderSettings();
    toast(next === 'dark' ? 'Tema gelap' : 'Tema terang', next === 'dark' ? '☾' : '☀');
  });

  $('#btnSettings').addEventListener('click', () => {
    openDrawer('drawerSettings');
    renderSettings();
  });
  bindSettingsEvents();

  $('#btnBookmarks').addEventListener('click', () => { location.hash = '#/markah'; });
  $('#btnSearch').addEventListener('click', openCmd);

  $$('[data-close-drawer]').forEach((b) => b.addEventListener('click', closeDrawers));
  $('#scrim').addEventListener('click', () => { closeDrawers(); closeCmd(); });

  // Search (hero)
  const input = $('#searchInput');
  const clear = $('#searchClear');
  input.addEventListener('input', () => {
    state.query = input.value.trim();
    clear.hidden = !state.query;
    renderSurahGrid();
  });
  $('#searchForm').addEventListener('submit', (e) => e.preventDefault());
  clear.addEventListener('click', () => {
    input.value = '';
    state.query = '';
    clear.hidden = true;
    renderSurahGrid();
    input.focus();
  });

  // Filters
  $$('.seg[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter;
      $$('.seg[data-filter]').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
      });
      renderSurahGrid();
    });
  });

  // Quick chips
  $('#quickChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-nomor]');
    if (chip) location.hash = `#/surat/${chip.dataset.nomor}`;
  });

  // Surah grid
  $('#surahGrid').addEventListener('click', (e) => {
    const card = e.target.closest('.surah-card');
    if (card) location.hash = `#/surat/${card.dataset.nomor}`;
  });

  // Reader head actions
  $('#readerHead').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play-surah') startMurattal();
    if (act === 'open-tafsir') openTafsir();
    if (act === 'toggle-bookmark-surah') {
      const a = state.surah?.ayat[0];
      if (!a) return;
      toggleBookmarkAyah(1, a);
    }
  });

  // Ayah list actions
  $('#ayahList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !state.surah) return;

    const act = btn.dataset.act;
    const no = Number(btn.dataset.ayah);
    const ayah = state.surah.ayat.find((a) => a.no === no);
    if (!ayah) return;

    if (act === 'play-ayah') {
      // Badge acts as a real play/pause toggle for the ayah it belongs to.
      const isCurrent = state.activeAyah === no && player.track?.ayah === no;
      if (isCurrent) await player.toggle();
      else await playAyah(state.surah.nomor, no);
      return;
    }
    if (act === 'tafsir') toggleInlineTafsir(no);
    if (act === 'bookmark') toggleBookmarkAyah(no, ayah);
    if (act === 'copy') copyAyah(no, ayah);
  });

  // Reader toolbar
  $('#btnFontUp').addEventListener('click', () => bump('arabScale', 0.05));
  $('#btnFontDown').addEventListener('click', () => bump('arabScale', -0.05));
  $('#btnToggleLatin').addEventListener('click', (e) => {
    const on = !getPrefs().showLatin;
    setPref('showLatin', on);
    e.currentTarget.classList.toggle('is-on', on);
    $$('.ayah__latin').forEach((el) => (el.hidden = !on));
  });
  $('#btnToggleTafsir').addEventListener('click', (e) => {
    const on = !getPrefs().showTafsir;
    setPref('showTafsir', on);
    e.currentTarget.classList.toggle('is-on', on);
    refreshTafsirPanels(on);
  });
  $('#btnTop').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  $('#btnPrevSurah').addEventListener('click', () => {
    if (state.nomor > 1) location.hash = `#/surat/${state.nomor - 1}`;
    else toast('Ini surat pertama', '۞');
  });
  $('#btnNextSurah').addEventListener('click', () => {
    if (state.nomor < 114) location.hash = `#/surat/${state.nomor + 1}`;
    else toast('Ini surat terakhir', '۞');
  });

  // Reciter drawer
  $('#reciterBody').addEventListener('click', (e) => {
    const row = e.target.closest('[data-reciter]');
    if (row) chooseReciter(row.dataset.reciter);
  });

  // Bookmarks delete
  $('#bmList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    e.preventDefault();
    e.stopPropagation();
    const [s, a] = del.dataset.del.split(':').map(Number);
    removeBookmark(s, a);
    renderBookmarks();
    toast('Markah dihapus', '✕');
  });

  // Command palette
  $('#cmdInput').addEventListener('input', () => { cmdCursor = 0; renderCmdResults(); });
  $('#cmdResults').addEventListener('click', (e) => {
    const item = e.target.closest('[data-nomor]');
    if (!item) return;
    closeCmd();
    location.hash = `#/surat/${item.dataset.nomor}`;
  });
  $('#cmdPalette').addEventListener('click', (e) => {
    if (e.target.id === 'cmdPalette') closeCmd();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    const cmdOpen = !$('#cmdPalette').hidden;

    if (cmdOpen) {
      if (e.key === 'Escape') { closeCmd(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = cmdMatches($('#cmdInput').value.trim());
        cmdCursor = (cmdCursor + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % Math.max(list.length, 1);
        renderCmdResults();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        const list = cmdMatches($('#cmdInput').value.trim());
        if (list[cmdCursor]) { closeCmd(); location.hash = `#/surat/${list[cmdCursor].n}`; }
        e.preventDefault();
        return;
      }
    }

    if (typing) return;

    if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      openCmd();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (openDrawerEl) { closeDrawers(); e.preventDefault(); }
      return;
    }
    if (e.key === ' ' && player.track) {
      // Don't hijack Space when a control already has focus.
      if (document.activeElement?.closest?.('button, a, [role="switch"], select')) return;
      player.toggle();
      e.preventDefault();
      return;
    }
    if (player.track && e.key === 'ArrowRight') { player.skip(5); e.preventDefault(); return; }
    if (player.track && e.key === 'ArrowLeft') { player.skip(-5); e.preventDefault(); }
  });

  // Scroll effects
  const topbar = $('#topbar');
  const onScroll = () => {
    topbar.classList.toggle('is-stuck', window.scrollY > 12);
    updateReadProgress();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Auto-close drawers when leaving the reader
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/surat')) closeDrawers();
  });
}

function bump(key, delta) {
  const next = Math.min(1.8, Math.max(0.7, getPrefs()[key] + delta));
  setPref(key, Math.round(next * 100) / 100);
}

function toggleBookmarkAyah(no, ayah) {
  const meta = state.index[state.nomor - 1];
  const saved = toggleBookmark({
    surah: state.nomor,
    ayah: no,
    surahName: meta?.id ?? '',
    arab: ayah.arab,
    tr: ayah.tr,
  });

  const btn = $(`.ayah[data-ayah="${no}"] .act[data-act="bookmark"]`);
  btn?.classList.toggle('is-on', saved);

  const badge = $('#bmBadge');
  const count = getBookmarks().length;
  badge.textContent = count;
  badge.hidden = count === 0;

  toast(saved ? `Ditandai: ${meta?.id ?? ''} ayat ${no}` : 'Markah dihapus', saved ? '★' : '✕');
}

async function copyAyah(no, ayah) {
  const meta = state.index[state.nomor - 1];
  const text = `${ayah.arab}\n\n${ayah.latin}\n\n"${ayah.tr}"\n\n(QS. ${meta?.id ?? ''} : ${no})\n${location.href}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`Ayat ${no} disalin`, '⧉');
  } catch {
    toast('Gagal menyalin ke papan klip', '⚠');
  }
}

function updateReadProgress() {
  const doc = document.documentElement;
  const max = doc.scrollHeight - window.innerHeight;
  const pct = max > 0 ? (window.scrollY / max) * 100 : 0;
  $('#readProgress').style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

/* ══════════════════════════════════════════════════════════════════════════
   Go
   ══════════════════════════════════════════════════════════════════════════ */

boot();

// Exposed for manual inspection in the console.
window.__nur = { state, player, getPrefs, DEFAULT_PREFS };
