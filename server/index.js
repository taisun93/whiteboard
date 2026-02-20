const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const db = require('./db');

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
    }
  });
});

app.post('/api/logout', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  if (cookies.session) await db.deleteSession(cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Server-authoritative: strokes, stickies, text, connectors, frames
let nextSeq = 0;
const strokes = [];
const stickies = []; // { id, x, y, width, height, text, color, rotation? }
const textElements = []; // { id, x, y, text, color, width?, height?, rotation? }
const connectors = []; // { id, from, to, color }
const frames = []; // { id, x, y, width, height, title? }
const STICKY_DEFAULT_W = 200;
const STICKY_DEFAULT_H = 150;
const TEXT_DEFAULT_W = 140;
const TEXT_DEFAULT_H = 28;
const FRAME_DEFAULT_W = 300;
const FRAME_DEFAULT_H = 200;

function persistBoard() {
  db.saveBoardState({ strokes, stickies, textElements, connectors, frames, nextSeq }).catch((err) =>
    console.error('persist board:', err)
  );
}

const wss = new WebSocketServer({ server });

// Cursor presence: clientId -> { x, y } (canvas coords), for new joiners
const cursors = new Map();
let nextClientId = 0;

wss.on('connection', async (ws, req) => {
  const cookies = parseCookie(req.headers.cookie);
  const session = cookies.session ? await db.getSession(cookies.session) : null;
  ws.username = session ? session.name : 'anonymous';

  const clientId = `u${nextClientId++}`;
  ws.clientId = clientId;

  ws.send(JSON.stringify({ type: 'ME', clientId, username: ws.username }));
  // Send full state to new client
  ws.send(JSON.stringify({ type: 'STATE', strokes, stickies, textElements, connectors, frames }));
  ws.send(JSON.stringify({ type: 'SEQ', nextSeq }));
  // Send current cursors so new user sees everyone on screen
  const cursorList = Array.from(cursors.entries()).map(([id, pos]) => ({ clientId: id, ...pos }));
  ws.send(JSON.stringify({ type: 'CURSORS', cursors: cursorList }));

  broadcastUsers();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'ADD_STROKE') {
      if (!Array.isArray(msg.points) || !msg.strokeId) return;
      const seq = nextSeq++;
      const color = typeof msg.color === 'string' ? msg.color : '#e2e8f0';
      const shape = msg.shape === 'rect' || msg.shape === 'circle' ? msg.shape : undefined;
      const stroke = { seq, strokeId: msg.strokeId, points: msg.points, color };
      if (shape) stroke.shape = shape;
      strokes.push(stroke);
      persistBoard();
      const payload = JSON.stringify({ type: 'STROKE_ADDED', stroke });
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(payload);
      });
      return;
    }
    if (msg.type === 'DELETE_STROKES' && Array.isArray(msg.strokeIds)) {
      const ids = new Set(msg.strokeIds);
      const removed = [];
      for (let i = strokes.length - 1; i >= 0; i--) {
        if (ids.has(strokes[i].strokeId)) {
          removed.push(strokes[i].strokeId);
          strokes.splice(i, 1);
        }
      }
      if (removed.length > 0) {
        const removedSet = new Set(removed);
        const connToRemoveIds = connectors.filter((c) => (c.from.type === 'stroke' && removedSet.has(c.from.strokeId)) || (c.to.type === 'stroke' && removedSet.has(c.to.strokeId))).map((c) => c.id);
        for (let k = connectors.length - 1; k >= 0; k--) {
          if (connToRemoveIds.includes(connectors[k].id)) connectors.splice(k, 1);
        }
        connToRemoveIds.forEach((id) => {
          const payload = JSON.stringify({ type: 'CONNECTOR_REMOVED', id });
          wss.clients.forEach((client) => { if (client.readyState === 1) client.send(payload); });
        });
        persistBoard();
        const payload = JSON.stringify({ type: 'STROKES_REMOVED', strokeIds: removed });
        const clients = Array.from(wss.clients);
        clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
    if (msg.type === 'CURSOR_MOVE' && typeof msg.x === 'number' && typeof msg.y === 'number') {
      cursors.set(clientId, { x: msg.x, y: msg.y });
      const payload = JSON.stringify({ type: 'CURSOR_MOVE', clientId, x: msg.x, y: msg.y });
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(payload);
      });
      return;
    }
    if (msg.type === 'CURSOR_LEFT') {
      cursors.delete(clientId);
      const payload = JSON.stringify({ type: 'CURSOR_LEFT', clientId });
      wss.clients.forEach((c) => {
        if (c.readyState === 1 && c !== ws) c.send(payload);
      });
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
      stickies.push(sticky);
      persistBoard();
      const payload = JSON.stringify({ type: 'STICKY_ADDED', sticky });
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(payload);
      });
      return;
    }
    if (msg.type === 'UPDATE_STICKY' && msg.id) {
      const s = stickies.find((s) => s.id === msg.id);
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
          persistBoard();
          const payload = JSON.stringify({ type: 'STICKY_UPDATED', id: msg.id, ...updates });
          wss.clients.forEach((c) => {
            if (c.readyState === 1) c.send(payload);
          });
        }
      }
      return;
    }
    if (msg.type === 'DELETE_STICKY' && msg.id) {
      const i = stickies.findIndex((s) => s.id === msg.id);
      if (i >= 0) {
        stickies.splice(i, 1);
        const toRemoveIds = connectors.filter((c) => (c.from.type === 'sticky' && c.from.id === msg.id) || (c.to.type === 'sticky' && c.to.id === msg.id)).map((c) => c.id);
        for (let k = connectors.length - 1; k >= 0; k--) {
          if (toRemoveIds.includes(connectors[k].id)) connectors.splice(k, 1);
        }
        toRemoveIds.forEach((id) => {
          const payload = JSON.stringify({ type: 'CONNECTOR_REMOVED', id });
          wss.clients.forEach((client) => { if (client.readyState === 1) client.send(payload); });
        });
        persistBoard();
        const payload = JSON.stringify({ type: 'STICKY_REMOVED', id: msg.id });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
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
      connectors.push(connector);
      persistBoard();
      const payload = JSON.stringify({ type: 'CONNECTOR_ADDED', connector });
      wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
      return;
    }
    if (msg.type === 'UPDATE_CONNECTOR' && msg.id && typeof msg.color === 'string') {
      const c = connectors.find((x) => x.id === msg.id);
      if (c) {
        c.color = msg.color;
        persistBoard();
        const payload = JSON.stringify({ type: 'CONNECTOR_UPDATED', id: msg.id, color: msg.color });
        wss.clients.forEach((client) => { if (client.readyState === 1) client.send(payload); });
      }
      return;
    }
    if (msg.type === 'DELETE_CONNECTOR' && msg.id) {
      const i = connectors.findIndex((c) => c.id === msg.id);
      if (i >= 0) {
        connectors.splice(i, 1);
        persistBoard();
        const payload = JSON.stringify({ type: 'CONNECTOR_REMOVED', id: msg.id });
        wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
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
      textElements.push(el);
      persistBoard();
      const payload = JSON.stringify({ type: 'TEXT_ADDED', textElement: el });
      wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
      return;
    }
    if (msg.type === 'UPDATE_TEXT_ELEMENT' && msg.id) {
      const el = textElements.find((e) => e.id === msg.id);
      if (el) {
        const updates = {};
        if (typeof msg.text === 'string') { el.text = msg.text; updates.text = msg.text; }
        if (typeof msg.color === 'string') { el.color = msg.color; updates.color = msg.color; }
        if (typeof msg.width === 'number' && msg.width >= 40) { el.width = msg.width; updates.width = msg.width; }
        if (typeof msg.height === 'number' && msg.height >= 20) { el.height = msg.height; updates.height = msg.height; }
        if (typeof msg.rotation === 'number') { el.rotation = msg.rotation; updates.rotation = msg.rotation; }
        if (Object.keys(updates).length > 0) {
          persistBoard();
          const payload = JSON.stringify({ type: 'TEXT_UPDATED', id: msg.id, ...updates });
          wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
        }
      }
      return;
    }
    if (msg.type === 'DELETE_TEXT_ELEMENT' && msg.id) {
      const i = textElements.findIndex((e) => e.id === msg.id);
      if (i >= 0) {
        textElements.splice(i, 1);
        const toRemoveIds = connectors.filter((c) => (c.from.type === 'text' && c.from.id === msg.id) || (c.to.type === 'text' && c.to.id === msg.id)).map((c) => c.id);
        for (let k = connectors.length - 1; k >= 0; k--) {
          if (toRemoveIds.includes(connectors[k].id)) connectors.splice(k, 1);
        }
        toRemoveIds.forEach((id) => {
          const payload = JSON.stringify({ type: 'CONNECTOR_REMOVED', id });
          wss.clients.forEach((client) => { if (client.readyState === 1) client.send(payload); });
        });
        persistBoard();
        const payload = JSON.stringify({ type: 'TEXT_REMOVED', id: msg.id });
        wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
      }
      return;
    }
    if (msg.type === 'UPDATE_TEXT_POSITION' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const el = textElements.find((e) => e.id === msg.id);
      if (el) {
        el.x = msg.x;
        el.y = msg.y;
        persistBoard();
        const payload = JSON.stringify({ type: 'TEXT_MOVED', id: msg.id, x: msg.x, y: msg.y });
        wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
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
      frames.push(frame);
      persistBoard();
      const payload = JSON.stringify({ type: 'FRAME_ADDED', frame });
      wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
      return;
    }
    if (msg.type === 'UPDATE_FRAME' && msg.id) {
      const f = frames.find((x) => x.id === msg.id);
      if (f) {
        const updates = {};
        if (typeof msg.x === 'number') { f.x = msg.x; updates.x = msg.x; }
        if (typeof msg.y === 'number') { f.y = msg.y; updates.y = msg.y; }
        if (typeof msg.width === 'number' && msg.width >= 60) { f.width = msg.width; updates.width = msg.width; }
        if (typeof msg.height === 'number' && msg.height >= 40) { f.height = msg.height; updates.height = msg.height; }
        if (typeof msg.title === 'string') { f.title = msg.title; updates.title = msg.title; }
        if (Object.keys(updates).length > 0) {
          persistBoard();
          const payload = JSON.stringify({ type: 'FRAME_UPDATED', id: msg.id, ...updates });
          wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
        }
      }
      return;
    }
    if (msg.type === 'DELETE_FRAME' && msg.id) {
      const i = frames.findIndex((f) => f.id === msg.id);
      if (i >= 0) {
        frames.splice(i, 1);
        persistBoard();
        const payload = JSON.stringify({ type: 'FRAME_REMOVED', id: msg.id });
        wss.clients.forEach((c) => { if (c.readyState === 1) c.send(payload); });
      }
      return;
    }
    if (msg.type === 'UPDATE_STICKY_POSITION' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const s = stickies.find((s) => s.id === msg.id);
      if (s) {
        s.x = msg.x;
        s.y = msg.y;
        persistBoard();
        const payload = JSON.stringify({ type: 'STICKY_MOVED', id: msg.id, x: msg.x, y: msg.y });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
    if (msg.type === 'MOVE_STROKE' && msg.strokeId && typeof msg.dx === 'number' && typeof msg.dy === 'number') {
      const s = strokes.find((s) => s.strokeId === msg.strokeId);
      if (s && s.points) {
        s.points.forEach((p) => {
          p.x += msg.dx;
          p.y += msg.dy;
        });
        persistBoard();
        const payload = JSON.stringify({ type: 'STROKE_MOVED', strokeId: msg.strokeId, dx: msg.dx, dy: msg.dy });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
    if (msg.type === 'SET_STROKE_COLOR' && msg.strokeId && typeof msg.color === 'string') {
      const s = strokes.find((s) => s.strokeId === msg.strokeId);
      if (s) {
        s.color = msg.color;
        persistBoard();
        const payload = JSON.stringify({ type: 'STROKE_COLOR_CHANGED', strokeId: msg.strokeId, color: msg.color });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
    if (msg.type === 'UPDATE_STROKE_POINTS' && msg.strokeId && Array.isArray(msg.points)) {
      const s = strokes.find((s) => s.strokeId === msg.strokeId);
      if (s && msg.points.every((p) => typeof p.x === 'number' && typeof p.y === 'number')) {
        s.points = msg.points.map((p) => ({ x: p.x, y: p.y }));
        persistBoard();
        const payload = JSON.stringify({ type: 'STROKE_POINTS_UPDATED', strokeId: msg.strokeId, points: s.points });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
  });

  ws.on('close', () => {
    cursors.delete(clientId);
    const payload = JSON.stringify({ type: 'CURSOR_LEFT', clientId });
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(payload);
    });
    broadcastUsers();
  });
});

// --- AI command route (LangChain + OpenAI 4o) ---
function broadcast(payload) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(s); });
}

function executeTool(name, args) {
  const id = () => crypto.randomUUID();
  const parsePoint = (s) => {
    if (typeof s !== 'string') return null;
    const [x, y] = s.split(',').map((n) => parseFloat(n.trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) return { type: 'point', x, y };
    return null;
  };
  const refFromId = (sid) => {
    if (stickies.some((s) => s.id === sid)) return { type: 'sticky', id: sid };
    if (textElements.some((t) => t.id === sid)) return { type: 'text', id: sid };
    if (strokes.some((s) => s.strokeId === sid)) return { type: 'stroke', strokeId: sid };
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
      stickies.push(sticky);
      persistBoard();
      broadcast({ type: 'STICKY_ADDED', sticky });
      break;
    }
    case 'createShape': {
      const { type = 'rect', x, y, width = 100, height = 80, color = '#e2e8f0' } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const shape = type === 'circle' ? 'circle' : 'rect';
      const strokeId = id();
      const points = [{ x, y }, { x: x + width, y: y + height }];
      const seq = nextSeq++;
      const stroke = { seq, strokeId, points, color, shape };
      strokes.push(stroke);
      persistBoard();
      broadcast({ type: 'STROKE_ADDED', stroke });
      break;
    }
    case 'createFrame': {
      const { title = '', x, y, width = FRAME_DEFAULT_W, height = FRAME_DEFAULT_H } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const fid = id();
      const frame = { id: fid, x, y, width, height, title };
      frames.push(frame);
      persistBoard();
      broadcast({ type: 'FRAME_ADDED', frame });
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
        frames.push(frame);
        broadcast({ type: 'FRAME_ADDED', frame });
      }
      persistBoard();
      break;
    }
    case 'createConnector': {
      const from = refFromId(args.fromId);
      const to = refFromId(args.toId);
      if (!from || !to) return;
      const cid = id();
      const connector = { id: cid, from, to, color: typeof args.style === 'string' ? args.style : '#94a3b8' };
      connectors.push(connector);
      persistBoard();
      broadcast({ type: 'CONNECTOR_ADDED', connector });
      break;
    }
    case 'moveObject': {
      const { objectId, x, y } = args;
      if (typeof x !== 'number' || typeof y !== 'number') return;
      const s = stickies.find((o) => o.id === objectId);
      if (s) {
        s.x = x; s.y = y;
        persistBoard();
        broadcast({ type: 'STICKY_MOVED', id: objectId, x, y });
        break;
      }
      const t = textElements.find((o) => o.id === objectId);
      if (t) {
        t.x = x; t.y = y;
        persistBoard();
        broadcast({ type: 'TEXT_MOVED', id: objectId, x, y });
        break;
      }
      const f = frames.find((o) => o.id === objectId);
      if (f) {
        f.x = x; f.y = y;
        persistBoard();
        broadcast({ type: 'FRAME_UPDATED', id: objectId, x, y });
        break;
      }
      const stroke = strokes.find((o) => o.strokeId === objectId);
      if (stroke && stroke.points) {
        const cx = stroke.shape === 'rect' || stroke.shape === 'circle'
          ? (stroke.points[0].x + stroke.points[1].x) / 2
          : stroke.points.reduce((a, p) => a + p.x, 0) / stroke.points.length;
        const cy = stroke.shape === 'rect' || stroke.shape === 'circle'
          ? (stroke.points[0].y + stroke.points[1].y) / 2
          : stroke.points.reduce((a, p) => a + p.y, 0) / stroke.points.length;
        const dx = x - cx, dy = y - cy;
        stroke.points.forEach((p) => { p.x += dx; p.y += dy; });
        persistBoard();
        broadcast({ type: 'STROKE_MOVED', strokeId: objectId, dx, dy });
      }
      break;
    }
    case 'resizeObject': {
      const { objectId, width, height } = args;
      const st = stickies.find((o) => o.id === objectId);
      if (st && width >= 40 && height >= 30) {
        st.width = width; st.height = height;
        persistBoard();
        broadcast({ type: 'STICKY_UPDATED', id: objectId, width, height });
        break;
      }
      const te = textElements.find((o) => o.id === objectId);
      if (te) {
        te.width = width; te.height = height;
        persistBoard();
        broadcast({ type: 'TEXT_UPDATED', id: objectId, width, height });
        break;
      }
      const fr = frames.find((o) => o.id === objectId);
      if (fr && width >= 60 && height >= 40) {
        fr.width = width; fr.height = height;
        persistBoard();
        broadcast({ type: 'FRAME_UPDATED', id: objectId, width, height });
        break;
      }
      const str = strokes.find((o) => o.strokeId === objectId);
      if (str && (str.shape === 'rect' || str.shape === 'circle') && str.points && str.points.length >= 2) {
        const p0 = str.points[0];
        str.points[1] = { x: p0.x + width, y: p0.y + height };
        persistBoard();
        broadcast({ type: 'STROKE_POINTS_UPDATED', strokeId: objectId, points: str.points });
      }
      break;
    }
    case 'updateText': {
      const { objectId, newText } = args;
      const stick = stickies.find((o) => o.id === objectId);
      if (stick) {
        stick.text = typeof newText === 'string' ? newText : '';
        persistBoard();
        broadcast({ type: 'STICKY_UPDATED', id: objectId, text: stick.text });
        break;
      }
      const txt = textElements.find((o) => o.id === objectId);
      if (txt) {
        txt.text = typeof newText === 'string' ? newText : '';
        persistBoard();
        broadcast({ type: 'TEXT_UPDATED', id: objectId, text: txt.text });
      }
      break;
    }
    case 'changeColor': {
      const { objectId, color } = args;
      if (typeof color !== 'string') return;
      const stick = stickies.find((o) => o.id === objectId);
      if (stick) {
        stick.color = color;
        persistBoard();
        broadcast({ type: 'STICKY_UPDATED', id: objectId, color });
        break;
      }
      const txt = textElements.find((o) => o.id === objectId);
      if (txt) {
        txt.color = color;
        persistBoard();
        broadcast({ type: 'TEXT_UPDATED', id: objectId, color });
        break;
      }
      const str = strokes.find((o) => o.strokeId === objectId);
      if (str) {
        str.color = color;
        persistBoard();
        broadcast({ type: 'STROKE_COLOR_CHANGED', strokeId: objectId, color });
        break;
      }
      const conn = connectors.find((o) => o.id === objectId);
      if (conn) {
        conn.color = color;
        persistBoard();
        broadcast({ type: 'CONNECTOR_UPDATED', id: objectId, color });
      }
      break;
    }
    case 'getBoardState':
      // No-op on server; model uses state we passed in the prompt
      break;
    default:
      break;
  }
}

const { runAiCommand } = require('./ai-agent.js');

app.post('/api/ai/command', async (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  const session = cookies.session ? await db.getSession(cookies.session) : null;
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { command } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: 'Missing or empty command' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'OpenAI API key not configured. Add OPENAI_API_KEY to .env' });
  }
  try {
    const boardStateJson = JSON.stringify({
      stickies: stickies.map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        text: (s.text || '').slice(0, 200),
        color: s.color
      })),
      strokes: strokes.map((s) => ({
        strokeId: s.strokeId,
        shape: s.shape,
        color: s.color,
        points: s.points && s.points.length ? s.points.slice(0, 2) : []
      })),
      textElements: textElements.map((t) => ({
        id: t.id,
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        text: (t.text || '').slice(0, 200),
        color: t.color
      })),
      frames: frames.map((f) => ({
        id: f.id,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        title: (f.title || '').slice(0, 100)
      })),
      connectors: connectors.map((c) => ({
        id: c.id,
        from: c.from,
        to: c.to,
        color: c.color
      }))
    });
    const { message, toolCalls, viewCenter } = await runAiCommand(command.trim(), boardStateJson);
    for (const tc of toolCalls) {
      executeTool(tc.name, tc.args);
    }
    const payload = { ok: true, message, toolCalls: toolCalls.length };
    if (viewCenter && typeof viewCenter.x === 'number' && typeof viewCenter.y === 'number') {
      payload.viewCenter = viewCenter;
    }
    res.json(payload);
  } catch (err) {
    console.error('AI command error:', err);
    res.status(500).json({ error: err.message || 'AI command failed' });
  }
});

function broadcastUsers() {
  const userList = Array.from(wss.clients)
    .filter((c) => c.readyState === 1)
    .map((c) => ({ clientId: c.clientId, username: c.username || 'anonymous' }))
    .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  const payload = JSON.stringify({ type: 'USERS', users: userList });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(payload);
  });
}

async function main() {
  await db.init();
  const loaded = await db.loadBoardState();
  if (loaded) {
    strokes.length = 0;
    strokes.push(...(loaded.strokes || []));
    stickies.length = 0;
    stickies.push(...(loaded.stickies || []));
    textElements.length = 0;
    textElements.push(...(loaded.textElements || []));
    connectors.length = 0;
    connectors.push(...(loaded.connectors || []));
    frames.length = 0;
    frames.push(...(loaded.frames || []));
    nextSeq = typeof loaded.nextSeq === 'number' ? loaded.nextSeq : 0;
  }
  server.listen(PORT, () => {
    console.log(`http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
