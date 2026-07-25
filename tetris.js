const crypto = require('crypto');
const account = require('./account');

const T_COLS = 10, T_ROWS = 20;
const TETRIS_MAX_ATTACK = 6;
const TETRIS_MAX_SCORE_RATE = 50000;

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

function cleanTetrisCell(cell) {
  if (!cell) return 0;
  if (!Array.isArray(cell) || cell.length !== 3) return 0;
  return cell.map(c => validColor(c, '#555'));
}

function cleanTetrisBoard(board) {
  if (!Array.isArray(board) || board.length !== T_ROWS) return null;
  const cleaned = [];
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== T_COLS) return null;
    cleaned.push(row.map(cleanTetrisCell));
  }
  return cleaned;
}

function emptyBoard() { return Array.from({ length: T_ROWS }, () => Array(T_COLS).fill(0)); }

function genAvatar(name) {
  const safeName = cleanText(name, '玩家', 12);
  const cs = ['#e94560', '#7cb8e8', '#f0a000', '#4ecca3', '#a000f0', '#00f0f0', '#f00000', '#00f000'];
  let h = 0; for (let i = 0; i < safeName.length; i++) h = safeName.charCodeAt(i) + ((h << 5) - h);
  return { letter: safeName[0].toUpperCase(), bg: cs[Math.abs(h) % cs.length] };
}

function genId() { return Math.random().toString(36).slice(2, 8); }

function init(io, accountModule) {
  const tetrisIO = io.of('/tetris');
  const tUsers = new Map();
  const tRooms = new Map();
  const tGames = new Map();
  let _hbTimer;

  function tFindRoom(sid) { for (const [, r] of tRooms) { if (r.players.includes(sid) || r.spectators.includes(sid)) return r; } return null; }
  function tListRooms() {
    const a = []; for (const [, r] of tRooms) { const h = tUsers.get(r.host); a.push({ id: r.id, name: r.name, players: r.players.length, spectators: r.spectators.length, hostName: h ? h.name : '—', playing: !!(r.game && r.game.active) }); } return a;
  }
  function broadcastRoom(r) {
    const ul = []; for (const id of r.players) { const u = tUsers.get(id); if (u) ul.push({ id, name: u.name, avatar: u.avatar }); }
    for (const id of r.spectators) { const u = tUsers.get(id); if (u) ul.push({ id, name: u.name, avatar: u.avatar, spectator: true }); }
    tetrisIO.in(r.id).emit('room-state', { roomId: r.id, name: r.name, host: r.host, users: ul, ready: [...r.ready], gameActive: !!(r.game && r.game.active) });
  }
  function sendSpecState(sock, room) {
    const g = room.game; if (!g || !g.active) return;
    sock.emit('game-start', { player: 0, p1: g.p1, p2: g.p2, roomId: room.id });
    sock.emit('opponent-state', { id: g.p1, board: g.boards[g.p1] || emptyBoard(), score: g.scores[g.p1] || 0, lines: g.lines[g.p1] || 0 });
    sock.emit('opponent-state', { id: g.p2, board: g.boards[g.p2] || emptyBoard(), score: g.scores[g.p2] || 0, lines: g.lines[g.p2] || 0 });
  }
  function cleanupPlayer(sock) {
    const g = tGames.get(sock.id);
    if (g && g.active) { const o = g.p1 === sock.id ? g.p2 : g.p1; tetrisIO.to(o).emit('player-left'); g.active = false; }
    tGames.delete(sock.id);

    let found = false;
    for (const [rid, r] of tRooms) {
      let did = false;
      const pi = r.players.indexOf(sock.id);
      if (pi > -1) { r.players.splice(pi, 1); r.ready.delete(sock.id); did = true; }
      const si = r.spectators.indexOf(sock.id);
      if (si > -1) { r.spectators.splice(si, 1); did = true; }
      if (r.disconnected && r.disconnected.socketId === sock.id) r.disconnected = null;
      if (!did) continue;

      sock.leave(rid);
      if (r._cd) { clearInterval(r._cd); r._cd = null; }

      if (r.players.length === 0 && r.spectators.length === 0) {
        console.log(`[Room] Deleted room ${rid} (empty)`);
        tRooms.delete(rid);
      } else {
        if (r.host === sock.id && r.players.length > 0) r.host = r.players[0];
        broadcastRoom(r);
      }
      found = true; break;
    }
    return found;
  }
  function cleanupGame(g) { tGames.delete(g.p1); tGames.delete(g.p2); g.active = false; const r = tRooms.get(g.roomId); if (r) { r.game = null; r.ready.clear(); broadcastRoom(r); } }

  tetrisIO.use(accountModule.socketMiddleware());
  tetrisIO.on('connection', (sock) => {
    console.log(`[T+] ${sock.id}`);

    sock.on('set-name', (name) => {
      const n = cleanText(name, '', 12) || cleanText(sock.userName, '玩家', 12), a = genAvatar(n); tUsers.set(sock.id, { name: n, avatar: a });
      sock.emit('name-ok', { name: n, avatar: a }); tetrisIO.emit('room-list', tListRooms());
    });

    sock.on('create-room', (name) => {
      const u = tUsers.get(sock.id); if (!u) return sock.emit('room-error', '请先设置昵称');
      const id = genId(), r = { id, name: cleanText(name, u.name + '的房间', 20), host: sock.id, players: [sock.id], spectators: [], ready: new Set(), game: null, _cd: null };
      tRooms.set(id, r); sock.join(id); broadcastRoom(r); tetrisIO.emit('room-list', tListRooms());
    });

    sock.on('join-room', (roomId) => {
      const u = tUsers.get(sock.id); if (!u) return sock.emit('room-error', '请先设置昵称');
      const r = tRooms.get(roomId); if (!r) return sock.emit('room-error', '房间不存在');
      if (r.players.length < 2 && !r.players.includes(sock.id)) { r.players.push(sock.id); sock.join(roomId); }
      else if (!r.players.includes(sock.id) && !r.spectators.includes(sock.id)) { r.spectators.push(sock.id); sock.join(roomId); sendSpecState(sock, r); }
      broadcastRoom(r); tetrisIO.emit('room-list', tListRooms());
    });

    sock.on('spectate-room', (roomId) => {
      const r = tRooms.get(roomId); if (!r) return;
      sock._hb = Date.now();
      if (!r.players.includes(sock.id) && !r.spectators.includes(sock.id)) { r.spectators.push(sock.id); sock.join(roomId); sendSpecState(sock, r); }
      broadcastRoom(r);
    });

    sock.on('leave-room', () => { cleanupPlayer(sock); tetrisIO.emit('room-list', tListRooms()); sock.emit('room-list', tListRooms()); });
    sock.on('list-rooms', () => { sock.emit('room-list', tListRooms()); });

    sock.on('ready', () => {
      const r = tFindRoom(sock.id); if (!r || !r.players.includes(sock.id)) return; if (r.game && r.game.active) return;
      r.ready.add(sock.id); broadcastRoom(r);
      if (r.ready.size >= 2 && r.players.length >= 2) {
        let c = 3; tetrisIO.in(r.id).emit('countdown', c);
        r._cd = setInterval(() => { c--; if (c > 0) { tetrisIO.in(r.id).emit('countdown', c); return; } clearInterval(r._cd); r._cd = null; tetrisIO.in(r.id).emit('countdown', 0);
          const p1 = r.players[0], p2 = r.players[1], g = { roomId: r.id, p1, p2, boards: { [p1]: emptyBoard(), [p2]: emptyBoard() }, scores: { [p1]: 0, [p2]: 0 }, lines: { [p1]: 0, [p2]: 0 }, active: true, winner: null, startTime: Date.now() };
          r.game = g; r.ready.clear(); tGames.set(p1, g); tGames.set(p2, g);
          tetrisIO.to(p1).emit('game-start', { player: 1, opponent: p2, roomId: r.id });
          tetrisIO.to(p2).emit('game-start', { player: 2, opponent: p1, roomId: r.id });
          for (const sid of r.spectators) tetrisIO.to(sid).emit('game-start', { player: 0, p1, p2, roomId: r.id });
          broadcastRoom(r);
        }, 1000);
      }
    });

    sock.on('cancel-ready', () => { const r = tFindRoom(sock.id); if (!r) return; r.ready.delete(sock.id); if (r._cd) { clearInterval(r._cd); r._cd = null; } broadcastRoom(r); });

    sock.on('new-game', () => {
      const r = tFindRoom(sock.id); if (!r || r.host !== sock.id) return;
      if (r._cd) { clearInterval(r._cd); r._cd = null; } if (r.game) cleanupGame(r.game); r.ready.clear(); r.disconnected = null; broadcastRoom(r); tetrisIO.emit('room-list', tListRooms());
    });

    sock.on('board-update', (data = {}) => {
      const g = tGames.get(sock.id); if (!g || !g.active) return;
      const board = cleanTetrisBoard(data.board); if (!board) return;
      const score = Math.max(0, Math.min(999999999, Number.isFinite(Number(data.score)) ? Math.floor(Number(data.score)) : 0));
      const lines = Math.max(0, Math.min(999999, Number.isFinite(Number(data.lines)) ? Math.floor(Number(data.lines)) : 0));

      const elapsed = (Date.now() - g.startTime) / 1000;
      if (elapsed > 1 && score / elapsed > TETRIS_MAX_SCORE_RATE) {
        console.log(`[CHEAT] ${sock.id} score rate ${Math.round(score / elapsed)}/s exceeds limit`);
        return;
      }

      // Track line clears for attack validation
      const prevLines = g.lines[sock.id] || 0;
      const linesCleared = Math.max(0, lines - prevLines);
      if (!g.attackCredits) g.attackCredits = {};
      g.attackCredits[sock.id] = (g.attackCredits[sock.id] || 0) + Math.floor(linesCleared / 2);

      g.boards[sock.id] = board; g.scores[sock.id] = score; g.lines[sock.id] = lines;
      const opp = g.p1 === sock.id ? g.p2 : g.p1;
      tetrisIO.to(opp).emit('opponent-state', { id: sock.id, board, score, lines });
      const r = tRooms.get(g.roomId); if (r) for (const sid of r.spectators) tetrisIO.to(sid).emit('opponent-state', { id: sock.id, board, score, lines });
    });

    sock.on('send-attack', (count) => {
      const g = tGames.get(sock.id);
      if (!g || !g.active) return;
      count = Math.max(0, Math.min(TETRIS_MAX_ATTACK, Number.isFinite(Number(count)) ? Math.floor(Number(count)) : 0));
      if (count <= 0) return;
      // Validate against accumulated attack credits (1 attack per 2 lines cleared)
      if (!g.attackCredits) g.attackCredits = {};
      const credits = g.attackCredits[sock.id] || 0;
      if (credits <= 0) { console.log(`[CHEAT] ${sock.id} sent attack with 0 credits`); return; }
      count = Math.min(count, credits);
      g.attackCredits[sock.id] = credits - count;
      const opp = g.p1 === sock.id ? g.p2 : g.p1, rows = [];
      for (let i = 0; i < count; i++) { const hole = Math.floor(Math.random() * T_COLS), row = Array(T_COLS).fill(1); row[hole] = 0; rows.push(row); }
      tetrisIO.to(opp).emit('incoming-attack', rows);
    });

    sock.on('game-over', () => {
      const g = tGames.get(sock.id); if (!g || !g.active) return;
      const opp = g.p1 === sock.id ? g.p2 : g.p1, wU = tUsers.get(opp), wName = wU ? wU.name : '对手'; g.winner = opp; g.active = false;
      tetrisIO.to(opp).emit('game-end', { winner: opp, winnerName: wName, youWin: true });
      sock.emit('game-end', { winner: opp, winnerName: wName, youWin: false });
      const r = tRooms.get(g.roomId); if (r) for (const sid of r.spectators) tetrisIO.to(sid).emit('game-end', { winner: opp, winnerName: wName });
      cleanupGame(g);
    });

    sock.on('rejoin', (data = {}) => {
      const name = cleanText(data.name, '', 12) || cleanText(sock.userName, '玩家', 12);
      const targetRoom = cleanText(data.roomId, '', 32);
      tUsers.set(sock.id, { name, avatar: genAvatar(name) }); sock._hb = Date.now();

      for (const [rid, r] of tRooms) {
        const dc = r.disconnected;
        if (!dc || dc.name !== name || (targetRoom && rid !== targetRoom)) continue;
        if (dc.token && dc.token !== sock.userToken) continue;

        const oid = dc.socketId, pi = r.players.indexOf(oid);
        if (pi > -1) r.players[pi] = sock.id;
        r.spectators = r.spectators.filter(id => id !== sock.id);
        const si = r.spectators.indexOf(oid); if (si > -1) r.spectators.splice(si, 1);
        if (r.host === oid) r.host = sock.id;
        const og = tGames.get(oid);
        if (og) {
          const board = og.boards[oid] || emptyBoard(), score = og.scores[oid] || 0, lines = og.lines[oid] || 0;
          tGames.delete(oid); tGames.set(sock.id, og); og.boards[sock.id] = board; og.scores[sock.id] = score; og.lines[sock.id] = lines; delete og.boards[oid]; delete og.scores[oid]; delete og.lines[oid];
          const isP1 = og.p1 === oid; if (isP1) og.p1 = sock.id; else og.p2 = sock.id;
          const oid2 = isP1 ? og.p2 : og.p1;
          if (og.winner) { const wU = tUsers.get(og.winner), wName = wU ? wU.name : '对手'; sock.emit('game-end', { winner: og.winner, winnerName: wName, youWin: og.winner === sock.id }); cleanupGame(og); }
          else {
            og.active = true;
            const oSk = tetrisIO.sockets.get(oid2); if (oSk) { oSk.emit('player-back', { name }); oSk.emit('opponent-state', { id: sock.id, board, score, lines }); }
            sock.emit('game-resume', { player: isP1 ? 1 : 2, opponent: oid2, board, score, lines, oppBoard: og.boards[oid2] || emptyBoard(), oppScore: og.scores[oid2] || 0, oppLines: og.lines[oid2] || 0, roomId: rid });
          }
        }
        sock.join(rid); r.disconnected = null; broadcastRoom(r); tetrisIO.emit('room-list', tListRooms()); return;
      }
      sock.emit('rejoin-failed'); sock.emit('room-list', tListRooms());
    });

    sock.on('heartbeat', () => { sock._hb = Date.now(); sock.emit('heartbeat-ack'); });

    sock.on('disconnect', () => {
      console.log(`[T-] ${sock.id}`);
      for (const [rid, r] of tRooms) {
        const pi = r.players.indexOf(sock.id);
        const si = r.spectators.indexOf(sock.id);
        if (pi === -1 && si === -1) continue;

        if (r._cd) { clearInterval(r._cd); r._cd = null; }

        if (pi > -1) {
          const u = tUsers.get(sock.id), dcName = u ? u.name : '对手';
          r.disconnected = { socketId: sock.id, name: dcName, token: sock.userToken, time: Date.now() };
          const g = tGames.get(sock.id); if (g) g.active = false;
          for (const pid of r.players) { if (pid === sock.id) continue; const s = tetrisIO.sockets.get(pid); if (s) s.emit('player-dc', { name: dcName }); }
          const sid = sock.id;
          setTimeout(() => {
            const r2 = tRooms.get(rid); if (!r2) return;
            if (!r2.players.includes(sid)) return;
            for (const pid of r2.players) { if (pid === sid) continue; const s = tetrisIO.sockets.get(pid); if (s) s.emit('player-gone', { name: dcName }); }
            r2.players = r2.players.filter(id => id !== sid);
            r2.ready.delete(sid);
            if (r2.disconnected && r2.disconnected.socketId === sid) r2.disconnected = null;
            const g2 = tGames.get(sid); if (g2) cleanupGame(g2);
            if (r2.players.length === 0 && r2.spectators.length === 0) tRooms.delete(rid);
            else broadcastRoom(r2);
          }, 60000);
        }

        if (si > -1) { r.spectators.splice(si, 1); sock.leave(rid); }

        if (r.players.length === 0 && r.spectators.length === 0) {
          if (r._cd) { clearInterval(r._cd); r._cd = null; }
          tRooms.delete(rid);
        } else {
          broadcastRoom(r);
        }
        break;
      }
      tUsers.delete(sock.id);
      tetrisIO.emit('room-list', tListRooms());
    });

    if (!_hbTimer) {
      _hbTimer = setInterval(() => {
        const now = Date.now();
        for (const [, r] of tRooms) {
          for (const pid of r.players) {
            const s = tetrisIO.sockets.get(pid);
            if (!s || !s._hb) continue;
            // Fix: skip if already disconnected
            if (r.disconnected) continue;
            if (now - s._hb > 8000) {
              const u = tUsers.get(pid), dcName = u ? u.name : '对手';
              s._hb = 0;
              if (r._cd) { clearInterval(r._cd); r._cd = null; }
              r.disconnected = { socketId: pid, name: dcName, token: s.userToken, time: now };
              const g = tGames.get(pid);
              if (g) g.active = false;
              for (const opid of r.players) {
                if (opid === pid) continue;
                const os = tetrisIO.sockets.get(opid);
                if (os) os.emit('player-dc', { name: dcName });
              }
              const rid = r.id;
              setTimeout(() => {
                const r2 = tRooms.get(rid); if (!r2) return;
                if (!r2.players.includes(pid)) return;
                for (const opid of r2.players) { if (opid === pid) continue; const os = tetrisIO.sockets.get(opid); if (os) os.emit('player-gone', { name: dcName }); }
                r2.players = r2.players.filter(id => id !== pid);
                r2.ready.delete(pid);
                if (r2.disconnected && r2.disconnected.socketId === pid) r2.disconnected = null;
                const g2 = tGames.get(pid); if (g2) cleanupGame(g2);
                if (r2.players.length === 0 && r2.spectators.length === 0) tRooms.delete(rid);
                else broadcastRoom(r2);
              }, 60000);
            }
          }
          r.spectators = r.spectators.filter(sid => {
            const s = tetrisIO.sockets.get(sid);
            if (!s || !s._hb) { if (s) s.leave(r.id); return false; }
            return true;
          });
        }
      }, 5000);
    }

    sock.emit('room-list', tListRooms());
  });

  return { tUsers, tRooms, tGames };
}

module.exports = { init };
