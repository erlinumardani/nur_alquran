# Nūr al-Qur'ān — Al-Qur'an Digital & Terjemahan Bahasa Indonesia

Aplikasi web bacaan Al-Qur'an 30 juz lengkap: teks Arab Utsmani, terjemahan
**Kemenag RI**, tafsir, dan murottal 6 qari — dengan tampilan bernuansa islami
(geometri arabesque, emas & zamrud) dan animasi yang halus.

![status](https://img.shields.io/badge/status-siap%20pakai-12a077) ![deps](https://img.shields.io/badge/dependencies-0-d9b25f)

---

## Menjalankan

Butuh Node.js 18+ (hanya untuk server statis — aplikasinya sendiri tanpa build step).

```bash
node server.mjs          # http://127.0.0.1:4173
node server.mjs 8080     # port lain
```

Atau lewat npm:

```bash
npm start
```

Aplikasi ini juga bisa di-hosting di layanan statis apa pun (Netlify, Vercel,
GitHub Pages, nginx) — cukup unggah seluruh folder. Karena memakai ES Modules
dan `fetch`, ia **tidak** bisa dibuka langsung lewat `file://`.

---

## Deploy ke Vercel

Proyek ini sudah siap deploy: **tanpa dependensi dan tanpa langkah build**, jadi
Vercel hanya perlu menyajikan berkas statis.

### Cara 1 — Dashboard

1. Push folder ini ke repositori GitHub/GitLab/Bitbucket.
2. Di Vercel: **Add New → Project**, lalu impor repositori tersebut.
3. Biarkan **Framework Preset = Other**, **Build Command kosong**, **Output
   Directory = `.`** (semuanya sudah dikunci oleh `vercel.json`).
4. **Deploy.**

### Cara 2 — CLI

```bash
npx vercel          # preview
npx vercel --prod   # produksi
```

### Berkas konfigurasi

| Berkas | Fungsi |
| --- | --- |
| `vercel.json` | Preset framework, cache, dan header keamanan (termasuk CSP) |
| `.vercelignore` | Mengecualikan `tools/`, `server.mjs`, dan `README.md` dari deployment |
| `.gitignore` | Mengecualikan `node_modules/`, `.vercel`, dan artefak lokal |

Catatan penting tentang konfigurasi:

- `"framework": null` secara eksplisit memilih preset **Other**, sehingga Vercel
  tidak menebak-nebak dan tidak mencoba menjalankan build.
- `"buildCommand": null` mematikan langkah build; tidak ada `build` script di
  `package.json` sehingga tidak ada yang dijalankan.
- **Cache:** `index.html` selalu divalidasi ulang supaya pembaruan langsung
  terlihat, sedangkan `/assets/*` memakai `s-maxage` panjang. Karena nama berkas
  **tidak** di-hash, browser sengaja hanya menyimpan 5 menit — cache panjang
  milik edge Vercel, yang otomatis dibersihkan setiap deployment. Dengan begitu
  memperbarui `app.js` tidak akan membuat pengguna terjebak versi lama.
- **CSP:** `vercel.json` memuat Content-Security-Policy yang mengizinkan tepat
  origin yang dipakai aplikasi (`equran.id` untuk API, `cdn.equran.id` untuk
  murottal, Google Fonts untuk tipografi). Origin `vercel.live` disertakan agar
  Vercel Toolbar tetap berfungsi di Preview Deployment — hapus bila tidak perlu.
  `tools/validate-vercel.mjs` memeriksa ulang daftar ini terhadap kode sumber,
  jadi menambah layanan eksternal baru tanpa memperbarui CSP akan gagal saat
  verifikasi.

---

## Fitur

### Bacaan
- **114 surat / 6.236 ayat** dengan teks Arab, transliterasi latin, dan terjemahan
  bahasa Indonesia (Kemenag RI).
- **Bismillah** otomatis di awal surat — disembunyikan pada At-Taubah (9) dan
  tidak diduplikasi pada Al-Fatihah (1).
- **Nomor ayat** bergaya bintang delapan (khatim) dengan angka Arab-Indic (١، ٢، ٣).
- **Tafsir Kemenag** — panel samping per surat, atau panel inline per ayat.
- **Markah ayat** dan **riwayat bacaan terakhir** (tersimpan di perangkat).
- **Penanda progres baca** di bilah atas dan *scroll spy* yang mengingat ayat
  terakhir yang kamu lihat.

### Murottal
- **6 qari**: Misyari Rasyid Al-Afasi, Abdullah Al-Juhany, Abdul-Muhsin Al-Qasim,
  Abdurrahman as-Sudais, Ibrahim Al-Dossari, Yasser Al-Dosari.
- Murottal diputar **berurutan ayat demi ayat**, sehingga teks dan bacaan selalu
  sinkron: ayat yang sedang dibaca disorot dan layar mengikutinya.
- Menekan **Putar murottal** langsung menggulir ke **ayat pertama** lalu
  melanjutkan ke ayat-ayat berikutnya; menjeda dan melanjutkan tidak menggulir
  ulang, jadi posisi baca tidak hilang.
- Ayat berikutnya **di-prefetch** agar sambungan antar ayat tidak terasa putus.
- Pemutar melekat di bawah: geser progres, ±5 detik, ulangi ayat, ganti qari.
- **Ikon putar ↔ jeda** bertukar di ketiga tempat: tombol pemutar, badge nomor
  ayat yang sedang diputar, dan tombol hero surat. Menekan badge ayat yang sama
  akan menjeda, menekannya lagi melanjutkan.
  Status diambil dari elemen `<audio>` itu sendiri (`paused`/`ended`), bukan dari
  payload event — event `waiting`/`playing` hanya membawa info buffering dan
  sempat membuat ikon kembali ke "play" di tengah pemutaran.
- **Media Session API** — tombol putar di lock screen / notifikasi sistem ikut
  berfungsi.

> **Kenapa bukan satu berkas MP3 per surat?** Berkas murottal utuh memang bebas
> jeda, tetapi satu berkas tidak membawa penanda waktu per ayat, jadi tidak ada
> cara akurat mengetahui ayat mana yang sedang dibaca — sorotan tidak bisa
> mengikuti. Memutar per ayat membuat teks dan bacaan tepat sejalan, dan prefetch
> menutup jeda di sambungannya. Konsekuensinya satu surat panjang seperti
> Al-Baqarah mengunduh banyak berkas kecil secara berurutan, bukan satu berkas besar.
- Ayat yang sedang diputar disorot dan digulirkan otomatis ke tengah layar.

### Tampilan & animasi
- Dua tema (gelap & terang) plus mode **otomatis** mengikuti sistem.
- **Mandala geometris** berlapis yang berputar di hero, digambar secara
  prosedural (roset 12 bintang, poligon bintang, jari-jari).
- **Latar langit** kanvas: bintang delapan bermotif yang melayang naik.
- Pola **arabesque** (khatim) yang bergeser perlahan, aurora bergerak, dan
  lapisan grain.
- Animasi masuk bertahap (stagger) saat menggulir, kartu terangkat dengan
  kilau emas, ayat aktif berdenyut, skeleton shimmer saat memuat.
- Transisi antar-halaman, panel yang membuka (unfold), dan toast.
- **`prefers-reduced-motion` dihormati** — semua animasi dinonaktifkan bila
  pengguna memintanya.

### Lain-lain
- **Pencarian** berdasarkan nama latin, nama Arab, nomor, atau arti
  (mis. "Yasin", "36", "Kesabaran").
- **Command palette** (`/` atau `Ctrl`/`Cmd` + `K`) dengan navigasi panah.
- Filter **Makkiyah / Madaniyah**.
- Pengaturan: ukuran huruf Arab & terjemahan, transliterasi, tafsir inline,
  lanjut otomatis, qari, animasi.
- **Cache lokal** bacaan & tafsir (26 surat terakhir) → bisa dibaca ulang offline.
- Tanggal **Hijriah** (Umm al-Qura) di bilah atas.
- Sepenuhnya responsif, aksesibel (fokus terlihat, ARIA, skip-link), dan punya
  gaya cetak.

---

## Pintasan papan tombol

| Tombol | Aksi |
| --- | --- |
| `/` atau `Ctrl`/`Cmd` + `K` | Buka pencarian surat |
| `↑` `↓` lalu `Enter` | Pilih hasil pencarian |
| `Spasi` | Putar / jeda murottal |
| `←` `→` | Mundur / maju 5 detik |
| `Esc` | Tutup panel atau pencarian |

---

## Struktur

```
index.html                 Markup: topbar, hero, reader, markah, player, drawer
assets/css/styles.css      Design system: token, tema, animasi, responsif
assets/js/app.js           Shell: routing, view, orkestrasi audio, interaksi
assets/js/data.js          Akses data: index bawaan, API, cache localStorage
assets/js/store.js         Preferensi, markah, riwayat bacaan, tema
assets/js/player.js        Pembungkus <audio>: transport + Media Session
assets/js/fx.js            Kanvas bintang, mandala, reveal, toast, formatter
data/surah.json            Index 114 surat (nama, arti, jumlah ayat, ringkasan)
server.mjs                 Server statis tanpa dependensi
vercel.json                Konfigurasi deploy: preset, cache, header keamanan
.vercelignore / .gitignore Berkas yang tidak ikut deploy / tidak ikut di-commit
tools/                     Skrip build data + tiga suite verifikasi
```

### Sumber data

| Data | Sumber |
| --- | --- |
| Teks Arab, transliterasi, terjemahan, tafsir | [equran.id API v2](https://equran.id/apidev/v2) — teks Kemenag RI |
| Murottal | `cdn.equran.id` |
| Index 114 surat | Dibundel di `data/surah.json` (dari `api.quran.gading.dev`) |

Index surat sengaja dibundel supaya beranda tampil seketika dan tetap bisa
dijelajahi tanpa internet. Teks ayat diambil saat dibutuhkan lalu disimpan di
`localStorage`. URL murottal dibentuk secara deterministik dari nomor surat dan
nomor ayat (lihat `data.js`), jadi ayat berikutnya bisa di-prefetch tanpa perlu
meminta data tambahan.

---

## Verifikasi

Tiga suite disertakan dan semuanya lulus:

```bash
npm run verify                 # menjalankan ketiganya berurutan
node tools/validate-vercel.mjs # konfigurasi deploy + cakupan CSP
node tools/verify.mjs          # integritas selector DOM + lapisan data
node tools/verify-render.mjs   # menjalankan app.js sungguhan dengan DOM tiruan
```

- **`validate-vercel.mjs`** — memeriksa `vercel.json` berisi JSON valid, setiap
  kunci dikenal Vercel (schema-nya memakai `additionalProperties: false`, jadi
  satu kunci asing menggagalkan deploy), bentuk `headers[]` benar, dan CSP
  mengizinkan **setiap** origin eksternal yang benar-benar dirujuk kode sumber.
- **`verify.mjs`** — memastikan setiap `#id` dan `.class` yang dipakai JavaScript
  benar-benar ada di markup/CSS/template; lalu menguji pembentuk URL audio,
  pemetaan respons API, cache, markah, riwayat, dan seluruh formatter.
- **`verify-render.mjs`** — mengimpor modul aplikasi apa adanya, menjalankan
  `boot()`, menavigasi ke `#/surat/112`, memeriksa markup yang dihasilkan
  (114 kartu surat, basmalah, teks Arab, terjemahan, nomor Arab-Indic, tombol aksi,
  navigasi antar-surat), lalu **menekan tombol putar/jeda** dan memastikan ikon
  serta kelas `is-playing` berpindah dengan benar di ketiga lokasi (tombol
  pemutar, badge ayat, dan tombol hero).

`tools/extract-surah.mjs` adalah skrip sekali jalan untuk membangun
`data/surah.json`; ia memvalidasi 114 surat dan total 6.236 ayat sebelum menulis.

> Catatan: suite ini memverifikasi jalur runtime JavaScript, bukan tata letak CSS
> atau hasil render visual — untuk itu jalankan aplikasinya di browser.

---

## Catatan teknis

- Tanpa framework, tanpa dependensi, tanpa langkah build. Satu `<script type="module">`.
- XSS dijaga: semua teks dinamis melewati `esc()` sebelum masuk `innerHTML`.
- `fetch` ayat memakai `AbortController`, jadi berpindah surat dengan cepat tidak
  menimpa hasil yang sudah tampil.
- Elemen `<audio>` sengaja **tanpa** atribut `crossorigin`, karena CDN murottal
  belum tentu mengirim header CORS dan pemutaran biasa tidak membutuhkannya.
- Cache dibatasi 26 surat dengan eviksi paling lama agar tidak melebihi kuota
  `localStorage`; kegagalan kuota ditangani tanpa error.
