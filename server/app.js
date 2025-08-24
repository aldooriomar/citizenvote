/**
 * CitizenVote backend (Express + SQLite)
 * - Works locally and on free hosts with persistent volume (e.g., Railway)
 * - Uses DATA_DIR=/data if provided, otherwise falls back to /database/votes.db
 * - On first boot with DATA_DIR, seeds /data/votes.db from repo copy
 * - Secure cookies in production; same routes/UI as your local build
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

/* -------------------------- Config / constants --------------------------- */

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'cv_local_dev_secret_CHANGE_ME';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// Persistent storage settings
const DATA_DIR = process.env.DATA_DIR || null;
const DEFAULT_DB_FILE = path.resolve(__dirname, '..', 'database', 'votes.db'); // repo copy
const DB_FILE = process.env.DB_PATH || (DATA_DIR ? path.join(DATA_DIR, 'votes.db') : DEFAULT_DB_FILE);

// Ensure DATA_DIR exists if provided (e.g., Railway volume mount /data)
if (DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Seed: if target DB is missing but repo copy exists, copy once
if (!fs.existsSync(DB_FILE) && fs.existsSync(DEFAULT_DB_FILE)) {
  fs.copyFileSync(DEFAULT_DB_FILE, DB_FILE);
  console.log('Seeded database from repo copy →', DB_FILE);
}

/* ---------------------------- Express middlewares ------------------------ */

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

// If later you split UI (Netlify) and API (Railway), set CORS_ORIGIN to that origin.
const CORS_ORIGIN = process.env.CORS_ORIGIN || true;
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// Trust proxy so secure cookies work behind HTTPS on the host
app.set('trust proxy', 1);
function cookieOpts() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  };
}

// Gentle rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(['/api/auth/login', '/api/auth/change-password'], authLimiter);

/* ------------------------------ DB helpers ------------------------------- */

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('DB open error:', err.message);
    process.exit(1);
  }
  console.log('DB connected:', DB_FILE);
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // { lastID, changes }
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

/* ----------------------------- Schema bootstrap -------------------------- */

async function ensureSchema() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS party (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    threshold INTEGER NOT NULL DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS districts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    district_id INTEGER,
    target INTEGER DEFAULT 0,
    FOREIGN KEY(district_id) REFERENCES districts(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS assistants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    area_tags TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(candidate_id) REFERENCES candidates(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS voters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    assistant_id INTEGER,
    full_name TEXT NOT NULL,
    dob TEXT,
    district_id INTEGER,
    polling_center TEXT,
    electoral_card TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(candidate_id) REFERENCES candidates(id)
  )`);

  await run(`CREATE INDEX IF NOT EXISTS idx_voters_card ON voters(electoral_card)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_voters_name_dob ON voters(full_name, dob)`);

  // Seed party row (id=1)
  const pr = await get(`SELECT id FROM party WHERE id=1`);
  if (!pr) await run(`INSERT INTO party(id, threshold) VALUES (1, 20000)`);

  // Seed default admin
  const admin = await get(`SELECT id FROM users WHERE email=?`, ['admin@local']);
  if (!admin) {
    const hash = await bcrypt.hash('ChangeMe123', 10);
    await run(`INSERT INTO users(email, password_hash, role) VALUES (?,?,?)`,
      ['admin@local', hash, 'admin']);
    console.log('Auth bootstrap OK (admin@local / ChangeMe123)');
  }
}
ensureSchema().catch(e => { console.error('Schema error', e); process.exit(1); });

/* ------------------------------- Auth utils ------------------------------ */

function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function authRequired(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ ok: false, msg: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, msg: 'Unauthorized' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, msg: 'Forbidden' });
  next();
}

/* ---------------------------- Guard HTML routes -------------------------- */

function htmlGuard(file) {
  return (req, res) => {
    const token = req.cookies?.token;
    if (!token) return res.redirect('/login.html');
    try {
      jwt.verify(token, JWT_SECRET);
      res.sendFile(path.join(PUBLIC_DIR, file));
    } catch {
      res.redirect('/login.html');
    }
  };
}
app.get('/', htmlGuard('index.html'));
app.get('/index.html', htmlGuard('index.html'));
app.get('/admin.html', htmlGuard('admin.html'));
app.get('/candidate.html', htmlGuard('candidate.html'));

/* ------------------------------- Static files ---------------------------- */

app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  maxAge: '1h'
}));

/* -------------------------------- Auth API ------------------------------- */

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, msg: 'Email & password required' });
    const u = await get(`SELECT * FROM users WHERE email=?`, [String(email).trim()]);
    if (!u) return res.status(401).json({ ok: false, msg: 'Invalid credentials' });
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.status(401).json({ ok: false, msg: 'Invalid credentials' });
    const token = signToken(u);
    res.cookie('token', token, cookieOpts());
    res.json({ ok: true, email: u.email, role: u.role });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Login failed' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', { ...cookieOpts(), maxAge: 0 });
  res.json({ ok: true });
});

// Me
app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Change password
app.post('/api/auth/change-password', authRequired, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return res.status(400).json({ ok: false, msg: 'Both passwords required' });
    const u = await get(`SELECT * FROM users WHERE id=?`, [req.user.uid]);
    if (!u) return res.status(404).json({ ok: false, msg: 'User not found' });
    const ok = await bcrypt.compare(String(current_password), u.password_hash);
    if (!ok) return res.status(401).json({ ok: false, msg: 'Current password incorrect' });
    const hash = await bcrypt.hash(String(new_password), 10);
    await run(`UPDATE users SET password_hash=? WHERE id=?`, [hash, u.id]);
    res.clearCookie('token', { ...cookieOpts(), maxAge: 0 }); // force re-login
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: 'Change password failed' });
  }
});

/* ------------------------------ Party endpoints -------------------------- */

// Get party progress (threshold + supporters count)
app.get('/api/party-progress', async (req, res) => {
  try {
    const pr = await get(`SELECT threshold FROM party WHERE id=1`);
    const cnt = await get(`SELECT COUNT(*) AS supporters FROM voters`);
    res.json({ ok: true, threshold: pr ? pr.threshold : 0, supporters: cnt?.supporters || 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Save threshold (admin)
app.post('/api/party-progress', authRequired, adminOnly, async (req, res) => {
  try {
    const th = Math.max(0, parseInt(req.body?.threshold || 0, 10) || 0);
    await run(`UPDATE party SET threshold=? WHERE id=1`, [th]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

/* ------------------------------ Candidate APIs --------------------------- */

// Candidates progress list
app.get('/api/candidates', async (req, res) => {
  try {
    const rows = await all(`
      SELECT
        c.id, c.name, d.name AS district, c.target,
        COUNT(v.id) AS supporters,
        ROUND(CASE WHEN c.target>0 THEN (100.0*COUNT(v.id)/c.target) ELSE 0 END,1) AS pct
      FROM candidates c
      LEFT JOIN districts d ON d.id = c.district_id
      LEFT JOIN voters v ON v.candidate_id = c.id
      GROUP BY c.id
      ORDER BY supporters DESC, c.id ASC
    `);
    res.json({ ok: true, candidates: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Candidate details
app.get('/api/candidate/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const cand = await get(`
      SELECT c.*, d.name AS district_name
      FROM candidates c
      LEFT JOIN districts d ON d.id = c.district_id
      WHERE c.id = ?
    `, [id]);
    if (!cand) return res.status(404).json({ ok: false, msg: 'Candidate not found' });

    const assistants = await all(
      `SELECT * FROM assistants WHERE candidate_id=? ORDER BY created_at DESC`, [id]
    );
    const voters = await all(
      `SELECT id, full_name, dob, electoral_card, created_at
       FROM voters WHERE candidate_id=? ORDER BY created_at DESC LIMIT 300`, [id]
    );

    res.json({ ok: true, candidate: cand, assistants, voters });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Add assistant (admin)
app.post('/api/assistants', authRequired, adminOnly, async (req, res) => {
  try {
    const { candidate_id, name, phone, area_tags } = req.body || {};
    if (!candidate_id || !name) return res.status(400).json({ ok: false, msg: 'candidate_id & name required' });
    const r = await run(
      `INSERT INTO assistants(candidate_id, name, phone, area_tags) VALUES (?,?,?,?)`,
      [candidate_id, name, phone || '', area_tags || '']
    );
    res.json({ ok: true, id: r.lastID });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

/* ------------------------------- Voters APIs ----------------------------- */

// Create voter (kept behavior + dedupe on electoral_card)
app.post('/api/voters', authRequired, adminOnly, async (req, res) => {
  try {
    const {
      candidate_id, assistant_id, full_name, dob,
      district_id, polling_center, electoral_card
    } = req.body || {};
    if (!candidate_id || !full_name) return res.status(400).json({ ok: false, msg: 'candidate_id & full_name required' });

    if (electoral_card) {
      const dupe = await get(`SELECT id FROM voters WHERE electoral_card=?`, [electoral_card]);
      if (dupe) return res.json({ ok: true, duplicate: true, msg: 'Duplicate electoral card' });
    }

    const r = await run(`
      INSERT INTO voters(candidate_id, assistant_id, full_name, dob, district_id, polling_center, electoral_card)
      VALUES (?,?,?,?,?,?,?)`,
      [
        candidate_id,
        assistant_id || null,
        full_name,
        dob || null,
        district_id || null,
        polling_center || null,
        electoral_card || null
      ]
    );
    res.json({ ok: true, id: r.lastID });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Admin list/search voters
app.get('/api/admin/voters', authRequired, adminOnly, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(50, Math.max(5, parseInt(req.query.size || '20', 10)));
    const offset = (page - 1) * size;

    let where = '';
    const params = [];
    if (search) {
      where = `WHERE full_name LIKE ? OR IFNULL(electoral_card,'') LIKE ?`;
      params.push(`%${search}%`, `%${search}%`);
    }

    const items = await all(
      `SELECT id, full_name, electoral_card, candidate_id, district_id
       FROM voters ${where}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`, [...params, size, offset]
    );

    res.json({ ok: true, page, size, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Update voter
app.put('/api/voters/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const id = +req.params.id;
    const {
      candidate_id, assistant_id, full_name, dob,
      district_id, polling_center, electoral_card
    } = req.body || {};

    const fields = [];
    const vals = [];
    function set(col, val) {
      fields.push(`${col}=?`);
      vals.push(val);
    }
    if (candidate_id !== undefined) set('candidate_id', candidate_id || null);
    if (assistant_id !== undefined) set('assistant_id', assistant_id || null);
    if (full_name !== undefined) set('full_name', full_name || null);
    if (dob !== undefined) set('dob', dob || null);
    if (district_id !== undefined) set('district_id', district_id || null);
    if (polling_center !== undefined) set('polling_center', polling_center || null);
    if (electoral_card !== undefined) {
      if (electoral_card) {
        const dupe = await get(`SELECT id FROM voters WHERE electoral_card=? AND id<>?`,
          [electoral_card, id]);
        if (dupe) return res.status(400).json({ ok: false, msg: 'Electoral card already used' });
      }
      set('electoral_card', electoral_card || null);
    }

    if (!fields.length) return res.json({ ok: true, changes: 0 });

    const sql = `UPDATE voters SET ${fields.join(', ')} WHERE id=?`;
    const r = await run(sql, [...vals, id]);
    res.json({ ok: true, changes: r.changes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Delete voter
app.delete('/api/voters/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const id = +req.params.id;
    const r = await run(`DELETE FROM voters WHERE id=?`, [id]);
    res.json({ ok: true, changes: r.changes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

/* -------------------------------- Health -------------------------------- */

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ------------------------------ Error/Not found -------------------------- */

app.use('/api', (req, res) => res.status(404).json({ ok: false, msg: 'Not found' }));

/* --------------------------------- Start --------------------------------- */

app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
