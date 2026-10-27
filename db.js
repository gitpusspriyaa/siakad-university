const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Lokasi DB: Mendukung Persistent Disk Render (/var/data) atau lokal (__dirname)
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'siakad.db');
const db = new Database(dbPath);

// Enable foreign keys and WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema Init
db.exec(`
  -- 1. Users / Mahasiswa & Dosen
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nim_nip TEXT UNIQUE NOT NULL,
    nama TEXT NOT NULL,
    email TEXT UNIQUE,
    role TEXT NOT NULL, -- 'MAHASISWA', 'DOSEN', 'BAAK', 'KAPRODI'
    prodi TEXT DEFAULT 'S1 Teknik Informatika',
    ipk REAL DEFAULT 0.00,
    sks_lulus INTEGER DEFAULT 0,
    status TEXT DEFAULT 'Aktif'
  );

  -- 2. Mata Kuliah
  CREATE TABLE IF NOT EXISTS mata_kuliah (
    id TEXT PRIMARY KEY,
    kode TEXT UNIQUE NOT NULL,
    nama TEXT NOT NULL,
    sks INTEGER NOT NULL,
    semester INTEGER NOT NULL,
    kelas TEXT NOT NULL,
    dosen TEXT NOT NULL,
    jadwal TEXT NOT NULL,
    ruang TEXT NOT NULL,
    kuota INTEGER NOT NULL,
    terisi INTEGER NOT NULL DEFAULT 0
  );

  -- 3. KRS Pengajuan
  CREATE TABLE IF NOT EXISTS krs_pengajuan (
    id TEXT PRIMARY KEY,
    nim TEXT NOT NULL,
    semester_akademik TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Menunggu Persetujuan', -- 'Menunggu Persetujuan', 'Disetujui', 'Ditolak'
    catatan_dpa TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 4. KRS Item
  CREATE TABLE IF NOT EXISTS krs_item (
    id TEXT PRIMARY KEY,
    pengajuan_id TEXT NOT NULL,
    matkul_id TEXT NOT NULL,
    FOREIGN KEY(pengajuan_id) REFERENCES krs_pengajuan(id) ON DELETE CASCADE,
    FOREIGN KEY(matkul_id) REFERENCES mata_kuliah(id)
  );

  -- 5. Presensi Sesi
  CREATE TABLE IF NOT EXISTS presensi_sesi (
    id TEXT PRIMARY KEY,
    matkul_id TEXT NOT NULL,
    pertemuan INTEGER NOT NULL,
    token TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 6. Presensi Kehadiran Mahasiswa
  CREATE TABLE IF NOT EXISTS presensi_kehadiran (
    id TEXT PRIMARY KEY,
    sesi_id TEXT NOT NULL,
    nim TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Hadir',
    waktu DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(sesi_id) REFERENCES presensi_sesi(id)
  );

  -- 7. Nilai Mahasiswa
  CREATE TABLE IF NOT EXISTS nilai (
    id TEXT PRIMARY KEY,
    nim TEXT NOT NULL,
    kode_mk TEXT NOT NULL,
    tugas REAL DEFAULT 0,
    uts REAL DEFAULT 0,
    uas REAL DEFAULT 0,
    presensi REAL DEFAULT 0,
    nilai_akhir REAL DEFAULT 0,
    grade TEXT DEFAULT 'E',
    bobot REAL DEFAULT 0.0,
    UNIQUE(nim, kode_mk)
  );

  -- 8. Logbook Skripsi
  CREATE TABLE IF NOT EXISTS logbook_skripsi (
    id TEXT PRIMARY KEY,
    nim TEXT NOT NULL,
    tanggal TEXT NOT NULL,
    bab TEXT NOT NULL,
    catatan TEXT NOT NULL,
    status TEXT DEFAULT 'ACC Dosen',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 9. App Settings / Konfigurasi BAAK
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Pastikan kolom password ada di users
try {
  db.exec(`ALTER TABLE users ADD COLUMN password TEXT DEFAULT 'password123';`);
} catch (e) {
  // Kolom sudah ada
}

// Inisialisasi default settings
const initSetting = db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`);
initSetting.run('krs_gate_open', '1');
initSetting.run('periode_aktif', '2024/2025 Ganjil');
initSetting.run('input_nilai_open', '1');

// Seed Data Awal jika kosong
const countUsers = db.prepare('SELECT count(*) as count FROM users').get().count;

if (countUsers === 0) {
  const insertUser = db.prepare(`
    INSERT INTO users (id, nim_nip, nama, email, role, prodi, ipk, sks_lulus, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run('u1', '2112012014', 'Rian Hidayat', 'rian@univ.ac.id', 'MAHASISWA', 'S1 Teknik Informatika', 3.75, 84, 'Aktif');
  insertUser.run('u2', '197805122003121002', 'Dr. Eng. Irwan Prasetyo, M.T.', 'irwan@univ.ac.id', 'DOSEN', 'S1 Teknik Informatika', 0.0, 0, 'Aktif');
  insertUser.run('u3', '196503141990031001', 'Prof. Dr. Hendra Wijaya, M.Sc.', 'hendra@univ.ac.id', 'KAPRODI', 'S1 Teknik Informatika', 0.0, 0, 'Aktif');
  insertUser.run('u4', 'ADMIN-BAAK', 'Biro Administrasi Akademik', 'baak@univ.ac.id', 'BAAK', 'Pusat', 0.0, 0, 'Aktif');

  // Insert Matkul
  const insertMK = db.prepare(`
    INSERT INTO mata_kuliah (id, kode, nama, sks, semester, kelas, dosen, jadwal, ruang, kuota, terisi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertMK.run('mk-1', 'IF2101', 'Struktur Data & Algoritma', 4, 3, 'A', 'Dr. Eng. Irwan Prasetyo, M.T.', 'Senin, 08:00 - 11:20', 'TI-301', 40, 38);
  insertMK.run('mk-2', 'IF2102', 'Basis Data Lanjut', 3, 3, 'B', 'Rina Kartika, S.Kom., M.Kom.', 'Selasa, 10:00 - 12:30', 'TI-204', 35, 35);
  insertMK.run('mk-3', 'IF2103', 'Pemrograman Web Berbasis Komponen', 3, 3, 'A', 'Ahmad Fauzi, M.Cs.', 'Rabu, 13:00 - 15:30', 'LAB-RPL', 30, 22);
  insertMK.run('mk-4', 'KU2001', 'Kewarganegaraan', 2, 3, 'C', 'Drs. H. Mulyadi, M.Hum.', 'Kamis, 08:00 - 09:40', 'GKU-102', 50, 41);
  insertMK.run('mk-5', 'IF2104', 'Jaringan Komputer', 3, 3, 'A', 'Bambang Wijaya, S.T., M.T.', 'Jumat, 08:00 - 10:30', 'TI-302', 35, 19);

  // Nilai Awal Mahasiswa
  const insertNilai = db.prepare(`
    INSERT INTO nilai (id, nim, kode_mk, tugas, uts, uas, presensi, nilai_akhir, grade, bobot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertNilai.run('n1', '2112012014', 'IF2101', 85, 88, 90, 100, 89.4, 'A', 4.0);
  insertNilai.run('n2', '2112012030', 'IF2101', 60, 65, 55, 80, 61.5, 'B', 3.0);
  insertNilai.run('n3', '2112012002', 'IF2101', 95, 92, 96, 100, 95.0, 'A', 4.0);

  // Logbook Awal
  const insertLogbook = db.prepare(`
    INSERT INTO logbook_skripsi (id, nim, tanggal, bab, catatan, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertLogbook.run('l1', '2112012014', '18 Okt 2024', 'Bab III - Analisis Kebutuhan Sistem & Micro-Frontend', 'Perjelas diagram konteks dan state management.', 'ACC Dosen');
  insertLogbook.run('l2', '2112012014', '10 Okt 2024', 'Bab II - Studi Literatur Zero-Trust & SSR', 'Perbarui referensi jurnal Scopus minimal 2022.', 'ACC Dosen');

  // Token Presensi Awal
  const insertSesi = db.prepare(`
    INSERT INTO presensi_sesi (id, matkul_id, pertemuan, token, is_active)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertSesi.run('sesi-1', 'mk-1', 9, 'BST-8921', 1);
}

module.exports = db;
