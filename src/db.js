const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'doubles.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      pin TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_member INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL CHECK(status IN ('signup','ready','teams','completed')) DEFAULT 'signup',
      ctp_hole TEXT,
      ace_result TEXT CHECK(ace_result IN ('yes','no')),
      ace_pot_before REAL NOT NULL DEFAULT 0,
      ace_pot_after REAL NOT NULL DEFAULT 0,
      ace_payout_total REAL NOT NULL DEFAULT 0,
      ctp_payout_total REAL NOT NULL DEFAULT 0,
      winner_payout_total REAL NOT NULL DEFAULT 0,
      greens_total REAL NOT NULL DEFAULT 0,
      payout_total REAL NOT NULL DEFAULT 0,
      ctp_total REAL NOT NULL DEFAULT 0,
      notes TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS round_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id),
      is_member INTEGER NOT NULL,
      greens_fee REAL NOT NULL DEFAULT 0,
      ctp_paid INTEGER NOT NULL DEFAULT 0,
      ace_paid INTEGER NOT NULL DEFAULT 0,
      payout_paid INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(round_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS round_teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      team_name TEXT NOT NULL,
      team_order INTEGER NOT NULL,
      is_cali INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS round_team_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES round_teams(id) ON DELETE CASCADE,
      round_player_id INTEGER NOT NULL REFERENCES round_players(id) ON DELETE CASCADE,
      UNIQUE(team_id, round_player_id)
    );

    CREATE TABLE IF NOT EXISTS round_aces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id)
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('ace','ctp','winner')),
      player_id INTEGER REFERENCES players(id),
      team_id INTEGER REFERENCES round_teams(id),
      amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertUser = db.prepare('INSERT OR IGNORE INTO users (username, pin, role) VALUES (?, ?, ?)');
  insertUser.run(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PIN || '1234', 'admin');
  insertUser.run(process.env.USER_USERNAME || 'user', process.env.USER_PIN || '1111', 'user');

  const seedSettings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  seedSettings.run('eligible_ctp_holes', JSON.stringify(['3', '7', '12', '17']));
  seedSettings.run('ace_pot', '0');
}

module.exports = { db, initDb, dbPath };
