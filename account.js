const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const path = require('path');
const crypto = require('crypto');

let db;

function init(dbPath) {
  const dir = path.dirname(dbPath);
  const fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      token      TEXT UNIQUE NOT NULL,
      is_guest   INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

    CREATE TABLE IF NOT EXISTS music_songs (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id),
      title      TEXT NOT NULL,
      artist     TEXT,
      album      TEXT,
      duration   REAL,
      file_hash  TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_songs_user ON music_songs(user_id);

    CREATE TABLE IF NOT EXISTS music_playlists (
      id         TEXT PRIMARY KEY,
      user_id    TEXT REFERENCES users(id),
      name       TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_music_playlists_user ON music_playlists(user_id);

    CREATE TABLE IF NOT EXISTS music_playlist_songs (
      playlist_id TEXT REFERENCES music_playlists(id) ON DELETE CASCADE,
      song_id     TEXT REFERENCES music_songs(id) ON DELETE CASCADE,
      sort_order  INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, song_id)
    );

    CREATE TABLE IF NOT EXISTS music_stats (
      user_id    TEXT REFERENCES users(id),
      song_id    TEXT REFERENCES music_songs(id) ON DELETE CASCADE,
      play_count INTEGER DEFAULT 0,
      last_played INTEGER,
      liked      INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, song_id)
    );
  `);

  console.log('[Account] Database initialized:', dbPath);
}

function getDB() { return db; }

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function createGuest() {
  const id = nanoid(12);
  const name = '游客' + id.slice(0, 4);
  const token = genToken();
  const now = Date.now();
  db.prepare('INSERT INTO users (id, name, token, is_guest, created_at, last_seen) VALUES (?, ?, ?, 1, ?, ?)')
    .run(id, name, token, now, now);
  return { id, name, token, is_guest: 1 };
}

function getUserByToken(token) {
  if (!token) return null;
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (user) {
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), user.id);
  }
  return user;
}

function upgradeGuest(token, newName) {
  const user = getUserByToken(token);
  if (!user || !user.is_guest) return null;
  const name = String(newName || '').trim().slice(0, 12) || user.name;
  const newToken = genToken();
  const result = db.prepare('UPDATE users SET name = ?, token = ?, is_guest = 0 WHERE id = ? AND token = ? AND is_guest = 1')
    .run(name, newToken, user.id, token);
  if (result.changes === 0) return null;
  return { id: user.id, name, token: newToken, is_guest: 0 };
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const guests = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_guest = 1').get().c;
  const registered = total - guests;
  const active5m = db.prepare('SELECT COUNT(*) as c FROM users WHERE last_seen > ?').get(Date.now() - 300000).c;
  return { total, guests, registered, active5m };
}

// Socket.IO 中间件
function socketMiddleware() {
  return (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    let user = null;
    if (token) user = getUserByToken(token);

    if (user) {
      socket.userId = user.id;
      socket.userName = user.name;
      socket.isGuest = !!user.is_guest;
      socket.userToken = user.token;
      return next();
    }

    // 无效 token → 自动创建游客
    const guest = createGuest();
    socket.userId = guest.id;
    socket.userName = guest.name;
    socket.isGuest = 1;
    socket.userToken = guest.token;
    socket.emit('guest-token', { token: guest.token });
    next();
  };
}

// HTTP 路由注册
function registerRoutes(app) {
  app.post('/api/register', (req, res) => {
    const { name, token } = req.body || {};
    if (!name || !token) return res.status(400).json({ error: '缺少参数' });
    const result = upgradeGuest(token, name);
    if (!result) return res.status(400).json({ error: '注册失败（token 无效或已注册）' });
    res.json(result);
  });

  app.get('/api/me', (req, res) => {
    const token = req.headers['x-token'];
    if (!token) return res.status(401).json({ error: '未登录' });
    const user = getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'token 无效' });
    res.json({ id: user.id, name: user.name, is_guest: !!user.is_guest });
  });

  app.get('/api/account-stats', (req, res) => {
    res.json(getStats());
  });

  // 创建游客（首页无 Socket.IO 时使用）
  app.post('/api/guest', (req, res) => {
    const guest = createGuest();
    res.json(guest);
  });
}

module.exports = { init, getDB, createGuest, getUserByToken, getUserById, upgradeGuest, getStats, socketMiddleware, registerRoutes };
