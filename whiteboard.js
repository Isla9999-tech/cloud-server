const crypto = require('crypto');
const account = require('./account');

function cleanText(value, fallback, maxLen) {
  const text = String(value ?? '').trim().slice(0, maxLen);
  return text || fallback;
}

function finiteNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function validColor(value, fallback = '#ffffff') {
  const text = String(value ?? '');
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(text) ? text : fallback;
}

function validPoint(data) {
  if (!data || typeof data !== 'object') return null;
  const x = finiteNumber(data.x, 0, 1);
  const y = finiteNumber(data.y, 0, 1);
  if (x === null || y === null) return null;
  return { x, y };
}

function init(io, accountModule) {
  const wbIO = io.of('/whiteboard');
  const wbStrokes = [];
  const MAX_STROKES = 500;
  let wbUsers = [];
  const wbCurrentStroke = new Map();
  let wbClearCooldown = 0;
  const CLEAR_COOLDOWN_MS = 5000;

  wbIO.use(accountModule.socketMiddleware());
  wbIO.on('connection', (sock) => {
    console.log(`[WB+] ${sock.id}`);

    sock.on('join', (data = {}) => {
      const colors = ['#e94560', '#f0a000', '#4ecca3', '#7cb8e8', '#a000f0', '#00f0f0'];
      const color = colors[wbUsers.length % colors.length];
      const name = cleanText(data.name, '', 12) || cleanText(sock.userName, '画手', 12);
      const existIdx = wbUsers.findIndex(u => u.id === sock.id);
      if (existIdx >= 0) wbUsers.splice(existIdx, 1);
      wbUsers.push({ id: sock.id, name, color });
      sock.emit('history', wbStrokes);
      wbIO.emit('users', wbUsers);
    });

    sock.on('draw-start', (data = {}) => {
      const point = validPoint(data);
      if (!point) return;
      const size = finiteNumber(data.size, 1, 80) || 3;
      const color = validColor(data.color);
      const strokeId = crypto.randomUUID();
      const stroke = { id: strokeId, sid: sock.id, color, size, points: [point], eraser: !!data.eraser };
      wbStrokes.push(stroke);
      if (wbStrokes.length > MAX_STROKES) wbStrokes.shift();
      wbCurrentStroke.set(sock.id, stroke);
      sock.broadcast.emit('draw-start', stroke);
    });

    sock.on('draw-move', (data = {}) => {
      const point = validPoint(data);
      if (!point) return;
      const stroke = wbCurrentStroke.get(sock.id);
      if (stroke) {
        if (stroke.points.length >= 2000) return;
        stroke.points.push(point);
      }
      sock.broadcast.emit('draw-move', { x: point.x, y: point.y, sid: sock.id });
    });

    sock.on('draw-end', () => {
      wbCurrentStroke.delete(sock.id);
      sock.broadcast.emit('draw-end', { sid: sock.id });
    });

    sock.on('undo', () => {
      for (let i = wbStrokes.length - 1; i >= 0; i--) {
        if (wbStrokes[i].sid === sock.id) {
          const removedId = wbStrokes[i].id;
          wbStrokes.splice(i, 1);
          wbIO.emit('undo', { id: removedId });
          break;
        }
      }
    });

    sock.on('clear', () => {
      const now = Date.now();
      if (now - wbClearCooldown < CLEAR_COOLDOWN_MS) {
        const remaining = Math.ceil((CLEAR_COOLDOWN_MS - (now - wbClearCooldown)) / 1000);
        sock.emit('clear-denied', { reason: `冷却中，请 ${remaining} 秒后再试` });
        return;
      }
      wbClearCooldown = now;
      wbStrokes.length = 0;
      wbIO.emit('clear');
    });

    sock.on('cursor-move', (data = {}) => {
      const point = validPoint(data);
      if (!point) return;
      sock.broadcast.volatile.emit('cursor-move', { sid: sock.id, x: point.x, y: point.y, color: validColor(data.color) });
    });

    sock.on('cursor-leave', () => {
      sock.broadcast.emit('cursor-leave', { sid: sock.id });
    });

    sock.on('disconnect', () => {
      console.log(`[WB-] ${sock.id}`);
      wbCurrentStroke.delete(sock.id);
      const removeIdx = wbUsers.findIndex(u => u.id === sock.id);
      if (removeIdx >= 0) wbUsers.splice(removeIdx, 1);
      wbIO.emit('users', wbUsers);
    });
  });

  return { wbUsers, wbStrokes };
}

module.exports = { init };
