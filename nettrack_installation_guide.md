# Panduan Instalasi & Pengoperasian NetTrack

Panduan ini berisi langkah-langkah lengkap untuk memasang dependensi, mengonfigurasi database MySQL, dan menjalankan aplikasi **NetTrack**.

---

## 📋 Prasyarat Sistem

Sebelum memulai, pastikan perangkat kamu telah terpasang software berikut:
* **Python** (Versi 3.8 atau yang lebih baru)
* **Laragon** / **XAMPP** (sebagai server MySQL)
* **Web Browser** modern (Chrome, Edge, Firefox, atau Opera)

---

## 🗄️ 1. Konfigurasi Database MySQL

1. Buka **Laragon** lalu klik **Start All** (memastikan Apache/Nginx & MySQL aktif).
2. Buka **HeidiSQL** (bawaan Laragon) atau **phpMyAdmin** (`http://localhost/phpmyadmin`).
3. Buat database baru bernama **`nettrack_db`**.
4. Eksekusi query SQL berikut untuk membuat tabel `users` dan `messages`:

```sql
CREATE DATABASE IF NOT EXISTS nettrack_db;
USE nettrack_db;

-- Tabel Pengguna (Users)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(30) UNIQUE NOT NULL,
    username VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    access_key VARCHAR(100) NOT NULL,
    last_login DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabel Pesan (Messages)
CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sender_id VARCHAR(30) NOT NULL,
    sender_name VARCHAR(100) NOT NULL,
    receiver_id VARCHAR(30) NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(user_id) ON DELETE CASCADE
);
```

---

## 📂 2. Persiapan Struktur Folder

Pastikan susunan folder dan file proyek kamu tersusun seperti ini:

```text
nettrack-project/
├── backend/
│   └── app.py
└── frontend/
    ├── index.html
    ├── style.css
    └── script.js
```

---

## 📦 3. Instalasi Modul / Package Python

Buka Terminal / Command Prompt (CMD), lalu jalankan perintah berikut secara berurutan:

### A. Masuk ke Folder Backend
```bash
cd path/to/nettrack-project/backend
```

### B. Buat & Aktifkan Virtual Environment
Menggunakan virtual environment sangat direkomendasikan agar versi package tidak bentrok dengan proyek Python lain.

* **Windows (CMD / PowerShell):**
  ```bash
  python -m venv venv
  venv\Scripts\activate
  ```

* **Linux / macOS / WSL Ubuntu:**
  ```bash
  python3 -m venv venv
  source venv/bin/activate
  ```
> *Tanda `(venv)` akan muncul di sisi kiri prompt terminal saat lingkungan virtual aktif.*

### C. Update Pip
```bash
python -m pip install --upgrade pip
```

### D. Install Semua Package Python
```bash
pip install Flask flask-socketio flask-cors mysql-connector-python
```

#### Ringkasan Package yang Diunduh:
| Package | Fungsi |
| :--- | :--- |
| **`Flask`** | Framework web backend utama |
| **`flask-socketio`** | Library komunikasi WebSocket real-time |
| **`flask-cors`** | Mengatur akses lintas domain (CORS) |
| **`mysql-connector-python`** | Driver koneksi dari Flask ke MySQL Laragon |

---

## 🚀 4. Menjalankan Server Aplikasi

1. Pastikan Virtual Environment `(venv)` dalam keadaan aktif.
2. Pastikan MySQL di Laragon sudah dalam kondisi **Running**.
3. Jalankan file server `app.py`:
   ```bash
   python app.py
   ```
4. Jika berhasil, terminal akan menampilkan log seperti ini:
   ```text
   * Serving Flask app 'app'
   * Debug mode: on
   * Running on http://0.0.0.0:5000
   ```

---

## 🧪 5. Mengakses Aplikasi

1. Buka web browser dan kunjungi alamat: `http://localhost:5000`
2. Silakan **Daftar Akun Baru**, lalu masuk menggunakan akun tersebut.
3. Untuk menguji fitur chat & status online secara real-time antar 2 pengguna, buka browser dalam **Mode Incognito / Private Window** dan login menggunakan akun kedua.