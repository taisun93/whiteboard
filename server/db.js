/**
 * PostgreSQL persistence: users, whiteboards (many-to-many), sessions, and board state per whiteboard.
 * If DATABASE_URL is not set, falls back to in-memory sessions only (no board persistence, no multi-board).
 */
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
/** Resolved at init: actual column name for board id in board_state (whiteboard_id, board_id, or id). */
let boardStateIdColumn = null;
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

  try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      google_id TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whiteboards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL DEFAULT 'Untitled',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_whiteboards (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      whiteboard_id UUID NOT NULL REFERENCES whiteboards(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, whiteboard_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      google_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // board_state: ensure table and a single id column for the whiteboard UUID
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_state (
      whiteboard_id UUID PRIMARY KEY REFERENCES whiteboards(id) ON DELETE CASCADE,
      strokes JSONB NOT NULL DEFAULT '[]',
      stickies JSONB NOT NULL DEFAULT '[]',
      text_elements JSONB NOT NULL DEFAULT '[]',
      connectors JSONB NOT NULL DEFAULT '[]',
      frames JSONB NOT NULL DEFAULT '[]',
      next_seq INTEGER NOT NULL DEFAULT 0
    )
  `);
  try {
    await pool.query(
      `ALTER TABLE board_state RENAME COLUMN board_id TO whiteboard_id`
    );
  } catch (e) {
    if (e.code !== '42701' && e.code !== '42703') throw e;
  }
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = COALESCE(current_schema(), 'public') AND table_name = 'board_state'
     AND data_type = 'uuid'
     AND column_name IN ('whiteboard_id', 'board_id')
     ORDER BY CASE column_name WHEN 'whiteboard_id' THEN 1 WHEN 'board_id' THEN 2 ELSE 3 END
     LIMIT 1`
  );
  if (colRes.rows.length) {
    boardStateIdColumn = colRes.rows[0].column_name;
  } else {
    const uuidCol = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = COALESCE(current_schema(), 'public') AND table_name = 'board_state'
       AND data_type = 'uuid'
       ORDER BY ordinal_position LIMIT 1`
    );
    if (uuidCol.rows.length) {
      boardStateIdColumn = uuidCol.rows[0].column_name;
    } else {
      try {
        await pool.query(
          `ALTER TABLE board_state ADD COLUMN IF NOT EXISTS whiteboard_id UUID UNIQUE REFERENCES whiteboards(id) ON DELETE CASCADE`
        );
        boardStateIdColumn = 'whiteboard_id';
      } catch (e) {
        if (e.code !== '42701') throw e;
        boardStateIdColumn = 'whiteboard_id';
      }
    }
  }
  if (!boardStateIdColumn) boardStateIdColumn = 'whiteboard_id';
  console.log('PostgreSQL board_state id column:', boardStateIdColumn);

  try {
    await pool.query('ALTER TABLE sessions ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL');
  } catch (e) {
    if (e.code !== '42701') throw e;
  }
  } catch (err) {
    console.error('PostgreSQL schema setup failed:', err.message || err);
    pool = null;
    return;
  }

  console.log('PostgreSQL connected.');
}

async function getOrCreateUserByGoogleId(googleId, email, name) {
  if (!pool) return null;
  const r = await pool.query(
    `INSERT INTO users (google_id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_id) DO UPDATE SET email = $2, name = $3
     RETURNING id`,
    [googleId, email || '', name || 'User']
  );
  return r.rows[0] ? r.rows[0].id : null;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  if (!pool) return memorySessions.get(sessionId) || null;
  const r = await pool.query(
    'SELECT user_id AS "userId", google_id AS "googleId", email, name FROM sessions WHERE session_id = $1',
    [sessionId]
  );
  return r.rows[0] || null;
}

async function setSession(sessionId, data) {
  if (!pool) {
    memorySessions.set(sessionId, data);
    return;
  }
  const userId = data.userId ?? (data.googleId ? await getOrCreateUserByGoogleId(data.googleId, data.email, data.name) : null);
  await pool.query(
    `INSERT INTO sessions (session_id, user_id, google_id, email, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET user_id = $2, google_id = $3, email = $4, name = $5`,
    [sessionId, userId, data.googleId, data.email, data.name]
  );
}

async function updateSessionUserId(sessionId, userId) {
  if (!pool || !sessionId) return;
  await pool.query('UPDATE sessions SET user_id = $1 WHERE session_id = $2', [userId, sessionId]);
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  if (!pool) {
    memorySessions.delete(sessionId);
    return;
  }
  await pool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
}

async function listWhiteboardsForUser(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(
    `SELECT w.id, w.name, w.created_at AS "createdAt"
     FROM whiteboards w
     JOIN user_whiteboards uw ON uw.whiteboard_id = w.id
     WHERE uw.user_id = $1
     ORDER BY w.created_at DESC`,
    [userId]
  );
  return r.rows;
}

async function createWhiteboard(userId, name) {
  if (!pool || !userId) return null;
  const client = await pool.connect();
  try {
    const w = await client.query(
      `INSERT INTO whiteboards (name) VALUES ($1) RETURNING id, name, created_at AS "createdAt"`,
      [name || 'Untitled']
    );
    const board = w.rows[0];
    if (!board) return null;
    await client.query(
      'INSERT INTO user_whiteboards (user_id, whiteboard_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, board.id]
    );
    return board;
  } finally {
    client.release();
  }
}

/** Ensure a whiteboard row exists with this id (for shareable links). Creates with name 'Untitled' if missing. */
async function ensureWhiteboardExists(whiteboardId) {
  if (!pool || !whiteboardId) return false;
  await pool.query(
    `INSERT INTO whiteboards (id, name) VALUES ($1, 'Untitled') ON CONFLICT (id) DO NOTHING`,
    [whiteboardId]
  );
  return true;
}

async function isUserInWhiteboard(userId, whiteboardId) {
  if (!pool || !userId || !whiteboardId) return false;
  const r = await pool.query(
    'SELECT 1 FROM user_whiteboards WHERE user_id = $1 AND whiteboard_id = $2',
    [userId, whiteboardId]
  );
  return r.rowCount > 0;
}

async function addUserToWhiteboard(userId, whiteboardId) {
  if (!pool || !userId || !whiteboardId) return false;
  await pool.query(
    'INSERT INTO user_whiteboards (user_id, whiteboard_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, whiteboardId]
  );
  return true;
}

async function loadBoardState(whiteboardId) {
  if (!pool || !whiteboardId) return null;
  const col = boardStateIdColumn || 'whiteboard_id';
  const r = await pool.query(
    `SELECT strokes, stickies, text_elements AS "textElements", connectors, frames, next_seq AS "nextSeq"
     FROM board_state WHERE ${col} = $1`,
    [whiteboardId]
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

async function saveBoardState(whiteboardId, state) {
  if (!pool || !whiteboardId) return;
  const { strokes, stickies, textElements, connectors, frames, nextSeq } = state;
  const col = boardStateIdColumn || 'whiteboard_id';
  await pool.query(
    `INSERT INTO board_state (${col}, strokes, stickies, text_elements, connectors, frames, next_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (${col}) DO UPDATE SET
       strokes = $2, stickies = $3, text_elements = $4, connectors = $5, frames = $6, next_seq = $7`,
    [
      whiteboardId,
      JSON.stringify(strokes || []),
      JSON.stringify(stickies || []),
      JSON.stringify(textElements || []),
      JSON.stringify(connectors || []),
      JSON.stringify(frames || []),
      typeof nextSeq === 'number' ? nextSeq : 0
    ]
  );
}

function hasDatabase() {
  return !!pool;
}

module.exports = {
  init,
  hasDatabase,
  getSession,
  setSession,
  updateSessionUserId,
  deleteSession,
  getOrCreateUserByGoogleId,
  listWhiteboardsForUser,
  createWhiteboard,
  ensureWhiteboardExists,
  isUserInWhiteboard,
  addUserToWhiteboard,
  loadBoardState,
  saveBoardState
};
