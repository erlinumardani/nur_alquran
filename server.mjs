/**
 * server.mjs — zero-dependency static file server for the app.
 *
 *   node server.mjs [port]
 *
 * The app is plain HTML/CSS/ES modules, so any static host works. This exists so
 * you can run it locally without installing anything.
 */

import { createServer } from 'node:http';
import { createReadStream, promises as fs, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

/** Resolve a request path to a file inside ROOT, or null if it escapes. */
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = resolve(join(ROOT, rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

/* ── Production headers, applied locally ───────────────────────────────── */

/**
 * Vercel applies vercel.json's header rules to *every* path — including sw.js.
 * That matters: the service worker inherits the site's CSP, so anything it
 * re-fetches must satisfy connect-src. Serving no CSP locally once hid a real
 * bug where audio playback was refused in production but worked in development.
 *
 * Only the non-caching headers are mirrored; the dev server always revalidates.
 */
const HEADER_RULES = (() => {
  // vercel.json sources are path-to-regexp patterns; `(.*)` is the only form
  // used here, so splitting on it and escaping the remainder is exact.
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const toRegExp = (source) =>
    new RegExp(`^${source.split('(.*)').map(escapeRegex).join('(.*)')}$`);

  try {
    const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    return (config.headers ?? []).map((rule) => ({
      re: toRegExp(rule.source),
      // The dev server always revalidates, so caching directives are skipped.
      headers: (rule.headers ?? []).filter((h) => h.key.toLowerCase() !== 'cache-control'),
    }));
  } catch {
    return [];
  }
})();

function applyHeaders(pathname, headers) {
  for (const rule of HEADER_RULES) {
    if (!rule.re.test(pathname)) continue;
    for (const { key, value } of rule.headers) headers[key] = value;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  let filePath = safeResolve(req.url || '/');
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
    const extra = {};
    applyHeaders(new URL(req.url || '/', 'http://localhost').pathname, extra);

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      etag,
      // Local development: always revalidate so edits show up on refresh.
      'cache-control': 'no-cache',
      ...extra,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }).end(
      `<meta charset="utf-8"><body style="font-family:system-ui;background:#04140f;color:#eaf4ee;display:grid;place-items:center;height:100vh;margin:0">
         <div style="text-align:center">
           <p style="font-size:3rem;margin:0">۞</p>
           <h1 style="font-weight:700">404 — Tidak ditemukan</h1>
           <p><a style="color:#d9b25f" href="/">Kembali ke beranda</a></p>
         </div>
       </body>`,
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nūr al-Qur'ān berjalan di http://${HOST}:${PORT}`);
  console.log(`Akar direktori: ${ROOT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} sudah dipakai. Jalankan: node server.mjs <port-lain>`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
