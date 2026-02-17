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

wss.on('connection', (ws) => {
  // Send full state to new client (authoritative order)
  ws.send(JSON.stringify({ type: 'STATE', strokes }));
  ws.send(JSON.stringify({ type: 'SEQ', nextSeq }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'ADD_STROKE' || !Array.isArray(msg.points) || !msg.strokeId) return;

    // Authoritative ordering: server assigns sequence number
    const seq = nextSeq++;
    const stroke = { seq, strokeId: msg.strokeId, points: msg.points };
    strokes.push(stroke);

    // Broadcast to all clients (including sender) so everyone applies in same order
    const payload = JSON.stringify({ type: 'STROKE_ADDED', stroke });
    wss.clients.forEach((c) => {
      if (c.readyState === 1) c.send(payload);
    });
  });
});
