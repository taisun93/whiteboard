const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

// Server-authoritative: strokes in seq order. Optimistic: pending by strokeId.
const strokes = [];
const pending = new Map();
// Other users' cursors: clientId -> { x, y } (canvas coords)
const otherCursors = new Map();

let ws = null;
let drawing = false;
let currentPoints = [];
let currentStrokeId = null;
let cursorThrottle = 0;
const CURSOR_THROTTLE_MS = 50;
let myClientId = null;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.classList.add('connected');
  };
  ws.onclose = () => {
    statusEl.textContent = 'Disconnected';
    statusEl.classList.remove('connected');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'ME') {
      myClientId = msg.clientId;
      return;
    }
    if (msg.type === 'STATE') {
      strokes.length = 0;
      (msg.strokes || []).forEach((s) => strokes.push(s));
      draw();
    } else if (msg.type === 'STROKE_ADDED') {
      const { stroke } = msg;
      if (pending.has(stroke.strokeId)) {
        pending.delete(stroke.strokeId);
        strokes.push(stroke);
        strokes.sort((a, b) => a.seq - b.seq);
      } else {
        strokes.push(stroke);
        strokes.sort((a, b) => a.seq - b.seq);
      }
      draw();
    } else if (msg.type === 'CURSORS') {
      otherCursors.clear();
      (msg.cursors || []).forEach(({ clientId, x, y }) => {
        if (clientId !== myClientId) otherCursors.set(clientId, { x, y });
      });
      draw();
    } else if (msg.type === 'CURSOR_MOVE') {
      if (msg.clientId !== myClientId) {
        otherCursors.set(msg.clientId, { x: msg.x, y: msg.y });
        draw();
      }
    } else if (msg.type === 'CURSOR_LEFT') {
      otherCursors.delete(msg.clientId);
      draw();
    }
  };
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
}

function draw() {
  ctx.fillStyle = '#0f0f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  strokes.forEach((s) => {
    if (!s.points || s.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
    ctx.stroke();
  });

  pending.forEach((points) => {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  });

  // Other users' cursors
  otherCursors.forEach((pos, clientId) => {
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number' || Number.isNaN(pos.x) || Number.isNaN(pos.y)) return;
    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '11px system-ui';
    ctx.fillStyle = '#fff';
    ctx.fillText(clientId, pos.x + 12, pos.y + 4);
  });

}

function toCanvasCoords(e) {
  const r = canvas.getBoundingClientRect();
  const scaleX = canvas.width / r.width;
  const scaleY = canvas.height / r.height;
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!ws || ws.readyState !== 1) return;
  drawing = true;
  currentStrokeId = uuid();
  currentPoints = [toCanvasCoords(e)];
  pending.set(currentStrokeId, [...currentPoints]);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  const pt = toCanvasCoords(e);
  if (drawing && currentStrokeId) {
    currentPoints.push(pt);
    pending.set(currentStrokeId, [...currentPoints]);
  }
  // Broadcast cursor position (throttled) when over canvas
  if (ws && ws.readyState === 1) {
    const now = Date.now();
    if (now - cursorThrottle >= CURSOR_THROTTLE_MS) {
      cursorThrottle = now;
      ws.send(JSON.stringify({ type: 'CURSOR_MOVE', x: pt.x, y: pt.y }));
    }
  }
  draw();
});

canvas.addEventListener('pointerup', (e) => {
  if (!drawing || !currentStrokeId) return;
  drawing = false;
  currentPoints.push(toCanvasCoords(e));
  if (ws && ws.readyState === 1 && currentPoints.length >= 2) {
    ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: currentStrokeId, points: currentPoints }));
  }
  currentStrokeId = null;
  currentPoints = [];
});

canvas.addEventListener('pointerleave', () => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'CURSOR_LEFT' }));
  if (!drawing || !currentStrokeId) {
    draw();
    return;
  }
  drawing = false;
  if (currentPoints.length >= 2 && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: currentStrokeId, points: currentPoints }));
  } else {
    pending.delete(currentStrokeId);
  }
  currentStrokeId = null;
  currentPoints = [];
  draw();
});

connect();
draw();
