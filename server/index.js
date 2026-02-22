const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const db = require('./db');
const redis = require('./redis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || '';

/** Base URL for redirects: env BASE_URL, or derived from request (supports proxies via X-Forwarded-*). Normalized so it matches Google Console redirect URIs (no default ports). */
function getRedirectBase(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, '');
  let proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim().toLowerCase();
  let host = (req.get('x-forwarded-host') || req.get('host') || 'localhost:3000').split(',')[0].trim();
  if (host.endsWith(':80') && proto === 'http') host = host.slice(0, -3);
  if (host.endsWith(':443') && proto === 'https') host = host.slice(0, -4);
  return `${proto}://${host}`.replace(/\/$/, '');
}

function getRedirectUri(req) {
  const base = getRedirectBase(req);
  return base + '/api/auth/google/callback';
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((s) => {
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return out;
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (ch) => (buf += ch));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
      },
      (res) => {
        let buf = '';
        res.on('data', (ch) => (buf += ch));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({
      error: 'Google auth not configured',
      hint: 'Create a .env file in the project root (see .env.example) and set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from Google Cloud Console → APIs & Services → Credentials.'
    });
  }
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('auth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const redirectUri = getRedirectUri(req);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state
  });
  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', (req, res) => {
  const { code, state } = req.query || {};
  const cookies = parseCookie(req.headers.cookie);
  if (!code || state !== cookies.auth_state) {
    res.clearCookie('auth_state');
    return res.redirect(302, '/?error=invalid_callback');
  }
  res.clearCookie('auth_state');
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect(302, '/?error=config');
  }
  const redirectUri = getRedirectUri(req);
  const tokenBody = {
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  };
  httpsPost('https://oauth2.googleapis.com/token', tokenBody)
    .then((tokenRes) => {
      if (!tokenRes.access_token) {
        return res.redirect(302, '/?error=token');
      }
      return httpsGet('https://www.googleapis.com/oauth2/v2/userinfo', tokenRes.access_token).then(
        async (userInfo) => {
          const googleId = userInfo.id;
          const email = userInfo.email || '';
          const name = userInfo.name || userInfo.email || 'User';
          const sessionId = crypto.randomBytes(16).toString('hex');
          await db.setSession(sessionId, { googleId, email, name });
          res.cookie('session', sessionId, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
          });
          res.redirect(302, '/');
        }
      );
    })
    .catch(() => res.redirect(302, '/?error=auth_failed'));
});

app.get('/api/me', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  const sessionId = cookies.session;
  const session = sessionId ? await db.getSession(sessionId) : null;
  if (!session) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json({
    user: {
      username: session.name,
      email: session.email,
      googleId: session.googleId
    },
    multiBoard: db.hasDatabase()
  });
});

app.post('/api/logout', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  if (cookies.session) {
    await invalidateSessionCache(cookies.session);
    await db.deleteSession(cookies.session);
  }
  res.clearCookie('session');
  res.json({ ok: true });
});

const SESSION_CACHE_TTL_MS = 60000;
const sessionCache = new Map();
const SESSION_KEY_PREFIX = 'session:';

async function getSessionCached(sessionId) {
  if (!sessionId) return null;
  if (redis.isAvailable()) {
    const cached = await redis.get(SESSION_KEY_PREFIX + sessionId);
    if (cached) return cached;
  } else {
    const entry = sessionCache.get(sessionId);
    if (entry && entry.expires > Date.now()) return entry.session;
  }
  const session = await db.getSession(sessionId);
  if (session) {
    if (redis.isAvailable()) {
      await redis.set(SESSION_KEY_PREFIX + sessionId, session, SESSION_CACHE_TTL_MS);
    } else {
      sessionCache.set(sessionId, { session, expires: Date.now() + SESSION_CACHE_TTL_MS });
    }
  }
  return session;
}

async function invalidateSessionCache(sessionId) {
  if (!sessionId) return;
  if (redis.isAvailable()) await redis.del(SESSION_KEY_PREFIX + sessionId);
  else sessionCache.delete(sessionId);
}

async function ensureSessionUserId(sessionId, session) {
  if (!session || session.userId) return session;
  if (!session.googleId || !db.hasDatabase()) return session;
  const userId = await db.getOrCreateUserByGoogleId(session.googleId, session.email, session.name);
  if (userId) {
    await db.updateSessionUserId(sessionId, userId);
    session.userId = userId;
  }
  return session;
}

app.get('/api/whiteboards', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  const sessionId = cookies.session;
  let session = sessionId ? await db.getSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  session = await ensureSessionUserId(sessionId, session);
  if (!session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const list = await db.listWhiteboardsForUser(session.userId);
    res.json({ whiteboards: list });
  } catch (err) {
    console.error('list whiteboards:', err);
    res.status(500).json({ error: 'Failed to list whiteboards' });
  }
});

app.post('/api/whiteboards', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  const sessionId = cookies.session;
  let session = sessionId ? await db.getSession(sessionId) : null;
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  session = await ensureSessionUserId(sessionId, session);
  if (!session.userId) return res.status(401).json({ error: 'Not logged in' });
  const name = (req.body && req.body.name) ? String(req.body.name).trim() || 'Untitled' : 'Untitled';
  try {
    const board = await db.createWhiteboard(session.userId, name);
    if (!board) return res.status(500).json({ error: 'Failed to create whiteboard' });
    res.status(201).json(board);
  } catch (err) {
    console.error('create whiteboard:', err);
    res.status(500).json({ error: 'Failed to create whiteboard' });
  }
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Server-authoritative: per-board state when DB; single default state when no DB
const STICKY_DEFAULT_W = 200;
const STICKY_DEFAULT_H = 150;
const TEXT_DEFAULT_W = 140;
const TEXT_DEFAULT_H = 28;
const FRAME_DEFAULT_W = 300;
const FRAME_DEFAULT_H = 200;

function emptyBoardState() {
  return {
    strokes: [],
    stickies: [],
    textElements: [],
    connectors: [],
    frames: [],
    nextSeq: 0
  };
}

const defaultState = emptyBoardState();
const boardStates = new Map();
const cursorsByBoard = new Map();
/** Board IDs that have in-memory changes not yet written to Postgres. Flushed periodically. */
const dirtyBoards = new Set();

function getBoardState(boardId) {
  if (boardId && boardStates.has(boardId)) return boardStates.get(boardId);
  return defaultState;
}

/** Sync: returns in-memory state (empty if first time). Kicks off background load from DB; when done, updates memory and broadcasts STATE so all clients on that board get it. */
function ensureBoardState(boardId) {
  if (!boardId) return defaultState;
  if (boardStates.has(boardId)) return boardStates.get(boardId);
  const state = emptyBoardState();
  boardStates.set(boardId, state);
  if (db.hasDatabase()) {
    setImmediate(() => {
      db.loadBoardState(boardId)
        .then((loaded) => {
          if (!loaded || dirtyBoards.has(boardId)) return;
          const s = boardStates.get(boardId);
          if (!s || s !== state) return;
          s.strokes.length = 0;
          (loaded.strokes || []).forEach((x) => s.strokes.push(x));
          s.stickies.length = 0;
          (loaded.stickies || []).forEach((x) => s.stickies.push(x));
          s.textElements.length = 0;
          (loaded.textElements || []).forEach((x) => s.textElements.push(x));
          s.connectors.length = 0;
          (loaded.connectors || []).forEach((x) => s.connectors.push(x));
          s.frames.length = 0;
          (loaded.frames || []).forEach((x) => s.frames.push(x));
          s.nextSeq = loaded.nextSeq != null ? loaded.nextSeq : 0;
          broadcastToBoard(boardId, {
            type: 'STATE',
            strokes: s.strokes,
            stickies: s.stickies,
            textElements: s.textElements,
            connectors: s.connectors,
            frames: s.frames
          });
          broadcastToBoard(boardId, { type: 'SEQ', nextSeq: s.nextSeq });
        })
        .catch((err) => console.error('Background load board state:', err.message || err));
    });
  }
  return state;
}

function broadcastToBoard(boardId, payload) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const onBoard = (c) => (!db.hasDatabase() || c.boardId === boardId) && c.readyState === 1;
  wss.clients.forEach((c) => { if (onBoard(c)) c.send(s); });
}

function broadcastUsers(boardId) {
  const onBoard = (c) => (!db.hasDatabase() || c.boardId === boardId) && c.readyState === 1;
  const userList = Array.from(wss.clients)
    .filter(onBoard)
    .map((c) => ({ clientId: c.clientId, username: c.username || 'anonymous' }))
    .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  const payload = JSON.stringify({ type: 'USERS', users: userList });
  wss.clients.forEach((c) => { if (onBoard(c)) c.send(payload); });
}

/** Mark board as dirty; actual save to Postgres happens in the periodic flush (keeps WebSocket path off the DB). */
function persistBoard(boardId) {
  if (!boardId || !db.hasDatabase()) return;
  dirtyBoards.add(boardId);
}

/** World bounds of all board content for fit-view. Returns { minX, minY, maxX, maxY } or null if empty. */
function getBoardWorldBounds(state) {
  if (!state) return null;
  const { stickies: st, textElements: te, frames: fr, strokes: sr } = state;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expand = (x, y) => {
    if (Number.isFinite(x)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  };
  (st || []).forEach((s) => {
    expand(s.x, s.y);
    expand(s.x + (s.width || STICKY_DEFAULT_W), s.y + (s.height || STICKY_DEFAULT_H));
  });
  (te || []).forEach((t) => {
    expand(t.x, t.y);
    expand(t.x + (t.width || TEXT_DEFAULT_W), t.y + (t.height || TEXT_DEFAULT_H));
  });
  (fr || []).forEach((f) => {
    expand(f.x, f.y);
    expand(f.x + (f.width || FRAME_DEFAULT_W), f.y + (f.height || FRAME_DEFAULT_H));
  });
  (sr || []).forEach((s) => {
    if (s.points && s.points.length) s.points.forEach((p) => expand(p.x, p.y));
  });
  if (minX === Infinity || minY === Infinity) return null;
  const pad = 0.15;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  return {
    minX: minX - w * pad,
    minY: minY - h * pad,
    maxX: maxX + w * pad,
    maxY: maxY + h * pad
  };
}

const wss = new WebSocketServer({ server });

// Keep connections alive and detect dead clients (e.g. prevents proxy idle timeouts on Render)
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_MISSES_BEFORE_CLOSE = 2;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPongs = (ws.missedPongs || 0) + 1;
      if (ws.missedPongs >= HEARTBEAT_MISSES_BEFORE_CLOSE) return ws.terminate();
    } else {
      ws.missedPongs = 0;
    }
    ws.isAlive = false;
    ws.ping();
  });
  // Flush dirty boards to Postgres (keeps WebSocket path off DB)
  if (db.hasDatabase() && dirtyBoards.size > 0) {
    const toFlush = Array.from(dirtyBoards);
    dirtyBoards.clear();
    toFlush.forEach((boardId) => {
      const state = getBoardState(boardId);
      db.saveBoardState(boardId, state).catch((err) => {
        console.error('persist board:', err.message || err);
        dirtyBoards.add(boardId);
      });
    });
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on('close', () => clearInterval(heartbeatInterval));

let nextClientId = 0;

function parseBoardIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const i = url.indexOf('?');
  if (i === -1) return null;
  const params = new URLSearchParams(url.slice(i));
  return params.get('board_id') || null;
}

wss.on('connection', async (ws, req) => {
  // Mark alive immediately so heartbeat doesn't kill the connection while we do DB work (getSession, ensureBoardState, etc.)
  ws.isAlive = true;
  ws.missedPongs = 0;
  ws.on('error', (err) => console.error('WebSocket error:', err.message || err));
  ws.on('pong', () => { ws.isAlive = true; ws.missedPongs = 0; });

  try {
  const cookies = parseCookie(req.headers.cookie);
  const sessionId = cookies.session;
  let session = sessionId ? await getSessionCached(sessionId) : null;
  session = session ? await ensureSessionUserId(sessionId, session) : null;
  ws.username = session ? session.name : 'anonymous';

  let boardId = parseBoardIdFromUrl(req.url);
  if (db.hasDatabase()) {
    if (!boardId) {
      ws.close(4000, 'board_id required');
      return;
    }
    if (!session || !session.userId) {
      ws.close(4001, 'auth required');
      return;
    }
    const allowed = await db.isUserInWhiteboard(session.userId, boardId);
    if (!allowed) {
      ws.close(4003, 'not in whiteboard');
      return;
    }
  } else {
    boardId = 'default';
  }
  ws.boardId = boardId;

  ensureBoardState(boardId);

  const clientId = `u${nextClientId++}`;
  ws.clientId = clientId;

  if (!cursorsByBoard.has(boardId)) cursorsByBoard.set(boardId, new Map());

  ws.send(JSON.stringify({ type: 'ME', clientId, username: ws.username }));
  const state = getBoardState(boardId);
  ws.send(JSON.stringify({ type: 'STATE', strokes: state.strokes, stickies: state.stickies, textElements: state.textElements, connectors: state.connectors, frames: state.frames }));
  ws.send(JSON.stringify({ type: 'SEQ', nextSeq: state.nextSeq }));
  const cursors = cursorsByBoard.get(boardId);
  const cursorList = Array.from(cursors.entries()).map(([id, pos]) => ({ clientId: id, ...pos }));
  ws.send(JSON.stringify({ type: 'CURSORS', cursors: cursorList }));

  broadcastUsers(boardId);

  } catch (err) {
    console.error('WebSocket connection setup error:', err.message || err);
    try { ws.close(1011, 'Server error during setup'); } catch (_) {}
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'PING') {
      ws.isAlive = true;
      ws.missedPongs = 0;
      return;
    }
    try {
      const state = getBoardState(ws.boardId);
      const cursors = cursorsByBoard.get(ws.boardId) || new Map();

    if (msg.type === 'ADD_STROKE') {
      if (!Array.isArray(msg.points) || !msg.strokeId) return;
      const seq = state.nextSeq++;
      const color = typeof msg.color === 'string' ? msg.color : '#e2e8f0';
      const shape = ['rect', 'circle', 'diamond', 'roundedRect'].includes(msg.shape) ? msg.shape : undefined;
      const stroke = { seq, strokeId: msg.strokeId, points: msg.points, color };
      if (shape) stroke.shape = shape;
      state.strokes.push(stroke);
      persistBoard(ws.boardId);
      broadcastToBoard(ws.boardId, { type: 'STROKE_ADDED', stroke });
      return;
    }
    if (msg.type === 'DELETE_STROKES' && Array.isArray(msg.strokeIds)) {
      const ids = new Set(msg.strokeIds);
      const removed = [];
      for (let i = state.strokes.length - 1; i >= 0; i--) {
        if (ids.has(state.strokes[i].strokeId)) {
          removed.push(state.strokes[i].strokeId);
          state.strokes.splice(i, 1);
        }
      }
      if (removed.length > 0) {
        const removedSet = new Set(removed);
        const connToRemoveIds = state.connectors.filter((c) => (c.from.type === 'stroke' && removedSet.has(c.from.strokeId)) || (c.to.type === 'stroke' && removedSet.has(c.to.strokeId))).map((c) => c.id);
        for (let k = state.connectors.length - 1; k >= 0; k--) {
          if (connToRemoveIds.includes(state.connectors[k].id)) state.connectors.splice(k, 1);
        }
        connToRemoveIds.forEach((id) => broadcastToBoard(ws.boardId, { type: 'CONNECTOR_REMOVED', id }));
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STROKES_REMOVED', strokeIds: removed });
      }
      return;
    }
    if (msg.type === 'CURSOR_MOVE' && typeof msg.x === 'number' && typeof msg.y === 'number') {
      cursors.set(clientId, { x: msg.x, y: msg.y });
      broadcastToBoard(ws.boardId, { type: 'CURSOR_MOVE', clientId, x: msg.x, y: msg.y });
      return;
    }
    if (msg.type === 'CURSOR_LEFT') {
      cursors.delete(clientId);
      broadcastToBoard(ws.boardId, { type: 'CURSOR_LEFT', clientId });
      return;
    }
    if (msg.type === 'ADD_STICKY' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const sticky = {
        id: msg.id,
        x: msg.x,
        y: msg.y,
        width: typeof msg.width === 'number' ? msg.width : STICKY_DEFAULT_W,
        height: typeof msg.height === 'number' ? msg.height : STICKY_DEFAULT_H,
        text: typeof msg.text === 'string' ? msg.text : '',
        color: typeof msg.color === 'string' ? msg.color : '#fef9c3'
      };
      state.stickies.push(sticky);
      persistBoard(ws.boardId);
      broadcastToBoard(ws.boardId, { type: 'STICKY_ADDED', sticky });
      return;
    }
    if (msg.type === 'UPDATE_STICKY' && msg.id) {
      const s = state.stickies.find((s) => s.id === msg.id);
      if (s) {
        const updates = {};
        if (typeof msg.text === 'string') {
          s.text = msg.text;
          updates.text = msg.text;
        }
        if (typeof msg.color === 'string') {
          s.color = msg.color;
          updates.color = msg.color;
        }
        if (typeof msg.width === 'number' && msg.width >= 40) {
          s.width = msg.width;
          updates.width = msg.width;
        }
        if (typeof msg.height === 'number' && msg.height >= 30) {
          s.height = msg.height;
          updates.height = msg.height;
        }
        if (typeof msg.rotation === 'number') {
          s.rotation = msg.rotation;
          updates.rotation = msg.rotation;
        }
        if (Object.keys(updates).length > 0) {
          persistBoard(ws.boardId);
          broadcastToBoard(ws.boardId, { type: 'STICKY_UPDATED', id: msg.id, ...updates });
        }
      }
      return;
    }
    if (msg.type === 'DELETE_STICKY' && msg.id) {
      const i = state.stickies.findIndex((s) => s.id === msg.id);
      if (i >= 0) {
        state.stickies.splice(i, 1);
        const toRemoveIds = state.connectors.filter((c) => (c.from.type === 'sticky' && c.from.id === msg.id) || (c.to.type === 'sticky' && c.to.id === msg.id)).map((c) => c.id);
        for (let k = state.connectors.length - 1; k >= 0; k--) {
          if (toRemoveIds.includes(state.connectors[k].id)) state.connectors.splice(k, 1);
        }
        toRemoveIds.forEach((id) => broadcastToBoard(ws.boardId, { type: 'CONNECTOR_REMOVED', id }));
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STICKY_REMOVED', id: msg.id });
      }
      return;
    }
    if (msg.type === 'ADD_CONNECTOR' && msg.id && msg.from && msg.to) {
      const norm = (r) => {
        if (r.type === 'sticky' && r.id) return { type: 'sticky', id: r.id };
        if (r.type === 'text' && r.id) return { type: 'text', id: r.id };
        if (r.type === 'point' && typeof r.x === 'number' && typeof r.y === 'number') return { type: 'point', x: r.x, y: r.y };
        if (r.type === 'stroke' && r.strokeId) return { type: 'stroke', strokeId: r.strokeId };
        return null;
      };
      const from = norm(msg.from);
      const to = norm(msg.to);
      if (!from || !to) return;
      const connector = { id: msg.id, from, to, color: typeof msg.color === 'string' ? msg.color : '#94a3b8' };
      state.connectors.push(connector);
      persistBoard(ws.boardId);
      broadcastToBoard(ws.boardId, { type: 'CONNECTOR_ADDED', connector });
      return;
    }
    if (msg.type === 'UPDATE_CONNECTOR' && msg.id && typeof msg.color === 'string') {
      const c = state.connectors.find((x) => x.id === msg.id);
      if (c) {
        c.color = msg.color;
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'CONNECTOR_UPDATED', id: msg.id, color: msg.color });
      }
      return;
    }
    if (msg.type === 'DELETE_CONNECTOR' && msg.id) {
      const i = state.connectors.findIndex((c) => c.id === msg.id);
      if (i >= 0) {
        state.connectors.splice(i, 1);
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'CONNECTOR_REMOVED', id: msg.id });
      }
      return;
    }
    if (msg.type === 'ADD_TEXT_ELEMENT' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const el = {
        id: msg.id,
        x: msg.x,
        y: msg.y,
        text: typeof msg.text === 'string' ? msg.text : '',
        color: typeof msg.color === 'string' ? msg.color : '#e2e8f0',
        width: typeof msg.width === 'number' ? msg.width : TEXT_DEFAULT_W,
        height: typeof msg.height === 'number' ? msg.height : TEXT_DEFAULT_H
      };
      state.textElements.push(el);
      persistBoard(ws.boardId);
      broadcastToBoard(ws.boardId, { type: 'TEXT_ADDED', textElement: el });
      return;
    }
    if (msg.type === 'UPDATE_TEXT_ELEMENT' && msg.id) {
      const el = state.textElements.find((e) => e.id === msg.id);
      if (el) {
        const updates = {};
        if (typeof msg.text === 'string') { el.text = msg.text; updates.text = msg.text; }
        if (typeof msg.color === 'string') { el.color = msg.color; updates.color = msg.color; }
        if (typeof msg.width === 'number' && msg.width >= 40) { el.width = msg.width; updates.width = msg.width; }
        if (typeof msg.height === 'number' && msg.height >= 20) { el.height = msg.height; updates.height = msg.height; }
        if (typeof msg.rotation === 'number') { el.rotation = msg.rotation; updates.rotation = msg.rotation; }
        if (Object.keys(updates).length > 0) {
          persistBoard(ws.boardId);
          broadcastToBoard(ws.boardId, { type: 'TEXT_UPDATED', id: msg.id, ...updates });
        }
      }
      return;
    }
    if (msg.type === 'DELETE_TEXT_ELEMENT' && msg.id) {
      const i = state.textElements.findIndex((e) => e.id === msg.id);
      if (i >= 0) {
        state.textElements.splice(i, 1);
        const toRemoveIds = state.connectors.filter((c) => (c.from.type === 'text' && c.from.id === msg.id) || (c.to.type === 'text' && c.to.id === msg.id)).map((c) => c.id);
        for (let k = state.connectors.length - 1; k >= 0; k--) {
          if (toRemoveIds.includes(state.connectors[k].id)) state.connectors.splice(k, 1);
        }
        toRemoveIds.forEach((id) => broadcastToBoard(ws.boardId, { type: 'CONNECTOR_REMOVED', id }));
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'TEXT_REMOVED', id: msg.id });
      }
      return;
    }
    if (msg.type === 'UPDATE_TEXT_POSITION' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const el = state.textElements.find((e) => e.id === msg.id);
      if (el) {
        el.x = msg.x;
        el.y = msg.y;
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'TEXT_MOVED', id: msg.id, x: msg.x, y: msg.y });
      }
      return;
    }
    if (msg.type === 'ADD_FRAME' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const frame = {
        id: msg.id,
        x: msg.x,
        y: msg.y,
        width: typeof msg.width === 'number' ? msg.width : FRAME_DEFAULT_W,
        height: typeof msg.height === 'number' ? msg.height : FRAME_DEFAULT_H,
        title: typeof msg.title === 'string' ? msg.title : ''
      };
      state.frames.push(frame);
      persistBoard(ws.boardId);
      broadcastToBoard(ws.boardId, { type: 'FRAME_ADDED', frame });
      return;
    }
    if (msg.type === 'UPDATE_FRAME' && msg.id) {
      const f = state.frames.find((x) => x.id === msg.id);
      if (f) {
        const updates = {};
        if (typeof msg.x === 'number') { f.x = msg.x; updates.x = msg.x; }
        if (typeof msg.y === 'number') { f.y = msg.y; updates.y = msg.y; }
        if (typeof msg.width === 'number' && msg.width >= 60) { f.width = msg.width; updates.width = msg.width; }
        if (typeof msg.height === 'number' && msg.height >= 40) { f.height = msg.height; updates.height = msg.height; }
        if (typeof msg.title === 'string') { f.title = msg.title; updates.title = msg.title; }
        if (typeof msg.rotation === 'number') { f.rotation = msg.rotation; updates.rotation = msg.rotation; }
        if (Object.keys(updates).length > 0) {
          persistBoard(ws.boardId);
          broadcastToBoard(ws.boardId, { type: 'FRAME_UPDATED', id: msg.id, ...updates });
        }
      }
      return;
    }
    if (msg.type === 'DELETE_FRAME' && msg.id) {
      const i = state.frames.findIndex((f) => f.id === msg.id);
      if (i >= 0) {
        state.frames.splice(i, 1);
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'FRAME_REMOVED', id: msg.id });
      }
      return;
    }
    if (msg.type === 'UPDATE_STICKY_POSITION' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const s = state.stickies.find((s) => s.id === msg.id);
      if (s) {
        s.x = msg.x;
        s.y = msg.y;
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STICKY_MOVED', id: msg.id, x: msg.x, y: msg.y });
      }
      return;
    }
    if (msg.type === 'MOVE_STROKE' && msg.strokeId && typeof msg.dx === 'number' && typeof msg.dy === 'number') {
      const s = state.strokes.find((s) => s.strokeId === msg.strokeId);
      if (s && s.points) {
        s.points.forEach((p) => {
          p.x += msg.dx;
          p.y += msg.dy;
        });
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STROKE_MOVED', strokeId: msg.strokeId, dx: msg.dx, dy: msg.dy });
      }
      return;
    }
    if (msg.type === 'SET_STROKE_COLOR' && msg.strokeId && typeof msg.color === 'string') {
      const s = state.strokes.find((s) => s.strokeId === msg.strokeId);
      if (s) {
        s.color = msg.color;
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STROKE_COLOR_CHANGED', strokeId: msg.strokeId, color: msg.color });
      }
      return;
    }
    if (msg.type === 'UPDATE_STROKE_POINTS' && msg.strokeId && Array.isArray(msg.points)) {
      const s = state.strokes.find((s) => s.strokeId === msg.strokeId);
      if (s && msg.points.every((p) => typeof p.x === 'number' && typeof p.y === 'number')) {
        s.points = msg.points.map((p) => ({ x: p.x, y: p.y }));
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STROKE_POINTS_UPDATED', strokeId: msg.strokeId, points: s.points });
      }
      return;
    }
    if (msg.type === 'SET_STROKE_ROTATION' && msg.strokeId && typeof msg.rotation === 'number') {
      const s = state.strokes.find((st) => st.strokeId === msg.strokeId);
      if (s) {
        s.rotation = msg.rotation;
        persistBoard(ws.boardId);
        broadcastToBoard(ws.boardId, { type: 'STROKE_ROTATION_CHANGED', strokeId: msg.strokeId, rotation: msg.rotation });
      }
      return;
    }
    } catch (err) {
      console.error('WebSocket message error:', err.message || err);
    }
  });

  ws.on('close', () => {
    const cursors = cursorsByBoard.get(ws.boardId);
    if (cursors) cursors.delete(clientId);
    broadcastToBoard(ws.boardId, { type: 'CURSOR_LEFT', clientId });
    broadcastUsers(ws.boardId);
  });
});

// --- AI command route (LangChain + OpenAI 4o) ---
function executeTool(name, args, state, boardId) {
  if (!state) return;
  const id = () => crypto.randomUUID();
  const parsePoint = (s) => {
    if (typeof s !== 'string') return null;
    const [x, y] = s.split(',').map((n) => parseFloat(n.trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) return { type: 'point', x, y };
    return null;
  };
  const refFromId = (sid) => {
    if (state.stickies.some((s) => s.id === sid)) return { type: 'sticky', id: sid };
    if (state.textElements.some((t) => t.id === sid)) return { type: 'text', id: sid };
    if (state.strokes.some((s) => s.strokeId === sid)) return { type: 'stroke', strokeId: sid };
    const pt = parsePoint(sid);
    if (pt) return pt;
    return null;
  };

  switch (name) {
    case 'createStickyNote': {
      const { text = '', x, y, color = '#fef9c3' } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const sid = id();
      const sticky = { id: sid, x, y, width: STICKY_DEFAULT_W, height: STICKY_DEFAULT_H, text, color };
      state.stickies.push(sticky);
      persistBoard(boardId);
      broadcastToBoard(boardId, { type: 'STICKY_ADDED', sticky });
      break;
    }
    case 'createShape': {
      const { type = 'rect', x, y, width = 100, height = 80, color = '#e2e8f0' } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const allowed = ['rect', 'circle', 'diamond', 'roundedRect'];
      const shape = allowed.includes(type) ? type : 'rect';
      const strokeId = id();
      const points = [{ x, y }, { x: x + width, y: y + height }];
      const seq = state.nextSeq++;
      const stroke = { seq, strokeId, points, color, shape };
      state.strokes.push(stroke);
      persistBoard(boardId);
      broadcastToBoard(boardId, { type: 'STROKE_ADDED', stroke });
      break;
    }
    case 'createFrame': {
      const { title = '', x, y, width = FRAME_DEFAULT_W, height = FRAME_DEFAULT_H } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const fid = id();
      const frame = { id: fid, x, y, width, height, title };
      state.frames.push(frame);
      persistBoard(boardId);
      broadcastToBoard(boardId, { type: 'FRAME_ADDED', frame });
      break;
    }
    case 'createQuadrantTemplate': {
      const w = typeof args.width === 'number' && args.width >= 60 ? args.width : 280;
      const h = typeof args.height === 'number' && args.height >= 40 ? args.height : 200;
      const gap = typeof args.gap === 'number' && args.gap >= 0 ? args.gap : 16;
      const { title1 = '', title2 = '', title3 = '', title4 = '', x, y } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const titles = [title1, title2, title3, title4];
      const positions = [
        { x, y },
        { x: x + w + gap, y },
        { x, y: y + h + gap },
        { x: x + w + gap, y: y + h + gap }
      ];
      for (let i = 0; i < 4; i++) {
        const fid = id();
        const frame = { id: fid, x: positions[i].x, y: positions[i].y, width: w, height: h, title: titles[i] || '' };
        state.frames.push(frame);
        broadcastToBoard(boardId, { type: 'FRAME_ADDED', frame });
      }
      persistBoard(boardId);
      break;
    }
    case 'createConnector': {
      const from = refFromId(args.fromId);
      const to = refFromId(args.toId);
      if (!from || !to) return;
      const cid = id();
      const connector = { id: cid, from, to, color: typeof args.style === 'string' ? args.style : '#94a3b8' };
      state.connectors.push(connector);
      persistBoard(boardId);
      broadcastToBoard(boardId, { type: 'CONNECTOR_ADDED', connector });
      break;
    }
    case 'createFlowchartNode': {
      const { type = 'process', text = '', x, y, width = 120, height = 60 } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const shapeMap = { process: 'rect', decision: 'diamond', start: 'roundedRect', end: 'roundedRect' };
      const shape = shapeMap[type] || 'rect';
      const strokeId = id();
      const points = [{ x, y }, { x: x + width, y: y + height }];
      const seq = state.nextSeq++;
      const stroke = { seq, strokeId, points, color: '#e2e8f0', shape };
      state.strokes.push(stroke);
      broadcastToBoard(boardId, { type: 'STROKE_ADDED', stroke });
      const tid = id();
      const tw = Math.min(TEXT_DEFAULT_W, Math.max(60, width - 16));
      const th = Math.min(TEXT_DEFAULT_H, Math.max(24, height - 12));
      const tx = x + width / 2 - tw / 2;
      const ty = y + height / 2 - th / 2;
      const textEl = { id: tid, x: tx, y: ty, text: String(text), color: '#e2e8f0', width: tw, height: th, centerLabel: true };
      state.textElements.push(textEl);
      broadcastToBoard(boardId, { type: 'TEXT_ADDED', textElement: textEl });
      persistBoard(boardId);
      break;
    }
    case 'moveObject': {
      const { objectId, x, y } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const s = state.stickies.find((o) => o.id === objectId);
      if (s) {
        s.x = x; s.y = y;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STICKY_MOVED', id: objectId, x, y });
        break;
      }
      const t = state.textElements.find((o) => o.id === objectId);
      if (t) {
        t.x = x; t.y = y;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'TEXT_MOVED', id: objectId, x, y });
        break;
      }
      const f = state.frames.find((o) => o.id === objectId);
      if (f) {
        f.x = x; f.y = y;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'FRAME_UPDATED', id: objectId, x, y });
        break;
      }
      const stroke = state.strokes.find((o) => o.strokeId === objectId);
      if (stroke && stroke.points) {
        const isBboxShape = ['rect', 'circle', 'diamond', 'roundedRect'].includes(stroke.shape);
        const cx = isBboxShape
          ? (stroke.points[0].x + stroke.points[1].x) / 2
          : stroke.points.reduce((a, p) => a + p.x, 0) / stroke.points.length;
        const cy = isBboxShape
          ? (stroke.points[0].y + stroke.points[1].y) / 2
          : stroke.points.reduce((a, p) => a + p.y, 0) / stroke.points.length;
        const dx = x - cx, dy = y - cy;
        stroke.points.forEach((p) => { p.x += dx; p.y += dy; });
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STROKE_MOVED', strokeId: objectId, dx, dy });
      }
      break;
    }
    case 'resizeObject': {
      const { objectId, width, height } = args;
      const st = state.stickies.find((o) => o.id === objectId);
      if (st && width >= 40 && height >= 30) {
        st.width = width; st.height = height;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STICKY_UPDATED', id: objectId, width, height });
        break;
      }
      const te = state.textElements.find((o) => o.id === objectId);
      if (te) {
        te.width = width; te.height = height;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'TEXT_UPDATED', id: objectId, width, height });
        break;
      }
      const fr = state.frames.find((o) => o.id === objectId);
      if (fr && width >= 60 && height >= 40) {
        fr.width = width; fr.height = height;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'FRAME_UPDATED', id: objectId, width, height });
        break;
      }
      const str = state.strokes.find((o) => o.strokeId === objectId);
      if (str && ['rect', 'circle', 'diamond', 'roundedRect'].includes(str.shape) && str.points && str.points.length >= 2) {
        const p0 = str.points[0];
        str.points[1] = { x: p0.x + width, y: p0.y + height };
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STROKE_POINTS_UPDATED', strokeId: objectId, points: str.points });
      }
      break;
    }
    case 'updateText': {
      const { objectId, newText } = args;
      const stick = state.stickies.find((o) => o.id === objectId);
      if (stick) {
        stick.text = typeof newText === 'string' ? newText : '';
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STICKY_UPDATED', id: objectId, text: stick.text });
        break;
      }
      const txt = state.textElements.find((o) => o.id === objectId);
      if (txt) {
        txt.text = typeof newText === 'string' ? newText : '';
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'TEXT_UPDATED', id: objectId, text: txt.text });
      }
      break;
    }
    case 'changeColor': {
      const { objectId, color } = args;
      if (typeof color !== 'string') return;
      const stick = state.stickies.find((o) => o.id === objectId);
      if (stick) {
        stick.color = color;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STICKY_UPDATED', id: objectId, color });
        break;
      }
      const txt = state.textElements.find((o) => o.id === objectId);
      if (txt) {
        txt.color = color;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'TEXT_UPDATED', id: objectId, color });
        break;
      }
      const str = state.strokes.find((o) => o.strokeId === objectId);
      if (str) {
        str.color = color;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'STROKE_COLOR_CHANGED', strokeId: objectId, color });
        break;
      }
      const conn = state.connectors.find((o) => o.id === objectId);
      if (conn) {
        conn.color = color;
        persistBoard(boardId);
        broadcastToBoard(boardId, { type: 'CONNECTOR_UPDATED', id: objectId, color });
      }
      break;
    }
    case 'getBoardState':
      break;
    default:
      break;
  }
}

const { runAiCommand } = require('./ai-agent.js');

app.post('/api/ai/command', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  const sessionId = cookies.session;
  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated', hint: 'No session cookie. Sign in again.' });
  }
  let session;
  try {
    session = await db.getSession(sessionId);
  } catch (err) {
    console.error('Session lookup error:', err);
    return res.status(500).json({ error: 'Not authenticated', hint: 'Session lookup failed.' });
  }
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated', hint: 'Session expired or invalid. Sign in again.' });
  }
  session = await ensureSessionUserId(sessionId, session);
  const { command, boardId } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'Missing or empty command' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OpenAI API key not configured. Add OPENAI_API_KEY to .env' });
  }
  const bid = typeof boardId === 'string' && boardId.trim() ? boardId.trim() : null;
  if (db.hasDatabase() && !bid) {
    return res.status(400).json({ error: 'Missing boardId. Open a whiteboard first.' });
  }
  if (db.hasDatabase() && session.userId) {
    const allowed = await db.isUserInWhiteboard(session.userId, bid);
    if (!allowed) return res.status(403).json({ error: 'Not allowed on this whiteboard' });
  }
  const AI_COMMAND_TIMEOUT_MS = 120000;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Request timed out')), AI_COMMAND_TIMEOUT_MS);
  });

  try {
    const state = bid ? await ensureBoardState(bid) : getBoardState('default');
    const boardStateJson = JSON.stringify({
      stickies: (state.stickies || []).map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        text: (s.text || '').slice(0, 200),
        color: s.color
      })),
      strokes: (state.strokes || []).map((s) => ({
        strokeId: s.strokeId,
        shape: s.shape,
        color: s.color,
        points: s.points && s.points.length ? s.points.slice(0, 2) : []
      })),
      textElements: (state.textElements || []).map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        text: (t.text || '').slice(0, 200),
        color: t.color
      })),
      frames: (state.frames || []).map((f) => ({
        id: f.id,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        title: (f.title || '').slice(0, 100)
      })),
      connectors: (state.connectors || []).map((c) => ({
        id: c.id,
        from: c.from,
        to: c.to,
        color: c.color
      }))
    });
    const { message, toolCalls, viewCenter } = await Promise.race([
      runAiCommand(command.trim(), boardStateJson),
      timeoutPromise
    ]);
    const targetBoardId = bid || 'default';
    for (const tc of toolCalls) {
      executeTool(tc.name, tc.args, state, targetBoardId);
    }
    const payload = { ok: true, message, toolCalls: toolCalls.length };
    const bounds = getBoardWorldBounds(state);
    if (bounds) {
      payload.viewFitBounds = bounds;
    } else if (viewCenter && typeof viewCenter.x === 'number' && typeof viewCenter.y === 'number') {
      payload.viewCenter = viewCenter;
    }
    res.json(payload);
  } catch (err) {
    console.error('AI command error:', err);
    const isTimeout = err.message === 'Request timed out';
    res.status(isTimeout ? 504 : 500).json({ error: err.message || 'AI command failed' });
  }
});

async function main() {
  await db.init();
  await redis.init();
  const host = '0.0.0.0'; // accept connections from any interface (required on Render/Heroku etc.)
  server.on('error', (err) => {
    console.error('Server error:', err.message || err);
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use.`);
  });
  server.listen(PORT, host, () => {
    console.log(`Server listening on http://${host}:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
