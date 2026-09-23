/**
 * visual.mjs — screenshot and inspect the running app through Chrome DevTools
 * Protocol, with zero dependencies.
 *
 *   node tools/visual.mjs [--port 9222] [--url http://127.0.0.1:4173] [--out .visual]
 *
 * Why this exists
 * ---------------
 * Chrome cannot usefully be launched from the agent's sandboxed shell: commands
 * run under a restricted token, so Chrome's crashpad handler dies with
 * "OpenProcess: Access is denied" and the browser exits with code 0 having done
 * nothing. Raising the *file* sandbox to danger-full-access does not help — that
 * widens file access, not process-handle rights.
 *
 * So you start the browser, outside the sandbox, and this script only connects
 * to it over localhost:
 *
 *   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
 *       --headless=new --remote-debugging-port=9222 `
 *       --user-data-dir="$env:TEMP\nurcdp" --no-first-run about:blank
 *
 * Wait for the line `DevTools listening on ws://127.0.0.1:9222/...`. If Chrome
 * exits immediately instead, it handed the command line to an already-running
 * Chrome — close all Chrome windows and run it again.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg('port', 9222));
const BASE = arg('url', 'http://127.0.0.1:4173').replace(/\/$/, '');
const OUT = resolve(ROOT, arg('out', '.visual'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Minimal CDP client over the browser-level WebSocket ───────────────── */

class CDP {
  #ws; #id = 0; #pending = new Map(); #waiters = []; #handlers = [];

  static async connect(port) {
    let info;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = await res.json();
    } catch (err) {
      throw new Error(
        `Tidak bisa terhubung ke Chrome DevTools di port ${port} (${err.message}).\n` +
        'Jalankan Chrome dengan --remote-debugging-port lebih dulu (lihat komentar di atas).',
      );
    }
    const cdp = new CDP();
    await cdp.#open(info.webSocketDebuggerUrl);
    return cdp;
  }

  #open(url) {
    return new Promise((ok, no) => {
      this.#ws = new WebSocket(url);
      this.#ws.addEventListener('open', () => ok());
      this.#ws.addEventListener('error', () => no(new Error('WebSocket CDP gagal dibuka')));
      this.#ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { ok: done, no: fail } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          msg.error ? fail(new Error(msg.error.message)) : done(msg.result);
          return;
        }
        if (!msg.method) return;
        this.#waiters = this.#waiters.filter((w) => {
          if (w.method !== msg.method || (w.sessionId && w.sessionId !== msg.sessionId)) return true;
          w.resolve(msg.params);
          return false;
        });
        this.#handlers.forEach((h) => h(msg.method, msg.params, msg.sessionId));
      });
    });
  }

  send(method, params = {}, sessionId) {
    const id = (this.#id += 1);
    return new Promise((ok, no) => {
      this.#pending.set(id, { ok, no });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, sessionId, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout menunggu ${method}`)), timeout);
      this.#waiters.push({ method, sessionId, resolve: (p) => { clearTimeout(timer); resolve(p); } });
    });
  }

  /** Subscribe to every CDP event; the callback filters as it likes. */
  on(fn) { this.#handlers.push(fn); }

  close() { try { this.#ws.close(); } catch { /* already closed */ } }
}

/* ── One page, with console + network captured ─────────────────────────── */

async function openPage(cdp, { prefs, width, height, scale = 2 }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const log = { errors: [], failed: [], requests: [] };
  cdp.on((method, params, sid) => {
    if (sid !== sessionId) return;
    if (method === 'Runtime.exceptionThrown') {
      log.errors.push(params.exceptionDetails?.exception?.description
        ?? params.exceptionDetails?.text ?? 'unknown exception');
    }
    if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
      log.errors.push(params.entry.text);
    }
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      log.errors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (method === 'Network.loadingFailed') {
      // A blocked cross-origin fetch surfaces here, often with corsErrorStatus.
      log.failed.push({
        url: params.requestId,
        error: params.errorText,
        cors: params.corsErrorStatus?.corsError ?? null,
        blocked: params.blockedReason ?? null,
      });
    }
    if (method === 'Network.responseReceived') {
      log.requests.push({ url: params.response.url, status: params.response.status });
    }
  });

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);

  // Seed preferences before any app script runs so the first paint is right, and
  // drop the cached tajwid so the quran.com request really happens each run —
  // otherwise a stale cache would hide a CORS failure.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{
      Object.keys(localStorage).filter(k=>k.indexOf('nur:tajwid')===0).forEach(k=>localStorage.removeItem(k));
      localStorage.setItem('nur:prefs', ${JSON.stringify(JSON.stringify(prefs ?? {}))});
    }catch(e){}`,
  }, sessionId);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: scale, mobile: width < 600,
  }, sessionId);

  return { sessionId, targetId, log };
}

async function goto(cdp, sessionId, url, settle = 3000) {
  const loaded = cdp.waitFor('Page.loadEventFired', sessionId).catch(() => null);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await sleep(settle);   // let fonts, animation frames and API calls settle
}

/** Drive the page the way a reader would, for shots that need an interaction. */
async function interact(cdp, sessionId, expression, settle = 800) {
  await evaluate(cdp, sessionId, expression);
  await sleep(settle);
}

async function shoot(cdp, sessionId, name) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
  }, sessionId);
  const file = resolve(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function evaluate(cdp, sessionId, expression) {
  try {
    const res = await cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    return res.result?.value ?? null;
  } catch {
    return null;
  }
}

/* ── Layout audit, for when pixels cannot be inspected directly ────────── */

const AUDIT = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const label = (el) => {
    if (el.id) return '#' + el.id;
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls;
  };
  // Off-canvas drawers, the decorative background and the palette legitimately
  // sit outside the flow.
  const decorative = (el) => el.closest('.drawer, .bg, .scrim, .cmd-palette, #starfield, .hero__art');
  // Anything clipped by an ancestor with a non-visible overflow cannot push the
  // page sideways, so it is not a layout defect however far it extends.
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ([cs.overflowX, cs.overflowY].some((v) => v !== 'visible')) return true;
    }
    return false;
  };

  const out = {
    fonts: {}, fontsStatus: document.fonts.status,
    overflow: [], smallTargets: [], marginalTargets: [], tooltips: [],
    docOverflowX: document.documentElement.scrollWidth > vw + 1,
  };

  // Only check families this page actually renders text with. A font that is
  // legitimately unused here has not been fetched, which is not a defect.
  const SAMPLES = {
    'Amiri Quran': 'قُلْ هُوَ',
    'Reem Kufi': 'الفاتحة',
    'Plus Jakarta Sans': 'Bismillah',
  };
  const inUse = new Set();
  document.querySelectorAll('body *').forEach((el) => {
    const ff = getComputedStyle(el).fontFamily || '';
    Object.keys(SAMPLES).forEach((f) => { if (ff.includes(f)) inUse.add(f); });
  });
  inUse.forEach((f) => {
    out.fonts[f] = document.fonts.check('16px "' + f + '"', SAMPLES[f]);
  });

  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || decorative(el) || clipped(el)) return;
    if (r.right > vw + 1) out.overflow.push({ el: label(el), right: Math.round(r.right) });
  });

  document.querySelectorAll('button, a, [role="switch"], input').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || decorative(el)) return;
    const min = Math.min(r.width, r.height);
    // Only clearly-small controls are defects; 38–40px inline chips are a
    // deliberate density choice in a text-heavy reader.
    if (min < 36) out.smallTargets.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height) });
    else if (min < 40) out.marginalTargets.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height) });
  });

  // Where each tooltip would open. Only controls the pointer can actually reach
  // matter, so anything scrolled out of view is skipped.
  document.querySelectorAll('[data-tip]').forEach((el) => {
    const cs = getComputedStyle(el, '::after');
    if (!cs.content || cs.content === 'none') return;
    const r = el.getBoundingClientRect();
    if (r.height < 1 || r.bottom < 0 || r.top > vh) return;
    const down = cs.top !== 'auto';
    const gap = parseFloat(down ? cs.top : cs.bottom) || 0;
    const edge = down ? r.bottom + gap : r.top - gap;
    const outside = down ? edge > vh : edge < 0;
    out.tooltips.push({ el: label(el), dir: down ? 'down' : 'up', edge: Math.round(edge), outside });
  });
  out.tooltipsOutside = out.tooltips.filter((t) => t.outside).length;

  // Reader toolbar geometry: how it wraps, and whether any label is clipped.
  const bar = document.querySelector('#readerToolbar');
  out.toolbar = null;
  if (bar && !bar.classList.contains('is-collapsed') && !bar.hidden) {
    // Tooltips are absolutely positioned but still inflate scrollWidth, which
    // would read as "label clipped". Detach them for the measurement only.
    const tipAttrs = [];
    bar.querySelectorAll('[data-tip]').forEach((el) => {
      tipAttrs.push([el, el.getAttribute('data-tip')]);
      el.removeAttribute('data-tip');
    });

    const boxes = [...bar.querySelectorAll('.tool-btn')].map((b) => {
      const r = b.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        w: Math.round(r.width),
        label: (b.textContent || '').trim().slice(0, 12),
        clipped: b.scrollWidth > b.clientWidth + 2,
      };
    }).filter((b) => b.bottom - b.top >= 1);

    // Cluster into rows by vertical overlap. Grouping on an exact top value
    // would split one visual row whenever its buttons differ in height.
    const rows = [];
    boxes.sort((a, b) => a.top - b.top).forEach((box) => {
      const row = rows.find((r) => box.top < r.bottom - 2 && box.bottom > r.top + 2);
      if (row) {
        row.items.push(box);
        row.top = Math.min(row.top, box.top);
        row.bottom = Math.max(row.bottom, box.bottom);
      } else {
        rows.push({ top: box.top, bottom: box.bottom, items: [box] });
      }
    });

    out.toolbar = rows.map((row) => {
      const widths = row.items.map((x) => x.w);
      return {
        count: row.items.length,
        widths,
        even: Math.max(...widths) - Math.min(...widths) <= 2,
        clipped: row.items.filter((x) => x.clipped).map((x) => x.label),
      };
    });

    tipAttrs.forEach(([el, value]) => el.setAttribute('data-tip', value));
  }

  return out;
})()`;

/* ── The shots ─────────────────────────────────────────────────────────── */

const DARK = { theme: 'dark', tajwid: true, showTafsir: false, showLatin: true };
const LIGHT = { ...DARK, theme: 'light' };
const NO_TAJWID = { ...DARK, tajwid: false };

const SHOTS = [
  { name: '01-home-dark', prefs: DARK, width: 1440, height: 900, path: '#/' },
  { name: '02-home-light', prefs: LIGHT, width: 1440, height: 900, path: '#/' },
  { name: '03-reader-tajwid', prefs: DARK, width: 1440, height: 1000, path: '#/surat/112' },
  { name: '04-reader-light', prefs: LIGHT, width: 1440, height: 1000, path: '#/surat/112' },
  { name: '05-reader-no-tajwid', prefs: NO_TAJWID, width: 1440, height: 900, path: '#/surat/112' },
  { name: '06-reader-long-surah', prefs: DARK, width: 1440, height: 1000, path: '#/surat/36' },
  { name: '07-mobile-home', prefs: DARK, width: 390, height: 844, scale: 3, path: '#/' },
  { name: '08-mobile-reader', prefs: DARK, width: 390, height: 844, scale: 3, path: '#/surat/112' },
  // Narrowest common phone: the 5-column reading row is the tight case here.
  { name: '08b-mobile-small', prefs: DARK, width: 360, height: 780, scale: 3, path: '#/surat/112' },
  { name: '09-markah', prefs: DARK, width: 1440, height: 900, path: '#/markah' },
  // Exercises the folded toolbar end to end: the click is real, and the panel's
  // computed display is read back from the live layout.
  {
    name: '10-toolbar-collapsed',
    prefs: DARK,
    width: 1440,
    height: 900,
    path: '#/surat/112',
    after: "document.querySelector('#btnToggleToolbar').click()",
  },
  // The install drawer, opened directly. Clicking the real button would call
  // BeforeInstallPromptEvent.prompt(), which Chrome refuses without a genuine
  // user gesture and logs as an error — a capture artefact, not an app fault.
  // The click path itself is covered by the runtime test suite.
  {
    name: '11-install-drawer',
    prefs: DARK,
    width: 430,
    height: 900,
    scale: 2,
    path: '#/',
    after: `(() => {
      const d = document.querySelector('#drawerInstall');
      d.classList.add('is-open');
      d.setAttribute('aria-hidden', 'false');
      document.querySelector('#scrim').hidden = false;
    })()`,
  },
];

/* ── Run ───────────────────────────────────────────────────────────────── */

mkdirSync(OUT, { recursive: true });

let cdp;
try {
  cdp = await CDP.connect(PORT);
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(2);
}

console.log(`\nTerhubung ke Chrome di port ${PORT}`);
console.log(`Aplikasi : ${BASE}`);
console.log(`Keluaran : ${OUT}\n`);

const report = [];

for (const shot of SHOTS) {
  const { sessionId, targetId, log } = await openPage(cdp, shot);
  await goto(cdp, sessionId, `${BASE}/${shot.path}`);
  if (shot.after) await interact(cdp, sessionId, shot.after);

  const health = await evaluate(cdp, sessionId, `(() => {
    const t = document.querySelector('tajweed');
    const arab = document.querySelector('.ayah__arab');
    const bar = document.querySelector('#readerToolbar');
    const panel = document.querySelector('#toolbarPanel');
    const handle = document.querySelector('#btnToggleToolbar');
    return {
      title: document.title,
      ayahs: document.querySelectorAll('.ayah').length,
      surahCards: document.querySelectorAll('.surah-card').length,
      tajweedNodes: document.querySelectorAll('tajweed').length,
      tajweedColour: t ? getComputedStyle(t).color : null,
      arabicColour: arab ? getComputedStyle(arab).color : null,
      theme: document.documentElement.dataset.theme,
      tajwidMode: document.documentElement.dataset.tajwid,
      legend: !!document.querySelector('.tajwid-legend'),
      toolbarCollapsed: bar ? bar.classList.contains('is-collapsed') : null,
      panelDisplay: panel ? getComputedStyle(panel).display : null,
      panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : null,
      handleVisible: handle ? handle.getBoundingClientRect().height > 0 : null,
      handleExpanded: handle ? handle.getAttribute('aria-expanded') : null,
      quranApiCalls: performance.getEntriesByType('resource')
        .filter(r => r.name.includes('api.quran.com')).length,
    };
  })()`) ?? {};

  const file = await shoot(cdp, sessionId, shot.name);
  const audit = await evaluate(cdp, sessionId, AUDIT) ?? {};
  const quranCall = log.requests.find((r) => r.url.includes('api.quran.com'));

  report.push({
    shot: shot.name,
    ...health,
    tajwidPref: shot.prefs?.tajwid !== false,
    audit,
    apiStatus: quranCall?.status ?? null,
    errors: log.errors,
    failedRequests: log.failed.filter((f) => f.cors || f.error !== 'net::ERR_ABORTED'),
    file: file.replace(`${ROOT}\\`, ''),
  });

  console.log(
    `${shot.name.padEnd(21)} ayah=${String(health.ayahs ?? 0).padStart(3)}` +
    ` tajwid=${String(health.tajweedNodes ?? 0).padStart(3)}` +
    ` api=${String(quranCall?.status ?? '-').padStart(4)}` +
    ` overflow=${String(audit.overflow?.length ?? 0).padStart(2)}` +
    ` tap<40=${String(audit.smallTargets?.length ?? 0).padStart(2)}` +
    ` tipOut=${String(audit.tooltipsOutside ?? 0).padStart(2)}` +
    ` ${health.theme ?? ''}`,
  );

  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
}

writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));

/* ── Findings ──────────────────────────────────────────────────────────── */

const readerShots = report.filter((r) => (r.ayahs ?? 0) > 0);
// Only shots where colouring was actually switched on can prove the API works.
const tajwidOn = readerShots.filter((r) => r.tajwidPref !== false);
const coloured = tajwidOn.filter((r) => (r.tajweedNodes ?? 0) > 0).length;
const corsFailures = report.flatMap((r) => r.failedRequests ?? []).filter((f) => f.cors);
const allErrors = report.flatMap((r) => r.errors ?? []);

console.log(`\n${report.length} tangkapan layar ditulis ke ${OUT}`);

console.log('\nTajwid');
console.log(coloured === tajwidOn.length
  ? `  api.quran.com dapat diakses dari browser (HTTP 200); kaidah tampil di ${coloured}/${tajwidOn.length} halaman pembaca yang menyalakan warna.`
  : `  HANYA ${coloured}/${tajwidOn.length} halaman pembaca menampilkan kaidah tajwid.`);

const missingFonts = new Map();
report.forEach((r) => {
  Object.entries(r.audit?.fonts ?? {}).forEach(([f, ok]) => {
    if (!ok) missingFonts.set(f, (missingFonts.get(f) ?? 0) + 1);
  });
});
console.log('\nFont');
if (missingFonts.size === 0) console.log('  Semua webfont termuat (Amiri Quran, Reem Kufi, Plus Jakarta Sans).');
else missingFonts.forEach((n, f) => console.log(`  "${f}" TIDAK termuat di ${n} tangkapan.`));

const overflows = report.flatMap((r) => (r.audit?.overflow ?? []).map((o) => ({ shot: r.shot, ...o })));
const docOverflow = report.filter((r) => r.audit?.docOverflowX);
console.log('\nTata letak');
console.log(overflows.length ? `  ${overflows.length} elemen meluber melewati lebar viewport:` : '  Tidak ada elemen yang meluber horizontal.');
overflows.slice(0, 8).forEach((o) => console.log(`    ${o.shot.padEnd(21)} ${o.el} → kanan ${o.right}px`));
if (docOverflow.length) console.log(`  Halaman bisa digeser horizontal di: ${docOverflow.map((r) => r.shot).join(', ')}`);

const small = report.flatMap((r) => (r.audit?.smallTargets ?? []).map((t) => ({ shot: r.shot, ...t })));
const marginal = report.flatMap((r) => (r.audit?.marginalTargets ?? []).map((t) => ({ shot: r.shot, ...t })));
const onMobile = (list) => list.filter((t) => t.shot.includes('mobile'));
console.log('\nTarget sentuh');
const smallMobile = onMobile(small);
const marginalMobile = onMobile(marginal);
console.log(smallMobile.length
  ? `  ${smallMobile.length} kontrol ponsel di bawah 36px (perlu diperbesar):`
  : '  Tidak ada kontrol ponsel di bawah 36px.');
[...new Set(smallMobile.map((t) => `${t.el} (${t.w}x${t.h})`))].slice(0, 10)
  .forEach((s) => console.log(`    ${s}`));
if (marginalMobile.length) {
  const kinds = [...new Set(marginalMobile.map((t) => `${t.el} (${t.w}x${t.h})`))];
  console.log(`  Catatan: ${marginalMobile.length} kontrol di 36–40px — pilihan kepadatan, bukan cacat.`);
  kinds.slice(0, 4).forEach((s) => console.log(`    ${s}`));
}

const tips = report.flatMap((r) => (r.audit?.tooltips ?? []).map((t) => ({ shot: r.shot, ...t })));
const tipsOut = tips.filter((t) => t.outside);
console.log('\nTooltip');
console.log(tipsOut.length
  ? `  ${tipsOut.length} tooltip akan terbuka di luar layar:`
  : `  Semua ${tips.length} tooltip akan terbuka di dalam layar.`);
[...new Set(tipsOut.map((t) => `${t.shot}: ${t.el} (${t.dir})`))].slice(0, 8)
  .forEach((s) => console.log(`    ${s}`));

// The collapsible toolbar is CSS-driven, so only the live layout can confirm it.
const bars = report.filter((r) => r.toolbarCollapsed !== null);
const folded = bars.filter((r) => r.toolbarCollapsed);
const unfolded = bars.filter((r) => !r.toolbarCollapsed);
console.log('\nBilah alat');
console.log(`  ${unfolded.length} tangkapan terbuka, ${folded.length} terlipat.`);
folded.forEach((r) => {
  console.log(`  ${r.shot}: panel display=${r.panelDisplay}, tinggi=${r.panelHeight}px,`
    + ` aria-expanded=${r.handleExpanded}`);
});
if (folded.length) {
  const bad = folded.filter((r) => r.panelDisplay !== 'none' || r.panelHeight !== 0);
  console.log(bad.length
    ? `  MASALAH: panel masih tampil di ${bad.map((r) => r.shot).join(', ')}`
    : '  Panel benar-benar tersembunyi (display:none, tinggi 0).');
  const handleGone = folded.filter((r) => r.handleVisible !== true);
  console.log(handleGone.length
    ? `  MASALAH: pegangan ikut hilang di ${handleGone.map((r) => r.shot).join(', ')}`
    : '  Pegangan tetap terlihat dan bisa diklik saat terlipat.');
  const notNone = unfolded.filter((r) => r.panelDisplay === 'none');
  if (notNone.length) console.log(`  MASALAH: panel tersembunyi padahal seharusnya terbuka di ${notNone.map((r) => r.shot).join(', ')}`);
}

console.log('\nTata letak bilah (baris)');
report.filter((r) => r.audit?.toolbar).forEach((r) => {
  const rows = r.audit.toolbar;
  console.log(`  ${r.shot} — ${rows.length} baris`);
  rows.forEach((row, i) => {
    console.log(`    baris ${i + 1}: ${row.count} tombol, lebar ${row.widths.join('/')}`
      + `${row.even ? ' (rata)' : ' (TIDAK RATA)'}`
      + `${row.clipped.length ? ` TERPOTONG: ${row.clipped.join(', ')}` : ''}`);
  });
});

if (corsFailures.length) console.log(`\nKegagalan CORS: ${JSON.stringify(corsFailures.slice(0, 3))}`);
console.log(allErrors.length
  ? `\nError konsol (${allErrors.length}):\n${[...new Set(allErrors)].slice(0, 6).map((e) => '  - ' + e).join('\n')}`
  : '\nTidak ada error konsol.');

/* ── Installable app + offline behaviour ───────────────────────────────── */

/** Poll a page-side expression until it is truthy (or time out). */
async function waitForEval(cdp, sessionId, expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, expression)) return true;
    await sleep(250);
  }
  return false;
}

async function auditPwa(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  await goto(cdp, sessionId, `${BASE}/#/`, 4000);

  const manifest = await cdp.send('Page.getAppManifest', {}, sessionId)
    .catch((e) => ({ parseError: e.message }));
  const installability = await cdp.send('Page.getInstallabilityErrors', {}, sessionId)
    .catch((e) => ({ installabilityErrors: [{ errorId: `unavailable: ${e.message}` }] }));

  // The worker installs, activates and claims this page — no reload needed.
  const swControlled = await waitForEval(cdp, sessionId, '!!navigator.serviceWorker.controller', 10000);
  const cacheNames = await evaluate(cdp, sessionId, `caches.keys()`) ?? [];

  // Cut the network entirely and navigate again: the reader must still boot.
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
  }, sessionId);
  await goto(cdp, sessionId, `${BASE}/#/`, 3500).catch(() => {});
  const offline = await evaluate(cdp, sessionId, `({
    cards: document.querySelectorAll('.surah-card').length,
    chips: document.querySelectorAll('.chip').length,
    styled: getComputedStyle(document.documentElement).getPropertyValue('--gold-2').trim(),
    heading: (document.querySelector('.hero__title') || {}).textContent || '',
  })`);

  // A previously-read surah should also work offline, from the localStorage cache.
  await goto(cdp, sessionId, `${BASE}/#/surat/112`, 3000).catch(() => {});
  const offlineSurah = await evaluate(cdp, sessionId, `({
    ayahs: document.querySelectorAll('.ayah').length,
    firstAyah: !!document.querySelector('.ayah__arab'),
  })`);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  }, sessionId);
  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});

  return { manifest, installability, swControlled, cacheNames, offline, offlineSurah };
}

/* ── Murattal: does the audio request actually leave the browser? ──────── */

/**
 * The service worker inherits the site CSP, so a missing connect-src entry
 * silently kills playback in production while working fine on a dev server with
 * no CSP. This plays one ayah and inspects the resulting request.
 */
async function auditAudio(cdp) {
  const { sessionId, targetId, log } = await openPage(cdp, { prefs: DARK, width: 900, height: 800 });
  await goto(cdp, sessionId, `${BASE}/#/surat/112`, 2500);

  // A programmatic click is enough: assigning src issues the request whether or
  // not the autoplay policy then allows playback to start.
  await evaluate(cdp, sessionId, `document.querySelector('.ayah__no').click()`);
  await sleep(4500);

  const audio = log.requests.filter((r) => r.url.includes('cdn.equran.id'));
  const state = await evaluate(cdp, sessionId, `(() => {
    const a = document.querySelector('audio');
    return a ? { src: a.currentSrc || a.src, error: a.error ? a.error.code : null } : null;
  })()`);
  // Proves offline murattal really works, rather than merely claiming to.
  const cachedAudio = await evaluate(cdp, sessionId, `(async () => {
    try { return (await caches.open('nur-v2-audio')).keys().then(k => k.length); } catch { return null; }
  })()`);

  // Cross-origin media is normally fetched no-cors, which makes the response
  // opaque and unsliceable. Knowing whether the CDN offers CORS decides whether
  // a smarter caching strategy is even possible.
  const corsProbe = await evaluate(cdp, sessionId, `fetch(
    'https://cdn.equran.id/audio-partial/Misyari-Rasyid-Al-Afasi/112001.mp3', { mode: 'cors' })
    .then(r => 'cors ' + r.status).catch(() => 'cors blocked')`);

  await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return { audio, state, cachedAudio, corsProbe, errors: log.errors, failed: log.failed };
}

console.log('\nMurattal');
try {
  const audio = await auditAudio(cdp);
  // 206 is a success: media elements fetch byte ranges.
  const ok = audio.audio.filter((r) => r.status >= 200 && r.status < 300);
  console.log(`  Permintaan ke cdn.equran.id: ${audio.audio.length}`
    + `${audio.audio.length ? ` (status ${audio.audio.map((r) => r.status).join(', ')})` : ''}`);
  if (audio.state?.src) console.log(`  Elemen audio memuat: ...${String(audio.state.src).slice(-26)}`);
  if (audio.state?.error) console.log(`  Kode error elemen audio: ${audio.state.error}`);
  const cspErrors = audio.errors.filter((e) => /Content Security Policy|Refused to/i.test(e));
  if (cspErrors.length) {
    console.log(`  DIBLOKIR CSP: ${cspErrors[0].split('\n')[0]}`);
  } else if (ok.length) {
    console.log('  Audio terunduh tanpa diblokir CSP.');
  } else if (!audio.audio.length) {
    console.log('  TIDAK ada permintaan audio sama sekali.');
  } else {
    console.log('  Permintaan audio terjadi tetapi tidak ada yang berhasil.');
  }
  console.log(`  Berkas murattal tersimpan untuk offline: ${audio.cachedAudio ?? '(tidak diketahui)'}`);
  console.log(`  CORS dari cdn.equran.id: ${audio.corsProbe}`);
} catch (err) {
  console.log(`  Audit audio gagal: ${err.message}`);
}

console.log('\nPemasangan (PWA)');
try {
  const pwa = await auditPwa(cdp);

  const manifestErrors = pwa.manifest?.errors ?? [];
  console.log(manifestErrors.length
    ? `  Manifest punya ${manifestErrors.length} error: ${manifestErrors.map((e) => e.message ?? e).join('; ')}`
    : '  Manifest terbaca tanpa error.');

  // `data` carries the raw manifest JSON; `parsed` only has scope/start_url.
  let manifestName = null;
  try { manifestName = JSON.parse(pwa.manifest?.data ?? '{}').name ?? null; } catch { /* ignore */ }
  console.log(`  Nama aplikasi: ${manifestName ?? '(tidak terbaca)'}`);

  const errs = (pwa.installability?.installabilityErrors ?? []).map((e) => e.errorId);
  console.log(errs.length
    ? `  BELUM BISA DIPASANG: ${errs.join(', ')}`
    : '  Chrome melaporkan aplikasi BISA DIPASANG (tidak ada installability error).');

  console.log(`  Service worker mengendalikan halaman: ${pwa.swControlled ? 'ya' : 'TIDAK'}`);
  console.log(`  Cache dibuat: ${(pwa.cacheNames ?? []).join(', ') || '(tidak ada)'}`);

  const off = pwa.offline ?? {};
  console.log(`  Mode offline — beranda: ${off.cards} kartu surat, ${off.chips} chip,`
    + ` tema ${off.styled || '?'}, judul "${(off.heading || '').trim()}"`);
  console.log(`  Mode offline — surat tersimpan: ${pwa.offlineSurah?.ayahs} ayat`
    + `${pwa.offlineSurah?.firstAyah ? '' : ' (teks Arab TIDAK ada)'}`);
  if (!errs.length && off.cards === 114 && pwa.offlineSurah?.ayahs > 0) {
    console.log('  Offline berfungsi penuh: shell + index surat + surat yang pernah dibuka.');
  }
} catch (err) {
  console.log(`  Audit PWA gagal: ${err.message}`);
}

cdp.close();
