const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

// 6 regular runners
const RUNNER_TEMPLATES = [
  { name: 'ブラックサンダー', color: '#5566ff' },
  { name: 'ゴールデンウィンド', color: '#f4a261' },
  { name: 'サクラストーム',    color: '#e63946' },
  { name: 'シルバーアロー',    color: '#88ccdd' },
  { name: 'ムーンライト',      color: '#aa77ee' },
  { name: 'ターボチャージ',    color: '#2ec4b6' },
];

// 3 special strong runners — each has ~1/3 chance per race
const SPECIAL_RUNNERS = [
  { name: 'レイブンオザワー',    color: '#ff6b9d', special: true },
  { name: 'カネシゲネオー',      color: '#00d4aa', special: true },
  { name: 'ファビエルニヒロー',  color: '#ff9500', special: true },
];

// Base win probabilities for 6 runners (lower house edge → lower odds)
const BASE_PROBS_6 = [0.30, 0.24, 0.18, 0.14, 0.09, 0.05];

const COND_LABELS = ['良', '普通', '悪'];
const COND_MOD    = { '良': 0.04, '普通': 0, '悪': -0.04 };
const PHASE = { WAITING: 'waiting', BETTING: 'betting', RACING: 'racing', RESULT: 'result' };

// Colors assigned to players in a room
const PLAYER_COLORS = ['#ff6b6b','#4d96ff','#6bcb77','#ffd93d','#cc5de8','#ff922b','#20c997','#f06595'];

const rooms   = new Map();
const clients = new Map(); // ws → { clientId, roomId, name }
let clientCounter = 0;

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? genRoomId() : id;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateHorses() {
  // Each special runner has ~1/3 chance of appearing
  const specials = SPECIAL_RUNNERS.filter(() => Math.random() < 1 / 3);
  const n = specials.length;               // 0-3 specials
  const regulars = shuffle([...RUNNER_TEMPLATES]).slice(0, 6 - n);

  // Sort base probs descending; top n go to specials
  const sorted = [...BASE_PROBS_6].sort((a, b) => b - a);
  const specialProbs  = sorted.slice(0, n);
  const regularProbs  = shuffle(sorted.slice(n));

  const pool = shuffle([
    ...specials.map((h, i) => ({ ...h, baseProb: specialProbs[i] })),
    ...regulars.map((h, i) => ({ ...h, baseProb: regularProbs[i] })),
  ]);

  const horses = pool.map((h, i) => {
    const cond   = COND_LABELS[Math.floor(Math.random() * 3)];
    const health = COND_LABELS[Math.floor(Math.random() * 3)];
    // Smaller variation so odds don't explode
    const v = 0.92 + Math.random() * 0.16;
    const raw = Math.max(0.01, h.baseProb * v + COND_MOD[cond] + COND_MOD[health]);
    return { ...h, id: i, cond, health, winProb: raw };
  });

  const total = horses.reduce((s, h) => s + h.winProb, 0);
  horses.forEach(h => {
    h.winProb /= total;
    h.tanshoOdds = Math.max(1.1, Math.round((1 / h.winProb) * 0.78 * 10) / 10);
  });
  return horses;
}

function roomClients(roomId) {
  const out = [];
  clients.forEach((info, ws) => { if (info.roomId === roomId) out.push({ ws, ...info }); });
  return out;
}

function broadcast(roomId, msg) {
  const data = JSON.stringify(msg);
  roomClients(roomId).forEach(({ ws }) => { if (ws.readyState === 1) ws.send(data); });
}

function send(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

// How many tansho bets per runner
function betCounts(room) {
  const c = {};
  room.horses.forEach((_, i) => { c[i] = 0; });
  Object.values(room.bets).forEach(bet => {
    Object.keys(bet.tansho || {}).forEach(h => { if (c[h] !== undefined) c[h]++; });
  });
  return c;
}

// Per-runner list of players who bet on tansho
function betDetails(room) {
  const details = {};
  room.horses.forEach((_, i) => { details[i] = []; });
  roomClients(room.id).forEach(({ clientId, name }) => {
    const bet = room.bets[clientId];
    if (!bet) return;
    const color = room.playerColors[clientId] || '#888';
    Object.keys(bet.tansho || {}).forEach(h => {
      if (details[h]) details[h].push({ name, color });
    });
  });
  return details;
}

function leaderboard(room) {
  return roomClients(room.id)
    .map(({ clientId, name }) => ({
      name, medals: room.medals[clientId] ?? room.startingMedals,
      color: room.playerColors[clientId] || '#888',
    }))
    .sort((a, b) => b.medals - a.medals).slice(0, 10);
}

function publicState(room, clientId) {
  return {
    phase: room.phase, horses: room.horses, timer: room.timer,
    raceResult: room.raceResult, raceProgress: room.raceProgress,
    betCounts: betCounts(room), betDetails: betDetails(room),
    roomId: room.id, startingMedals: room.startingMedals,
    playerCount: roomClients(room.id).length,
    myMedals: clientId != null ? (room.medals[clientId] ?? room.startingMedals) : null,
    myBets: clientId != null ? (room.bets[clientId] || { tansho: {}, nirentan: {} }) : null,
    leaderboard: leaderboard(room),
  };
}

function createRoom(startingMedals) {
  const id = genRoomId();
  const room = {
    id, startingMedals, phase: PHASE.WAITING,
    horses: [], bets: {}, medals: {}, playerColors: {},
    _colorIndex: 0, raceResult: null, raceProgress: [], timer: 20, _timers: [],
  };
  rooms.set(id, room);
  room._timers.push(setTimeout(() => startBetting(id), 1500));
  return room;
}

function assignColor(room, clientId) {
  if (!room.playerColors[clientId]) {
    room.playerColors[clientId] = PLAYER_COLORS[room._colorIndex % PLAYER_COLORS.length];
    room._colorIndex++;
  }
  return room.playerColors[clientId];
}

function startBetting(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (roomClients(roomId).length === 0) {
    room._timers.push(setTimeout(() => startBetting(roomId), 3000));
    return;
  }
  room.phase = PHASE.BETTING;
  room.horses = generateHorses();
  room.bets = {};
  room.raceResult = null;
  room.raceProgress = room.horses.map(() => 0);
  room.timer = 20;

  roomClients(roomId).forEach(({ clientId }) => {
    room.bets[clientId] = { tansho: {}, nirentan: {} };
  });

  broadcast(roomId, { type: 'stateUpdate', state: publicState(room) });
  roomClients(roomId).forEach(({ ws, clientId }) =>
    send(ws, { type: 'myMedals', medals: room.medals[clientId] ?? room.startingMedals }));

  const tick = setInterval(() => {
    room.timer--;
    broadcast(roomId, { type: 'timer', timer: room.timer });
    if (room.timer <= 0) { clearInterval(tick); startRace(roomId); }
  }, 1000);
  room._timers.push(tick);
}

function simulateRace(room) {
  let r1 = Math.random(), cum = 0, first = room.horses.length - 1;
  for (let i = 0; i < room.horses.length; i++) {
    cum += room.horses[i].winProb;
    if (r1 <= cum) { first = i; break; }
  }
  const rem = room.horses.filter((_, i) => i !== first);
  const totRem = rem.reduce((s, h) => s + h.winProb, 0);
  let r2 = Math.random() * totRem, cum2 = 0;
  let second = rem[rem.length - 1];
  for (const h of rem) { cum2 += h.winProb; if (r2 <= cum2) { second = h; break; } }
  return [first, second.id];
}

function startRace(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = PHASE.RACING;
  room.raceResult = simulateRace(room);
  room.raceProgress = room.horses.map(() => 0);
  broadcast(roomId, { type: 'stateUpdate', state: publicState(room) });

  const [r0, r1] = room.raceResult;
  const ft = {};
  ft[r0] = 43 + Math.floor(Math.random() * 4);
  ft[r1] = ft[r0] + 2 + Math.floor(Math.random() * 3);
  room.horses.forEach((_, i) => {
    if (i !== r0 && i !== r1) ft[i] = ft[r1] + 2 + Math.floor(Math.random() * 8);
  });
  const maxTicks = Math.max(...Object.values(ft)) + 5;
  let tick = 0;
  const iv = setInterval(() => {
    tick++;
    room.horses.forEach((_, i) => {
      const t = tick / ft[i];
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      room.raceProgress[i] = tick < ft[i] ? Math.min(99, Math.round(ease * 100)) : 100;
    });
    broadcast(roomId, { type: 'raceProgress', progress: room.raceProgress });
    if (tick >= maxTicks) { clearInterval(iv); showResult(roomId); }
  }, 100);
  room._timers.push(iv);
}

function nirentanOdds(room, first, second) {
  const raw = (1 / room.horses[first].winProb) * (1 / room.horses[second].winProb) * 0.60;
  return Math.max(1.5, Math.round(raw * 10) / 10);
}

function showResult(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.phase = PHASE.RESULT;
  const [first, second] = room.raceResult;
  const nOdds = nirentanOdds(room, first, second);
  const payouts = {};

  Object.entries(room.bets).forEach(([cid, bet]) => {
    let p = 0;
    Object.entries(bet.tansho || {}).forEach(([horse, amount]) => {
      if (parseInt(horse) === first)
        p += Math.floor(amount * room.horses[first].tanshoOdds);
    });
    const key = `${first}-${second}`;
    if (bet.nirentan?.[key])
      p += Math.floor(bet.nirentan[key].amount * nOdds);
    payouts[cid] = p;
    if (room.medals[cid] != null) room.medals[cid] += p;
  });

  broadcast(roomId, {
    type: 'result', first, second,
    tanshoOdds: room.horses[first].tanshoOdds, nirentanOdds: nOdds,
    payouts, medals: room.medals, leaderboard: leaderboard(room),
  });
  room._timers.push(setTimeout(() => startBetting(roomId), 9000));
}

wss.on('connection', (ws) => {
  const clientId = `p${++clientCounter}`;
  clients.set(ws, { clientId, roomId: null, name: `プレイヤー${clientCounter}` });
  send(ws, { type: 'connected', clientId });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const info = clients.get(ws);
      if (!info) return;

      if (msg.type === 'createRoom') {
        const medals = Math.max(100, Math.min(99999, parseInt(msg.startingMedals) || 1000));
        const name = String(msg.name || info.name).slice(0, 12);
        const room = createRoom(medals);
        info.name = name; info.roomId = room.id;
        room.medals[info.clientId] = medals;
        room.bets[info.clientId]   = { tansho: {}, nirentan: {} };
        const myColor = assignColor(room, info.clientId);
        send(ws, { type: 'roomJoined', roomId: room.id, clientId: info.clientId, name, myColor,
          state: publicState(room, info.clientId) });
      }

      if (msg.type === 'joinRoom') {
        const roomId = String(msg.roomId || '').toUpperCase().trim().slice(0, 4);
        const room = rooms.get(roomId);
        if (!room) { send(ws, { type: 'error', message: '部屋が見つかりません' }); return; }
        const name = String(msg.name || info.name).slice(0, 12);
        info.name = name; info.roomId = roomId;
        room.medals[info.clientId] = room.startingMedals;
        room.bets[info.clientId]   = { tansho: {}, nirentan: {} };
        const myColor = assignColor(room, info.clientId);
        broadcast(roomId, { type: 'playerCount', count: roomClients(roomId).length });
        send(ws, { type: 'roomJoined', roomId, clientId: info.clientId, name, myColor,
          state: publicState(room, info.clientId) });
      }

      if (msg.type === 'setName') {
        info.name = String(msg.name).slice(0, 12);
        const room = rooms.get(info.roomId);
        if (room) broadcast(info.roomId, { type: 'leaderboard', leaderboard: leaderboard(room) });
      }

      if (msg.type === 'bet') {
        const room = rooms.get(info.roomId);
        if (!room || room.phase !== PHASE.BETTING) return;
        const { clientId } = info;
        if (!room.bets[clientId]) room.bets[clientId] = { tansho: {}, nirentan: {} };
        const bet = room.bets[clientId];
        let cur = room.medals[clientId] ?? room.startingMedals;

        if (msg.betType === 'tansho') {
          const h = parseInt(msg.horse);
          if (isNaN(h) || h < 0 || h >= room.horses.length) return;
          const old = bet.tansho[h] || 0;
          const amount = Math.max(10, Math.min(cur + old, parseInt(msg.amount) || 100));
          room.medals[clientId] = cur + old - amount;
          bet.tansho[h] = amount;
        }
        if (msg.betType === 'removeTansho') {
          const h = parseInt(msg.horse);
          room.medals[clientId] = cur + (bet.tansho[h] || 0);
          delete bet.tansho[h];
        }
        if (msg.betType === 'nirentan') {
          const f = parseInt(msg.first), s = parseInt(msg.second);
          if (isNaN(f) || isNaN(s) || f === s || f < 0 || s < 0 ||
              f >= room.horses.length || s >= room.horses.length) return;
          const key = `${f}-${s}`;
          const old = bet.nirentan[key]?.amount || 0;
          const amount = Math.max(10, Math.min(cur + old, parseInt(msg.amount) || 100));
          room.medals[clientId] = cur + old - amount;
          bet.nirentan[key] = { first: f, second: s, amount };
        }
        if (msg.betType === 'removeNirentan') {
          const key = `${msg.first}-${msg.second}`;
          room.medals[clientId] = cur + (bet.nirentan[key]?.amount || 0);
          delete bet.nirentan[key];
        }

        send(ws, { type: 'betConfirm', bet, myMedals: room.medals[clientId] });
        broadcast(info.roomId, {
          type: 'betCounts', counts: betCounts(room), details: betDetails(room)
        });
      }
    } catch (e) { console.error(e); }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info?.roomId)
      broadcast(info.roomId, { type: 'playerCount', count: roomClients(info.roomId).length - 1 });
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Derby server on http://localhost:${PORT}`));
