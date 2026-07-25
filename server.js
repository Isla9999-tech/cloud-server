const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const account = require('./account');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ===== 安全响应头 =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "blob:", "data:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      mediaSrc: ["'self'", "blob:"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));

// 初始化账号系统
account.init(path.join(__dirname, 'data', 'app.db'));
app.use(express.json({ limit: '1mb' }));
account.registerRoutes(app);

// ===== CSRF 保护 =====
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const origin = req.headers.origin || '';
    const referer = req.headers.referer || '';
    const host = req.headers.host || '';
    // Must have origin or referer, and it must match the host exactly
    if (!origin && !referer) {
      return res.status(403).json({ error: 'CSRF 检测失败：缺少 Origin/Referer' });
    }
    const source = origin || referer;
    try {
      const url = new URL(source);
      if (url.host !== host) {
        return res.status(403).json({ error: 'CSRF 检测失败：来源不匹配' });
      }
    } catch {
      return res.status(403).json({ error: 'CSRF 检测失败：无效来源' });
    }
  }
  next();
});

// ===== API 速率限制 =====
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/', apiLimiter);

const guestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '创建游客过于频繁' }
});
app.use('/api/guest', guestLimiter);

// ===== 工具函数 =====
function cleanText(value, fallback, maxLen) {
  const text = String(value ?? '').trim().slice(0, maxLen);
  return text || fallback;
}

function finiteNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// ===== 路由 =====
app.get('/ping', (req, res) => res.send('ok'));
app.get('/whiteboard', (req, res) => res.sendFile(__dirname + '/public/whiteboard/index.html', { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } }));
app.get('/api/status', (req, res) => res.json(buildStatus()));
app.get('/status', (req, res) => res.sendFile(__dirname + '/public/status/index.html', { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } }));
app.get('/snake', (req, res) => res.sendFile(__dirname + '/public/snake/index.html', { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } }));
app.get('/music', (req, res) => res.sendFile(__dirname + '/public/music/index.html', { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } }));

// ===== Music API =====
function getMusicDB() { return account.getDB(); }

app.get('/api/music/data', (req, res) => {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const user = account.getUserByToken(token);
  if (!user || user.is_guest) return res.json({ songs: [], playlists: [], stats: [] });
  const db = getMusicDB();
  const songs = db.prepare('SELECT * FROM music_songs WHERE user_id = ?').all(user.id);
  const playlists = db.prepare('SELECT * FROM music_playlists WHERE user_id = ? ORDER BY sort_order').all(user.id);
  for (const p of playlists) {
    p.songIds = db.prepare('SELECT song_id FROM music_playlist_songs WHERE playlist_id = ? ORDER BY sort_order').all(p.id).map(r => r.song_id);
  }
  const stats = db.prepare('SELECT * FROM music_stats WHERE user_id = ?').all(user.id);
  res.json({ songs, playlists, stats });
});

app.post('/api/music/sync', (req, res) => {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const user = account.getUserByToken(token);
  if (!user || user.is_guest) return res.status(400).json({ error: '游客不能同步' });
  const { songs, playlists, stats } = req.body || {};
  const db = getMusicDB();
  const now = Date.now();
  const insertSong = db.prepare('INSERT OR REPLACE INTO music_songs (id, user_id, title, artist, album, duration, file_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertPlaylist = db.prepare('INSERT OR REPLACE INTO music_playlists (id, user_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertPS = db.prepare('INSERT OR REPLACE INTO music_playlist_songs (playlist_id, song_id, sort_order) VALUES (?, ?, ?)');
  const insertStat = db.prepare('INSERT OR REPLACE INTO music_stats (user_id, song_id, play_count, last_played, liked) VALUES (?, ?, ?, ?, ?)');

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM music_songs WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM music_playlists WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM music_stats WHERE user_id = ?').run(user.id);

    for (const s of (songs || [])) {
      const id = cleanText(s.id, '', 64);
      if (!id) continue;
      insertSong.run(id, user.id, cleanText(s.title, '', 200), cleanText(s.artist, '', 100), cleanText(s.album, '', 100), finiteNumber(s.duration, 0, 7200) || 0, cleanText(s.file_hash, '', 64), finiteNumber(s.created_at, 0, now + 86400000) || now);
    }
    for (let i = 0; i < (playlists || []).length; i++) {
      const p = playlists[i];
      const pid = cleanText(p.id, '', 64);
      if (!pid) continue;
      insertPlaylist.run(pid, user.id, cleanText(p.name, '', 100), finiteNumber(p.sort_order, 0, 9999) ?? i, finiteNumber(p.created_at, 0, now + 86400000) || now);
      db.prepare('DELETE FROM music_playlist_songs WHERE playlist_id = ?').run(pid);
      for (let j = 0; j < (p.songIds || []).length; j++) {
        const sid = cleanText(p.songIds[j], '', 64);
        if (sid) insertPS.run(pid, sid, j);
      }
    }
    for (const st of (stats || [])) {
      const sid = cleanText(st.song_id, '', 64);
      if (!sid) continue;
      insertStat.run(user.id, sid, finiteNumber(st.play_count, 0, 999999) || 0, finiteNumber(st.last_played, 0, now + 86400000) || 0, st.liked ? 1 : 0);
    }
  });
  txn();
  res.json({ ok: true });
});

app.use(express.static('public', { setHeaders: (res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));

// ===== 聊天室 =====
const messages = [];
const MAX_MESSAGES = 200;
const onlineUsers = new Map();

function formatTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

io.use(account.socketMiddleware());
io.on('connection', (socket) => {
  console.log(`新连接: ${socket.id}`);

  socket.on('join', (data = {}) => {
    const oldUser = onlineUsers.get(socket.id);
    const username = cleanText(data.username, '', 12) || cleanText(socket.userName, '游客', 12);
    const room = '大厅';
    socket.join(room);
    onlineUsers.set(socket.id, { username, room });

    socket.emit('history', messages);

    if (!oldUser || oldUser.username !== username) {
      socket.to(room).emit('chat message', {
        type: 'system',
        text: `${username} 加入了聊天室`,
        time: formatTime()
      });
    }

    updateRoomUsers(room);
    console.log(`${username} 加入 ${room}`);
  });

  socket.on('chat message', (msg) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    const text = cleanText(msg, '', 500);
    if (!text) return;

    const message = {
      type: 'chat',
      username: user.username,
      text,
      time: formatTime()
    };

    messages.push(message);
    if (messages.length > MAX_MESSAGES) messages.shift();

    io.to(user.room).emit('chat message', message);
  });

  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      socket.to(user.room).emit('chat message', {
        type: 'system',
        text: `${user.username} 离开了聊天室`,
        time: formatTime()
      });

      onlineUsers.delete(socket.id);
      updateRoomUsers(user.room);
      console.log(`${user.username} 离开`);
    }
  });

  function updateRoomUsers(room) {
    const users = [];
    onlineUsers.forEach((u, id) => {
      if (u.room === room) users.push(u.username);
    });
    io.to(room).emit('room users', users);
  }
});

// ===== 加载游戏模块 =====
const tetris = require('./tetris');
const snake = require('./snake');
const whiteboard = require('./whiteboard');

tetris.init(io, account);
snake.init(io, account);
whiteboard.init(io, account);

// ===== 系统状态 =====
let cpuUsage = 0;
let lastCpus = os.cpus();
setInterval(() => {
  const now = os.cpus();
  let totalDiff = 0, idleDiff = 0;
  const count = Math.min(now.length, lastCpus.length);
  for (let i = 0; i < count; i++) {
    const p = lastCpus[i].times, c = now[i].times;
    const pt = p.user + p.nice + p.sys + p.idle + p.irq;
    const ct = c.user + c.nice + c.sys + c.idle + c.irq;
    totalDiff += ct - pt;
    idleDiff += c.idle - p.idle;
  }
  if (totalDiff > 0) cpuUsage = Math.round((1 - idleDiff / totalDiff) * 100);
  lastCpus = now;
}, 2000);

function buildStatus() {
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const memUsed = process.memoryUsage();
  const tetrisData = tetris.tUsers ? { online: tetris.tUsers.size, rooms: tetris.tRooms.size, gamesActive: [...tetris.tGames.values()].filter(g => g.active).length } : { online: 0, rooms: 0, gamesActive: 0 };
  const whiteboardData = whiteboard.wbUsers ? { online: whiteboard.wbUsers.length, strokes: whiteboard.wbStrokes.length } : { online: 0, strokes: 0 };
  const snakeData = snake.snakes ? { online: [...snake.snakes.values()].filter(s => s.alive).length, total: snake.snakes.size, food: snake.snFood.length } : { online: 0, total: 0, food: 0 };

  return {
    system: {
      cpuCores: os.cpus().length,
      cpuUsage,
      totalMem: (totalMem / 1e9).toFixed(1) + ' GB',
      memUsage: Math.round((1 - freeMem / totalMem) * 100),
      osUptime: Math.floor(os.uptime())
    },
    process: {
      nodeVersion: process.version,
      uptime: Math.floor(process.uptime()),
      heapMB: (memUsed.heapUsed / 1e6).toFixed(1),
      heapTotalMB: (memUsed.heapTotal / 1e6).toFixed(1),
      rssMB: (memUsed.rss / 1e6).toFixed(1)
    },
    services: {
      chat: { online: onlineUsers.size, messages: messages.length },
      tetris: tetrisData,
      whiteboard: whiteboardData,
      snake: snakeData
    },
    time: Date.now()
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ISLA LABS: http://localhost:${PORT}`);
});
