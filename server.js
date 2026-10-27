const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Sessions in memory (Token -> User info)
const SESSIONS = new Map();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Simple Auth Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const session = SESSIONS.get(token);
    if (session) {
      req.user = session;
    }
  }
  next();
}

app.use(authMiddleware);

// ==================== AUTH ENDPOINTS ====================

// Login User
app.post('/api/auth/login', (req, res) => {
  const { nim_nip, password } = req.body;
  if (!nim_nip) return res.status(400).json({ error: 'NIM/NIP wajib diisi' });

  const user = db.prepare('SELECT id, nim_nip, nama, email, role, prodi, ipk, sks_lulus, status, password FROM users WHERE nim_nip = ?').get(nim_nip);
  if (!user) {
    return res.status(401).json({ error: 'Pengguna dengan NIM/NIP tersebut tidak terdaftar' });
  }

  // Cek password sederhana (default: 'password123' atau nilai yang ada)
  const validPass = user.password || 'password123';
  if (password && password !== validPass) {
    return res.status(401).json({ error: 'Password salah' });
  }

  const token = 'token-' + crypto.randomUUID();
  const safeUser = { ...user };
  delete safeUser.password;

  SESSIONS.set(token, safeUser);
  res.json({ success: true, token, user: safeUser });
});

// Current User Profile
app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    // Default fallback ke Rian Hidayat jika belum login
    const defaultMhs = db.prepare('SELECT id, nim_nip, nama, email, role, prodi, ipk, sks_lulus, status FROM users WHERE nim_nip = ?').get('2112012014');
    return res.json(defaultMhs);
  }
  res.json(req.user);
});

// ==================== BAAK & SETTINGS ENDPOINTS ====================

// Get All App Settings
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// Update Saklar KRS BAAK
app.post('/api/settings/krs-gate', (req, res) => {
  const { isOpen } = req.body;
  const val = isOpen ? '1' : '0';
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('krs_gate_open', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(val);

  res.json({ success: true, krs_gate_open: val === '1' });
});

// ==================== AKADEMIK & KRS ENDPOINTS ====================

// Get Katalog Mata Kuliah
app.get('/api/matakuliah', (req, res) => {
  const list = db.prepare('SELECT * FROM mata_kuliah ORDER BY semester ASC, kode ASC').all();
  res.json(list);
});

// Get Mahasiswa Data
app.get('/api/mahasiswa/:nim', (req, res) => {
  const mhs = db.prepare('SELECT id, nim_nip, nama, email, role, prodi, ipk, sks_lulus, status FROM users WHERE nim_nip = ?').get(req.params.nim);
  if (!mhs) return res.status(404).json({ error: 'Mahasiswa tidak ditemukan' });
  res.json(mhs);
});

// Get KRS Mahasiswa
app.get('/api/krs/:nim', (req, res) => {
  const pengajuan = db.prepare('SELECT * FROM krs_pengajuan WHERE nim = ? ORDER BY updated_at DESC LIMIT 1').get(req.params.nim);
  if (!pengajuan) {
    return res.json({ status: 'Belum Mengisi', matkul: [] });
  }
  const items = db.prepare(`
    SELECT mk.* FROM krs_item ki
    JOIN mata_kuliah mk ON ki.matkul_id = mk.id
    WHERE ki.pengajuan_id = ?
  `).all(pengajuan.id);

  res.json({ ...pengajuan, matkul: items });
});

// Submit KRS dengan Validasi Ketat Server-Side (Gerbang, Kuota, Beban SKS)
app.post('/api/krs', (req, res) => {
  const { nim, semesterAkademik, selectedIds } = req.body;

  // 1. Cek Gerbang KRS BAAK
  const gateSetting = db.prepare("SELECT value FROM app_settings WHERE key = 'krs_gate_open'").get();
  if (gateSetting && gateSetting.value === '0') {
    return res.status(403).json({ error: 'Gerbang pengisian KRS sedang DITUTUP oleh BAAK Pusat.' });
  }

  if (!nim || !selectedIds || !Array.isArray(selectedIds) || selectedIds.length === 0) {
    return res.status(400).json({ error: 'Daftar mata kuliah terpilih tidak boleh kosong' });
  }

  // 2. Ambil data matkul terpilih
  const placeholders = selectedIds.map(() => '?').join(',');
  const matkulList = db.prepare(`SELECT * FROM mata_kuliah WHERE id IN (${placeholders})`).all(...selectedIds);

  if (matkulList.length !== selectedIds.length) {
    return res.status(400).json({ error: 'Terdapat mata kuliah yang tidak valid dalam katalog' });
  }

  // 3. Validasi Batas Beban SKS
  const totalSks = matkulList.reduce((sum, m) => sum + m.sks, 0);
  const mhs = db.prepare('SELECT ipk FROM users WHERE nim_nip = ?').get(nim);
  const maksSks = (mhs && mhs.ipk >= 3.0) ? 24 : 18;

  if (totalSks > maksSks) {
    return res.status(400).json({
      error: `Beban ${totalSks} SKS melampaui batas maksimum Anda (${maksSks} SKS). Harap kurangi pilihan mata kuliah.`
    });
  }

  // 4. Validasi Kuota Kelas
  for (const mk of matkulList) {
    if (mk.terisi >= mk.kuota) {
      return res.status(400).json({
        error: `Kelas ${mk.kode} - ${mk.nama} (Kelas ${mk.kelas}) telah penuh! (${mk.terisi}/${mk.kuota} mahasiswa)`
      });
    }
  }

  // 5. Eksekusi Atomic Transaction
  const pengajuanId = 'krs-' + crypto.randomUUID();
  const insertPengajuan = db.prepare(`
    INSERT INTO krs_pengajuan (id, nim, semester_akademik, status, catatan_dpa)
    VALUES (?, ?, ?, 'Menunggu Persetujuan', 'Menunggu review dan tanda tangan digital oleh Dosen Pembimbing Akademik.')
  `);

  const insertItem = db.prepare(`
    INSERT INTO krs_item (id, pengajuan_id, matkul_id)
    VALUES (?, ?, ?)
  `);

  const incrementKuota = db.prepare(`
    UPDATE mata_kuliah SET terisi = terisi + 1 WHERE id = ?
  `);

  const runTransaction = db.transaction(() => {
    insertPengajuan.run(pengajuanId, nim, semesterAkademik || '2024/2025 Ganjil');
    for (const mk of matkulList) {
      insertItem.run('item-' + crypto.randomUUID(), pengajuanId, mk.id);
      incrementKuota.run(mk.id);
    }
  });

  try {
    runTransaction();
    res.json({
      success: true,
      message: `KRS berhasil diajukan (${totalSks} SKS). Data tersimpan permanen di database.`,
      pengajuanId,
      totalSks
    });
  } catch (err) {
    console.error('KRS Transaction Error:', err);
    res.status(500).json({ error: 'Gagal memproses transaksi KRS pada database SQLite.' });
  }
});

// ==================== PORTAL DOSEN ====================

// Data Bimbingan Dosen
app.get('/api/dosen/bimbingan', (req, res) => {
  const bimbinganList = [
    { nim: '2112012014', nama: 'Rian Hidayat', ipk: 3.75, maksSks: 24 },
    { nim: '2112012030', nama: 'Fajar Nugraha', ipk: 2.45, maksSks: 18 },
    { nim: '2112012002', nama: 'Siti Rahmawati', ipk: 3.90, maksSks: 24 },
    { nim: '2112012055', nama: 'Dimas Anggara', ipk: 3.10, maksSks: 22 }
  ];

  const result = bimbinganList.map(mhs => {
    const krs = db.prepare('SELECT * FROM krs_pengajuan WHERE nim = ? ORDER BY updated_at DESC LIMIT 1').get(mhs.nim);
    let items = [];
    let sksTotal = 0;
    if (krs) {
      items = db.prepare(`
        SELECT mk.kode, mk.nama, mk.kelas, mk.sks FROM krs_item ki
        JOIN mata_kuliah mk ON ki.matkul_id = mk.id
        WHERE ki.pengajuan_id = ?
      `).all(krs.id);
      sksTotal = items.reduce((s, mk) => s + mk.sks, 0);
    }

    return {
      nim: mhs.nim,
      nama: mhs.nama,
      ipk: mhs.ipk,
      maksSks: mhs.maksSks,
      sksDiajukan: sksTotal,
      status: krs ? krs.status : 'Belum Mengisi',
      catatanDpa: krs ? krs.catatan_dpa : '',
      matkul: items
    };
  });

  res.json(result);
});

// Persetujuan KRS Dosen
app.post('/api/dosen/krs-action', (req, res) => {
  const { nim, action, notes } = req.body;
  const status = action === 'APPROVE' ? 'Disetujui' : 'Ditolak';

  const update = db.prepare(`
    UPDATE krs_pengajuan
    SET status = ?, catatan_dpa = ?, updated_at = CURRENT_TIMESTAMP
    WHERE nim = ?
  `);
  update.run(status, notes || '', nim);

  res.json({ success: true, status });
});

// ==================== PRESENSI & TOKEN OTP ====================

app.get('/api/presensi/active', (req, res) => {
  const sesi = db.prepare('SELECT * FROM presensi_sesi WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1').get();
  res.json(sesi || { token: 'BST-8921', pertemuan: 9 });
});

app.post('/api/presensi/generate', (req, res) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = 'BST-';
  for (let i = 0; i < 4; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  db.prepare('UPDATE presensi_sesi SET is_active = 0').run();
  db.prepare(`
    INSERT INTO presensi_sesi (id, matkul_id, pertemuan, token, is_active)
    VALUES (?, 'mk-1', 9, ?, 1)
  `).run('sesi-' + crypto.randomUUID(), token);

  res.json({ success: true, token });
});

app.post('/api/presensi/submit', (req, res) => {
  const { nim, token } = req.body;
  if (!nim || !token) return res.status(400).json({ error: 'NIM dan Token wajib disertakan' });

  const activeSesi = db.prepare('SELECT * FROM presensi_sesi WHERE is_active = 1').get();
  if (!activeSesi || activeSesi.token !== token.toUpperCase().trim()) {
    return res.status(400).json({ error: 'Token presensi tidak valid atau masa berlaku sesi telah habis' });
  }

  const existing = db.prepare('SELECT * FROM presensi_kehadiran WHERE sesi_id = ? AND nim = ?').get(activeSesi.id, nim);
  if (existing) {
    return res.status(400).json({ error: 'Anda sudah melakukan presensi pada sesi perkuliahan ini.' });
  }

  db.prepare(`
    INSERT INTO presensi_kehadiran (id, sesi_id, nim, status)
    VALUES (?, ?, ?, 'Hadir')
  `).run('p-' + crypto.randomUUID(), activeSesi.id, nim);

  res.json({ success: true, message: 'Presensi perkuliahan berhasil tervalidasi & tercatat resmi.' });
});

// ==================== NILAI PERKULIAHAN ====================

app.get('/api/nilai/:kodeMk', (req, res) => {
  const list = db.prepare('SELECT * FROM nilai WHERE kode_mk = ?').all(req.params.kodeMk);
  res.json(list);
});

app.post('/api/nilai', (req, res) => {
  const { nim, kodeMk, tugas, uts, uas, presensi } = req.body;
  const numTugas = parseFloat(tugas) || 0;
  const numUts = parseFloat(uts) || 0;
  const numUas = parseFloat(uas) || 0;
  const numPresensi = parseFloat(presensi) || 0;

  const skor = (numTugas * 0.2) + (numUts * 0.3) + (numUas * 0.4) + (numPresensi * 0.1);

  let grade = 'E';
  let bobot = 0.0;
  if (skor >= 85) { grade = 'A'; bobot = 4.0; }
  else if (skor >= 75) { grade = 'AB'; bobot = 3.5; }
  else if (skor >= 65) { grade = 'B'; bobot = 3.0; }
  else if (skor >= 55) { grade = 'BC'; bobot = 2.5; }
  else if (skor >= 45) { grade = 'C'; bobot = 2.0; }
  else if (skor >= 35) { grade = 'D'; bobot = 1.0; }

  const upsert = db.prepare(`
    INSERT INTO nilai (id, nim, kode_mk, tugas, uts, uas, presensi, nilai_akhir, grade, bobot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(nim, kode_mk) DO UPDATE SET
      tugas = excluded.tugas,
      uts = excluded.uts,
      uas = excluded.uas,
      presensi = excluded.presensi,
      nilai_akhir = excluded.nilai_akhir,
      grade = excluded.grade,
      bobot = excluded.bobot
  `);

  upsert.run('n-' + crypto.randomUUID(), nim, kodeMk, numTugas, numUts, numUas, numPresensi, skor.toFixed(1), grade, bobot);
  res.json({ success: true, skor: skor.toFixed(1), grade, bobot });
});

// ==================== LOGBOOK SKRIPSI ====================

app.get('/api/logbook/:nim', (req, res) => {
  const logs = db.prepare('SELECT * FROM logbook_skripsi WHERE nim = ? ORDER BY created_at DESC').all(req.params.nim);
  res.json(logs);
});

app.post('/api/logbook', (req, res) => {
  const { nim, tanggal, bab, catatan } = req.body;
  if (!nim || !bab || !catatan) {
    return res.status(400).json({ error: 'Bab dan catatan bimbingan wajib diisi' });
  }

  const insert = db.prepare(`
    INSERT INTO logbook_skripsi (id, nim, tanggal, bab, catatan, status)
    VALUES (?, ?, ?, ?, ?, 'Menunggu Review')
  `);
  insert.run('log-' + crypto.randomUUID(), nim, tanggal || new Date().toISOString().split('T')[0], bab, catatan);
  res.json({ success: true });
});

// Serve Frontend SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server SIAKAD (SQLite Engine) berjalan di http://localhost:${PORT}`);
});
