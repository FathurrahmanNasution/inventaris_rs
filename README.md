# 🏥 Sistem Inventaris Stok Obat Rumah Sakit

Aplikasi web inventaris farmasi berbasis **Node.js + Express.js** dengan basis data **PostgreSQL (Neon)**, autentikasi **JWT** di cookie httpOnly, dan **Role-Based Access Control (RBAC)** empat peran. Dibangun berdasarkan **SRS v1.0** dan **Software Design Document (SWDD)** Kelompok 2 (KOM B).

Halaman (HTML, CSS, JavaScript tanpa framework di folder `views/`) disajikan oleh server Express yang sama dengan REST API, sehingga aplikasi dan API berada di satu origin.

---

## 🚀 Menjalankan di Lokal

```bash
npm install
cp .env.example .env     # lalu isi DATABASE_URL dan JWT_SECRET
npm start
```

Server aktif di **`http://localhost:3000`**. Saat start, aplikasi menjalankan `SELECT 1` ke database (batas 15 detik) sebelum menerima request. Bila gagal, kode error ditampilkan tanpa kredensial dan proses keluar dengan kode 1.

### Variabel environment

| Variabel | Wajib | Keterangan |
| :--- | :--- | :--- |
| `DATABASE_URL` | Ya | Connection string PostgreSQL Neon. Untuk Vercel pakai versi **pooled** (host berakhiran `-pooler`). |
| `JWT_SECRET` | Ya | Minimal 32 karakter acak. Aplikasi menolak berjalan bila kurang. |
| `NODE_ENV` | Disarankan | `production` saat diakses lewat HTTPS agar cookie memakai flag `Secure`. |
| `PORT` | Tidak | Port lokal, bawaan `3000`. Tidak dipakai di Vercel. |
| `APP_ORIGIN` | Tidak | Origin publik persis untuk cek CSRF, tanpa garis miring akhir. |
| `PG_POOL_MAX` | Tidak | Maksimum koneksi pool. Bawaan 3 di Vercel, 10 di lokal. |
| `TRUST_PROXY` | Tidak | Percayai header `X-Forwarded-*` dari reverse proxy. Otomatis aktif di Vercel. |

Jangan commit file `.env` atau menuliskan nilai rahasia di dokumen mana pun.

---

## 👥 Peran dan Akun

Tidak ada pendaftaran mandiri. Akun staf dibuat **Administrator IT** di halaman `/admin` (`POST /api/users`), dan alamat lama `/register` dialihkan ke `/login`. Kredensial akun **tidak dicantumkan di repositori**; minta ke Administrator IT tim.

| Peran | Nilai `role` | Hak akses utama (SRS 2.3) |
| :--- | :--- | :--- |
| Staf Gudang Farmasi | `gudang` | Stok masuk, entry fisik stock opname, lihat katalog dan riwayat |
| Apoteker / Staf Farmasi Pelayanan | `pelayanan` | Stok keluar (FEFO), lihat katalog dan notifikasi kedaluwarsa |
| Kepala Instalasi Farmasi | `kepala_farmasi` | Seluruh akses operasional, kelola data obat, setujui/tolak opname, laporan |
| Administrator IT | `admin` | Manajemen akun dan audit log, tanpa transaksi fisik (separation of duties) |

Login Admin diarahkan ke `/admin`, peran lain ke `/dashboard`. Menu dan tombol disembunyikan sesuai peran, dan otorisasi tetap diperiksa di setiap endpoint.

---

## 🧩 Fitur

| Modul | Halaman | Ringkasan |
| :--- | :--- | :--- |
| Autentikasi & Pengguna | `/login`, `/admin`, `/account/password` | Login, logout, ganti sandi, kunci 15 menit setelah 5 kali gagal, kelola akun, audit log |
| Dashboard | `/dashboard` | 4 kartu metrik, tren pengeluaran 6 bulan, alert, transaksi terakhir, komposisi kategori, aksi cepat per peran |
| Data Obat | `/data-obat` | Cari, filter kategori dan status, tambah obat, aktif/nonaktif (tanpa hapus permanen) |
| Stok Masuk | `/stok-masuk` | Penerimaan per batch, validasi kedaluwarsa, bukti penerimaan |
| Stok Keluar | `/stok-keluar` | Alokasi FEFO lintas batch otomatis, cegah stok negatif, bukti pengeluaran |
| Monitoring | `/monitoring` | Batch kritis (≤ 30 hari) dan perhatian (31–90 hari), tab stok menipis, catat tindak lanjut |
| Laporan | `/laporan` | Tab Stock Opname (alur persetujuan), Valuasi Aset, Kartu Stok; cetak PDF lewat browser dan ekspor CSV |

---

## 📡 Daftar Endpoint REST API

Semua request tulis wajib `Content-Type: application/json` dan berasal dari origin aplikasi (perlindungan CSRF). Respons berbentuk `{ success, message?, data? }`.

| Method | Endpoint | Hak akses | Keterangan |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Publik | Login, menerbitkan JWT 8 jam di cookie httpOnly |
| `POST` | `/api/auth/logout` | Terautentikasi | Catat logout dan hapus cookie |
| `GET` | `/api/auth/me` | Terautentikasi | Profil pengguna yang login |
| `PATCH` | `/api/auth/password` | Terautentikasi | Ganti sandi sendiri (`oldPassword`, `newPassword`) |
| `GET` | `/api/users` | `admin` | Daftar akun |
| `GET` | `/api/users/:userId` | `admin` | Detail akun |
| `POST` | `/api/users` | `admin` | Tambah akun (`username`, `password`, `role`) |
| `PATCH` | `/api/users/:userId` | `admin` | Ubah `username`, `role`, `status` |
| `POST` | `/api/users/:userId/reset-password` | `admin` | Reset sandi akun lain |
| `GET` | `/api/audit-logs?search=&page=1` | `admin` | Cari log aktivitas, 50 baris per halaman |
| `GET` | `/api/dashboard` | Terautentikasi | Ringkasan dashboard |
| `GET` | `/api/medicines?search=&category=&filter=&active=1&page=1&limit=20` | Terautentikasi | Daftar obat dengan `total_stock`, `is_active`, `days` (kedaluwarsa terdekat) |
| `POST` | `/api/medicines` | `kepala_farmasi` | Tambah obat |
| `PATCH` | `/api/medicines/:code/status` | `kepala_farmasi` | Aktif/nonaktif (`is_active`) |
| `GET` | `/api/categories` | Terautentikasi | Kategori bawaan + kategori yang sudah dipakai |
| `POST` | `/api/stock/in` | `gudang`, `kepala_farmasi` | Catat penerimaan (stok masuk) |
| `POST` | `/api/stock/out` | `pelayanan`, `kepala_farmasi` | Catat pengeluaran dengan FEFO |
| `GET` | `/api/stock/receipts` | Terautentikasi | Penerimaan terakhir |
| `GET` | `/api/stock/documents/:documentId` | Terautentikasi | Bukti transaksi |
| `GET` | `/api/stock/history` | Terautentikasi | Riwayat transaksi stok |
| `GET` | `/api/stock/medicines` | Terautentikasi | Katalog obat aktif beserta stok |
| `GET` | `/api/stock/medicines/:medicineCode/batches` | Terautentikasi | Batch layak keluar, urut FEFO |
| `GET` | `/api/monitoring/expiry?filter=all` | Terautentikasi | Alert kedaluwarsa (`critical`, `warning`) |
| `GET` | `/api/monitoring/low-stock` | Terautentikasi | Obat pada atau di bawah stok minimum |
| `GET` | `/api/monitoring/summary` | Terautentikasi | Ringkasan jumlah alert |
| `POST` | `/api/monitoring/action` | `gudang`, `pelayanan`, `kepala_farmasi` | Catat tindak lanjut (retur/distribusi) ke audit log |
| `GET` | `/api/laporan/valuation` | Terautentikasi | Valuasi aset obat aktif |
| `GET` | `/api/laporan/stock-card?medicine_code=&from=&to=` | Terautentikasi | Kartu stok dengan saldo berjalan |
| `GET` | `/api/laporan/opname` | Terautentikasi | Daftar sesi stock opname |
| `GET` | `/api/laporan/opname/:opnameId` | Terautentikasi | Detail sesi dan item |
| `POST` | `/api/laporan/opname` | `gudang`, `kepala_farmasi` | Buat sesi (saldo sistem dibekukan) |
| `PATCH` | `/api/laporan/opname/:opnameId/items` | `gudang`, `kepala_farmasi` | Input hasil hitung fisik (keterangan wajib bila selisih) |
| `POST` | `/api/laporan/opname/:opnameId/submit` | `gudang`, `kepala_farmasi` | Ajukan untuk persetujuan |
| `POST` | `/api/laporan/opname/:opnameId/cancel` | `gudang`, `kepala_farmasi` | Batalkan sesi draft/menunggu |
| `POST` | `/api/laporan/opname/:opnameId/approve` | `kepala_farmasi` | Setujui dan terapkan penyesuaian stok (FEFO) |
| `POST` | `/api/laporan/opname/:opnameId/reject` | `kepala_farmasi` | Tolak tanpa mengubah stok |

---

## 📁 Struktur Direktori

```text
inventaris_rs/
├── api/index.js              # Entry point Vercel Function (memakai server.js)
├── migrations/               # Perubahan skema, dijalankan manual
├── src/
│   ├── config/db.js          # Pool PostgreSQL
│   ├── controllers/          # Handler HTTP per modul
│   ├── middlewares/          # JWT, RBAC, perlindungan CSRF
│   ├── repositories/         # Query stok
│   ├── routes/               # Route API dan halaman
│   ├── services/             # Logika bisnis per modul
│   └── validations/          # Validasi payload stok
├── tests/                    # Tes node:test dan smoke test Playwright
├── views/                    # Halaman HTML
├── images/                   # Aset gambar
├── server.js                 # Aplikasi Express (lokal: npm start)
├── vercel.json               # Konfigurasi deploy Vercel
└── .env.example              # Contoh variabel environment
```

---

## 🗄️ Database dan Migrasi

Tabel: `users`, `audit_logs`, `medicines`, `medicine_batches`, `stock_transactions`, `stock_documents`, `stock_opname`, `stock_opname_items`. Semuanya sudah terpasang di database Neon tim.

File di `migrations/` bersifat aditif dan **tidak dijalankan otomatis** saat aplikasi start. Jalankan manual lewat SQL Editor Neon atau `psql`, uji dulu di branch Neon, baru di branch utama. Tidak ada seed akun otomatis.

---

## ✅ Pengujian

```bash
npm test
```

Menjalankan tes HTTP dengan adapter database in-memory (tidak menyentuh Neon): RBAC empat peran, akun, lockout, CSRF, audit, data obat, stok FEFO, monitoring, laporan, opname, dan dashboard.

Tes tambahan yang memerlukan PostgreSQL lokal khusus (tidak pernah memakai `DATABASE_URL`):

- `npm run test:stock` dengan `STOCK_TEST_DATABASE_URL` ke database `stock_inventory_test`
- `npm run test:admin` dengan `ADMIN_TEST_DATABASE_URL` ke database `admin_inventory_test`
- `npm run test:e2e` dengan `E2E_TEST_DATABASE_URL` ke database `e2e_inventory_test`: alur lintas modul (Admin membuat akun, login per peran, tambah obat, stok masuk, stok keluar FEFO, Data Obat/Monitoring/Dashboard/Laporan) di PostgreSQL sungguhan. Tabel opname belum ada di fixture/migrasi, jadi alur opname tidak termasuk.
- Smoke test browser (Python Playwright + Edge): `python tests/navigation-ui-smoke.py`, `python tests/stock-ui-smoke.py`, `python tests/admin-ui-smoke.py`

---

## ☁️ Deploy ke Vercel

Repositori sudah disiapkan untuk Vercel: `api/index.js` menjalankan aplikasi Express sebagai Vercel Function, dan `vercel.json` mengarahkan semua path ke sana serta menyertakan folder `views/` dan `images/`.

1. **Neon:** salin connection string versi **pooled** (Neon Console > Connect > centang *Connection pooling*). Untuk Preview, sebaiknya pakai branch Neon terpisah.
2. **Vercel:** *Add New Project* > import repositori GitHub ini. Framework preset: **Other**. Build command dan output directory dibiarkan kosong.
3. **Environment Variables** (Project Settings):
   - `DATABASE_URL` = connection string pooled
   - `JWT_SECRET` = 32+ karakter acak (bedakan Production dan Preview)
   - `NODE_ENV` = `production`
   - Opsional: `APP_ORIGIN` = URL produksi persis (jangan diisi untuk Preview)
4. **Deploy.** Setiap push ke `master` men-deploy Production; setiap branch/pull request mendapat deployment Preview.
5. **Cek setelah deploy:** buka URL, login, coba satu aksi simpan (mis. ganti kata sandi). Bila muncul "Permintaan harus berasal dari aplikasi ini.", periksa `APP_ORIGIN`. Lihat error di menu Logs Vercel.

Catatan untuk Vercel:

- `trust proxy` aktif otomatis (`VERCEL=1`), sehingga HTTPS dan IP pengguna terbaca benar. Pool koneksi otomatis kecil (3).
- Penghitung kunci login (5 kali gagal) disimpan di memori function, sehingga tidak dibagi antar-instance dan hilang saat instance berhenti.
- Paket Hobby Vercel ditujukan untuk penggunaan non-komersial.
- **Sebelum URL dibagikan, ganti kata sandi semua akun bawaan/demo** dan nonaktifkan akun yang tidak dipakai, karena aplikasi dapat dibuka dari internet.

Rollback: Vercel > Deployments > pilih deployment sebelumnya > *Instant Rollback*.
