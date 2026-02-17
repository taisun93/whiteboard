const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});

// Server-authoritative: single ordered log of strokes
let nextSeq = 0;
const strokes = [];

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
  ws.send(JSON.stringify({ type: 'STATE', strokes }));
  ws.send(JSON.stringify({ type: 'SEQ', nextSeq }));
  // Send current cursors so new user sees everyone on screen
  const cursorList = Array.from(cursors.entries()).map(([id, pos]) => ({ clientId: id, ...pos }));
  ws.send(JSON.stringify({ type: 'CURSORS', cursors: cursorList }));

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
    }
  });

  ws.on('close', () => {
    cursors.delete(clientId);
    const payload = JSON.stringify({ type: 'CURSOR_LEFT', clientId });
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(payload);
    });
  });
});
