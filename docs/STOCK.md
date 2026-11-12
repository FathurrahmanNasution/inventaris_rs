# Modul Stok Masuk dan Stok Keluar

Implementasi mengikuti SRS v1.0 bagian 2.3, 3.1, 3.4 dan DSD bagian 4–5. Stack tetap Express/CommonJS + `pg`; autentikasi, CSRF, audit, dan kartu stok memakai modul existing. Admin dan Add Account tidak mengalami perubahan fitur.

## Perilaku dan mapping requirement

| Requirement | Implementasi |
| --- | --- |
| REQ-STK-001 | Nomor batch dan tanggal kedaluwarsa wajib. Batch baru dibuat pada `medicine_batches`; primary key existing memastikan nomor batch unik **global**, termasuk lintas obat dan batch yang telah habis. Keunikan mengikuti perbandingan case-sensitive PostgreSQL existing. Duplikat mendapat HTTP 409. |
| REQ-STK-002 | Tanggal kalender divalidasi ketat. Kedaluwarsa wajib lebih besar dari hari ini di Asia/Jakarta dan tanggal terima. Tanggal terima boleh historis, tidak boleh di masa depan. Penerimaan historis juga tidak dapat memasukkan obat yang sudah kedaluwarsa hari ini. |
| REQ-STK-003 | FEFO hanya mengambil batch `current_qty > 0` dan `expired_date > hari ini`. Urutan `expired_date ASC, batch_number ASC`, dapat melintasi beberapa batch. Ledger OUT dibuat per batch. |
| REQ-STK-004 | Total stok layak keluar diperiksa di dalam transaksi setelah penguncian. Medicine rows dikunci dalam urutan kode, kemudian batch rows dengan `FOR UPDATE`. Pengurangan SQL memakai syarat `current_qty >= quantity`; constraint nonnegatif existing tetap dipakai. |
| REQ-STK-005 | Referensi faktur/resep wajib pada dokumen dan seluruh ledger IN/OUT. |
| REQ-STK-006 | Endpoint riwayat memakai `reportService.getStockCard` existing. Perbaikan terbatas: saldo awal periode kini memasukkan mutasi sebelum tanggal awal, tanggal dikembalikan sebagai date-only, tanggal tidak valid/periode terbalik ditolak. |
| REQ-AUTH-005; SRS 2.3 | JWT/cookie dan role/status database diverifikasi middleware existing. Di dalam transaksi, aktor dibaca dan dikunci ulang. IN: `gudang`, `kepala_farmasi`. OUT: `pelayanan`, `kepala_farmasi`. Admin IT ditolak pada API tulis dan kedua halaman transaksi. |
| REQ-AUTH-007 | `stock_in`/`stock_out` mencatat user, ID dokumen, jumlah baris ledger, timestamp dan IP melalui `writeAuditLog` existing. |
| SRS 3.4.2; DSD 5 | Bukti penerimaan/pengeluaran tersimpan, dapat dibaca ulang melalui ID dokumen, dan dicetak dari halaman existing. |

Stok, dokumen, ledger, dan audit selalu memakai **satu koneksi dan satu database transaction**. Kegagalan satu item atau audit membatalkan seluruh dokumen, termasuk perubahan pada batch sebelumnya. Tidak memakai `SKIP LOCKED`, sehingga request yang menunggu tidak melewati batch FEFO yang sedang dipakai request lain. Request bersamaan untuk obat yang sama diserialisasi oleh row lock; deadlock/serialization failure dikembalikan sebagai 409 untuk diulang pengguna.

## Endpoint

Seluruh endpoint membutuhkan sesi aktif. Respons mengikuti pola `{ success, data, message? }` existing. Semua request tulis harus JSON dan berasal dari origin aplikasi.

| Method | Endpoint | Akses / hasil |
| --- | --- | --- |
| POST | `/api/stock/in` | Gudang/Kepala Farmasi; HTTP 201, dokumen beserta ledger IN dan identitas petugas. |
| POST | `/api/stock/out` | Pelayanan/Kepala Farmasi; HTTP 201, dokumen dan alokasi OUT yang benar-benar tersimpan. |
| GET | `/api/stock/documents/:documentId` | Semua sesi aktif; bukti IN/OUT menurut UUID. 404 bila tidak ada. |
| GET | `/api/stock/receipts?limit=5` | Semua sesi aktif; baris penerimaan terbaru, default 5, maksimum 100. Data lama juga tetap terlihat. |
| GET | `/api/stock/medicines?limit=500` | Semua sesi aktif; lookup obat aktif khusus formulir stok, maksimum 500. Hasil `data.data` adalah array obat. |
| GET | `/api/stock/medicines/:medicineCode/batches` | Semua sesi aktif; batch layak keluar, terurut FEFO. Preview bersifat informatif; server menghitung ulang saat menyimpan. |
| GET | `/api/stock/history?medicine_code=...&from=YYYY-MM-DD&to=YYYY-MM-DD` | Semua sesi aktif; kartu stok existing dengan saldo awal/akhir per transaksi. Tanggal opsional. |
| GET | `/api/laporan/stock-card?medicine_code=...&from=...&to=...` | Endpoint kartu stok existing tetap tersedia. |

Contoh payload IN:

```json
{
  "reference_number": "FAK-2026-001",
  "received_date": "2026-11-12",
  "supplier": "PBF Contoh",
  "notes": "Penerimaan gudang",
  "items": [
    {
      "medicine_code": "OBT-001",
      "batch_number": "BATCH-BARU-001",
      "expired_date": "2027-11-30",
      "quantity": 100,
      "unit_price": "1250.25"
    }
  ]
}
```

Contoh payload OUT satu obat:

```json
{
  "reference_number": "RSP-2026-001",
  "destination": "Depo Rawat Inap",
  "medicine_code": "OBT-001",
  "quantity": 30,
  "notes": "Permintaan ruangan"
}
```

OUT beberapa obat memakai `items: [{ medicine_code, quantity }, ...]` sebagai pengganti field obat/kuantitas tingkat atas. Satu dokumen berisi 1–100 item. Kode obat duplikat pada OUT harus digabung kuantitasnya oleh pemanggil. Kuantitas wajib integer positif, maksimal 2147483647. Harga beli nonnegatif dengan maksimal 13 digit bilangan bulat dan 2 digit desimal; string desimal disarankan agar tidak kehilangan presisi. Harga beli disimpan pada ledger IN, tanpa mengubah harga master obat.

Respons dokumen memiliki `document_id`, tipe, nomor referensi, tanggal transaksi, supplier/tujuan, catatan, user, timestamp, dan `items`. Setiap item memuat ID transaksi, kode/nama obat, satuan, nomor batch, tanggal kedaluwarsa, kuantitas, dan harga beli untuk IN. Bukti cetak frontend memakai hasil commit server.

## Migrasi dan aktivasi

File: [`migrations/001_stock_documents.sql`](../migrations/001_stock_documents.sql).

- Tabel baru `stock_documents`: identitas UUID, tipe, faktur/resep, tanggal, supplier/tujuan, catatan, pembuat, timestamp.
- Kolom baru nullable `stock_transactions.document_id` (FK) dan `unit_price NUMERIC(15,2)` dengan check nonnegatif.
- Index untuk pencarian dokumen dan antrean FEFO.
- Tidak menghapus data, tidak mengubah users/audit schema, tidak mengisi harga atau dokumen historis secara spekulatif. Baris lama memiliki `document_id`/`unit_price` NULL.
- Seluruh DDL dibungkus BEGIN/COMMIT; penggunaan ulang diuji. Migrasi tidak dijalankan otomatis pada startup aplikasi.

**Status:** migrasi sudah diterapkan dan diuji pada PostgreSQL lokal terisolasi. Database shared dari `.env` hanya diperiksa metadata skemanya menggunakan transaksi READ ONLY. Sebelum memakai endpoint tulis pada deployment, jalankan file migrasi melalui client PostgreSQL/migration runner pada target deployment yang telah ditentukan. Pembuatan index dan ALTER TABLE memerlukan lock singkat, sehingga penerapan pada database shared perlu dijadwalkan sesuai prosedur deployment tim.

`/stok-masuk` dan `/stok-keluar` sudah menggunakan API nyata; mock stok masuk dan pengurangan stok lokal stok keluar telah dihapus. Lookup berada di namespace `/api/stock` agar tidak mengambil alih API master obat milik modul lain. UI mempertahankan pilihan satu obat per formulir; API mendukung banyak item. Laporan/monitoring membaca tabel stok existing sehingga langsung melihat perubahan yang telah di-commit. Valuasi existing tetap memakai harga master; perubahan perhitungan valuasi di luar scope ini.

## Pengujian aman

`npm test` menjalankan regresi existing. Pengujian PostgreSQL tambahan hanya aktif bila `STOCK_TEST_DATABASE_URL` diberikan; tanpa variabel itu tes PostgreSQL ditandai **skip**, bukan dianggap lulus. Tidak ada fallback ke `DATABASE_URL` atau kredensial `.env`.

Guard pengujian mewajibkan host loopback, nama database `stock_inventory_test`, dan tanpa opsi query pada URL. Setiap run membuat schema acak dengan search_path khusus, lalu menghapus hanya schema miliknya. Akun uji dibuat di schema tersebut; akun README yang berada pada database shared tidak diubah.

Contoh setup Windows untuk **cluster lokal baru** dengan PostgreSQL 17 terpasang:

```powershell
& 'C:\Program Files\PostgreSQL\17\bin\initdb.exe' -D .tmp-stock-pg -U stock_test -A trust --encoding=UTF8 --locale=C
& 'C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe' -D .tmp-stock-pg -l .tmp-stock-pg.log -o '-p 55439 -h 127.0.0.1' -w start
& 'C:\Program Files\PostgreSQL\17\bin\createdb.exe' -h 127.0.0.1 -p 55439 -U stock_test stock_inventory_test
$env:STOCK_TEST_DATABASE_URL = 'postgresql://stock_test@127.0.0.1:55439/stock_inventory_test'
npm test
# Hanya suite stok PostgreSQL:
npm run test:stock
# Opsional: memerlukan Python playwright dan Microsoft Edge terpasang.
python tests/stock-ui-smoke.py
& 'C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe' -D .tmp-stock-pg -m fast -w stop
```

Cluster trust di atas hanya untuk pengujian lokal sementara; jangan dipakai sebagai konfigurasi deployment. Bila cluster sudah dibuat, cukup jalankan start dan gunakan database pengujian yang sudah tersedia.

Hasil yang benar-benar dijalankan pada 12 November 2026:

| Pemeriksaan | Hasil |
| --- | --- |
| `npm test` dengan PostgreSQL pengujian aktif | **52 lulus, 0 gagal, 0 skip**: 34 regresi existing + 18 tes stok PostgreSQL. |
| IN berhasil; duplikat global, batch habis, duplikat dalam dokumen | Lulus. |
| Tanggal kedaluwarsa/tanggal kalender/tanggal terima; qty, harga dan obat | Lulus. |
| OUT satu batch; beberapa batch FEFO dan tie-break; stok kurang | Lulus. |
| Batch kedaluwarsa dan kedaluwarsa hari ini | Tidak dialokasikan; lulus. |
| Dua OUT bersamaan meminta masing-masing 7 dari stok 10 | Satu 201, satu 409; stok akhir 3; lulus. |
| Dua IN bersamaan memakai batch identik | Satu dokumen/ledger/audit; lulus. |
| Rollback multi-item IN, multi-obat OUT, kegagalan audit dan ledger OUT batch kedua | Seluruh perubahan dibatalkan; lulus. |
| Authentication, empat role, status nonaktif, role JWT lama, CSRF | Lulus. |
| Riwayat, saldo periode, nomor referensi, audit dan bukti tersimpan | Lulus. |
| Edge headless, `tests/stock-ui-smoke.py` | Login, IN harga desimal, preview FEFO, OUT lintas batch, kedua bukti, tombol cetak dan riwayat persisten lulus; tanpa error JavaScript. |

Browser smoke memeriksa mode CSS print dan pemanggilan `window.print`; tidak menguji printer fisik.

## File implementasi

Baru:

- `src/routes/stockRoutes.js`
- `src/controllers/stockController.js`
- `src/services/stockService.js`
- `src/repositories/stockRepository.js`
- `src/validations/stockValidation.js`
- `migrations/001_stock_documents.sql`
- `tests/stock.postgres.test.js`
- `tests/fixtures/stock-schema.sql`
- `tests/helpers/stock-ui-server.cjs`
- `tests/stock-ui-smoke.py`
- `docs/STOCK.md`

Diubah:

- `server.js`: mount router stok.
- `src/routes/viewRoutes.js`: batasi halaman stok keluar sesuai role.
- `src/middlewares/authMiddleware.js`: pesan penolakan role operasional dibuat sesuai konteks; perilaku/pesan khusus Admin tetap sama.
- `src/services/reportService.js`: koreksi saldo awal periode dan tanggal kartu stok untuk integrasi mutasi.
- `tests/laporan.test.js`: verifikasi saldo periode yang telah dikoreksi.
- `views/stok-masuk.html`, `views/stok-keluar.html`: integrasi API nyata, preview, bukti server dan cetak.
- `package.json`: perintah `test:stock`.
- `.gitignore`: abaikan tooling dan cluster pengujian lokal.
- `README.md`: tautan dokumentasi modul stok.

Implementasi fitur yang diminta selesai pada kode dan telah diuji lokal. Penerapan migrasi pada database deployment merupakan langkah aktivasi yang belum dilakukan. Dokumen historis yang tidak pernah menyimpan harga/tujuan tidak direkonstruksi. Tidak ada perubahan `.env`, penghapusan data existing, commit, atau push.
