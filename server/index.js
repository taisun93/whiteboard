const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

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

wss.on('connection', (ws) => {
  const clientId = `u${nextClientId++}`;
  ws.clientId = clientId;

  // Tell client their id (so they can ignore their own cursor in "others")
  ws.send(JSON.stringify({ type: 'ME', clientId }));
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
  const userIds = Array.from(wss.clients)
    .filter((c) => c.readyState === 1)
    .map((c) => c.clientId)
    .sort();
  const payload = JSON.stringify({ type: 'USERS', users: userIds });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(payload);
  });
}
