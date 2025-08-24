// server/app.js — CitizenVote backend (Express + SQLite)
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Paths
const DB_PATH = path.resolve(__dirname, '..', 'database', 'votes.db');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// DB open
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('DB open error:', err.message); process.exit(1); }
  console.log('DB connected:', DB_PATH);
});

// Serve static frontend
app.use(express.static(PUBLIC_DIR));

/* =========================================
   DASHBOARD APIs
   ========================================= */

// Party toward threshold (pie)
app.get('/api/party-progress', (req, res) => {
  db.get(`SELECT threshold FROM party WHERE id=1`, [], (e, row) => {
    if (e) return res.status(500).json({ ok:false, msg:e.message });
    db.get(`SELECT COUNT(*) AS supporters FROM voters`, [], (e2, row2) => {
      if (e2) return res.status(500).json({ ok:false, msg:e2.message });
      res.json({ ok:true, threshold: row ? row.threshold : 0, supporters: row2.supporters });
    });
  });
});

// Candidate progress cards (uses vw_candidate_progress)
app.get('/api/candidates', (req, res) => {
  db.all(`SELECT * FROM vw_candidate_progress ORDER BY supporters DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ ok:false, msg:err.message });
    res.json({ ok:true, candidates: rows });
  });
});

// Party distribution by district (bar)
app.get('/api/party-districts', (req,res)=>{
  const sql = `
    SELECT d.id AS district_id, d.name AS district, d.official_voters,
           COUNT(v.id) AS supporters
    FROM districts d
    LEFT JOIN voters v ON v.district_id = d.id
    GROUP BY d.id
    ORDER BY supporters DESC, official_voters DESC`;
  db.all(sql, [], (e, rows) => {
    if (e) return res.status(500).json({ ok:false, msg:e.message });
    res.json({ ok:true, rows });
  });
});

// Party weekly growth (line)
app.get('/api/party-weekly', (req,res)=>{
  db.all(`SELECT yweek, supporters FROM vw_weekly_party ORDER BY yweek`, [], (e, rows) => {
    if (e) return res.status(500).json({ ok:false, msg:e.message });
    res.json({ ok:true, rows });
  });
});

/* =========================================
   CANDIDATE APIs
   ========================================= */

// Candidate full view: profile, assistants, district split, weekly, recent voters
app.get('/api/candidate/:id', (req, res) => {
  const id = +req.params.id;
  db.serialize(() => {
    db.get(`
      SELECT c.*, d.name AS district_name
      FROM candidates c
      LEFT JOIN districts d ON d.id = c.district_id
      WHERE c.id = ?`,
      [id], (e, cand) => {
        if (e || !cand) return res.status(404).json({ ok:false, msg: 'Candidate not found' });

        db.all(`SELECT * FROM assistants WHERE candidate_id = ? ORDER BY created_at DESC`, [id], (e2, assistants) => {
          if (e2) return res.status(500).json({ ok:false, msg: e2.message });

          db.all(`
            SELECT d.id AS district_id, d.name AS district, d.official_voters,
                   COUNT(v.id) AS supporters
            FROM districts d
            LEFT JOIN voters v ON v.district_id = d.id AND v.candidate_id = ?
            GROUP BY d.id
            ORDER BY supporters DESC`,
            [id], (e3, byDistrict) => {
              if (e3) return res.status(500).json({ ok:false, msg: e3.message });

              db.all(`SELECT yweek, supporters FROM vw_weekly_candidate WHERE candidate_id = ? ORDER BY yweek`, [id], (e4, weekly) => {
                if (e4) return res.status(500).json({ ok:false, msg: e4.message });

                db.all(`
                  SELECT full_name, dob, electoral_card, created_at
                  FROM voters
                  WHERE candidate_id = ?
                  ORDER BY created_at DESC
                  LIMIT 500`, [id], (e5, voters) => {
                    if (e5) return res.status(500).json({ ok:false, msg: e5.message });
                    res.json({ ok:true, candidate: cand, assistants, byDistrict, weekly, voters });
                });
              });
          });
        });
    });
  });
});

// Add assistant (returns a shareable link for that assistant)
app.post('/api/assistants', (req, res) => {
  const { candidate_id, name, phone, area_tags } = req.body;
  if (!candidate_id || !name) return res.status(400).json({ ok:false, msg:'candidate_id & name required' });

  db.run(
    `INSERT INTO assistants(candidate_id, name, phone, area_tags) VALUES (?,?,?,?)`,
    [candidate_id, name, phone || '', area_tags || ''],
    function (err) {
      if (err) return res.status(500).json({ ok:false, msg: err.message });
      const link = `${req.protocol}://${req.get('host')}/candidate.html?id=${candidate_id}&aid=${this.lastID}`;
      res.json({ ok:true, id: this.lastID, link });
    }
  );
});

// Add voter (accepts assistant_id OR aid param from assistant link)
// Duplicate protection on electoral_card; soft fuzzy check handled elsewhere
app.post('/api/voters', (req, res) => {
  let { candidate_id, assistant_id, full_name, dob, district_id, polling_center, electoral_card, aid } = req.body;
  if (!assistant_id && aid) assistant_id = +aid;
  if (!candidate_id || !full_name) return res.status(400).json({ ok:false, msg: 'candidate_id & full_name required' });

  const insert = () =>
    db.run(
      `INSERT INTO voters(candidate_id, assistant_id, full_name, dob, district_id, polling_center, electoral_card)
       VALUES (?,?,?,?,?,?,?)`,
      [candidate_id, assistant_id || null, full_name, dob || null, district_id || null, polling_center || null, electoral_card || null],
      function (err) {
        if (err) return res.status(500).json({ ok:false, msg: err.message });
        res.json({ ok:true, id: this.lastID });
      }
    );

  if (electoral_card) {
    db.get(`SELECT id FROM voters WHERE electoral_card = ?`, [electoral_card], (e, row) => {
      if (e) return res.status(500).json({ ok:false, msg: e.message });
      if (row) return res.json({ ok:true, duplicate: true, msg: 'Duplicate electoral card' });
      insert();
    });
  } else insert();
});

/* =========================================
   DEDUPE helper (review near-duplicates)
   ========================================= */

// Lists repeated (full_name + dob) across candidates to review
app.get('/api/fuzzy-duplicates', (req, res) => {
  const sql = `
    SELECT v1.full_name, v1.dob, COUNT(*) AS cnt, GROUP_CONCAT(v1.candidate_id) AS candidate_ids
    FROM voters v1
    WHERE v1.full_name <> '' AND v1.dob IS NOT NULL
    GROUP BY v1.full_name, v1.dob
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, full_name`;
  db.all(sql, [], (e, rows) => {
    if (e) return res.status(500).json({ ok:false, msg:e.message });
    res.json({ ok:true, rows });
  });
});

/* =========================================
   ADMIN CRUD APIs (no auth for now)
   ========================================= */

// PARTY (single row id=1)
app.get('/api/party', (req, res) => {
  db.get(`SELECT id, name, threshold, start_date, end_date FROM party WHERE id = 1`, [], (e, row) => {
    if (e) return res.status(500).json({ ok:false, msg:e.message });
    res.json({ ok:true, party: row || { id:1, name:'', threshold:0, start_date:null, end_date:null }});
  });
});

app.put('/api/party', (req, res) => {
  const { name, threshold, start_date, end_date } = req.body;
  db.run(
    `INSERT INTO party(id, name, threshold, start_date, end_date)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       threshold = excluded.threshold,
       start_date = excluded.start_date,
       end_date = excluded.end_date`,
    [name || '', +threshold || 0, start_date || null, end_date || null],
    function (err) {
      if (err) return res.status(500).json({ ok:false, msg: err.message });
      res.json({ ok:true });
    }
  );
});

// GOVERNORATES
app.get('/api/governorates', (req, res) => {
  db.all(`SELECT id, name FROM governorates ORDER BY id`, [], (e, rows) => {
    if (e) return res.status(500).json({ ok:false, msg:e.message });
    res.json({ ok:true, rows });
  });
});

app.post('/api/governorates', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok:false, msg:'name required' });
  db.run(`INSERT INTO governorates(name) VALUES (?)`, [name], function (err) {
    if (err) return res.status(500).json({ ok:false, msg: err.message });
    res.json({ ok:true, id: this.lastID });
  });
});

app.delete('/api/governorates/:id', (req, res) => {
  db.run(`DELETE FROM governorates WHERE id = ?`, [+req.params.id], function (err) {
    if (err) return res.status(500).json({ ok:false, msg: err.message });
    res.json({ ok:true, deleted: this.changes });
  });
});

// DISTRICTS
app.get('/api/districts', (req, res) => {
  db.all(`
    SELECT d.id, d.name, d.official_voters, g.name AS governorate_name, d.governorate_id
    FROM districts d
    LEFT JOIN governorates g ON g.id = d.governorate_id
    ORDER BY d.id`, [], (e, rows) => {
      if (e) return res.status(500).json({ ok:false, msg:e.message });
      res.json({ ok:true, rows });
  });
});

app.post('/api/districts', (req, res) => {
  const { governorate_id, name, official_voters } = req.body;
  if (!name) return res.status(400).json({ ok:false, msg:'name required' });
  db.run(
    `INSERT INTO districts(governorate_id, name, official_voters) VALUES (?,?,?)`,
    [governorate_id || null, name, +official_voters || 0],
    function (err) {
      if (err) return res.status(500).json({ ok:false, msg: err.message });
      res.json({ ok:true, id: this.lastID });
    }
  );
});

app.put('/api/districts/:id', (req, res) => {
  const { governorate_id, name, official_voters } = req.body;
  db.run(
    `UPDATE districts SET governorate_id = ?, name = ?, official_voters = ? WHERE id = ?`,
    [governorate_id || null, name, +official_voters || 0, +req.params.id],
    function (err) {
      if (err) return res.status(500).json({ ok:false, msg: err.message });
      res.json({ ok:true, updated: this.changes });
    }
  );
});

app.delete('/api/districts/:id', (req, res) => {
  db.run(`DELETE FROM districts WHERE id = ?`, [+req.params.id], function (err) {
    if (err) return res.status(500).json({ ok:false, msg: err.message });
    res.json({ ok:true, deleted: this.changes });
  });
});

// CANDIDATES
app.get('/api/candidates-admin', (req, res) => {
  db.all(`
    SELECT c.id, c.name, c.target, c.district_id, d.name AS district
    FROM candidates c
    LEFT JOIN districts d ON d.id = c.district_id
    ORDER BY c.id`, [], (e, rows) => {
      if (e) return res.status(500).json({ ok:false, msg:e.message });
      res.json({ ok:true, rows });
  });
});

app.post('/api/candidates', (req, res) => {
  const { name, district_id, target } = req.body;
  if (!name) return res.status(400).json({ ok:false, msg:'name required' });
  db.run(
    `INSERT INTO candidates(name, district_id, target) VALUES (?,?,?)`,
    [name, district_id || null, +target || 0],
    function (err) {
      if (err) return res.status(500).json({ ok:false, msg: err.message });
      res.json({ ok:true, id: this.lastID });
    }
  );
});

app.put('/api/candidates/:id', (req, res) => {
  const { name, district_id, target } = req.body;
  db.run(
    `UPDATE candidates SET name = ?, district_id = ?, target = ? WHERE id = ?`,
    [name, district_id || null, +target || 0, +req.params.id],
    function (err) {
      if (err) return res.status(500).json({ ok:false, msg: err.message });
      res.json({ ok:true, updated: this.changes });
    }
  );
});

app.delete('/api/candidates/:id', (req, res) => {
  db.run(`DELETE FROM candidates WHERE id = ?`, [+req.params.id], function (err) {
    if (err) return res.status(500).json({ ok:false, msg: err.message });
    res.json({ ok:true, deleted: this.changes });
  });
});

/* =========================================
   MISC
   ========================================= */
app.get('/api/health', (_, res) => res.json({ ok:true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));
