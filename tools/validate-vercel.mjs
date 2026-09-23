/**
 * validate-vercel.mjs — sanity-check vercel.json before deploying.
 *
 *   node tools/validate-vercel.mjs
 *
 * Vercel's published JSON schema (openapi.vercel.sh/vercel.json) explicitly sets
 * "additionalProperties": false at the top level, so one unknown key rejects the
 * whole configuration. The schema is also far too large to fetch reliably here,
 * so the allowed key list below is transcribed from the official reference:
 * https://vercel.com/docs/project-configuration/vercel-json
 *
 * The CSP is additionally cross-checked against every external origin the app
 * actually references, so adding a new service without updating the CSP fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

let failures = 0;
const fail = (m) => { failures += 1; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);

/** Supported per the reference docs. */
const SUPPORTED = new Set([
  '$schema', 'buildCommand', 'bunVersion', 'cleanUrls', 'crons', 'devCommand',
  'fluid', 'framework', 'functions', 'headers', 'ignoreCommand', 'images',
  'installCommand', 'outputDirectory', 'redirects', 'bulkRedirectsPath',
  'regions', 'functionFailoverRegions', 'rewrites', 'routes', 'trailingSlash',
]);

/** Still accepted for backwards compatibility, but discouraged. */
const LEGACY = new Set(['name', 'version', 'alias', 'scope', 'env', 'build', 'builds']);

/** The docs state this one now causes deployment failures. */
const REJECTED = new Set(['public']);

console.log('\nvercel.json validation');

let config;
try {
  config = JSON.parse(read('vercel.json'));
  pass('vercel.json is valid JSON');
} catch (err) {
  fail(`vercel.json is not valid JSON: ${err.message}`);
  process.exit(1);
}

for (const key of Object.keys(config)) {
  if (REJECTED.has(key)) fail(`"${key}" is rejected by Vercel and will break the deploy`);
  else if (SUPPORTED.has(key)) pass(`"${key}" is a supported property`);
  else if (LEGACY.has(key)) console.log(`  warn  "${key}" is legacy/deprecated`);
  else fail(`"${key}" is not a documented property — Vercel rejects unknown keys`);
}

// Types documented for the keys we actually set.
const types = {
  framework: ['string', 'null'],
  buildCommand: ['string', 'null'],
  outputDirectory: ['string', 'null'],
  cleanUrls: ['boolean'],
  trailingSlash: ['boolean'],
};
for (const [key, allowed] of Object.entries(types)) {
  if (!(key in config)) continue;
  const v = config[key];
  const actual = v === null ? 'null' : typeof v;
  if (allowed.includes(actual)) pass(`"${key}" has documented type ${allowed.join(' | ')}`);
  else fail(`"${key}" is ${actual}, documented types are ${allowed.join(' | ')}`);
}

// headers[] shape.
if (!Array.isArray(config.headers)) {
  fail('"headers" must be an array');
} else {
  let bad = 0;
  config.headers.forEach((entry, i) => {
    if (typeof entry.source !== 'string') { fail(`headers[${i}].source must be a string`); bad += 1; }
    if (!Array.isArray(entry.headers) || entry.headers.length === 0) {
      fail(`headers[${i}].headers must be a non-empty array`); bad += 1; return;
    }
    entry.headers.forEach((h, j) => {
      if (typeof h.key !== 'string' || typeof h.value !== 'string') {
        fail(`headers[${i}].headers[${j}] needs string key and value`); bad += 1;
      }
    });
  });
  if (!bad) pass(`all ${config.headers.length} header rules are well formed`);
}

/* ── CSP must cover every external origin the app uses ─────────────────── */

const csp = (config.headers ?? [])
  .flatMap((h) => h.headers ?? [])
  .find((h) => h.key === 'Content-Security-Policy')?.value;

if (!csp) {
  fail('no Content-Security-Policy header configured');
} else {
  const directive = (name) =>
    csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) ?? '';

  // Collect every external origin referenced by the shipped app.
  const sources = [
    read('index.html'),
    read('assets/css/styles.css'),
    ...readdirSync(resolve(ROOT, 'assets/js')).map((f) => read(`assets/js/${f}`)),
  ].join('\n');

  const origins = new Set();
  for (const m of sources.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) origins.add(m[0].replace(/\/$/, ''));
  // Origins that only exist in generated inline markup (the CSS pattern data URI
  // and favicon use data:, which is listed separately below).
  origins.delete('http://www.w3.org');   // XML namespace inside data: URIs

  let uncovered = 0;
  for (const origin of [...origins].sort()) {
    if (csp.includes(origin)) pass(`CSP permits ${origin}`);
    else { fail(`CSP does not permit ${origin} — the browser would block it`); uncovered += 1; }
  }

  // The service worker inherits this same CSP (it is served by the catch-all
  // rule), and everything it re-fetches is checked against connect-src — even
  // media and fonts, which the page itself loads under media-src/font-src.
  // Hosts are read straight out of the worker's routing table, so adding a new
  // route without updating the policy fails here instead of in production.
  const swSource = read('sw.js');
  const swHosts = [...swSource.matchAll(/hostname\s*===\s*'([a-z0-9.-]+)'/gi)].map((m) => m[1]);
  if (!swHosts.length) fail('could not read any hostname routes out of sw.js');
  const connect = directive('connect-src');
  for (const host of [...new Set(swHosts)].sort()) {
    if (connect.includes(`https://${host}`)) pass(`connect-src covers the worker's route to ${host}`);
    else fail(`service worker re-fetches ${host} but connect-src omits it — the worker's own CSP will refuse the request`);
  }

  for (const [dir, token] of [
    ['img-src', 'data:'],
    ['style-src', "'unsafe-inline'"],
    ['worker-src', "'self'"],
  ]) {
    if (directive(dir).includes(token)) pass(`${dir} allows ${token}`);
    else fail(`${dir} is missing ${token}`);
  }
  if (!uncovered) pass('every external origin used by the app is allowed by the CSP');
}

/* ── Deploy surface ────────────────────────────────────────────────────── */

const ignore = read('.vercelignore');
const kept = ['index.html', 'assets/', 'data/'];
kept.forEach((p) => (ignore.includes(p)
  ? fail(`.vercelignore excludes ${p}, which the app needs at runtime`)
  : pass(`${p} is deployed`)));

const pkg = JSON.parse(read('package.json'));
if (pkg.scripts?.build) fail('package.json has a build script — Vercel would run it');
else pass('no build script, so Vercel treats this as a static site');

console.log(`\n${failures === 0 ? 'VERCEL CONFIG READY' : `${failures} PROBLEM(S) FOUND`}\n`);
process.exit(failures === 0 ? 0 : 1);
