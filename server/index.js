const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Auth: in-memory (no register yet). Passwords plain for dev seed only.
const users = new Map([
  ['alice', 'alice123'],
  ['bob', 'bob123']
]);
const sessions = new Map(); // sessionId -> { username }

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((s) => {
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return out;
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const stored = users.get(String(username).toLowerCase());
  if (!stored || stored !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, { username: String(username).toLowerCase() });
  res.cookie('session', sessionId, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, user: { username: String(username).toLowerCase() } });
});

app.get('/api/me', (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  const sessionId = cookies.session;
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json({ user: { username: session.username } });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookie(req.headers.cookie);
  if (cookies.session) sessions.delete(cookies.session);
  res.clearCookie('session');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});

// Server-authoritative: single ordered log of strokes and stickies
let nextSeq = 0;
const strokes = [];
const stickies = []; // { id, x, y, width, height, text }
const STICKY_DEFAULT_W = 200;
const STICKY_DEFAULT_H = 150;

const wss = new WebSocketServer({ server });

// Cursor presence: clientId -> { x, y } (canvas coords), for new joiners
const cursors = new Map();
let nextClientId = 0;

wss.on('connection', (ws, req) => {
  const cookies = parseCookie(req.headers.cookie);
  const session = cookies.session ? sessions.get(cookies.session) : null;
  ws.username = session ? session.username : 'anonymous';

  const clientId = `u${nextClientId++}`;
  ws.clientId = clientId;

  ws.send(JSON.stringify({ type: 'ME', clientId, username: ws.username }));
  // Send full state to new client
  ws.send(JSON.stringify({ type: 'STATE', strokes, stickies }));
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
      const stroke = { seq, strokeId: msg.strokeId, points: msg.points };
      strokes.push(stroke);
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
        text: typeof msg.text === 'string' ? msg.text : ''
      };
      stickies.push(sticky);
      const payload = JSON.stringify({ type: 'STICKY_ADDED', sticky });
      wss.clients.forEach((c) => {
        if (c.readyState === 1) c.send(payload);
      });
      return;
    }
    if (msg.type === 'UPDATE_STICKY' && msg.id && typeof msg.text === 'string') {
      const s = stickies.find((s) => s.id === msg.id);
      if (s) {
        s.text = msg.text;
        const payload = JSON.stringify({ type: 'STICKY_UPDATED', id: msg.id, text: msg.text });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
    if (msg.type === 'DELETE_STICKY' && msg.id) {
      const i = stickies.findIndex((s) => s.id === msg.id);
      if (i >= 0) {
        stickies.splice(i, 1);
        const payload = JSON.stringify({ type: 'STICKY_REMOVED', id: msg.id });
        wss.clients.forEach((c) => {
          if (c.readyState === 1) c.send(payload);
        });
      }
      return;
    }
    if (msg.type === 'UPDATE_STICKY_POSITION' && msg.id && typeof msg.x === 'number' && typeof msg.y === 'number') {
      const s = stickies.find((s) => s.id === msg.id);
      if (s) {
        s.x = msg.x;
        s.y = msg.y;
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
        const payload = JSON.stringify({ type: 'STROKE_MOVED', strokeId: msg.strokeId, dx: msg.dx, dy: msg.dy });
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
