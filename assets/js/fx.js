/**
 * fx.js — ambient visuals, reveal animations and small DOM helpers.
 */

import { getPrefs } from './store.js';

/* ── Helpers ───────────────────────────────────────────────────────────── */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text before it is interpolated into innerHTML. */
export const esc = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

const AR_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

/** 7 → "٧" */
export const toArabicDigits = (n) =>
  String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

/** 754 → "12:34" */
export const fmtTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
};

const ONES = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan'];
const TEENS = ['sepuluh', 'sebelas', 'dua belas', 'tiga belas', 'empat belas', 'lima belas',
  'enam belas', 'tujuh belas', 'delapan belas', 'sembilan belas'];

/** Small Indonesian number-to-words, used to label "Juz" and ayah counts. */
export function spellNumber(n) {
  if (n < 10) return ONES[n] || 'nol';
  if (n < 20) return TEENS[n - 10];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const rest = n % 10;
    return `${ONES[t]} puluh${rest ? ` ${ONES[rest]}` : ''}`;
  }
  if (n < 200) return `seratus${n % 100 ? ` ${spellNumber(n % 100)}` : ''}`;
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const rest = n % 100;
    return `${ONES[h]} ratus${rest ? ` ${spellNumber(rest)}` : ''}`;
  }
  if (n < 2000) return `seribu${n % 1000 ? ` ${spellNumber(n % 1000)}` : ''}`;
  const th = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${spellNumber(th)} ribu${rest ? ` ${spellNumber(rest)}` : ''}`;
}

/* ── Toasts ────────────────────────────────────────────────────────────── */

let toastHost = null;

export function toast(message, mark = '﷽') {
  toastHost ??= $('#toasts');
  if (!toastHost) return;

  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="toast__mark">${esc(mark)}</span><span>${esc(message)}</span>`;
  toastHost.append(el);

  setTimeout(() => {
    el.classList.add('is-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 2300);
}

/* ── Scroll reveal ─────────────────────────────────────────────────────── */

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    )
  : null;

/** Observe newly rendered `.io-reveal` nodes. Falls back to showing them. */
export function observeReveals(root = document) {
  const nodes = $$('.io-reveal', root);
  if (!io) {
    nodes.forEach((n) => n.classList.add('is-in'));
    return;
  }
  nodes.forEach((n) => io.observe(n));
}

/* ── Starfield ─────────────────────────────────────────────────────────── */

let starfieldStop = null;

/**
 * Slow drift of gilded eight-point stars. Density and speed scale down on
 * small screens, and the whole thing pauses when the tab is hidden.
 */
export function initStarfield() {
  const canvas = $('#starfield');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let stars = [];
  let raf = null;
  let w = 0;
  let h = 0;

  const resize = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.round(Math.min(90, Math.max(22, (w * h) / 26000)));
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.9 + 0.7,
      vy: -(Math.random() * 0.16 + 0.04),
      vx: (Math.random() - 0.5) * 0.09,
      a: Math.random() * 0.5 + 0.2,
      tw: Math.random() * Math.PI * 2,
      gold: Math.random() > 0.35,
    }));
  };

  const drawStar = (x, y, r, rot) => {
    ctx.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const ang = rot + (i * Math.PI) / 4;
      const rad = i % 2 === 0 ? r : r * 0.42;
      const px = x + Math.cos(ang) * rad;
      const py = y + Math.sin(ang) * rad;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  };

  const frame = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      s.y += s.vy;
      s.x += s.vx;
      s.tw += 0.012;
      if (s.y < -8) { s.y = h + 8; s.x = Math.random() * w; }
      if (s.x < -8) s.x = w + 8;
      if (s.x > w + 8) s.x = -8;

      const alpha = s.a * (0.6 + 0.4 * Math.sin(s.tw));
      ctx.fillStyle = s.gold
        ? `rgba(231, 199, 122, ${alpha})`
        : `rgba(110, 226, 186, ${alpha})`;
      drawStar(s.x, s.y, s.r * 3.1, s.tw * 0.35);
    }
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (raf === null) raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  window.addEventListener('resize', resize, { passive: true });

  starfieldStop = stop;
  if (getPrefs().stars) start();

  return {
    setEnabled(on) {
      canvas.style.display = on ? '' : 'none';
      on ? (resize(), start()) : stop();
    },
  };
}

export const stopStarfield = () => starfieldStop?.();

/* ── Hero mandala ──────────────────────────────────────────────────────── */

const polar = (cx, cy, r, deg) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
};

const starPoints = (cx, cy, outer, inner, points = 8, rot = 0) => {
  const pts = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const [x, y] = polar(cx, cy, r, rot + (i * 180) / points);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
};

const polygonPoints = (cx, cy, r, sides, rot = 0) => {
  const pts = [];
  for (let i = 0; i < sides; i += 1) {
    const [x, y] = polar(cx, cy, r, rot + (i * 360) / sides);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
};

/** Points for an n-pointed star centred in a square viewBox — used for badges. */
export const starPolygon = (size, points = 8, outerRatio = 0.46, innerRatio = 0.2, rot = 0) =>
  starPoints(size / 2, size / 2, size * outerRatio, size * innerRatio, points, rot);

/** Layered rotating geometry for the hero: rosettes, rings and rays. */
export function buildMandala(host) {
  if (!host) return;
  const C = 200;
  const layers = [];

  // Outer rings + tick marks.
  layers.push(`<circle class="ring" cx="${C}" cy="${C}" r="196"/>`);
  layers.push(`<circle class="ring" cx="${C}" cy="${C}" r="182" stroke-dasharray="3 9"/>`);

  let ticks = '';
  for (let i = 0; i < 72; i += 1) {
    const [x1, y1] = polar(C, C, 182, i * 5);
    const [x2, y2] = polar(C, C, i % 6 === 0 ? 168 : 175, i * 5);
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  layers.push(`<g class="ring spin-slow">${ticks}</g>`);

  // Rosette of 12 sixteen-point stars.
  let rosette = '';
  for (let i = 0; i < 12; i += 1) {
    const [x, y] = polar(C, C, 132, (i * 360) / 12);
    rosette += `<polygon class="ring ring--em" points="${starPoints(x, y, 30, 12, 8, i * 7)}"/>`;
  }
  layers.push(`<g class="spin-mid">${rosette}</g>`);

  // Concentric star polygons.
  layers.push(`<g class="spin-slow glow">
    <polygon class="ring" points="${starPoints(C, C, 118, 52, 8, 0)}"/>
    <polygon class="ring" points="${starPoints(C, C, 100, 44, 8, 22.5)}"/>
  </g>`);

  // Inner web: hexagon + triangle + circle, counter-rotating.
  layers.push(`<g class="spin-fast">
    <polygon class="ring ring--em" points="${polygonPoints(C, C, 84, 6, 0)}"/>
    <polygon class="ring" points="${polygonPoints(C, C, 84, 3, 180)}"/>
    <polygon class="ring ring--em" points="${polygonPoints(C, C, 60, 4, 45)}"/>
  </g>`);

  // Core.
  layers.push(`<g class="spin-mid">
    <polygon class="ring glow" points="${starPoints(C, C, 46, 20, 8, 0)}"/>
    <circle class="ring ring--em" cx="${C}" cy="${C}" r="22" stroke-dasharray="2 5"/>
  </g>`);

  // Rays.
  let rays = '';
  for (let i = 0; i < 24; i += 1) {
    const [x1, y1] = polar(C, C, 118, i * 15);
    const [x2, y2] = polar(C, C, i % 2 ? 152 : 162, i * 15);
    rays += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }
  layers.push(`<g class="spin-fast">${rays}</g>`);

  host.innerHTML = `<svg viewBox="0 0 400 400" role="presentation" aria-hidden="true">
    <g stroke-linejoin="round">${layers.join('')}</g>
  </svg>`;
}

/* ── Hijri date ────────────────────────────────────────────────────────── */

export function renderHijriDate(el) {
  if (!el) return;
  try {
    const now = new Date();
    const hijri = new Intl.DateTimeFormat('id-ID-u-ca-islamic-umalqura', {
      day: 'numeric', month: 'long', year: 'numeric',
    }).format(now);
    const greg = new Intl.DateTimeFormat('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).format(now);
    el.textContent = hijri.replace(/\s*H\.?$/i, '').trim();
    el.parentElement?.setAttribute('title', `${hijri} · ${greg}`);
  } catch {
    el.textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium' }).format(new Date());
  }
}
