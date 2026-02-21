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
// Connectors/arrows: { id, from: { type:'sticky'|'text', id }|{ type:'point', x, y }|{ type:'stroke', strokeId }, to: same, color }
const connectors = [];
// Standalone text: { id, x, y, text, color, width?, height?, rotation? }
const textElements = [];
// Frames: { id, x, y, width, height, title? }
const frames = [];
// Selection (sets of ids)
const selectedStickyIds = new Set();
const selectedStrokeIds = new Set();
const selectedTextIds = new Set();
const selectedFrameIds = new Set();
// Marquee drag
let selectionRectStart = null;
let selectionRectCurrent = null;
// Clipboard for copy/paste
let clipboard = null;
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
let tool = 'draw'; // 'draw' | 'erase' | 'sticky' | 'move' | 'fill' | 'rect' | 'circle' | 'arrow'
let pendingShape = null; // { type: 'rect'|'circle', p1: {x,y}, p2: {x,y} }
let pendingFrame = null; // { p1: {x,y}, p2: {x,y} }
let connectorPendingFrom = null; // { type:'sticky', id } | { type:'point', x, y } when waiting for second click
let connectorPreviewTo = null; // { x, y } world coords for preview line while moving
let erasing = false;
const strokesToErase = new Set();
const stickiesToErase = new Set();
const textsToErase = new Set();
const framesToErase = new Set();
const connectorsToErase = new Set();
const ERASER_RADIUS = 20;
let movingStickyId = null;
let movingTextId = null;
let movingFrameId = null;
let initialFrameX = 0;
let initialFrameY = 0;
let resizingStickyId = null;
let resizeStartWorld = null;
let initialStickyW = 0;
let initialStickyH = 0;
let movingStrokeId = null;
let moveStartWorld = null;
let initialStrokePoints = null;
let movedStrokeIdPendingEcho = null; // skip applying STROKE_MOVED echo for this stroke
const MOVE_HIT_RADIUS = 15;
const RESIZE_HANDLE_RADIUS = 12;
let resizingStrokeId = null;
let initialShapePoint1 = null;
const PRESET_COLORS = [
  '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#1e293b', '#0f172a',
  '#f87171', '#fb923c', '#facc15', '#a3e635', '#4ade80', '#22d3ee', '#38bdf8', '#a78bfa', '#f472b6',
  '#fef9c3', '#fecaca', '#fed7aa', '#fef08a', '#bbf7d0', '#a5f3fc', '#ddd6fe', '#fbcfe8',
  '#dc2626', '#ea580c', '#ca8a04', '#65a30d', '#059669', '#0891b2', '#7c3aed', '#db2777'
];
let selectedColor = '#e2e8f0';

function parseHex(str) {
  const s = String(str).trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase();
  if (/^[0-9a-fA-F]{3}$/.test(s)) return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return null;
}

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
      connectors.length = 0;
      (msg.connectors || []).forEach((c) => connectors.push(c));
      textElements.length = 0;
      (msg.textElements || []).forEach((e) => textElements.push(e));
      frames.length = 0;
      (msg.frames || []).forEach((f) => frames.push(f));
      renderStickies();
      renderTextElements();
      draw();
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
        if (msg.text !== undefined) s.text = msg.text;
        if (msg.color !== undefined) s.color = msg.color;
        if (msg.width !== undefined) s.width = msg.width;
        if (msg.height !== undefined) s.height = msg.height;
        if (msg.rotation !== undefined) s.rotation = msg.rotation;
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
      if (msg.strokeId === movedStrokeIdPendingEcho) {
        movedStrokeIdPendingEcho = null;
        return;
      }
      const stroke = strokes.find((s) => s.strokeId === msg.strokeId);
      if (stroke && stroke.points) {
        stroke.points.forEach((p) => {
          p.x += msg.dx;
          p.y += msg.dy;
        });
        draw();
      }
    } else if (msg.type === 'STROKE_COLOR_CHANGED') {
      const stroke = strokes.find((s) => s.strokeId === msg.strokeId);
      if (stroke) {
        stroke.color = msg.color;
        draw();
      }
    } else if (msg.type === 'STROKE_POINTS_UPDATED') {
      const stroke = strokes.find((s) => s.strokeId === msg.strokeId);
      if (stroke && Array.isArray(msg.points)) {
        stroke.points = msg.points.map((p) => ({ x: p.x, y: p.y }));
        draw();
      }
    } else if (msg.type === 'CONNECTOR_ADDED') {
      const c = msg.connector;
      if (c && c.id) {
        const existing = connectors.find((x) => x.id === c.id);
        if (existing) Object.assign(existing, c);
        else connectors.push(c);
        draw();
      }
    } else if (msg.type === 'CONNECTOR_REMOVED') {
      const i = connectors.findIndex((c) => c.id === msg.id);
      if (i >= 0) connectors.splice(i, 1);
      draw();
    } else if (msg.type === 'CONNECTOR_UPDATED' && msg.id && msg.color !== undefined) {
      const c = connectors.find((x) => x.id === msg.id);
      if (c) c.color = msg.color;
      draw();
    } else if (msg.type === 'TEXT_ADDED') {
      const el = msg.textElement;
      if (el && el.id) {
        const existing = textElements.find((e) => e.id === el.id);
        if (existing) Object.assign(existing, el);
        else textElements.push(el);
        renderTextElements();
      }
    } else if (msg.type === 'TEXT_UPDATED') {
      const el = textElements.find((e) => e.id === msg.id);
      if (el) {
        if (msg.text !== undefined) el.text = msg.text;
        if (msg.color !== undefined) el.color = msg.color;
        if (msg.width !== undefined) el.width = msg.width;
        if (msg.height !== undefined) el.height = msg.height;
        if (msg.rotation !== undefined) el.rotation = msg.rotation;
        renderTextElements();
      }
    } else if (msg.type === 'TEXT_REMOVED') {
      const i = textElements.findIndex((e) => e.id === msg.id);
      if (i >= 0) textElements.splice(i, 1);
      renderTextElements();
    } else if (msg.type === 'TEXT_MOVED') {
      const el = textElements.find((e) => e.id === msg.id);
      if (el) {
        el.x = msg.x;
        el.y = msg.y;
        renderTextElements();
      }
    } else if (msg.type === 'FRAME_ADDED') {
      const f = msg.frame;
      if (f && f.id) {
        const existing = frames.find((x) => x.id === f.id);
        if (existing) Object.assign(existing, f);
        else frames.push(f);
        draw();
      }
    } else if (msg.type === 'FRAME_UPDATED') {
      const f = frames.find((x) => x.id === msg.id);
      if (f) {
        if (msg.x !== undefined) f.x = msg.x;
        if (msg.y !== undefined) f.y = msg.y;
        if (msg.width !== undefined) f.width = msg.width;
        if (msg.height !== undefined) f.height = msg.height;
        if (msg.title !== undefined) f.title = msg.title;
        draw();
      }
    } else if (msg.type === 'FRAME_REMOVED') {
      const i = frames.findIndex((x) => x.id === msg.id);
      if (i >= 0) frames.splice(i, 1);
      selectedFrameIds.delete(msg.id);
      draw();
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
const TEXT_DEFAULT_W = 140;
const TEXT_DEFAULT_H = 28;
const FRAME_DEFAULT_W = 300;
const FRAME_DEFAULT_H = 200;
let stickyUpdateDebounce = null;
let textUpdateDebounce = null;

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
      el.innerHTML = '<div class="sticky-header"><button type="button" class="sticky-delete" aria-label="Delete">×</button></div><textarea class="sticky-body" rows="3" placeholder="Write here…"></textarea><div class="sticky-resize-handle" aria-label="Resize"></div>';
      const header = el.querySelector('.sticky-header');
      const body = el.querySelector('.sticky-body');
      const delBtn = el.querySelector('.sticky-delete');
      const resizeHandle = el.querySelector('.sticky-resize-handle');
      resizeHandle.addEventListener('pointerdown', (ev) => {
        if (tool !== 'move' || ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        resizingStickyId = s.id;
        resizeStartWorld = toWorldCoords(ev);
        initialStickyW = s.width;
        initialStickyH = s.height;
        ev.target.setPointerCapture(ev.pointerId);
        const onMove = (e2) => {
          if (resizingStickyId !== s.id) return;
          const pt = toWorldCoords(e2);
          const dw = pt.x - resizeStartWorld.x;
          const dh = pt.y - resizeStartWorld.y;
          const st = stickies.find((x) => x.id === s.id);
          if (st) {
            st.width = Math.max(80, initialStickyW + dw);
            st.height = Math.max(60, initialStickyH + dh);
            clampStickyToVisible(st);
            renderStickies();
          }
        };
        const onUp = (e2) => {
          if (resizingStickyId !== s.id) return;
          ev.target.releasePointerCapture(e2.pointerId);
          const st = stickies.find((x) => x.id === s.id);
          if (st && (st.width !== initialStickyW || st.height !== initialStickyH) && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: s.id, width: st.width, height: st.height }));
          }
          resizingStickyId = null;
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
      el.addEventListener('pointerdown', (ev) => {
        if (tool === 'arrow' && ev.button === 0) {
          ev.preventDefault();
          ev.stopPropagation();
          handleConnectorEndpoint({ type: 'sticky', id: s.id });
          return;
        }
        if (tool === 'fill' && ev.button === 0) {
          ev.preventDefault();
          ev.stopPropagation();
          const st = stickies.find((x) => x.id === s.id);
          if (st) {
            st.color = selectedColor;
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: s.id, color: selectedColor }));
            renderStickies();
          }
        }
      });
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
          clampStickyToVisible(s);
          renderStickies();
        };
        const onUp = (e2) => {
          if (movingStickyId !== s.id) return;
          ev.target.releasePointerCapture(ev.pointerId);
          const pt = toWorldCoords(e2);
          const dist = Math.hypot(pt.x - moveStartCanvas.x, pt.y - moveStartCanvas.y);
          if (dist < 5) {
            if (e2.shiftKey) addToSelection('sticky', s.id);
            else setSelection('sticky', s.id);
            renderStickies();
          } else if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'UPDATE_STICKY_POSITION', id: s.id, x: s.x, y: s.y }));
          }
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
      body.addEventListener('pointerdown', (e) => {
        if (tool === 'arrow' && e.button === 0) {
          e.stopPropagation();
          e.preventDefault();
          handleConnectorEndpoint({ type: 'sticky', id: s.id });
          return;
        }
        if (tool === 'fill' && e.button === 0) {
          e.stopPropagation();
          e.preventDefault();
          const st = stickies.find((x) => x.id === s.id);
          if (st) {
            st.color = selectedColor;
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: s.id, color: selectedColor }));
            renderStickies();
          }
        } else e.stopPropagation();
      });
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
    el.style.background = s.color || '#fef9c3';
    el.classList.toggle('selected', selectedStickyIds.has(s.id));
    el.style.left = `${contentLeft + pos.x * scale}px`;
    el.style.top = `${contentTop + pos.y * scale}px`;
    el.style.width = `${w * scale}px`;
    el.style.height = `${h * scale}px`;
    const body = el.querySelector('.sticky-body');
    const header = el.querySelector('.sticky-header');
    const dispH = h * scale;
    const fs = Math.max(9, dispH * 0.14);
    const pad = Math.max(3, dispH * 0.04);
    if (body) {
      body.style.fontSize = `${fs}px`;
      body.style.lineHeight = 1.4;
      body.style.padding = `${pad}px ${Math.max(4, dispH * 0.05)}px`;
    }
    if (header) header.style.padding = `${Math.max(2, pad * 0.5)}px ${pad}px`;
  });
  existing.forEach((id) => {
    const el = layer.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  });
}

function clampTextToVisible(el) {
  const b = getVisibleWorldBounds();
  const w = el.width || TEXT_DEFAULT_W, h = el.height || TEXT_DEFAULT_H;
  el.x = Math.max(b.minX, Math.min(b.maxX - w, el.x));
  el.y = Math.max(b.minY, Math.min(b.maxY - h, el.y));
}

function renderTextElements() {
  const layer = document.getElementById('text-layer');
  if (!layer) return;
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / CANVAS_W, rect.height / CANVAS_H) || 1;
  const contentLeft = (rect.width - CANVAS_W * scale) / 2;
  const contentTop = (rect.height - CANVAS_H * scale) / 2;
  const existing = new Set(Array.from(layer.querySelectorAll('.text-element'), (el) => el.dataset.id));
  textElements.forEach((el) => {
    existing.delete(el.id);
    let div = layer.querySelector(`[data-id="${el.id}"]`);
    if (!div) {
      div = document.createElement('div');
      div.className = 'text-element';
      div.dataset.id = el.id;
      div.innerHTML = '<button type="button" class="text-delete" aria-label="Delete">×</button><span class="text-content"></span>';
      const content = div.querySelector('.text-content');
      const delBtn = div.querySelector('.text-delete');
      content.contentEditable = 'true';
      content.addEventListener('pointerdown', (ev) => {
        if (tool === 'arrow' && ev.button === 0) {
          ev.preventDefault();
          ev.stopPropagation();
          handleConnectorEndpoint({ type: 'text', id: el.id });
          return;
        }
        if (tool === 'fill' && ev.button === 0) {
          ev.preventDefault();
          ev.stopPropagation();
          const t = textElements.find((x) => x.id === el.id);
          if (t) {
            t.color = selectedColor;
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_ELEMENT', id: el.id, color: selectedColor }));
            renderTextElements();
          }
        }
        ev.stopPropagation();
      });
      content.addEventListener('input', () => {
        clearTimeout(textUpdateDebounce);
        textUpdateDebounce = setTimeout(() => {
          const text = content.textContent || '';
          const t = textElements.find((x) => x.id === el.id);
          if (t) {
            t.text = text;
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_ELEMENT', id: el.id, text }));
          }
        }, 300);
      });
      div.addEventListener('pointerdown', (ev) => {
        if (tool === 'move' && ev.button === 0 && !ev.target.classList.contains('text-delete')) {
          ev.preventDefault();
          ev.stopPropagation();
          movingTextId = el.id;
          moveStartCanvas = toWorldCoords(ev);
          const startX = el.x, startY = el.y;
          div.setPointerCapture(ev.pointerId);
          const onMove = (e2) => {
            if (movingTextId !== el.id) return;
            const pt = toWorldCoords(e2);
            const t = textElements.find((x) => x.id === el.id);
            if (t) {
              t.x = startX + (pt.x - moveStartCanvas.x);
              t.y = startY + (pt.y - moveStartCanvas.y);
              clampTextToVisible(t);
              renderTextElements();
            }
          };
          const onUp = (e2) => {
            if (movingTextId !== el.id) return;
            div.releasePointerCapture(e2.pointerId);
            const pt = toWorldCoords(e2);
            const dist = Math.hypot(pt.x - moveStartCanvas.x, pt.y - moveStartCanvas.y);
            if (dist < 5) {
              if (e2.shiftKey) addToSelection('text', el.id);
              else setSelection('text', el.id);
              renderTextElements();
            } else if (ws && ws.readyState === 1) {
              const t = textElements.find((x) => x.id === el.id);
              if (t) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_POSITION', id: el.id, x: t.x, y: t.y }));
            }
            movingTextId = null;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
          };
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
        }
      });
      delBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_TEXT_ELEMENT', id: el.id }));
      });
      layer.appendChild(div);
    } else {
      const content = div.querySelector('.text-content');
      if (content && content.textContent !== el.text && document.activeElement !== content) content.textContent = el.text || '';
    }
    const pos = worldToCanvas(el.x, el.y);
    const w = (el.width || TEXT_DEFAULT_W) * zoom;
    const h = (el.height || TEXT_DEFAULT_H) * zoom;
    div.style.color = el.color || '#e2e8f0';
    div.classList.toggle('selected', selectedTextIds.has(el.id));
    div.style.left = `${contentLeft + pos.x * scale}px`;
    div.style.top = `${contentTop + pos.y * scale}px`;
    div.style.width = `${w * scale}px`;
    div.style.minHeight = `${h * scale}px`;
    const dispH = h * scale;
    const fs = Math.max(10, dispH * 0.5);
    div.style.fontSize = `${fs}px`;
    div.style.padding = `${Math.max(3, dispH * 0.12)}px ${Math.max(4, dispH * 0.06)}px`;
    const content = div.querySelector('.text-content');
    if (content && document.activeElement !== content) content.textContent = el.text || '';
  });
  existing.forEach((id) => {
    const d = layer.querySelector(`[data-id="${id}"]`);
    if (d) d.remove();
  });
}

function draw() {
  ctx.fillStyle = '#0f0f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = Math.max(0.5, 2 / zoom);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  frames.forEach((f) => {
    const a = worldToCanvas(f.x, f.y);
    const b = worldToCanvas(f.x + (f.width || FRAME_DEFAULT_W), f.y + (f.height || FRAME_DEFAULT_H));
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.8)';
    ctx.fillStyle = 'rgba(30, 41, 59, 0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);
    if (f.title) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.font = `bold ${Math.max(10, 12 / zoom)}px system-ui`;
      ctx.fillText(f.title, x + 8, y + 18);
    }
  });
  if (pendingFrame) {
    const a = worldToCanvas(pendingFrame.p1.x, pendingFrame.p1.y);
    const b = worldToCanvas(pendingFrame.p2.x, pendingFrame.p2.y);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.9)';
    ctx.fillStyle = 'rgba(30, 41, 59, 0.15)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  strokes.forEach((s) => {
    ctx.strokeStyle = s.color || '#e2e8f0';
    if (s.shape === 'rect' && s.points && s.points.length >= 2) {
      const a = worldToCanvas(s.points[0].x, s.points[0].y);
      const b = worldToCanvas(s.points[1].x, s.points[1].y);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.strokeRect(x, y, w, h);
      return;
    }
    if (s.shape === 'circle' && s.points && s.points.length >= 2) {
      const a = worldToCanvas(s.points[0].x, s.points[0].y);
      const b = worldToCanvas(s.points[1].x, s.points[1].y);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
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

  if (tool === 'move') {
    strokes.forEach((s) => {
      if ((s.shape === 'rect' || s.shape === 'circle') && s.points && s.points.length >= 2) {
        const p = worldToCanvas(s.points[1].x, s.points[1].y);
        const r = Math.max(4, RESIZE_HANDLE_RADIUS * zoom);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    });
  }

  ctx.strokeStyle = selectedColor;
  if (pendingShape) {
    const a = worldToCanvas(pendingShape.p1.x, pendingShape.p1.y);
    const b = worldToCanvas(pendingShape.p2.x, pendingShape.p2.y);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (pendingShape.type === 'rect') {
      ctx.strokeRect(x, y, w, h);
    } else {
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
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

  connectors.forEach((c) => {
    const a = connectorEndpointWorld(c.from, c.to);
    const b = connectorEndpointWorld(c.to, c.from);
    if (!a || !b) return;
    const ca = worldToCanvas(a.x, a.y);
    const cb = worldToCanvas(b.x, b.y);
    const color = c.color || '#94a3b8';
    const lineEnd = lineEndBeforeArrowhead(ca.x, ca.y, cb.x, cb.y);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(ca.x, ca.y);
    ctx.lineTo(lineEnd.x, lineEnd.y);
    ctx.stroke();
    drawArrowhead(ctx, ca.x, ca.y, cb.x, cb.y, color);
  });

  if (connectorPendingFrom && connectorPreviewTo) {
    const previewToRef = { type: 'point', x: connectorPreviewTo.x, y: connectorPreviewTo.y };
    const a = connectorEndpointWorld(connectorPendingFrom, previewToRef);
    if (a) {
      const ca = worldToCanvas(a.x, a.y);
      const cb = worldToCanvas(connectorPreviewTo.x, connectorPreviewTo.y);
      const lineEnd = lineEndBeforeArrowhead(ca.x, ca.y, cb.x, cb.y);
      ctx.strokeStyle = selectedColor;
      ctx.setLineDash([4 / zoom, 4 / zoom]);
      ctx.beginPath();
      ctx.moveTo(ca.x, ca.y);
      ctx.lineTo(lineEnd.x, lineEnd.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawArrowhead(ctx, ca.x, ca.y, cb.x, cb.y, selectedColor);
    }
  }

  if (selectionRectCurrent) {
    const a = worldToCanvas(selectionRectCurrent.minX, selectionRectCurrent.minY);
    const b = worldToCanvas(selectionRectCurrent.maxX, selectionRectCurrent.maxY);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  selectedStrokeIds.forEach((strokeId) => {
    const s = strokes.find((x) => x.strokeId === strokeId);
    if (!s) return;
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    if (s.shape === 'rect' && s.points && s.points.length >= 2) {
      const a = worldToCanvas(s.points[0].x, s.points[0].y);
      const b = worldToCanvas(s.points[1].x, s.points[1].y);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      ctx.strokeRect(x, y, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (s.shape === 'circle' && s.points && s.points.length >= 2) {
      const a = worldToCanvas(s.points[0].x, s.points[0].y);
      const b = worldToCanvas(s.points[1].x, s.points[1].y);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.points && s.points.length >= 2) {
      const p0 = worldToCanvas(s.points[0].x, s.points[0].y);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < s.points.length; i++) {
        const p = worldToCanvas(s.points[i].x, s.points[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
  selectedFrameIds.forEach((frameId) => {
    const f = frames.find((x) => x.id === frameId);
    if (!f) return;
    const a = worldToCanvas(f.x, f.y);
    const b = worldToCanvas(f.x + (f.width || FRAME_DEFAULT_W), f.y + (f.height || FRAME_DEFAULT_H));
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
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

function getVisibleWorldBounds() {
  const tl = canvasToWorld(0, 0);
  const br = canvasToWorld(CANVAS_W, CANVAS_H);
  return {
    minX: Math.min(tl.x, br.x),
    minY: Math.min(tl.y, br.y),
    maxX: Math.max(tl.x, br.x),
    maxY: Math.max(tl.y, br.y)
  };
}

function clampStickyToVisible(s) {
  const b = getVisibleWorldBounds();
  const w = s.width || STICKY_DEFAULT_W, h = s.height || STICKY_DEFAULT_H;
  s.x = Math.max(b.minX, Math.min(b.maxX - w, s.x));
  s.y = Math.max(b.minY, Math.min(b.maxY - h, s.y));
}

function clampPointToVisible(x, y) {
  const b = getVisibleWorldBounds();
  return { x: Math.max(b.minX, Math.min(b.maxX, x)), y: Math.max(b.minY, Math.min(b.maxY, y)) };
}

function clampShapeToVisible(points, shape) {
  if (!points || points.length < 2) return;
  const b = getVisibleWorldBounds();
  if (shape === 'rect' || shape === 'circle') {
    const x1 = Math.min(points[0].x, points[1].x), x2 = Math.max(points[0].x, points[1].x);
    const y1 = Math.min(points[0].y, points[1].y), y2 = Math.max(points[0].y, points[1].y);
    const w = x2 - x1, h = y2 - y1;
    let nx1 = Math.max(b.minX, Math.min(b.maxX - w, x1));
    let ny1 = Math.max(b.minY, Math.min(b.maxY - h, y1));
    nx1 = Math.min(nx1, b.maxX - w);
    ny1 = Math.min(ny1, b.maxY - h);
    const nx2 = nx1 + w, ny2 = ny1 + h;
    points[0].x = nx1;
    points[0].y = ny1;
    points[1].x = nx2;
    points[1].y = ny2;
  } else {
    points.forEach((p) => {
      const c = clampPointToVisible(p.x, p.y);
      p.x = c.x;
      p.y = c.y;
    });
  }
}

function clampStrokeToVisible(stroke) {
  if (!stroke || !stroke.points) return;
  clampShapeToVisible(stroke.points, stroke.shape);
}

function worldToCanvas(worldX, worldY) {
  return {
    x: (worldX - panX) * zoom + VIEW_CENTER_X,
    y: (worldY - panY) * zoom + VIEW_CENTER_Y
  };
}

/** Center the view on world coordinates; optional zoom (e.g. 1 = 100%). Used by AI centerView tool. */
function centerView(worldX, worldY, zoomLevel) {
  if (typeof worldX === 'number' && typeof worldY === 'number') {
    panX = worldX;
    panY = worldY;
  }
  if (typeof zoomLevel === 'number') {
    zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel));
  }
  draw();
  renderStickies();
  renderTextElements();
}

function strokeCenterWorld(s) {
  if (!s || !s.points || s.points.length === 0) return null;
  if (s.shape === 'rect' || s.shape === 'circle') {
    const p1 = s.points[0], p2 = s.points[1];
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  }
  let minX = s.points[0].x, minY = s.points[0].y, maxX = minX, maxY = minY;
  s.points.forEach((p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function stickyEdgePoint(sticky, otherWorld) {
  const cx = sticky.x + sticky.width / 2;
  const cy = sticky.y + sticky.height / 2;
  let dx = otherWorld.x - cx;
  let dy = otherWorld.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: cx, y: cy };
  dx /= len;
  dy /= len;
  const x1 = sticky.x, x2 = sticky.x + sticky.width, y1 = sticky.y, y2 = sticky.y + sticky.height;
  let bestT = Infinity;
  if (dx !== 0) {
    let t = (x1 - cx) / dx;
    if (t > 0) {
      const y = cy + t * dy;
      if (y >= y1 && y <= y2) bestT = Math.min(bestT, t);
    }
    t = (x2 - cx) / dx;
    if (t > 0) {
      const y = cy + t * dy;
      if (y >= y1 && y <= y2) bestT = Math.min(bestT, t);
    }
  }
  if (dy !== 0) {
    let t = (y1 - cy) / dy;
    if (t > 0) {
      const x = cx + t * dx;
      if (x >= x1 && x <= x2) bestT = Math.min(bestT, t);
    }
    t = (y2 - cy) / dy;
    if (t > 0) {
      const x = cx + t * dx;
      if (x >= x1 && x <= x2) bestT = Math.min(bestT, t);
    }
  }
  if (bestT === Infinity) return { x: cx, y: cy };
  return { x: cx + bestT * dx, y: cy + bestT * dy };
}

function strokeEdgePoint(stroke, otherWorld) {
  if (!stroke || !stroke.points || stroke.points.length < 2) return strokeCenterWorld(stroke);
  const p1 = stroke.points[0], p2 = stroke.points[1];
  const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
  const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
  const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
  let dx = otherWorld.x - cx, dy = otherWorld.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: cx, y: cy };
  dx /= len;
  dy /= len;

  if (stroke.shape === 'rect') {
    let bestT = Infinity;
    if (dx !== 0) {
      let t = (x1 - cx) / dx;
      if (t > 0) { const y = cy + t * dy; if (y >= y1 && y <= y2) bestT = Math.min(bestT, t); }
      t = (x2 - cx) / dx;
      if (t > 0) { const y = cy + t * dy; if (y >= y1 && y <= y2) bestT = Math.min(bestT, t); }
    }
    if (dy !== 0) {
      let t = (y1 - cy) / dy;
      if (t > 0) { const x = cx + t * dx; if (x >= x1 && x <= x2) bestT = Math.min(bestT, t); }
      t = (y2 - cy) / dy;
      if (t > 0) { const x = cx + t * dx; if (x >= x1 && x <= x2) bestT = Math.min(bestT, t); }
    }
    if (bestT === Infinity) return { x: cx, y: cy };
    return { x: cx + bestT * dx, y: cy + bestT * dy };
  }

  if (stroke.shape === 'circle') {
    const rx = Math.abs(p2.x - p1.x) / 2, ry = Math.abs(p2.y - p1.y) / 2;
    if (rx < 1e-6 || ry < 1e-6) return { x: cx, y: cy };
    const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return { x: cx + t * dx, y: cy + t * dy };
  }

  return strokeCenterWorld(stroke);
}

function textElementEdgePoint(el, otherWorld) {
  const cx = el.x + (el.width || TEXT_DEFAULT_W) / 2;
  const cy = el.y + (el.height || TEXT_DEFAULT_H) / 2;
  const x1 = el.x, x2 = el.x + (el.width || TEXT_DEFAULT_W);
  const y1 = el.y, y2 = el.y + (el.height || TEXT_DEFAULT_H);
  let dx = otherWorld.x - cx, dy = otherWorld.y - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: cx, y: cy };
  dx /= len;
  dy /= len;
  let bestT = Infinity;
  if (dx !== 0) {
    let t = (x1 - cx) / dx;
    if (t > 0) { const y = cy + t * dy; if (y >= y1 && y <= y2) bestT = Math.min(bestT, t); }
    t = (x2 - cx) / dx;
    if (t > 0) { const y = cy + t * dy; if (y >= y1 && y <= y2) bestT = Math.min(bestT, t); }
  }
  if (dy !== 0) {
    let t = (y1 - cy) / dy;
    if (t > 0) { const x = cx + t * dx; if (x >= x1 && x <= x2) bestT = Math.min(bestT, t); }
    t = (y2 - cy) / dy;
    if (t > 0) { const x = cx + t * dx; if (x >= x1 && x <= x2) bestT = Math.min(bestT, t); }
  }
  if (bestT === Infinity) return { x: cx, y: cy };
  return { x: cx + bestT * dx, y: cy + bestT * dy };
}

function connectorEndpointWorldRaw(ref) {
  if (!ref) return null;
  if (ref.type === 'point') return { x: ref.x, y: ref.y };
  if (ref.type === 'sticky') {
    const s = stickies.find((x) => x.id === ref.id);
    if (!s) return null;
    return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
  }
  if (ref.type === 'text') {
    const t = textElements.find((x) => x.id === ref.id);
    if (!t) return null;
    return { x: t.x + (t.width || TEXT_DEFAULT_W) / 2, y: t.y + (t.height || TEXT_DEFAULT_H) / 2 };
  }
  if (ref.type === 'stroke') {
    const s = strokes.find((x) => x.strokeId === ref.strokeId);
    return s ? strokeCenterWorld(s) : null;
  }
  return null;
}

function connectorEndpointWorld(ref, otherRef) {
  if (!ref) return null;
  if (ref.type === 'point') return { x: ref.x, y: ref.y };
  if (ref.type === 'sticky') {
    const s = stickies.find((x) => x.id === ref.id);
    if (!s) return null;
    if (otherRef) {
      const otherWorld = connectorEndpointWorldRaw(otherRef);
      if (otherWorld) return stickyEdgePoint(s, otherWorld);
    }
    return { x: s.x + s.width / 2, y: s.y + s.height / 2 };
  }
  if (ref.type === 'text') {
    const t = textElements.find((x) => x.id === ref.id);
    if (!t) return null;
    if (otherRef) {
      const otherWorld = connectorEndpointWorldRaw(otherRef);
      if (otherWorld) return textElementEdgePoint(t, otherWorld);
    }
    return { x: t.x + (t.width || TEXT_DEFAULT_W) / 2, y: t.y + (t.height || TEXT_DEFAULT_H) / 2 };
  }
  if (ref.type === 'stroke') {
    const s = strokes.find((x) => x.strokeId === ref.strokeId);
    if (!s) return null;
    if (otherRef && (s.shape === 'rect' || s.shape === 'circle')) {
      const otherWorld = connectorEndpointWorldRaw(otherRef);
      if (otherWorld) return strokeEdgePoint(s, otherWorld);
    }
    return strokeCenterWorld(s);
  }
  return null;
}

const ARROW_HEAD_LEN = 10;

function drawArrowhead(ctx, fromX, fromY, toX, toY, color) {
  const headLen = Math.max(8, ARROW_HEAD_LEN / zoom);
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function lineEndBeforeArrowhead(fromX, fromY, toX, toY) {
  const headLen = Math.max(8, ARROW_HEAD_LEN / zoom);
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len <= headLen) return { x: fromX, y: fromY };
  const t = (len - headLen) / len;
  return { x: fromX + dx * t, y: fromY + dy * t };
}

function handleConnectorEndpoint(ref) {
  if (!ref) return;
  if (!connectorPendingFrom) {
    connectorPendingFrom = ref;
    connectorPreviewTo = ref.type === 'point' ? { x: ref.x, y: ref.y } : connectorEndpointWorld(ref);
    draw();
    return;
  }
  const id = uuid();
  const connector = { id, from: connectorPendingFrom, to: ref, color: selectedColor };
  connectors.push(connector);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ADD_CONNECTOR', id, from: connector.from, to: connector.to, color: selectedColor }));
  connectorPendingFrom = null;
  connectorPreviewTo = null;
  draw();
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

function pointInRect(px, py, p1, p2) {
  const x1 = Math.min(p1.x, p2.x), x2 = Math.max(p1.x, p2.x);
  const y1 = Math.min(p1.y, p2.y), y2 = Math.max(p1.y, p2.y);
  return px >= x1 && px <= x2 && py >= y1 && py <= y2;
}

function pointInEllipse(px, py, p1, p2) {
  const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
  const rx = Math.abs(p2.x - p1.x) / 2, ry = Math.abs(p2.y - p1.y) / 2;
  if (rx === 0 || ry === 0) return false;
  return ((px - cx) * (px - cx)) / (rx * rx) + ((py - cy) * (py - cy)) / (ry * ry) <= 1;
}

function getStrokesHitByPoint(px, py, radius) {
  const r = radius ?? ERASER_RADIUS;
  const hit = new Set();
  const checkStroke = (points, strokeId, shape) => {
    if (!points || points.length < 2) return;
    if (shape === 'rect') {
      if (pointInRect(px, py, points[0], points[1])) hit.add(strokeId);
      return;
    }
    if (shape === 'circle') {
      if (pointInEllipse(px, py, points[0], points[1])) hit.add(strokeId);
      return;
    }
    for (let i = 0; i < points.length - 1; i++) {
      if (distPointToSegment(px, py, points[i].x, points[i].y, points[i + 1].x, points[i + 1].y) <= r) {
        hit.add(strokeId);
        return;
      }
    }
  };
  strokes.forEach((s) => checkStroke(s.points, s.strokeId, s.shape));
  pending.forEach((points, strokeId) => checkStroke(points, strokeId, undefined));
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

function getFrameAtPoint(px, py) {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const w = f.width || FRAME_DEFAULT_W, h = f.height || FRAME_DEFAULT_H;
    if (px >= f.x && px <= f.x + w && py >= f.y && py <= f.y + h) return f.id;
  }
  return null;
}

function getStickyAtPoint(px, py) {
  for (let i = stickies.length - 1; i >= 0; i--) {
    const s = stickies[i];
    const w = s.width || STICKY_DEFAULT_W, h = s.height || STICKY_DEFAULT_H;
    if (px >= s.x && px <= s.x + w && py >= s.y && py <= s.y + h) return s.id;
  }
  return null;
}

function getTextAtPoint(px, py) {
  for (let i = textElements.length - 1; i >= 0; i--) {
    const t = textElements[i];
    const w = t.width || TEXT_DEFAULT_W, h = t.height || TEXT_DEFAULT_H;
    if (px >= t.x && px <= t.x + w && py >= t.y && py <= t.y + h) return t.id;
  }
  return null;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / (len * len);
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

function getConnectorsHitByPoint(px, py, radius) {
  const r = radius ?? ERASER_RADIUS;
  const hit = new Set();
  connectors.forEach((c) => {
    const a = connectorEndpointWorld(c.from, c.to);
    const b = connectorEndpointWorld(c.to, c.from);
    if (!a || !b) return;
    if (distanceToSegment(px, py, a.x, a.y, b.x, b.y) <= r) hit.add(c.id);
  });
  return hit;
}

function getObjectsInRect(minX, minY, maxX, maxY) {
  const stickiesIn = [], strokesIn = [], textsIn = [], framesIn = [];
  stickies.forEach((s) => {
    if (s.x + (s.width || 0) >= minX && s.x <= maxX && s.y + (s.height || 0) >= minY && s.y <= maxY) stickiesIn.push(s.id);
  });
  strokes.forEach((s) => {
    if (s.shape === 'rect' || s.shape === 'circle') {
      if (s.points && s.points.length >= 2) {
        const x1 = Math.min(s.points[0].x, s.points[1].x), x2 = Math.max(s.points[0].x, s.points[1].x);
        const y1 = Math.min(s.points[0].y, s.points[1].y), y2 = Math.max(s.points[0].y, s.points[1].y);
        if (x2 >= minX && x1 <= maxX && y2 >= minY && y1 <= maxY) strokesIn.push(s.strokeId);
      }
    } else if (s.points && s.points.length > 0) {
      const inBox = s.points.some((p) => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY);
      if (inBox) strokesIn.push(s.strokeId);
    }
  });
  textElements.forEach((t) => {
    const w = t.width || TEXT_DEFAULT_W, h = t.height || TEXT_DEFAULT_H;
    if (t.x + w >= minX && t.x <= maxX && t.y + h >= minY && t.y <= maxY) textsIn.push(t.id);
  });
  frames.forEach((f) => {
    const w = f.width || FRAME_DEFAULT_W, h = f.height || FRAME_DEFAULT_H;
    if (f.x + w >= minX && f.x <= maxX && f.y + h >= minY && f.y <= maxY) framesIn.push(f.id);
  });
  return { stickiesIn, strokesIn, textsIn, framesIn };
}

function clearSelection() {
  selectedStickyIds.clear();
  selectedStrokeIds.clear();
  selectedTextIds.clear();
  selectedFrameIds.clear();
  renderStickies();
  renderTextElements();
  draw();
}

function setSelection(type, id) {
  clearSelection();
  if (type === 'sticky') selectedStickyIds.add(id);
  else if (type === 'stroke') selectedStrokeIds.add(id);
  else if (type === 'text') selectedTextIds.add(id);
  else if (type === 'frame') selectedFrameIds.add(id);
  renderStickies();
  renderTextElements();
  draw();
}

function addToSelection(type, id) {
  if (type === 'sticky') selectedStickyIds.add(id);
  else if (type === 'stroke') selectedStrokeIds.add(id);
  else if (type === 'text') selectedTextIds.add(id);
  else if (type === 'frame') selectedFrameIds.add(id);
  renderStickies();
  renderTextElements();
  draw();
}

const PASTE_OFFSET = 30;

function deleteSelection() {
  if (!ws || ws.readyState !== 1) return;
  selectedStickyIds.forEach((id) => ws.send(JSON.stringify({ type: 'DELETE_STICKY', id })));
  if (selectedStrokeIds.size) ws.send(JSON.stringify({ type: 'DELETE_STROKES', strokeIds: [...selectedStrokeIds] }));
  selectedTextIds.forEach((id) => ws.send(JSON.stringify({ type: 'DELETE_TEXT_ELEMENT', id })));
  selectedFrameIds.forEach((id) => ws.send(JSON.stringify({ type: 'DELETE_FRAME', id })));
  clearSelection();
}

function duplicateSelection() {
  if (!ws || ws.readyState !== 1) return;
  const dx = PASTE_OFFSET, dy = PASTE_OFFSET;
  selectedStickyIds.forEach((id) => {
    const s = stickies.find((x) => x.id === id);
    if (s) {
      const newId = uuid();
      ws.send(JSON.stringify({
        type: 'ADD_STICKY', id: newId, x: s.x + dx, y: s.y + dy,
        width: s.width, height: s.height, text: s.text || '', color: s.color || '#fef9c3'
      }));
    }
  });
  selectedStrokeIds.forEach((strokeId) => {
    const s = strokes.find((x) => x.strokeId === strokeId);
    if (s && s.points && s.points.length) {
      const newStrokeId = uuid();
      const points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: newStrokeId, points, color: s.color || '#e2e8f0', shape: s.shape }));
    }
  });
  selectedTextIds.forEach((id) => {
    const t = textElements.find((x) => x.id === id);
    if (t) {
      const newId = uuid();
      ws.send(JSON.stringify({
        type: 'ADD_TEXT_ELEMENT', id: newId, x: t.x + dx, y: t.y + dy,
        text: t.text || '', color: t.color || '#e2e8f0', width: t.width, height: t.height
      }));
    }
  });
  selectedFrameIds.forEach((id) => {
    const f = frames.find((x) => x.id === id);
    if (f) {
      const newId = uuid();
      ws.send(JSON.stringify({
        type: 'ADD_FRAME', id: newId, x: f.x + dx, y: f.y + dy,
        width: f.width, height: f.height, title: f.title || ''
      }));
    }
  });
  clearSelection();
}

function copySelection() {
  const stickiesData = [];
  const strokesData = [];
  const textsData = [];
  const framesData = [];
  selectedStickyIds.forEach((id) => {
    const s = stickies.find((x) => x.id === id);
    if (s) stickiesData.push({ x: s.x, y: s.y, width: s.width, height: s.height, text: s.text || '', color: s.color || '#fef9c3' });
  });
  selectedStrokeIds.forEach((strokeId) => {
    const s = strokes.find((x) => x.strokeId === strokeId);
    if (s && s.points) strokesData.push({ points: s.points.map((p) => ({ x: p.x, y: p.y })), color: s.color || '#e2e8f0', shape: s.shape });
  });
  selectedTextIds.forEach((id) => {
    const t = textElements.find((x) => x.id === id);
    if (t) textsData.push({ x: t.x, y: t.y, text: t.text || '', color: t.color || '#e2e8f0', width: t.width, height: t.height });
  });
  selectedFrameIds.forEach((id) => {
    const f = frames.find((x) => x.id === id);
    if (f) framesData.push({ x: f.x, y: f.y, width: f.width, height: f.height, title: f.title || '' });
  });
  if (stickiesData.length || strokesData.length || textsData.length || framesData.length) {
    clipboard = { stickies: stickiesData, strokes: strokesData, texts: textsData, frames: framesData };
  }
}

function pasteFromClipboard() {
  if (!clipboard || (!clipboard.stickies.length && !clipboard.strokes.length && !clipboard.texts.length && !clipboard.frames.length)) return;
  if (!ws || ws.readyState !== 1) return;
  const b = getVisibleWorldBounds();
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const dx = PASTE_OFFSET;
  const dy = PASTE_OFFSET;
  clipboard.stickies.forEach((s) => {
    const newId = uuid();
    ws.send(JSON.stringify({
      type: 'ADD_STICKY', id: newId, x: s.x + dx, y: s.y + dy,
      width: s.width, height: s.height, text: s.text, color: s.color
    }));
  });
  clipboard.strokes.forEach((s) => {
    const newStrokeId = uuid();
    const points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: newStrokeId, points, color: s.color, shape: s.shape }));
  });
  clipboard.texts.forEach((t) => {
    const newId = uuid();
    ws.send(JSON.stringify({
      type: 'ADD_TEXT_ELEMENT', id: newId, x: t.x + dx, y: t.y + dy,
      text: t.text, color: t.color, width: t.width, height: t.height
    }));
  });
  clipboard.frames.forEach((f) => {
    const newId = uuid();
    ws.send(JSON.stringify({
      type: 'ADD_FRAME', id: newId, x: f.x + dx, y: f.y + dy,
      width: f.width, height: f.height, title: f.title
    }));
  });
}

function getShapeResizeHandleAtPoint(px, py) {
  let found = null;
  let topSeq = -1;
  strokes.forEach((s) => {
    if ((s.shape !== 'rect' && s.shape !== 'circle') || !s.points || s.points.length < 2) return;
    const p1 = s.points[1];
    if (Math.hypot(px - p1.x, py - p1.y) <= RESIZE_HANDLE_RADIUS && s.seq != null && s.seq > topSeq) {
      found = s.strokeId;
      topSeq = s.seq;
    }
  });
  return found;
}

function updateCursor() {
  if (panning) canvas.style.cursor = 'grabbing';
  else canvas.style.cursor = tool === 'erase' || tool === 'fill' ? 'cell' : tool === 'move' ? 'grab' : 'crosshair';
}

function setTool(newTool) {
  tool = newTool;
  document.getElementById('tool-draw').classList.toggle('active', tool === 'draw');
  document.getElementById('tool-erase').classList.toggle('active', tool === 'erase');
  document.getElementById('tool-sticky').classList.toggle('active', tool === 'sticky');
  document.getElementById('tool-move').classList.toggle('active', tool === 'move');
  document.getElementById('tool-frame').classList.toggle('active', tool === 'frame');
  document.getElementById('tool-fill').classList.toggle('active', tool === 'fill');
  document.getElementById('tool-rect').classList.toggle('active', tool === 'rect');
  document.getElementById('tool-circle').classList.toggle('active', tool === 'circle');
  document.getElementById('tool-arrow').classList.toggle('active', tool === 'arrow');
  document.getElementById('tool-text').classList.toggle('active', tool === 'text');
  if (tool !== 'arrow') connectorPendingFrom = null;
  connectorPreviewTo = null;
  const boardInner = document.getElementById('board-inner');
  if (boardInner) {
    boardInner.classList.toggle('erase-active', tool === 'erase');
    boardInner.classList.toggle('hand-tool', tool === 'move');
  }
  updateCursor();
}

document.getElementById('tool-draw').addEventListener('click', () => setTool('draw'));
document.getElementById('tool-erase').addEventListener('click', () => setTool('erase'));
document.getElementById('tool-sticky').addEventListener('click', () => setTool('sticky'));
document.getElementById('tool-move').addEventListener('click', () => setTool('move'));
document.getElementById('tool-frame').addEventListener('click', () => setTool('frame'));
  document.getElementById('tool-fill').addEventListener('click', () => setTool('fill'));
document.getElementById('tool-rect').addEventListener('click', () => setTool('rect'));
document.getElementById('tool-circle').addEventListener('click', () => setTool('circle'));
document.getElementById('tool-arrow').addEventListener('click', () => setTool('arrow'));
document.getElementById('tool-text').addEventListener('click', () => setTool('text'));

function setSelectedColor(hex) {
  selectedColor = hex;
  const hexEl = document.getElementById('color-hex');
  if (hexEl) hexEl.value = hex;
  const swatchesEl = document.getElementById('color-swatches');
  if (swatchesEl) {
    swatchesEl.querySelectorAll('.color-swatch').forEach((b) => {
      b.classList.toggle('active', b.style.background === hex);
    });
  }
  const currentEl = document.getElementById('color-current');
  if (currentEl) currentEl.style.background = hex;
}

function renderColorSwatches() {
  const el = document.getElementById('color-swatches');
  if (!el) return;
  el.textContent = '';
  PRESET_COLORS.forEach((hex) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch' + (selectedColor === hex ? ' active' : '');
    btn.style.background = hex;
    btn.title = hex;
    btn.addEventListener('click', () => {
      setSelectedColor(hex);
      const section = document.getElementById('color-section');
      if (section) section.classList.remove('expanded');
    });
    el.appendChild(btn);
  });
  const hexEl = document.getElementById('color-hex');
  if (hexEl) {
    hexEl.value = selectedColor;
    hexEl.addEventListener('input', () => {
      const parsed = parseHex(hexEl.value);
      if (parsed) {
        selectedColor = parsed;
        el.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('active', b.style.background === selectedColor));
      }
    });
    hexEl.addEventListener('change', () => {
      const parsed = parseHex(hexEl.value);
      if (parsed) {
        setSelectedColor(parsed);
        const section = document.getElementById('color-section');
        if (section) section.classList.remove('expanded');
      } else {
        hexEl.value = selectedColor;
      }
    });
  }
}
renderColorSwatches();
const colorCurrentBtn = document.getElementById('color-current');
const colorSectionEl = document.getElementById('color-section');
if (colorCurrentBtn && colorSectionEl) {
  colorCurrentBtn.style.background = selectedColor;
  colorCurrentBtn.addEventListener('click', () => colorSectionEl.classList.toggle('expanded'));
}

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') spaceKey = true;
  const inInput = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || (e.target.isContentEditable && e.target.closest('[contenteditable="true"]'));
  if (inInput) return;
  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (selectedStickyIds.size || selectedStrokeIds.size || selectedTextIds.size || selectedFrameIds.size) {
      e.preventDefault();
      deleteSelection();
        }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
    e.preventDefault();
    if (selectedStickyIds.size || selectedStrokeIds.size || selectedTextIds.size || selectedFrameIds.size) duplicateSelection();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    copySelection();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    e.preventDefault();
    pasteFromClipboard();
    return;
  }
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
    const resizeHandleStroke = getShapeResizeHandleAtPoint(pt.x, pt.y);
    if (resizeHandleStroke) {
      const stroke = strokes.find((s) => s.strokeId === resizeHandleStroke);
      if (stroke && stroke.points && stroke.points.length >= 2) {
        resizingStrokeId = resizeHandleStroke;
        moveStartWorld = { x: pt.x, y: pt.y };
        initialShapePoint1 = { x: stroke.points[1].x, y: stroke.points[1].y };
        e.target.setPointerCapture(e.pointerId);
      }
    } else {
      const frameId = getFrameAtPoint(pt.x, pt.y);
      if (frameId) {
        if (e.shiftKey) addToSelection('frame', frameId);
        else setSelection('frame', frameId);
        const f = frames.find((x) => x.id === frameId);
        if (f) {
          movingFrameId = frameId;
          moveStartWorld = { x: pt.x, y: pt.y };
          initialFrameX = f.x;
          initialFrameY = f.y;
          e.target.setPointerCapture(e.pointerId);
        }
      } else {
        const hit = getTopmostStrokeAtPoint(pt.x, pt.y);
        if (hit) {
          if (e.shiftKey) addToSelection('stroke', hit);
          else setSelection('stroke', hit);
          const stroke = strokes.find((s) => s.strokeId === hit);
          if (stroke && stroke.points && stroke.points.length) {
            movingStrokeId = hit;
            moveStartWorld = { x: pt.x, y: pt.y };
            initialStrokePoints = stroke.points.map((p) => ({ x: p.x, y: p.y }));
            e.target.setPointerCapture(e.pointerId);
          }
        } else {
          // Empty space: pan the board (hand tool drag-to-pan)
          e.preventDefault();
          panning = true;
          panStartX = panX;
          panStartY = panY;
          const c = toCanvasCoords(e);
          pointerStartCanvasX = c.x;
          pointerStartCanvasY = c.y;
          e.target.setPointerCapture(e.pointerId);
          updateCursor();
        }
      }
    }
    return;
  }
  if (tool === 'arrow') {
    const hitStroke = getTopmostStrokeAtPoint(pt.x, pt.y);
    if (hitStroke) handleConnectorEndpoint({ type: 'stroke', strokeId: hitStroke });
    else handleConnectorEndpoint({ type: 'point', x: pt.x, y: pt.y });
    return;
  }
  if (tool === 'text') {
    const id = uuid();
    const textEl = {
      id,
      x: pt.x,
      y: pt.y,
      text: '',
      color: selectedColor,
      width: TEXT_DEFAULT_W,
      height: TEXT_DEFAULT_H
    };
    clampTextToVisible(textEl);
    textElements.push(textEl);
    renderTextElements();
    ws.send(JSON.stringify({
      type: 'ADD_TEXT_ELEMENT',
      id,
      x: textEl.x,
      y: textEl.y,
      text: '',
      color: selectedColor,
      width: TEXT_DEFAULT_W,
      height: TEXT_DEFAULT_H
    }));
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
      text: '',
      color: selectedColor
    };
    clampStickyToVisible(sticky);
    stickies.push(sticky);
    renderStickies();
    ws.send(JSON.stringify({
      type: 'ADD_STICKY',
      id,
      x: sticky.x,
      y: sticky.y,
      width: STICKY_DEFAULT_W,
      height: STICKY_DEFAULT_H,
      color: selectedColor
    }));
    return;
  }
  if (tool === 'erase') {
    erasing = true;
    strokesToErase.clear();
    stickiesToErase.clear();
    textsToErase.clear();
    framesToErase.clear();
    connectorsToErase.clear();
    getStrokesHitByPoint(pt.x, pt.y).forEach((id) => strokesToErase.add(id));
    const sid = getStickyAtPoint(pt.x, pt.y);
    if (sid) stickiesToErase.add(sid);
    const tid = getTextAtPoint(pt.x, pt.y);
    if (tid) textsToErase.add(tid);
    const fid = getFrameAtPoint(pt.x, pt.y);
    if (fid) framesToErase.add(fid);
    getConnectorsHitByPoint(pt.x, pt.y).forEach((id) => connectorsToErase.add(id));
    draw();
    return;
  }
  if (tool === 'fill') {
    const hit = getStrokesHitByPoint(pt.x, pt.y);
    let topId = null;
    let topSeq = -1;
    strokes.forEach((s) => {
      if (hit.has(s.strokeId) && s.seq != null && s.seq > topSeq) {
        topId = s.strokeId;
        topSeq = s.seq;
      }
    });
    if (topId && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'SET_STROKE_COLOR', strokeId: topId, color: selectedColor }));
      const stroke = strokes.find((s) => s.strokeId === topId);
      if (stroke) stroke.color = selectedColor;
      draw();
    }
    return;
  }
  if (tool === 'rect' || tool === 'circle') {
    pendingShape = { type: tool, p1: { x: pt.x, y: pt.y }, p2: { x: pt.x, y: pt.y } };
    draw();
    return;
  }
  if (tool === 'frame') {
    pendingFrame = { p1: { x: pt.x, y: pt.y }, p2: { x: pt.x, y: pt.y } };
    e.target.setPointerCapture(e.pointerId);
    draw();
    return;
  }
  if (tool !== 'draw') return;
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
    renderTextElements();
    return;
  }
  const pt = toWorldCoords(e);
  if (tool === 'move' && resizingStrokeId && initialShapePoint1) {
    const stroke = strokes.find((s) => s.strokeId === resizingStrokeId);
    if (stroke && stroke.points && stroke.points.length >= 2) {
      stroke.points[1].x = initialShapePoint1.x + (pt.x - moveStartWorld.x);
      stroke.points[1].y = initialShapePoint1.y + (pt.y - moveStartWorld.y);
      clampStrokeToVisible(stroke);
      draw();
    }
  } else if (tool === 'move' && movingStrokeId && initialStrokePoints) {
    const dx = pt.x - moveStartWorld.x;
    const dy = pt.y - moveStartWorld.y;
    const stroke = strokes.find((s) => s.strokeId === movingStrokeId);
    if (stroke && stroke.points && stroke.points.length === initialStrokePoints.length) {
      for (let i = 0; i < stroke.points.length; i++) {
        stroke.points[i].x = initialStrokePoints[i].x + dx;
        stroke.points[i].y = initialStrokePoints[i].y + dy;
      }
      clampStrokeToVisible(stroke);
      draw();
    }
  } else if (tool === 'move' && selectionRectStart) {
    selectionRectCurrent = { x: pt.x, y: pt.y };
    draw();
  } else if (tool === 'move' && movingFrameId) {
    const f = frames.find((x) => x.id === movingFrameId);
    if (f) {
      const dx = pt.x - moveStartWorld.x;
      const dy = pt.y - moveStartWorld.y;
      f.x = initialFrameX + dx;
      f.y = initialFrameY + dy;
      draw();
    }
  } else if (tool === 'erase' && erasing) {
    getStrokesHitByPoint(pt.x, pt.y).forEach((id) => strokesToErase.add(id));
    const sid = getStickyAtPoint(pt.x, pt.y);
    if (sid) stickiesToErase.add(sid);
    const tid = getTextAtPoint(pt.x, pt.y);
    if (tid) textsToErase.add(tid);
    const fid = getFrameAtPoint(pt.x, pt.y);
    if (fid) framesToErase.add(fid);
    getConnectorsHitByPoint(pt.x, pt.y).forEach((id) => connectorsToErase.add(id));
    draw();
  } else if (tool === 'arrow' && connectorPendingFrom) {
    connectorPreviewTo = { x: pt.x, y: pt.y };
  } else if (pendingShape) {
    pendingShape.p2 = { x: pt.x, y: pt.y };
  } else if (pendingFrame) {
    pendingFrame.p2 = { x: pt.x, y: pt.y };
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
  if (tool === 'move' && resizingStrokeId) {
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    const stroke = strokes.find((s) => s.strokeId === resizingStrokeId);
    if (stroke && stroke.points && ws && ws.readyState === 1) {
      const p1 = stroke.points[1];
      if (p1 && (p1.x !== initialShapePoint1.x || p1.y !== initialShapePoint1.y)) {
        ws.send(JSON.stringify({ type: 'UPDATE_STROKE_POINTS', strokeId: resizingStrokeId, points: stroke.points }));
      }
    }
    resizingStrokeId = null;
    initialShapePoint1 = null;
    draw();
    return;
  }
  if (tool === 'move' && movingStrokeId) {
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    const pt = toWorldCoords(e);
    const dx = pt.x - moveStartWorld.x;
    const dy = pt.y - moveStartWorld.y;
    if ((dx !== 0 || dy !== 0) && strokes.some((s) => s.strokeId === movingStrokeId) && ws && ws.readyState === 1) {
      movedStrokeIdPendingEcho = movingStrokeId;
      ws.send(JSON.stringify({ type: 'MOVE_STROKE', strokeId: movingStrokeId, dx, dy }));
    }
    movingStrokeId = null;
    initialStrokePoints = null;
    draw();
    return;
  }
  if (tool === 'move' && selectionRectStart != null) {
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    if (selectionRectCurrent) {
      const minX = Math.min(selectionRectStart.x, selectionRectCurrent.x);
      const maxX = Math.max(selectionRectStart.x, selectionRectCurrent.x);
      const minY = Math.min(selectionRectStart.y, selectionRectCurrent.y);
      const maxY = Math.max(selectionRectStart.y, selectionRectCurrent.y);
      const area = (maxX - minX) * (maxY - minY);
      if (area < 25) clearSelection();
      else {
        const inRect = getObjectsInRect(minX, minY, maxX, maxY);
        clearSelection();
        inRect.stickiesIn.forEach((id) => addToSelection('sticky', id));
        inRect.strokesIn.forEach((id) => addToSelection('stroke', id));
        inRect.textsIn.forEach((id) => addToSelection('text', id));
        inRect.framesIn.forEach((id) => addToSelection('frame', id));
      }
    } else clearSelection();
    selectionRectStart = null;
    selectionRectCurrent = null;
    draw();
    return;
  }
  if (tool === 'move' && movingFrameId) {
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    const f = frames.find((x) => x.id === movingFrameId);
    if (f && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'UPDATE_FRAME', frameId: movingFrameId, x: f.x, y: f.y, width: f.width, height: f.height }));
    }
    movingFrameId = null;
    draw();
    return;
  }
  if (tool === 'erase' && erasing) {
    erasing = false;
    const strokeIds = new Set(strokesToErase);
    const toSendStrokes = [...strokeIds].filter((id) => strokes.some((s) => s.strokeId === id));
    if (toSendStrokes.length && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'DELETE_STROKES', strokeIds: toSendStrokes }));
    }
    strokeIds.forEach((id) => {
      if (!strokes.some((s) => s.strokeId === id)) pending.delete(id);
    });
    strokesToErase.clear();
    stickiesToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_STICKY', id }));
    });
    stickiesToErase.clear();
    textsToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_TEXT_ELEMENT', id }));
    });
    textsToErase.clear();
    framesToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_FRAME', id }));
    });
    framesToErase.clear();
    connectorsToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_CONNECTOR', id }));
    });
    connectorsToErase.clear();
    draw();
    renderStickies();
    renderTextElements();
    return;
  }
  if (pendingFrame) {
    try { e.target.releasePointerCapture(e.pointerId); } catch (_) {}
    const x = Math.min(pendingFrame.p1.x, pendingFrame.p2.x);
    const y = Math.min(pendingFrame.p1.y, pendingFrame.p2.y);
    const w = Math.max(20, Math.abs(pendingFrame.p2.x - pendingFrame.p1.x));
    const h = Math.max(20, Math.abs(pendingFrame.p2.y - pendingFrame.p1.y));
    if (ws && ws.readyState === 1) {
      const frameId = uuid();
      ws.send(JSON.stringify({ type: 'ADD_FRAME', id: frameId, x, y, width: w, height: h }));
    }
    pendingFrame = null;
    draw();
    return;
  }
  if (pendingShape) {
    const pts = [{ x: pendingShape.p1.x, y: pendingShape.p1.y }, { x: pendingShape.p2.x, y: pendingShape.p2.y }];
    clampShapeToVisible(pts, pendingShape.type);
    const strokeId = uuid();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId, points: pts, color: selectedColor, shape: pendingShape.type }));
    }
    pendingShape = null;
    draw();
    return;
  }
  if (!drawing || !currentStrokeId) return;
  drawing = false;
  currentPoints.push(toWorldCoords(e));
  if (ws && ws.readyState === 1 && currentPoints.length >= 2) {
    clampShapeToVisible(currentPoints, undefined);
    ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: currentStrokeId, points: currentPoints, color: selectedColor }));
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
  renderTextElements();
}, { passive: false });

canvas.addEventListener('pointerleave', () => {
  if (panning) {
    panning = false;
    updateCursor();
  }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'CURSOR_LEFT' }));
  if (tool === 'erase' && erasing) {
    erasing = false;
    const strokeIds = new Set(strokesToErase);
    const toSendStrokes = [...strokeIds].filter((id) => strokes.some((s) => s.strokeId === id));
    if (toSendStrokes.length && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'DELETE_STROKES', strokeIds: toSendStrokes }));
    }
    strokeIds.forEach((id) => {
      if (!strokes.some((s) => s.strokeId === id)) pending.delete(id);
    });
    strokesToErase.clear();
    stickiesToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_STICKY', id }));
    });
    stickiesToErase.clear();
    textsToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_TEXT_ELEMENT', id }));
    });
    textsToErase.clear();
    framesToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_FRAME', id }));
    });
    framesToErase.clear();
    connectorsToErase.forEach((id) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'DELETE_CONNECTOR', id }));
    });
    connectorsToErase.clear();
    draw();
    renderStickies();
    renderTextElements();
  }
  if (pendingShape) {
    const pts = [{ x: pendingShape.p1.x, y: pendingShape.p1.y }, { x: pendingShape.p2.x, y: pendingShape.p2.y }];
    clampShapeToVisible(pts, pendingShape.type);
    const strokeId = uuid();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId, points: pts, color: selectedColor, shape: pendingShape.type }));
    }
    pendingShape = null;
    draw();
    return;
  }
  if (!drawing || !currentStrokeId) {
    draw();
    return;
  }
  drawing = false;
  if (currentPoints.length >= 2 && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ADD_STROKE', strokeId: currentStrokeId, points: currentPoints, color: selectedColor }));
  } else {
    pending.delete(currentStrokeId);
  }
  currentStrokeId = null;
  currentPoints = [];
  draw();
});

// Console API for testing (call from DevTools: createStickyNote('Hi', 100, 100, '#fef9c3'), etc.)
function createStickyNote(text, x, y, color) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const id = uuid();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'ADD_STICKY',
      id,
      x,
      y,
      text: typeof text === 'string' ? text : '',
      color: typeof color === 'string' ? color : '#fef9c3'
    }));
  }
  return id;
}

function createShape(type, x, y, width, height, color) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const shape = type === 'circle' ? 'circle' : 'rect';
  const w = typeof width === 'number' && width > 0 ? width : 100;
  const h = typeof height === 'number' && height > 0 ? height : 80;
  const strokeId = uuid();
  const points = [{ x, y }, { x: x + w, y: y + h }];
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'ADD_STROKE',
      strokeId,
      points,
      color: typeof color === 'string' ? color : '#e2e8f0',
      shape
    }));
  }
  return strokeId;
}

function createFrame(title, x, y, width, height) {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const id = uuid();
  const w = typeof width === 'number' && width >= 60 ? width : FRAME_DEFAULT_W;
  const h = typeof height === 'number' && height >= 40 ? height : FRAME_DEFAULT_H;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'ADD_FRAME',
      id,
      x,
      y,
      width: w,
      height: h,
      title: typeof title === 'string' ? title : ''
    }));
  }
  return id;
}

function _refFromId(id) {
  if (stickies.some((s) => s.id === id)) return { type: 'sticky', id };
  if (textElements.some((t) => t.id === id)) return { type: 'text', id };
  if (strokes.some((s) => s.strokeId === id)) return { type: 'stroke', strokeId: id };
  if (Array.isArray(id) && id.length >= 2 && typeof id[0] === 'number' && typeof id[1] === 'number') return { type: 'point', x: id[0], y: id[1] };
  return null;
}

function createConnector(fromId, toId, style) {
  const from = _refFromId(fromId);
  const to = _refFromId(toId);
  if (!from || !to) return null;
  const id = uuid();
  const color = typeof style === 'string' ? style : '#94a3b8';
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ADD_CONNECTOR', id, from, to, color }));
  }
  return id;
}

function moveObject(objectId, x, y) {
  if (typeof x !== 'number' || typeof y !== 'number') return false;
  const s = stickies.find((o) => o.id === objectId);
  if (s) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY_POSITION', id: objectId, x, y }));
    return true;
  }
  const t = textElements.find((o) => o.id === objectId);
  if (t) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_POSITION', id: objectId, x, y }));
    return true;
  }
  const f = frames.find((o) => o.id === objectId);
  if (f) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_FRAME', id: objectId, x, y, width: f.width, height: f.height }));
    return true;
  }
  const stroke = strokes.find((o) => o.strokeId === objectId);
  if (stroke && stroke.points && stroke.points.length) {
    const center = strokeCenterWorld(stroke);
    if (center && ws && ws.readyState === 1) {
      const dx = x - center.x;
      const dy = y - center.y;
      ws.send(JSON.stringify({ type: 'MOVE_STROKE', strokeId: objectId, dx, dy }));
    }
    return true;
  }
  return false;
}

function resizeObject(objectId, width, height) {
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  const s = stickies.find((o) => o.id === objectId);
  if (s) {
    if (width >= 40 && height >= 30 && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: objectId, width, height }));
    return true;
  }
  const t = textElements.find((o) => o.id === objectId);
  if (t) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_ELEMENT', id: objectId, width, height }));
    return true;
  }
  const f = frames.find((o) => o.id === objectId);
  if (f) {
    if (width >= 60 && height >= 40 && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_FRAME', id: objectId, width, height }));
    return true;
  }
  const stroke = strokes.find((o) => o.strokeId === objectId);
  if (stroke && (stroke.shape === 'rect' || stroke.shape === 'circle') && stroke.points && stroke.points.length >= 2) {
    const p0 = stroke.points[0];
    const points = [p0, { x: p0.x + width, y: p0.y + height }];
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STROKE_POINTS', strokeId: objectId, points }));
    return true;
  }
  return false;
}

function updateText(objectId, newText) {
  const str = typeof newText === 'string' ? newText : '';
  const s = stickies.find((o) => o.id === objectId);
  if (s) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: objectId, text: str }));
    return true;
  }
  const t = textElements.find((o) => o.id === objectId);
  if (t) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_ELEMENT', id: objectId, text: str }));
    return true;
  }
  return false;
}

function changeColor(objectId, color) {
  if (typeof color !== 'string') return false;
  const s = stickies.find((o) => o.id === objectId);
  if (s) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_STICKY', id: objectId, color }));
    return true;
  }
  const t = textElements.find((o) => o.id === objectId);
  if (t) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_TEXT_ELEMENT', id: objectId, color }));
    return true;
  }
  const stroke = strokes.find((o) => o.strokeId === objectId);
  if (stroke) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'SET_STROKE_COLOR', strokeId: objectId, color }));
    return true;
  }
  const c = connectors.find((o) => o.id === objectId);
  if (c) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'UPDATE_CONNECTOR', id: objectId, color }));
    return true;
  }
  return false;
}

function getBoardState() {
  return {
    stickies: stickies.map((s) => ({ ...s })),
    strokes: strokes.map((s) => ({ ...s, points: s.points ? s.points.map((p) => ({ ...p })) : [] })),
    textElements: textElements.map((t) => ({ ...t })),
    frames: frames.map((f) => ({ ...f })),
    connectors: connectors.map((c) => ({ ...c }))
  };
}

window.whiteboard = {
  createStickyNote,
  createShape,
  createFrame,
  createConnector,
  moveObject,
  resizeObject,
  updateText,
  changeColor,
  getBoardState,
  centerView
};
Object.keys(window.whiteboard).forEach((k) => { window[k] = window.whiteboard[k]; });

window.addEventListener('resize', () => {
  renderStickies();
  renderTextElements();
});

// AI command panel: POST to /api/ai/command (LangChain + GPT-4o), show result
(function initAiCommandPanel() {
  const panel = document.getElementById('ai-command-panel');
  const toggle = document.getElementById('ai-panel-toggle');
  const input = document.getElementById('ai-command-input');
  const runBtn = document.getElementById('ai-command-run');
  const statusEl = document.getElementById('ai-command-status');
  if (!panel || !toggle || !input || !runBtn) return;

  toggle.addEventListener('click', () => {
    panel.classList.toggle('ai-panel-collapsed');
  });

  function setStatus(msg, type) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'ai-command-status' + (type ? ' ' + type : '');
  }

  async function runCommand() {
    const text = (input.value || '').trim();
    if (!text) return;
    runBtn.disabled = true;
    setStatus('Running…', '');
    window.dispatchEvent(new CustomEvent('ai-command-run', { detail: { text } }));
    if (typeof window.onAiCommandRun === 'function') window.onAiCommandRun(text);
    try {
      const res = await fetch('/api/ai/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ command: text })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || 'Request failed', 'error');
        return;
      }
      const msg = data.message || 'Done.';
      const n = data.toolCalls;
      setStatus(n ? `${msg} (${n} tool${n === 1 ? '' : 's'} run)` : msg, 'success');
      if (data.viewCenter && typeof data.viewCenter.x === 'number' && typeof data.viewCenter.y === 'number') {
        centerView(data.viewCenter.x, data.viewCenter.y, data.viewCenter.zoom);
      }
    } catch (err) {
      setStatus(err.message || 'Network error', 'error');
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', runCommand);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runCommand();
    }
  });
})();

connect();
draw();
