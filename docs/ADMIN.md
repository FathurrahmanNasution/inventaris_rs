# Backend Admin dan Manajemen Pengguna

Implementasi mengacu pada SRS v1.0 §2.3 dan §3.1 serta DSD §4–6 dan matriks §7.1. Stack tetap Express/CommonJS, PostgreSQL melalui `pg`, bcrypt, dan JWT existing. Seluruh operasi pengujian tulis memakai database lokal khusus; database shared hanya diperiksa metadata skemanya dalam transaksi READ ONLY.

## Analisis awal dan mapping requirement

Fitur yang sudah tersedia diperiksa sebelum implementasi; fitur tersebut dipertahankan dan diverifikasi, bukan dibuat ulang.

| Requirement | Fungsi dan status awal | Penyelesaian / file | Dependensi dan batas kolaborasi |
| --- | --- | --- | --- |
| REQ-AUTH-001/002/003 | Login, bcrypt dan JWT maksimal 8 jam sudah tersedia. | Dipertahankan; diverifikasi melalui tes existing dan PostgreSQL. | `authService`, `authController`, middleware dan halaman login existing tidak diubah. |
| REQ-AUTH-004 | Lockout akun/IP setelah lima kegagalan dalam 15 menit sudah tersedia. | Tes existing tetap lulus. | Counter tetap di memori satu proses; tidak memperkenalkan penyimpanan baru. |
| REQ-AUTH-005 | Middleware autentikasi/role dan proteksi service untuk mutasi sudah tersedia. | Endpoint detail baru memakai middleware yang sama dan memeriksa aktor aktif/Admin di service. | Empat role existing tetap; Kepala Farmasi tidak memperoleh hak kelola kredensial. |
| REQ-AUTH-007 | Audit login/logout, perubahan akun, reset/ganti sandi dan pencarian log sudah tersedia. | Diverifikasi dengan PostgreSQL nyata: filter, pagination, kerahasiaan, dan rollback saat audit gagal. | `writeAuditLog`, batas `action` 100 karakter dan IP handling existing tidak diubah; audit stok tetap. |
| REQ-AUTH-008 | Daftar, Add Account, edit username/peran/status dan reset sandi sudah tersedia. Endpoint detail belum ada; Edit memakai objek daftar lama. | Tambah `GET /api/users/:userId` pada route/controller/service pengguna; Edit memuat detail terbaru sebelum membuka dialog. | Add Account, validasi dan transaksi existing dipertahankan. Pencarian/filter/pagination 20 akun tetap dilakukan frontend sesuai kontrak daftar existing. |
| REQ-AUTH-009 | Ganti sandi mandiri dengan sandi lama dan pembatalan sesi existing sudah tersedia. | Diverifikasi untuk semua role, sandi salah/lemah, bcrypt, token lama, dan rollback. | Halaman password dan kontrak autentikasi tidak diubah. |
| SRS §2.3; DSD §6.1 | Deskripsi pemisahan tugas dan fitur Admin masih umum; navigasi Admin menampilkan tautan transaksi fisik. | Deskripsi akun/audit diperjelas; tautan stok masuk/keluar disembunyikan pada halaman Admin. | Layout, komponen bersama, Add Account dan halaman stok tidak ditulis ulang. Backend tetap menjadi penegak otorisasi. |
| SRS §2.3 — konfigurasi sistem/backup | Hanya disebut sebagai tanggung jawab Admin; tidak ada spesifikasi parameter, storage backup, retention, izin proses atau alur restore. | **Menunggu klarifikasi teknis**, tanpa endpoint administrasi server/backup baru. | Tidak menjalankan backup/restore maupun mengakses kredensial melalui API. |

## Perubahan yang dikerjakan

- Endpoint detail pengguna mengembalikan hanya `user_id`, `username`, `role`, `status`, `created_at`. ID harus integer positif maksimal 2147483647; pengguna tidak ditemukan mendapat 404.
- Service detail memeriksa status dan peran aktor, termasuk bila dipanggil langsung tanpa controller. Request HTTP tetap melewati middleware autentikasi dan role existing.
- Tombol Edit memuat detail terbaru dari endpoint baru. Selama request berjalan tombol menampilkan “Memuat...”; kegagalan ditampilkan memakai pesan/API client existing dan tidak membuka editor berisi data lama.
- Deskripsi menjelaskan field akun yang dapat diedit, penolakan akses bagi akun nonaktif, perlindungan akun sendiri, jenis aktivitas audit, pencarian, dan pagination. Deskripsi Add Account tetap sama.
- Pengujian diperluas ke PostgreSQL nyata dan browser Edge. Tidak ada perubahan pada implementasi Add Account, update akun, reset/ganti sandi, login/logout, middleware, atau utilitas audit dalam tahap Admin ini.

## API dan izin

| Method | Endpoint | Hak akses | Kontrak / status |
| --- | --- | --- | --- |
| GET | `/api/users` | `admin` aktif | Existing; `{ success: true, data: { users } }`, seluruh akun diurutkan `user_id ASC`. |
| GET | `/api/users/:userId` | `admin` aktif | **Baru**; `{ success: true, data: { user } }`, termasuk akun target nonaktif. |
| POST | `/api/users` | `admin` aktif | Add Account existing milik developer lain, dipertahankan; 201. |
| PATCH | `/api/users/:userId` | `admin` aktif | Existing; wajib `username`, `role`, `status`. 200 dengan `data.user`. |
| POST | `/api/users/:userId/reset-password` | `admin` aktif | Existing; `newPassword`. Tidak digunakan untuk reset akun sendiri. |
| GET | `/api/audit-logs?search=&page=1` | `admin` aktif | Existing; `{ logs, page, hasMore }` dalam `data`. Maksimal 50 log per halaman. |
| POST | `/api/auth/login` | Publik | Existing; cookie sesi HttpOnly, tanpa token/hash dalam body respons. |
| GET | `/api/auth/me` | Semua role aktif | Existing; informasi sesi saat ini. |
| POST | `/api/auth/logout` | Semua role aktif | Existing; catat audit dan hapus cookie. |
| PATCH | `/api/auth/password` | Semua role aktif | Existing; `oldPassword`, `newPassword`, hanya akun sendiri. |
| GET | `/admin`, `/admin/users` | `admin` aktif | Halaman Admin existing. |
| GET | `/account/password` | Semua role aktif | Halaman ganti sandi existing. |

API Admin menolak sesi tidak valid/nonaktif dengan 401 dan peran operasional dengan 403. ID/body tidak valid mendapat 400; akun tidak ditemukan 404; username duplikat 409. Kesalahan database mendapat pesan 500 generik tanpa SQL maupun detail rahasia.

Cookie dan bearer JWT existing tetap didukung. Request tulis wajib `Content-Type: application/json` dan validasi same-origin existing. Tidak ada endpoint DELETE akun/log atau endpoint edit/hapus audit. Akun dinonaktifkan, bukan dihapus.

Contoh respons detail:

```json
{
  "success": true,
  "data": {
    "user": {
      "user_id": 42,
      "username": "staf_contoh",
      "role": "gudang",
      "status": "aktif",
      "created_at": "2026-11-12T00:00:00.000Z"
    }
  }
}
```

Contoh body update existing:

```json
{
  "username": "staf_contoh",
  "role": "pelayanan",
  "status": "nonaktif"
}
```

Field yang dapat diubah tetap dibatasi secara eksplisit ke username/peran/status; input tambahan tidak dapat mengganti `user_id`, hash atau timestamp. Username mengikuti validasi existing 3–50 karakter huruf kecil/angka/titik/garis bawah/tanda hubung. Role valid: `admin`, `gudang`, `pelayanan`, `kepala_farmasi`; status: `aktif`/`nonaktif`.

Untuk reset, kirim `newPassword` melalui field password pada dialog existing. Ganti sandi sendiri meminta `oldPassword` dan `newPassword`. Password minimal 8 karakter dengan huruf dan angka, maksimal 72 byte; disimpan sebagai bcrypt. Konfirmasi password pada frontend tetap tersedia. Password baru, hash, bearer token, dan isi request tidak ditulis ke audit.

## RBAC, audit dan sesi

- Mutasi pengguna existing memakai database transaction dengan `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, membaca ulang aktor, lalu memvalidasi target. Perubahan dan log memakai koneksi yang sama.
- Pengguna tidak dapat menonaktifkan atau menurunkan role Admin akun sendiri. Penurunan/deaktivasi Admin juga memiliki pengecekan Admin aktif lain. Konkurensi dua Admin yang saling menonaktifkan diuji: hanya satu berhasil dan minimal satu Admin aktif tersisa.
- Setiap request membaca ulang role/status dari database. Promosi/demosi tidak mengandalkan claim role JWT yang lama.
- Reset dan ganti password membatalkan token lama melalui credential tag HMAC terhadap hash bcrypt existing. Hash/tag tidak dikembalikan oleh API profil atau detail pengguna.
- Akun nonaktif ditolak saat login maupun menggunakan token lama. Mengaktifkan kembali akun **tidak merotasi password**; token sebelum deaktivasi dapat berlaku lagi bila belum kedaluwarsa dan hash belum berubah. Ini mempertahankan strategi sesi existing.
- Logout menghapus cookie browser; salinan bearer token tidak dicabut per-token dan tetap mengikuti batas waktu/perubahan password existing.
- Audit update memakai `update_user: target=<id> fields=<field>`; pembuatan akun, reset dan ganti sandi memakai action existing. Username/IP/action dapat dicari tanpa wildcard tidak sengaja; log diurutkan `created_at DESC, log_id DESC`.
- User pada log adalah **aktor**, sedangkan target perubahan ada pada action. Riwayat tidak dihapus. Search atas username mengikuti username aktor saat dibaca dari tabel users.
- IP dan trust-proxy tidak diubah. Di balik reverse proxy, konfigurasi trust-proxy tetap menjadi tugas deployment sesuai topologi yang dipercaya.
- Admin IT tetap ditolak pada POST stok masuk/keluar dan halaman transaksi. Pengujian otorisasi Admin berjalan bahkan ketika tabel dokumen stok belum tersedia.

## Konflik spesifikasi dan batas yang masih berlaku

SRS narasi manajemen akun menyebut nama/email dan DSD antarmuka menyebut validasi email, tetapi DSD data dictionary serta skema PostgreSQL aktual hanya menyediakan username, hash, role, status dan timestamp. Implementasi mempertahankan field aktual dan kontrak Add Account. Tidak menambahkan profil/email atau mengganti login secara spekulatif; perlu kesepakatan skema dan integrasi dengan pemilik Add Account bila akan dikembangkan.

SRS memakai istilah `role_id` pada narasi JWT, sedangkan repository memakai string `role` dengan empat nilai resmi. Middleware/service existing konsisten memakai nilai tersebut; kontrak JWT tidak diubah.

Konfigurasi sistem dan backup belum memiliki spesifikasi yang dapat diimplementasikan dengan aman. Sebelum pengerjaan, tim perlu menentukan daftar parameter/validasi, pemilik infrastruktur, mekanisme backup resmi, lokasi penyimpanan, enkripsi/retensi, jadwal, izin proses, dan prosedur restore. Tidak ada fitur ini yang diklaim tersedia.

Counter lockout masih berada dalam memori proses; deployment beberapa instance membutuhkan penyimpanan counter bersama. Tidak ada integrasi email/reset link eksternal yang ditambahkan.

## Database dan deployment

Tidak ada migrasi Admin baru. Skema `users` dan `audit_logs` existing cukup; Admin dapat berjalan tanpa `001_stock_documents.sql`.

Migrasi stok [`001_stock_documents.sql`](../migrations/001_stock_documents.sql) tetap belum diterapkan ke database shared, tidak diubah, dan tidak dijalankan otomatis. Tidak ada dependensi migrasi baru atau perubahan urutan migrasi. Penerapan migrasi stok tetap merupakan langkah deployment terpisah dengan persetujuan eksplisit.

Untuk menjalankan aplikasi: gunakan dependensi existing, `DATABASE_URL` dan `JWT_SECRET` yang telah dikonfigurasi, lalu `npm start`. Gunakan HTTPS dengan `NODE_ENV=production`; bila reverse proxy dipakai, `APP_ORIGIN` harus sesuai origin publik. `.env` tidak diubah. Tidak ada seed Admin maupun perubahan akun shared otomatis.

## Pengujian aman dan hasil aktual

Jalankan regresi default dengan `npm test`. Suite PostgreSQL Admin hanya aktif bila `ADMIN_TEST_DATABASE_URL` diberikan. Guard mewajibkan host loopback, database `admin_inventory_test`, dan URL tanpa query options; tidak memakai `DATABASE_URL` sebagai fallback.

Tes Admin membuat schema acak dengan search_path khusus menggunakan base fixture existing, **tanpa menerapkan migrasi stok**. Saat selesai, hanya schema buatannya yang dibersihkan. Tes stok terpisah tetap memakai database `stock_inventory_test` dan migrasi dalam schema pengujiannya sendiri. Kredensial testing pada README/shared tidak dipakai untuk operasi tulis.

Contoh PowerShell, setelah cluster pengujian lokal di port 55439 berjalan sesuai [panduan stok](STOCK.md):

```powershell
# Jalankan createdb hanya bila database khusus Admin ini belum dibuat.
& 'C:\Program Files\PostgreSQL\17\bin\createdb.exe' -h 127.0.0.1 -p 55439 -U stock_test admin_inventory_test
$env:ADMIN_TEST_DATABASE_URL = 'postgresql://stock_test@127.0.0.1:55439/admin_inventory_test'
$env:STOCK_TEST_DATABASE_URL = 'postgresql://stock_test@127.0.0.1:55439/stock_inventory_test'
npm test
# Hanya suite Admin:
npm run test:admin
# Browser opsional; memerlukan Python Playwright dan Edge terpasang.
python tests/admin-ui-smoke.py
python tests/stock-ui-smoke.py
```

Tanpa variabel pengujian terkait, suite PostgreSQL diberi status **skip**, bukan dianggap lulus. Tidak ada script lint atau build pada repository; gunakan tes dan pemeriksaan sintaks yang sesuai stack existing.

Hasil yang benar-benar dijalankan pada 12 November 2026:

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` dengan kedua database lokal aktif | **74 lulus, 0 gagal, 0 skip**: 21 Admin PostgreSQL, 18 Admin HTTP in-memory, 17 monitoring/laporan existing, 18 stok PostgreSQL. |
| Detail pengguna | Field aman, ID invalid/404, target nonaktif, pembatasan role dan service recheck lulus. |
| Pengelolaan akun | Edit, whitelist field, empat role/invalid role, aktivasi/deaktivasi, sesi lama dan preservasi referensi lulus. |
| Perlindungan Admin | Akun sendiri dan dua deaktivasi Admin bersamaan lulus; minimal satu Admin aktif tersisa. |
| Password | Reset/ganti sendiri, sandi lama salah, password lemah/batas byte, bcrypt dan pembatalan token lama lulus. |
| Audit | Konsistensi aktor/target/IP, kerahasiaan, pencarian action/username/IP, escape wildcard dan pagination stabil lulus. |
| Rollback PostgreSQL | Kegagalan audit membatalkan edit/role/status, reset, ganti sandi dan Add Account. |
| Add Account | Regresi HTTP/PostgreSQL dan browser lulus; route/controller/service, validasi, dialog/form/submit dan deskripsi existing dipertahankan. |
| Stok | Seluruh 18 tes PostgreSQL tetap lulus, termasuk FEFO, konkurensi, rollback dan larangan Admin IT. |
| Edge — `tests/admin-ui-smoke.py` | Login/logout, daftar/filter/pagination, Add Account, detail terbaru, edit peran/status, reset/ganti sandi, audit, validasi dan proteksi diri lulus; tanpa error JavaScript. Kegagalan detail 404 disimulasikan untuk memeriksa state error UI. |
| Edge — `tests/stock-ui-smoke.py` | Regresi login, stok masuk/harga desimal, preview FEFO, pengeluaran lintas batch, bukti/cetak dan riwayat persisten tetap lulus; tanpa error JavaScript. |
| Pemeriksaan statis | Sintaks 32 file JavaScript, script inline Admin, dua script Python dan `git diff --check` lulus. Perbandingan hash memastikan `.env`, file stok/migrasi dan bagian Add Account yang dilindungi tidak berubah; bagian akun README juga tetap sama. |

Daftar hasil ini tidak menggantikan UAT/deployment pada infrastruktur rumah sakit. Tidak ada migrasi atau pengujian tulis pada database shared.

## File tahap Admin

Ditambah:

- `docs/ADMIN.md`
- `tests/admin.postgres.test.js`
- `tests/admin-ui-smoke.py`
- `tests/helpers/admin-ui-server.cjs`

Diubah:

- `src/routes/userRoutes.js`: satu route GET detail baru.
- `src/controllers/userController.js`: handler detail ringan.
- `src/services/userService.js`: service detail dengan validasi/otorisasi.
- `views/admin.html`: edit memuat detail, deskripsi, dan penyembunyian tautan fisik bagi Admin.
- `tests/admin.test.js`: regresi endpoint detail baru.
- `package.json`: perintah `test:admin`.
- `README.md`: endpoint detail dan tautan dokumentasi tahap Admin.

Perubahan stok dari tahap sebelumnya tetap ada di working tree karena belum di-commit; bukan perubahan ulang oleh tahap Admin. Tidak ada commit/push otomatis, perubahan `.env`, atau penghapusan data existing.
