# 🏥 Backend Sistem Inventaris Stok Obat Rumah Sakit

Backend RESTful API berbasis **Node.js + Express.js** dengan basis data **Neon Cloud PostgreSQL** dan otentikasi **JWT + Role-Based Access Control (RBAC)**, dibangun berdasarkan **SRS v1.0** dan **Design Specification Document (DSD)**.

---

## 🚀 Cara Menjalankan Proyek

### 1. Install Dependensi
```bash
npm install
```

### 2. Jalankan Server
```bash
npm start
```
Server aktif di: **`http://localhost:3000`**

*(Koneksi basis data sudah terhubung langsung ke Neon Cloud PostgreSQL melalui file `.env`)*.

---

## 🔑 Kredensial Akun untuk Pengujian (Login)

Gunakan akun-akun berikut untuk masuk dan menguji sistem sesuai role masing-masing:

| Peran (Role) | Username | Password | Deskripsi & Hak Akses |
| :--- | :--- | :--- | :--- |
| **Administrator IT** | `admin` | `Admin123!` | Kelola akun pengguna, konfigurasi role RBAC, dan audit log. |
| **Staf Gudang** | `staf_gudang` | `Staff123!` | Catat penerimaan stok masuk & mutasi gudang. |
| **Apoteker Pelayanan** | `apoteker_pelayanan` | `Staff123!` | Pengeluaran obat otomatis sistem FEFO & resep. |
| **Kepala Farmasi** | `kepala_farmasi` | `Staff123!` | Dashboard eksekutif, approval stock opname, retur obat. |

---

## 🧩 Fungsi Modular Backend (`src/services/authService.js`)

Rekan tim dapat mengimpor fungsi-fungsi modular berikut:
```javascript
const authService = require('./src/services/authService');
```

- `findUserByUsername(username)`: Cari data pengguna berdasarkan username.
- `findUserById(userId)`: Cari data pengguna berdasarkan ID.
- `hashPassword(plainPassword)`: Enkripsi kata sandi menggunakan bcrypt (salt 10).
- `validatePassword(plainPassword, passwordHash)`: Validasi kecocokan kata sandi.
- `checkUserStatus(user)`: Validasi status aktif akun staf.
- `createJwtToken(payload)`: Buat token JWT dengan masa kedaluwarsa 8 jam.
- `verifyJwtToken(token)`: Verifikasi dan dekripsi token JWT.
- `writeAuditLog(userId, action, ipAddress)`: Catat riwayat audit ke tabel `audit_logs`.
- `registerUser(payload, ipAddress, actorId)`: Pembuatan akun staf oleh Admin terautentikasi.
- `loginUser(payload, ipAddress)`: Alur masuk dan pembuatan token JWT.

---

## 📡 Daftar Endpoint REST API

| Method | Endpoint | Hak Akses | Keterangan |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/login` | Publik | Login pengguna & penerbitan token JWT |
| `POST` | `/api/auth/logout` | Terautentikasi | Catat logout dan hapus cookie sesi |
| `GET` | `/api/auth/me` | Terautentikasi | Ambil informasi profil user yang sedang login |
| `GET` | `/api/users` | Khusus `admin` | Ambil daftar seluruh akun staf |
| `GET` | `/api/users/:userId` | Khusus `admin` | Detail akun dengan field publik; 404 bila tidak ditemukan |
| `POST` | `/api/users` | Khusus `admin` | Tambah akun aktif: username, password, role |
| `PATCH` | `/api/users/:userId` | Khusus `admin` | Simpan username, role, status (`aktif`/`nonaktif`) |
| `POST` | `/api/users/:userId/reset-password` | Khusus `admin` | Reset akun lain dengan `newPassword` |
| `PATCH` | `/api/auth/password` | Terautentikasi | Ganti sandi sendiri dengan `oldPassword`, `newPassword` |
| `GET` | `/api/audit-logs?search=&page=1` | Khusus `admin` | Cari aktivitas/username/IP; 50 baris per halaman |

---

## 📁 Struktur Direktori

```text
inventaris_rs/
├── src/
│   ├── config/
│   │   └── db.js                 # Koneksi PostgreSQL Neon Cloud
│   ├── controllers/
│   │   └── authController.js     # Handler HTTP Login, Logout, Me, Ganti Sandi
│   ├── services/
│   │   └── authService.js        # Fungsi modular autentikasi & RBAC
│   ├── middlewares/
│   │   └── authMiddleware.js     # Middleware JWT & proteksi role RBAC
│   └── routes/
│       ├── authRoutes.js         # Route API autentikasi (/api/auth)
│       ├── userRoutes.js         # Route API data user admin (/api/users)
│       └── viewRoutes.js         # Route antarmuka web HTML
├── views/
│   ├── home.html                 # Halaman beranda
│   └── dashboard.html            # Halaman dashboard operasional
├── .env                          # Konfigurasi database Neon Cloud
├── .env.example
├── package.json
├── server.js                     # File utama aplikasi backend
└── README.md
```


## DEV 02 - Halaman Admin

Jalankan `npm install` lalu `npm start`, buka `/login`, dan gunakan akun Admin yang sudah ada. Login Admin menuju `/admin`; pengguna lain menuju `/dashboard`. Tidak ada seed atau pembuatan akun Admin otomatis.

Konfigurasi lokal `.env` membutuhkan `DATABASE_URL` dan `JWT_SECRET` (minimal 32 karakter). Jangan commit atau menampilkan nilainya. JWT berlaku tetap maksimal 8 jam; `JWT_EXPIRES_IN` lama tidak digunakan. Gunakan `NODE_ENV=production` di HTTPS. Untuk reverse proxy, set `APP_ORIGIN` ke origin publik persis, misalnya `https://inventaris.example` (tanpa slash akhir), agar validasi Origin tetap sesuai. Aplikasi dan API menggunakan origin yang sama.

- `/admin` dan `/admin/users`: daftar/cari/filter akun, tambah, edit username/peran/status, reset kata sandi, dan log aktivitas. Tidak ada halaman maupun endpoint registrasi: akun staf baru hanya dibuat Admin lewat `POST /api/users`, dan alamat lama `/register` dialihkan ke `/login`.
- `/account/password`: tersedia bagi semua role; kata sandi lama wajib valid. Kata sandi baru minimal 8 karakter dengan huruf dan angka, maksimal 72 byte sesuai batas bcrypt.
- Semua request tulis menggunakan `Content-Type: application/json`. API mengembalikan `success`, `message` bila relevan, dan `data` untuk hasil baca/simpan.
- Update pengguna mengirim ketiga field `username`, `role`, `status`. Pembuatan pengguna mengirim `username`, `password`, `role`; `confirmPassword` opsional dan diverifikasi bila dikirim.
- Akun sendiri tidak dapat dinonaktifkan atau diturunkan dari Admin. Tidak ada endpoint hapus akun/log.
- Role/status dibaca ulang dari database pada setiap request. Reset/ganti password membatalkan seluruh token lama akun melalui penanda kredensial HMAC. Token sebelum DEV 02 memerlukan login ulang.
- Perubahan akun dan log audit disimpan dalam satu transaksi; gagal menulis audit membatalkan perubahan akun. `audit_logs.action` dibatasi 100 karakter: log mencatat aktor, target ID, dan jenis field yang diubah, bukan kata sandi.

Skema `public.users` dan `public.audit_logs` telah diperiksa dengan query read-only. Implementasi memakai kolom yang ada; tidak ada migrasi/perubahan skema. Nama lengkap/email pada narasi SRS belum didukung karena tidak tersedia dalam skema aktual; profil yang dapat diedit adalah username. Konfigurasi sistem, backup, dan modul stok di luar lingkup DEV 02 ini.

Batasan sesi: logout menghapus cookie browser; salinan bearer token tetap berlaku sampai kedaluwarsa atau kata sandi berubah. Penonaktifan akun menolak request selama status nonaktif; mengaktifkan kembali akun tidak merotasi kata sandi. Counter lockout disimpan di memori satu proses dan hilang saat restart; deployment multi-instance membutuhkan penyimpanan counter bersama. Di belakang proxy, IP yang terlihat adalah IP koneksi sampai trust-proxy dikonfigurasi sesuai topologi jaringan.

### Pemeriksaan

`npm test` menjalankan pengujian HTTP dengan adapter database in-memory terisolasi: RBAC empat role, CRUD terbatas, validasi, reset/ganti sandi, sesi lama, lockout, CSRF, log, dan rollback saat audit gagal. Tes ini tidak menyentuh Neon atau akun yang sudah ada. Query baca dan render Admin juga diverifikasi terhadap Neon dengan koneksi read-only. Alur tulis UI diuji menggunakan fixture browser, bukan data operasional.

## Modul Stok Masuk dan Stok Keluar

Backend transaksi IN/OUT, FEFO lintas batch, penguncian PostgreSQL, audit atomik, bukti transaksi, dan kedua formulir stok sudah diimplementasikan. Dokumentasi endpoint, payload, mapping SRS, daftar file, serta pengujian tersedia di [docs/STOCK.md](docs/STOCK.md).

Sebelum memakai endpoint tulis di deployment, terapkan [migrations/001_stock_documents.sql](migrations/001_stock_documents.sql) pada target database yang ditentukan. Migrasi menambahkan dokumen transaksi dan harga beli tanpa menghapus data existing; tidak berjalan otomatis saat startup. Migrasi pada database shared belum dilakukan.

`npm run test:stock` memakai PostgreSQL nyata bila `STOCK_TEST_DATABASE_URL` menunjuk database lokal khusus `stock_inventory_test`; tanpa konfigurasi itu suite PostgreSQL ditandai skip. Pengujian tidak memakai `DATABASE_URL` untuk operasi tulis. Jalankan `python tests/stock-ui-smoke.py` untuk smoke test browser dengan Python Playwright dan Edge, menggunakan database pengujian yang sama.

## Finalisasi Backend Admin

Endpoint `GET /api/users/:userId` kini menyediakan detail akun aman dan digunakan tombol Edit untuk memuat data terbaru. Deskripsi fitur akun/audit diperjelas; tautan transaksi fisik disembunyikan pada halaman Admin. Alur dan deskripsi Add Account existing dipertahankan.

Tidak ada migrasi Admin baru atau penerapan migrasi pada database shared. Dokumentasi requirement, izin endpoint, batas spesifikasi, dan deployment tersedia di [docs/ADMIN.md](docs/ADMIN.md).

`npm run test:admin` menjalankan tes Admin existing dan PostgreSQL bila `ADMIN_TEST_DATABASE_URL` menunjuk database lokal khusus `admin_inventory_test`. Suite Admin tidak membutuhkan migrasi stok. Smoke test browser tersedia melalui `python tests/admin-ui-smoke.py` dengan Python Playwright dan Edge. Seluruh akun uji bersifat sementara dan terisolasi dari akun shared.
