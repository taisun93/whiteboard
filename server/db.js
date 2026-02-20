/**
 * PostgreSQL persistence for sessions and board state.
 * If DATABASE_URL is not set, falls back to in-memory (sessions only; board not persisted).
 */
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
const memorySessions = new Map();

async function init() {
  if (!DATABASE_URL) {
    console.warn('DATABASE_URL not set; using in-memory sessions and no board persistence.');
    return;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      google_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      strokes JSONB NOT NULL DEFAULT '[]',
      stickies JSONB NOT NULL DEFAULT '[]',
      text_elements JSONB NOT NULL DEFAULT '[]',
      connectors JSONB NOT NULL DEFAULT '[]',
      frames JSONB NOT NULL DEFAULT '[]',
      next_seq INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT single_row CHECK (id = 1)
    )
  `);
  await pool.query(`
    INSERT INTO board_state (id, next_seq) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('PostgreSQL connected.');
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  if (!pool) return memorySessions.get(sessionId) || null;
  const r = await pool.query(
    'SELECT google_id AS "googleId", email, name FROM sessions WHERE session_id = $1',
    [sessionId]
  );
  return r.rows[0] || null;
}

async function setSession(sessionId, data) {
  if (!pool) {
    memorySessions.set(sessionId, data);
    return;
  }
  await pool.query(
    `INSERT INTO sessions (session_id, google_id, email, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id) DO UPDATE SET google_id = $2, email = $3, name = $4`,
    [sessionId, data.googleId, data.email, data.name]
  );
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  if (!pool) {
    memorySessions.delete(sessionId);
    return;
  }
  await pool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
}

async function loadBoardState() {
  if (!pool) return null;
  const r = await pool.query(
    'SELECT strokes, stickies, text_elements AS "textElements", connectors, frames, next_seq AS "nextSeq" FROM board_state WHERE id = 1'
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    strokes: Array.isArray(row.strokes) ? row.strokes : [],
    stickies: Array.isArray(row.stickies) ? row.stickies : [],
    textElements: Array.isArray(row.textElements) ? row.textElements : [],
    connectors: Array.isArray(row.connectors) ? row.connectors : [],
    frames: Array.isArray(row.frames) ? row.frames : [],
    nextSeq: typeof row.nextSeq === 'number' ? row.nextSeq : 0
  };
}

async function saveBoardState(state) {
  if (!pool) return;
  const { strokes, stickies, textElements, connectors, frames, nextSeq } = state;
  await pool.query(
    `UPDATE board_state SET
       strokes = $1, stickies = $2, text_elements = $3, connectors = $4, frames = $5, next_seq = $6
     WHERE id = 1`,
    [
      JSON.stringify(strokes || []),
      JSON.stringify(stickies || []),
      JSON.stringify(textElements || []),
      JSON.stringify(connectors || []),
      JSON.stringify(frames || []),
      typeof nextSeq === 'number' ? nextSeq : 0
    ]
  );
}

module.exports = {
  init,
  getSession,
  setSession,
  deleteSession,
  loadBoardState,
  saveBoardState
};
