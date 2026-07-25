const account = require('./account');

const GRID_W = 40, GRID_H = 30;
const TICK_MS = 150;
const MAX_FOOD = 5;
const INITIAL_LEN = 3;
const SN_COLORS = ['#e94560', '#f0a000', '#4ecca3', '#7cb8e8', '#a000f0', '#00f0f0', '#ff6b9d', '#ffe66d'];
const SN_DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const SN_REV = { up: 'down', down: 'up', left: 'right', right: 'left' };

function cleanText(value, fallback, maxLen) {
  const text = String(value ?? '').trim().slice(0, maxLen);
  return text || fallback;
}

function init(io, accountModule) {
  const snIO = io.of('/snake');
  const snakes = new Map();
  const snDisconnected = new Map();
  const snFood = [];
  const snSockets = new Map();
  let snTick = null, snColorIdx = 0;
  let prevState = null;

  function snOccMap() {
    const m = new Map();
    for (const [sid, sn] of snakes) {
      if (!sn.alive) continue;
      for (let i = 0; i < sn.body.length; i++) {
        const k = sn.body[i].x + ',' + sn.body[i].y;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ sid, isHead: i === 0 });
      }
    }
    return m;
  }

  function snEmptyCells() {
    const occ = new Set();
    for (const [, sn] of snakes) {
      if (!sn.alive) continue;
      for (const s of sn.body) occ.add(s.x + ',' + s.y);
    }
    for (const f of snFood) occ.add(f.x + ',' + f.y);
    const arr = [];
    for (let x = 0; x < GRID_W; x++)
      for (let y = 0; y < GRID_H; y++)
        if (!occ.has(x + ',' + y)) arr.push({ x, y });
    return arr;
  }

  function snSpawn(sid) {
    const sn = snakes.get(sid);
    if (!sn) return false;
    const dirKeys = Object.keys(SN_DIRS);
    const allCells = snEmptyCells();
    // Pre-filter cells by safe bounds for each direction
    const safeBounds = { up: { yMin: INITIAL_LEN }, down: { yMax: GRID_H - INITIAL_LEN }, left: { xMin: INITIAL_LEN }, right: { xMax: GRID_W - INITIAL_LEN } };
    const cellsByDir = {};
    for (const d of dirKeys) {
      const b = safeBounds[d];
      cellsByDir[d] = allCells.filter(c =>
        (b.xMin == null || c.x >= b.xMin) && (b.xMax == null || c.x < b.xMax) &&
        (b.yMin == null || c.y >= b.yMin) && (b.yMax == null || c.y < b.yMax)
      );
      for (let i = cellsByDir[d].length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cellsByDir[d][i], cellsByDir[d][j]] = [cellsByDir[d][j], cellsByDir[d][i]]; }
    }
    const sd = [...dirKeys].sort(() => Math.random() - 0.5);
    for (const d of sd) {
      const cells = cellsByDir[d];
      for (let a = 0; a < Math.min(cells.length, 200); a++) {
        const pos = cells[a];
        const body = [{ x: pos.x, y: pos.y }];
        let ok = true;
        const dv = SN_DIRS[d];
        for (let i = 1; i < INITIAL_LEN; i++) {
          const sx = pos.x - dv.x * i, sy = pos.y - dv.y * i;
          for (const f of snFood) { if (f.x === sx && f.y === sy) { ok = false; break; } }
          if (!ok) break;
          for (const [, os] of snakes) {
            if (!os.alive || os === sn) continue;
            if (os.body.some(s => s.x === sx && s.y === sy)) { ok = false; break; }
          }
          if (!ok) break;
          body.push({ x: sx, y: sy });
        }
        if (ok) {
          sn.body = body; sn.dir = d; sn.nextDir = null;
          sn.alive = true; sn.grow = 0; sn.score = 0; sn.deadUntil = 0;
          return true;
        }
      }
    }
    return false;
  }

  function snDropFood(body, count) {
    const shuffled = [...body].sort(() => Math.random() - 0.5);
    let added = 0;
    for (const seg of shuffled) {
      if (added >= count) break;
      let blocked = false;
      for (const f of snFood) { if (f.x === seg.x && f.y === seg.y) { blocked = true; break; } }
      if (blocked) continue;
      for (const [, sn] of snakes) {
        if (!sn.alive) continue;
        if (sn.body.some(s => s.x === seg.x && s.y === seg.y)) { blocked = true; break; }
      }
      if (!blocked) { snFood.push({ x: seg.x, y: seg.y }); added++; }
    }
  }

  function snEnsureFood() {
    while (snFood.length < MAX_FOOD) {
      const cells = snEmptyCells();
      if (cells.length === 0) break;
      snFood.push(cells[Math.floor(Math.random() * cells.length)]);
    }
  }

  function buildState() {
    const state = { snakes: [], food: [...snFood], gridW: GRID_W, gridH: GRID_H };
    for (const [sid, sn] of snakes) {
      state.snakes.push({
        id: sid, name: sn.name, color: sn.color,
        body: [...sn.body], alive: sn.alive, score: sn.score,
        deadUntil: sn.deadUntil
      });
    }
    return state;
  }

  function buildDelta() {
    if (!prevState) return { type: 'full', ...buildState() };

    const cur = buildState();
    const delta = { type: 'delta', snakes: [], removedSnakes: [], foodAdded: [], foodRemoved: [] };

    // Check snake changes
    const prevSnakeMap = new Map(prevState.snakes.map(s => [s.id, s]));
    const curSnakeMap = new Map(cur.snakes.map(s => [s.id, s]));

    for (const [id, sn] of curSnakeMap) {
      const prev = prevSnakeMap.get(id);
      if (!prev) { delta.snakes.push(sn); continue; }
      if (sn.alive !== prev.alive || sn.score !== prev.score || sn.deadUntil !== prev.deadUntil ||
          sn.body.length !== prev.body.length || sn.name !== prev.name ||
          (sn.body.length > 0 && prev.body.length > 0 && (sn.body[0].x !== prev.body[0].x || sn.body[0].y !== prev.body[0].y))) {
        delta.snakes.push(sn);
      }
    }
    for (const [id] of prevSnakeMap) {
      if (!curSnakeMap.has(id)) delta.removedSnakes.push(id);
    }

    // Check food changes
    const prevFoodSet = new Set(prevState.food.map(f => f.x + ',' + f.y));
    const curFoodSet = new Set(cur.food.map(f => f.x + ',' + f.y));
    for (const f of cur.food) { if (!prevFoodSet.has(f.x + ',' + f.y)) delta.foodAdded.push(f); }
    for (const f of prevState.food) { if (!curFoodSet.has(f.x + ',' + f.y)) delta.foodRemoved.push(f); }

    prevState = cur;
    return delta;
  }

  function snBroadcast() {
    if (snakes.size === 0) return;
    const delta = buildDelta();
    if (delta.type === 'full') {
      snIO.emit('state', delta);
    } else {
      // Only send if there are changes
      if (delta.snakes.length > 0 || delta.removedSnakes.length > 0 || delta.foodAdded.length > 0 || delta.foodRemoved.length > 0) {
        snIO.emit('delta', delta);
      }
    }
  }

  function startSnakeTick() {
    if (snTick) return;
    prevState = buildState();
    snEnsureFood();
    snTick = setInterval(() => {
      for (const [, sn] of snakes) {
        if (!sn.alive) continue;
        if (sn.nextDir) {
          if (sn.nextDir !== SN_REV[sn.dir]) sn.dir = sn.nextDir;
          sn.nextDir = null;
        }
      }
      for (const [, sn] of snakes) {
        if (!sn.alive) continue;
        const d = SN_DIRS[sn.dir];
        const head = sn.body[0];
        sn.body.unshift({ x: head.x + d.x, y: head.y + d.y });
        if (sn.grow > 0) sn.grow--;
        else sn.body.pop();
      }
      const occ = snOccMap();
      const toKill = new Set();
      for (const [, entries] of occ) {
        if (entries.length < 2) continue;
        const heads = entries.filter(e => e.isHead);
        if (heads.length >= 2) {
          for (const h of heads) toKill.add(h.sid);
        } else if (heads.length === 1) {
          toKill.add(heads[0].sid);
        }
      }
      for (const [sid, sn] of snakes) {
        if (!sn.alive || toKill.has(sid)) continue;
        const h = sn.body[0];
        if (h.x < 0 || h.x >= GRID_W || h.y < 0 || h.y >= GRID_H) toKill.add(sid);
      }
      const now = Date.now();
      for (const sid of toKill) {
        const sn = snakes.get(sid);
        if (!sn) continue;
        sn.alive = false; sn.deadUntil = now + 3000;
        snDropFood(sn.body, Math.min(3, sn.body.length));
        sn.body = [];
        snSockets.get(sid)?.emit('you-died');
      }
      for (const [, sn] of snakes) {
        if (!sn.alive) continue;
        const h = sn.body[0];
        const fi = snFood.findIndex(f => f.x === h.x && f.y === h.y);
        if (fi >= 0) { snFood.splice(fi, 1); sn.grow++; sn.score++; }
      }
      for (const [sid, sn] of snakes) {
        if (sn.alive) continue;
        if (sn.deadUntil > 0 && now >= sn.deadUntil) {
          snSpawn(sid);
          if (sn.alive) snSockets.get(sid)?.emit('you-respawned');
        }
      }
      snEnsureFood();
      snBroadcast();
    }, TICK_MS);
  }

  snIO.use(accountModule.socketMiddleware());
  snIO.on('connection', (sock) => {
    console.log(`[SN+] ${sock.id}`);
    snSockets.set(sock.id, sock);
    const color = SN_COLORS[snColorIdx++ % SN_COLORS.length];
    const sn = { id: sock.id, name: '', color, body: [], dir: 'right', nextDir: null, alive: false, grow: 0, score: 0, deadUntil: 0, userToken: sock.userToken };
    snakes.set(sock.id, sn);

    sock.on('join', (data = {}) => {
      sn.name = cleanText(data.name, '', 8) || cleanText(sock.userName, '蛇', 8);
      if (!sn.alive && sn.deadUntil === 0) {
        snSpawn(sock.id);
        if (sn.alive) snSockets.get(sock.id)?.emit('you-respawned');
      }
      snBroadcast();
      startSnakeTick();
    });

    sock.on('rejoin', (data = {}) => {
      const token = sock.userToken;
      let dcEntry = null;
      for (const [t, entry] of snDisconnected) {
        if (t === token) { dcEntry = entry; snDisconnected.delete(t); break; }
      }
      if (dcEntry) {
        clearTimeout(dcEntry.timeout);
        snakes.delete(sock.id);
        const restoredSnake = dcEntry.snake;
        restoredSnake.id = sock.id;
        restoredSnake.userToken = token;
        snakes.set(sock.id, restoredSnake);
        snSockets.set(sock.id, sock);
        snBroadcast();
        startSnakeTick();
      } else {
        sn.name = cleanText(data.name, '蛇', 8);
        if (!sn.alive && sn.deadUntil === 0) {
          snSpawn(sock.id);
          if (sn.alive) snSockets.get(sock.id)?.emit('you-respawned');
        }
        snBroadcast();
        startSnakeTick();
      }
    });

    sock.on('direction', (data = {}) => {
      if (!sn.alive) return;
      const dir = data.dir;
      if (!SN_DIRS[dir]) return;
      sn.nextDir = dir;
    });

    sock.on('disconnect', () => {
      console.log(`[SN-] ${sock.id}`);
      const s = snakes.get(sock.id);
      if (s && s.alive) snDropFood(s.body, Math.min(3, s.body.length));
      if (s && s.userToken) {
        snakes.delete(sock.id);
        snSockets.delete(sock.id);
        const existing = snDisconnected.get(s.userToken);
        if (existing) clearTimeout(existing.timeout);
        const snakeCopy = { ...s };
        const timeout = setTimeout(() => {
          snDisconnected.delete(s.userToken);
          snBroadcast();
        }, 30000);
        snDisconnected.set(s.userToken, { snake: snakeCopy, timeout, name: s.name });
      } else {
        snakes.delete(sock.id);
        snSockets.delete(sock.id);
      }
      snBroadcast();
      if (snakes.size === 0 && snDisconnected.size === 0) { clearInterval(snTick); snTick = null; snFood.length = 0; prevState = null; }
    });
  });

  return { snakes, snFood };
}

module.exports = { init };
