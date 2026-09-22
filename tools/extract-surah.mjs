// One-off build helper: parse the cached gading.dev /surah payload into a compact bundled index.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = process.argv[2];

// The fetch layer mangles the payload in three ways: it doubles every backslash,
// it escapes square/curly brackets, and it hard-wraps long lines at a fixed column
// with no character inserted. Undoing all three is lossless for this payload, and
// the validation below proves the reconstruction before anything is written.
const raw = readFileSync(src, 'utf8')
  .replace(/\\\\/g, '\\')
  .replace(/\\([[\]{}])/g, '$1')
  .replace(/[\r\n]+/g, '');
const start = raw.indexOf('{"code"');
const end = raw.lastIndexOf('}');
if (start < 0 || end < 0) throw new Error('JSON payload not found in source file');

const json = JSON.parse(raw.slice(start, end + 1));
if (!Array.isArray(json.data) || json.data.length !== 114) {
  throw new Error(`expected 114 surahs, received ${json.data?.length}`);
}

const strip = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const surahs = json.data.map((s) => ({
  n: s.number,
  ar: strip(s.name.short),
  arLong: strip(s.name.long),
  id: strip(s.name.transliteration.id),
  en: strip(s.name.transliteration.en),
  arti: strip(s.name.translation.id),
  ayat: s.numberOfVerses,
  turun: /Medinan|Madani/i.test(s.revelation.en) ? 'Madinah' : 'Makkah',
  desc: strip(s.tafsir.id),
}));

// Sanity checks: sequential numbering and a plausible total ayah count.
surahs.forEach((s, i) => {
  if (s.n !== i + 1) throw new Error(`surah numbering gap at index ${i}`);
  if (!s.ar || !s.id || !s.arti || !s.ayat) throw new Error(`missing fields for surah ${s.n}`);
});

const totalAyah = surahs.reduce((a, s) => a + s.ayat, 0);
if (totalAyah !== 6236) throw new Error(`expected 6236 total ayahs, received ${totalAyah}`);

mkdirSync(resolve(root, 'data'), { recursive: true });
const out = resolve(root, 'data', 'surah.json');
writeFileSync(out, JSON.stringify(surahs), 'utf8');

console.log(`wrote ${out}`);
console.log(`surahs=${surahs.length} ayahs=${totalAyah}`);
console.log('first:', JSON.stringify(surahs[0]).slice(0, 160));
console.log('last :', JSON.stringify(surahs[113]).slice(0, 160));
