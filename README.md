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
- `registerUser(payload, ipAddress)`: Alur pendaftaran akun staf baru.
- `loginUser(payload, ipAddress)`: Alur masuk dan pembuatan token JWT.

---

## 📡 Daftar Endpoint REST API

| Method | Endpoint | Hak Akses | Keterangan |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Publik | Registrasi staf baru |
| `POST` | `/api/auth/login` | Publik | Login pengguna & penerbitan token JWT |
| `POST` | `/api/auth/logout` | Publik | Logout sesi pengguna |
| `GET` | `/api/auth/me` | Terautentikasi | Ambil informasi profil user yang sedang login |
| `GET` | `/api/users` | Khusus `admin` | Ambil daftar seluruh akun staf |

---

## 📁 Struktur Direktori

```text
inventaris_rs/
├── src/
│   ├── config/
│   │   └── db.js                 # Koneksi PostgreSQL Neon Cloud
│   ├── controllers/
│   │   └── authController.js     # Handler HTTP Register, Login, Logout, Me
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
│   ├── register.html             # Halaman register staf
│   └── dashboard.html            # Halaman dashboard operasional
├── .env                          # Konfigurasi database Neon Cloud
├── .env.example
├── package.json
├── server.js                     # File utama aplikasi backend
└── README.md
```
