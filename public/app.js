const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

// Server-authoritative: strokes in seq order. Optimistic: pending by strokeId.
const strokes = [];
const pending = new Map();
// Other users' cursors: clientId -> { x, y } (world coords)
const otherCursors = new Map();
// Online users: [{ clientId, username }, ...]
let onlineUsers = [];
// Sticky notes: { id, x, y, width, height, text } in world coordinates
const stickies = [];
// Infinite board view: world is unbounded; view has pan and zoom
const VIEW_CENTER_X = 400;
const VIEW_CENTER_Y = 250;
let panX = VIEW_CENTER_X;
let panY = VIEW_CENTER_Y;
let zoom = 1;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 10;
let panning = false;
let panStartX = 0;
let panStartY = 0;
let pointerStartCanvasX = 0;
let pointerStartCanvasY = 0;
let spaceKey = false;

let ws = null;
let drawing = false;
let currentPoints = [];
let currentStrokeId = null;
let cursorThrottle = 0;
const CURSOR_THROTTLE_MS = 50;
let myClientId = null;
let tool = 'draw'; // 'draw' | 'erase' | 'sticky' | 'move'
let erasing = false;
const strokesToErase = new Set();
const ERASER_RADIUS = 20;
let movingStickyId = null;
let movingStrokeId = null;
let moveStartWorld = null;
let initialStrokePoints = null;
const MOVE_HIT_RADIUS = 15;

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
    if (msg.type === 'USERS') {
      onlineUsers = msg.users || [];
      renderUsersList();
      return;
    }
    if (msg.type === 'STATE') {
      strokes.length = 0;
      (msg.strokes || []).forEach((s) => strokes.push(s));
      stickies.length = 0;
      (msg.stickies || []).forEach((s) => stickies.push(s));
      renderStickies();
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
    } else if (msg.type === 'STROKES_REMOVED') {
      const ids = new Set(msg.strokeIds || []);
      for (let i = strokes.length - 1; i >= 0; i--) {
        if (ids.has(strokes[i].strokeId)) strokes.splice(i, 1);
      }
      ids.forEach((id) => pending.delete(id));
      draw();
    } else if (msg.type === 'STICKY_ADDED') {
      const { sticky } = msg;
      const existing = stickies.find((s) => s.id === sticky.id);
      if (existing) Object.assign(existing, sticky);
      else stickies.push(sticky);
      renderStickies();
    } else if (msg.type === 'STICKY_UPDATED') {
      const s = stickies.find((s) => s.id === msg.id);
      if (s) {
        s.text = msg.text;
        renderStickies();
      }
    } else if (msg.type === 'STICKY_REMOVED') {
      const i = stickies.findIndex((s) => s.id === msg.id);
      if (i >= 0) stickies.splice(i, 1);
      renderStickies();
    } else if (msg.type === 'STICKY_MOVED') {
      const s = stickies.find((s) => s.id === msg.id);
      if (s) {
        s.x = msg.x;
        s.y = msg.y;
        renderStickies();
      }
    } else if (msg.type === 'STROKE_MOVED') {
      const stroke = strokes.find((s) => s.strokeId === msg.strokeId);
      if (stroke && stroke.points && msg.strokeId !== movingStrokeId) {
        stroke.points.forEach((p) => {
          p.x += msg.dx;
          p.y += msg.dy;
        });
        draw();
      }
      if (msg.strokeId === movingStrokeId) movingStrokeId = null;
    }
  };
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
}

function renderUsersList() {
  const el = document.getElementById('users-list');
  if (!el) return;
  el.textContent = '';
  onlineUsers.forEach((u) => {
    const span = document.createElement('span');
    span.textContent = u.username || u.clientId || '—';
    if (u.clientId === myClientId) span.style.fontWeight = 'bold';
    el.appendChild(span);
  });
  if (onlineUsers.length === 0) {
    const span = document.createElement('span');
    span.textContent = '—';
    span.style.color = '#64748b';
    el.appendChild(span);
  }
}

const CANVAS_W = 800;
const CANVAS_H = 500;
const STICKY_DEFAULT_W = 200;
const STICKY_DEFAULT_H = 150;
let stickyUpdateDebounce = null;

function renderStickies() {
  const layer = document.getElementById('stickies-layer');
  if (!layer) return;
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / CANVAS_W, rect.height / CANVAS_H) || 1;
  const contentLeft = (rect.width - CANVAS_W * scale) / 2;
  const contentTop = (rect.height - CANVAS_H * scale) / 2;
  const existing = new Set(Array.from(layer.querySelectorAll('.sticky-note'), (el) => el.dataset.id));
  stickies.forEach((s) => {
    existing.delete(s.id);
    let el = layer.querySelector(`[data-id="${s.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'sticky-note';
      el.dataset.id = s.id;
      el.innerHTML = '<div class="sticky-header"><button type="button" class="sticky-delete" aria-label="Delete">×</button></div><textarea class="sticky-body" rows="3" placeholder="Write here…"></textarea>';
      const header = el.querySelector('.sticky-header');
      const body = el.querySelector('.sticky-body');
      const delBtn = el.querySelector('.sticky-delete');
      header.addEventListener('pointerdown', (ev) => {
        if (tool !== 'move' || ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        movingStickyId = s.id;
        moveStartCanvas = toWorldCoords(ev);
        const stickyStartX = s.x;
        const stickyStartY = s.y;
        ev.target.setPointerCapture(ev.pointerId);
        const onMove = (e2) => {
          if (movingStickyId !== s.id) return;
          const pt = toWorldCoords(e2);
          s.x = stickyStartX + (pt.x - moveStartCanvas.x);
          s.y = stickyStartY + (pt.y - moveStartCanvas.y);
          renderStickies();
        };
        const onUp = (e2) => {
          if (movingStickyId !== s.id) return;
          ev.target.releasePointerCapture(ev.pointerId);
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY_POSITION', id: s.id, x: s.x, y: s.y }));
          movingStickyId = null;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
      body.value = s.text || '';
      body.addEventListener('input', () => {
        clearTimeout(stickyUpdateDebounce);
        stickyUpdateDebounce = setTimeout(() => {
          const text = body.value;
          const st = stickies.find((x) => x.id === s.id);
          if (st) st.text = text;
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: s.id, text }));
        }, 300);
      });
      body.addEventListener('mousedown', (e) => e.stopPropagation());
      delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_STICKY', id: s.id }));
      });
      layer.appendChild(el);
    } else {
      const body = el.querySelector('.sticky-body');
      if (body && body.value !== s.text && document.activeElement !== body) body.value = s.text || '';
    }
    const pos = worldToCanvas(s.x, s.y);
    const w = s.width * zoom;
    const h = s.height * zoom;
    el.style.left = `${contentLeft + pos.x * scale}px`;
    el.style.top = `${contentTop + pos.y * scale}px`;
    el.style.width = `${w * scale}px`;
    el.style.height = `${h * scale}px`;
  });
  existing.forEach((id) => {
    const el = layer.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  });
}

function draw() {
  ctx.fillStyle = '#0f0f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = Math.max(0.5, 2 / zoom);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  strokes.forEach((s) => {
    if (!s.points || s.points.length < 2) return;
    const p0 = worldToCanvas(s.points[0].x, s.points[0].y);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < s.points.length; i++) {
      const p = worldToCanvas(s.points[i].x, s.points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  });

  pending.forEach((points) => {
    if (points.length < 2) return;
    const p0 = worldToCanvas(points[0].x, points[0].y);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; i++) {
      const p = worldToCanvas(points[i].x, points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  });

  // Other users' cursors (world coords)
  otherCursors.forEach((pos, clientId) => {
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number' || Number.isNaN(pos.x) || Number.isNaN(pos.y)) return;
    const c = worldToCanvas(pos.x, pos.y);
    const u = onlineUsers.find((x) => x.clientId === clientId);
    const label = u ? u.username : clientId;
    ctx.fillStyle = '#f59e0b';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '11px system-ui';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, c.x + 12, c.y + 4);
  });
}

function toCanvasCoords(e) {
  const r = canvas.getBoundingClientRect();
  const scaleX = canvas.width / r.width;
  const scaleY = canvas.height / r.height;
  return { x: (e.clientX - r.left) * scaleX, y: (e.clientY - r.top) * scaleY };
}

function canvasToWorld(canvasX, canvasY) {
  return {
    x: (canvasX - VIEW_CENTER_X) / zoom + panX,
    y: (canvasY - VIEW_CENTER_Y) / zoom + panY
  };
}

function worldToCanvas(worldX, worldY) {
  return {
    x: (worldX - panX) * zoom + VIEW_CENTER_X,
    y: (worldY - panY) * zoom + VIEW_CENTER_Y
  };
}

function toWorldCoords(e) {
  const c = toCanvasCoords(e);
  return canvasToWorld(c.x, c.y);
}

function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / (len * len);
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx, ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

function getStrokesHitByPoint(px, py, radius) {
  const r = radius ?? ERASER_RADIUS;
  const hit = new Set();
  const checkStroke = (points, strokeId) => {
    if (!points || points.length < 2) return;
    for (let i = 0; i < points.length - 1; i++) {
      if (distPointToSegment(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y) <= r) {
        hit.add(strokeId);
        return;
      }
    }
  };
  strokes.forEach((s) => checkStroke(s.points, s.strokeId));
  pending.forEach((points, strokeId) => checkStroke(points, strokeId));
  return hit;
}

function getTopmostStrokeAtPoint(px, py) {
  const hit = getStrokesHitByPoint(px, py, MOVE_HIT_RADIUS);
  if (hit.size === 0) return null;
  let top = null;
  let topSeq = -1;
  strokes.forEach((s) => {
    if (hit.has(s.strokeId) && s.seq != null && s.seq > topSeq) {
      top = s.strokeId;
      topSeq = s.seq;
    }
  });
  return top;
}

function updateCursor() {
  if (panning) canvas.style.cursor = 'grabbing';
  else canvas.style.cursor = tool === 'erase' ? 'cell' : tool === 'move' ? 'grab' : 'crosshair';
}

function setTool(newTool) {
  tool = newTool;
  document.getElementById('tool-draw').classList.toggle('active', tool === 'draw');
  document.getElementById('tool-erase').classList.toggle('active', tool === 'erase');
  document.getElementById('tool-sticky').classList.toggle('active', tool === 'sticky');
  document.getElementById('tool-move').classList.toggle('active', tool === 'move');
  updateCursor();
}

document.getElementById('tool-draw').addEventListener('click', () => setTool('draw'));
document.getElementById('tool-erase').addEventListener('click', () => setTool('erase'));
document.getElementById('tool-sticky').addEventListener('click', () => setTool('sticky'));
document.getElementById('tool-move').addEventListener('click', () => setTool('move'));

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') spaceKey = true;
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceKey = false;
    if (panning) {
      panning = false;
      updateCursor();
    }
  }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || (spaceKey && e.button === 0)) {
    e.preventDefault();
    panning = true;
    panStartX = panX;
    panStartY = panY;
    const c = toCanvasCoords(e);
    pointerStartCanvasX = c.x;
    pointerStartCanvasY = c.y;
    updateCursor();
    return;
  }
  if (e.button !== 0) return;
  if (!ws || ws.readyState !== 1) return;
  const pt = toWorldCoords(e);
  if (tool === 'move') {
    const hit = getTopmostStrokeAtPoint(pt.x, pt.y);
    if (hit) {
      const stroke = strokes.find((s) => s.strokeId === hit);
      if (stroke && stroke.points && stroke.points.length) {
        movingStrokeId = hit;
        moveStartWorld = { x: pt.x, y: pt.y };
        initialStrokePoints = stroke.points.map((p) => ({ x: p.x, y: p.y }));
        e.target.setPointerCapture(e.pointerId);
      }
    }
    return;
  }
  if (tool === 'sticky') {
    const id = uuid();
    const sticky = {
      id,
      x: pt.x,
      y: pt.y,
      width: STICKY_DEFAULT_W,
      height: STICKY_DEFAULT_H,
      text: ''
    };
    stickies.push(sticky);
    renderStickies();
    ws.send(JSON.stringify({
      type: 'ADD_STICKY',
      id,
      x: pt.x,
      y: pt.y,
      width: STICKY_DEFAULT_W,
      height: STICKY_DEFAULT_H
    }));
    return;
  }
  if (tool === 'erase') {
    erasing = true;
    strokesToErase.clear();
    getStrokesHitByPoint(pt.x, pt.y).forEach((id) => strokesToErase.add(id));
    draw();
    return;
  }
  drawing = true;
  currentStrokeId = uuid();
  currentPoints = [pt];
  pending.set(currentStrokeId, [...currentPoints]);
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  const c = toCanvasCoords(e);
  if (panning) {
    panX = panStartX - (c.x - pointerStartCanvasX) / zoom;
    panY = panStartY - (c.y - pointerStartCanvasY) / zoom;
    draw();
    renderStickies();
    return;
  }
  const pt = toWorldCoords(e);
  if (tool === 'move' && movingStrokeId && initialStrokePoints) {
    const dx = pt.x - moveStartWorld.x;
    const dy = pt.y - moveStartWorld.y;
    const stroke = strokes.find((s) => s.strokeId === movingStrokeId);
    if (stroke && stroke.points && stroke.points.length === initialStrokePoints.length) {
      for (let i = 0; i < stroke.points.length; i++) {
        stroke.points[i].x = initialStrokePoints[i].x + dx;
        stroke.points[i].y = initialStrokePoints[i].y + dy;
      }
      draw();
    }
  } else if (tool === 'erase' && erasing) {
    getStrokesHitByPoint(pt.x, pt.y).forEach((id) => strokesToErase.add(id));
    draw();
  } else if (drawing && currentStrokeId) {
    currentPoints.push(pt);
    pending.set(currentStrokeId, [...currentPoints]);
  }
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
  if (e.button === 1 || (panning && e.button === 0)) {
    panning = false;
    updateCursor();
    return;
  }
  if (tool === 'move' && movingStrokeId) {
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    const pt = toWorldCoords(e);
    const dx = pt.x - moveStartWorld.x;
    const dy = pt.y - moveStartWorld.y;
    if ((dx !== 0 || dy !== 0) && strokes.some((s) => s.strokeId === movingStrokeId) && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'MOVE_STROKE', strokeId: movingStrokeId, dx, dy }));
    }
    movingStrokeId = null;
    initialStrokePoints = null;
    draw();
    return;
  }
  if (tool === 'erase' && erasing) {
    erasing = false;
    const ids = new Set(strokesToErase);
    // Same as draw: send to server, everyone (including this client) applies when server broadcasts STROKES_REMOVED
    const toSend = [...ids].filter((id) => strokes.some((s) => s.strokeId === id));
    if (toSend.length && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'DELETE_STROKES', strokeIds: toSend }));
    }
    // Pending-only strokes (not on server yet): remove locally only
    ids.forEach((id) => {
      if (!strokes.some((s) => s.strokeId === id)) pending.delete(id);
    });
    strokesToErase.clear();
    draw();
    return;
  }
  if (!drawing || !currentStrokeId) return;
  drawing = false;
  currentPoints.push(toWorldCoords(e));
  if (ws && ws.readyState === 1 && currentPoints.length >= 2) {
    ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: currentStrokeId, points: currentPoints }));
  }
  currentStrokeId = null;
  currentPoints = [];
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = toCanvasCoords(e);
  const worldBefore = canvasToWorld(c.x, c.y);
  const factor = 1 - e.deltaY * 0.001;
  const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
  if (newZoom === zoom) return;
  zoom = newZoom;
  panX = worldBefore.x - (c.x - VIEW_CENTER_X) / zoom;
  panY = worldBefore.y - (c.y - VIEW_CENTER_Y) / zoom;
  draw();
  renderStickies();
}, { passive: false });

canvas.addEventListener('pointerleave', () => {
  if (panning) {
    panning = false;
    updateCursor();
  }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'CURSOR_LEFT' }));
  if (tool === 'erase' && erasing) {
    erasing = false;
    const ids = new Set(strokesToErase);
    const toSend = [...ids].filter((id) => strokes.some((s) => s.strokeId === id));
    if (toSend.length && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'DELETE_STROKES', strokeIds: toSend }));
    }
    ids.forEach((id) => {
      if (!strokes.some((s) => s.strokeId === id)) pending.delete(id);
    });
    strokesToErase.clear();
    draw();
  }
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

window.addEventListener('resize', () => {
  renderStickies();
});

connect();
draw();
