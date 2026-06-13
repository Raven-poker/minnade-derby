const WS_URL = location.protocol === 'https:' ? `wss://${location.host}` : `ws://${location.host}`;

// Track geometry — must match SVG viewBox values in index.html
const CX = 290, CY = 145;
const LANE_RX = [185, 201, 216, 232, 247, 263];
const LANE_RY = [ 58,  73,  89, 104, 120, 136];

// Progress > 100 allowed so runners can overshoot the finish line
function lanePos(progress, lane) {
  const angle = -Math.PI / 2 + (progress / 100) * 2 * Math.PI;
  return {
    x: CX + LANE_RX[lane] * Math.cos(angle),
    y: CY + LANE_RY[lane] * Math.sin(angle),
  };
}

let ws, clientId = null, myName = '', myColor = '#888';
let horses = [], phase = 'waiting', myMedals = 0;
let betState  = { tansho: {}, nirenfuku: {} };
let countdown = null;
let finishedSet = new Set();
const OVERSHOOT = 107;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose   = () => setTimeout(connect, 2000);
}
function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

function handle(msg) {
  switch (msg.type) {
    case 'connected': clientId = msg.clientId; break;

    case 'roomJoined':
      clientId = msg.clientId;
      myName   = msg.name;
      myColor  = msg.myColor || '#888';
      document.getElementById('nameInput').value = myName;
      document.getElementById('roomBadge').textContent = `部屋: ${msg.roomId}`;
      document.getElementById('myColorDot').style.background = myColor;
      document.getElementById('lobby').classList.add('hidden');
      document.getElementById('gameArea').classList.remove('hidden');
      applyState(msg.state);
      break;

    case 'stateUpdate': applyState(msg.state); break;
    case 'timer':       updateTimer(msg.timer); break;
    case 'raceProgress': updateProgress(msg.progress); break;
    case 'result':      showResult(msg); break;

    case 'betConfirm':
      betState  = msg.bet;
      myMedals  = msg.myMedals;
      setMedals(myMedals);
      renderTanshoButtons();
      renderMyBets();
      break;

    case 'myMedals':
      myMedals = msg.medals; setMedals(myMedals); break;

    case 'betCounts':
      if (msg.details) renderBetDetails(msg.details);
      break;

    case 'leaderboard': renderLeaderboard(msg.leaderboard); break;
    case 'playerCount': document.getElementById('playerCount').textContent = `👥 ${msg.count}人`; break;
    case 'error':       showLobbyError(msg.message); break;
  }
}

// ===== State =====
function applyState(state) {
  phase    = state.phase;
  horses   = state.horses || [];
  betState = state.myBets || { tansho: {}, nirenfuku: {} };
  finishedSet = new Set();

  if (state.myMedals != null)    { myMedals = state.myMedals; setMedals(myMedals); }
  if (state.playerCount != null) document.getElementById('playerCount').textContent = `👥 ${state.playerCount}人`;
  if (state.leaderboard)         renderLeaderboard(state.leaderboard);

  initRunners();
  renderRunnerInfoRows();
  renderTanshoButtons();
  renderNirenfukuSelects();
  renderMyBets();
  updatePhaseUI();
  document.getElementById('nirenfukuOddsPreview').textContent = '';
  document.getElementById('resultOverlay').classList.add('hidden');
  clearRankBadges();

  if (state.betDetails)   renderBetDetails(state.betDetails);
  if (state.raceProgress) updateProgress(state.raceProgress);
  if (state.timer != null && phase === 'betting') updateTimer(state.timer);
}

function updatePhaseUI() {
  const label = document.getElementById('phaseLabel');
  const timer = document.getElementById('timerDisplay');
  const svg   = document.getElementById('trackSVG');
  svg.classList.toggle('racing', phase === 'racing');
  document.getElementById('nirenfukuBtn').disabled = phase !== 'betting';

  if      (phase === 'betting') { label.textContent = '🎰 ベット受付中！'; timer.classList.remove('hidden'); }
  else if (phase === 'racing')  { label.textContent = '🏃 レース中！';      timer.classList.add('hidden'); }
  else if (phase === 'result')  { label.textContent = '🏆 結果発表';        timer.classList.add('hidden'); }
  else                          { label.textContent = '⏳ 待機中...';       timer.classList.add('hidden'); }
}

function updateTimer(t) {
  const el = document.getElementById('timerDisplay');
  el.textContent = t;
  el.classList.toggle('urgent', t <= 5);
}

function setMedals(n) { document.getElementById('myMedals').textContent = n.toLocaleString(); }

// ===== SVG Track =====
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function initRunners() {
  const g = document.getElementById('runnersGroup');
  g.innerHTML = '';
  horses.forEach((h, i) => {
    const pos   = lanePos(0, i);
    const group = svgEl('g', { id: `svgRunner-${i}`, transform: `translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})` });
    group.appendChild(svgEl('circle', { r: '14', fill: h.color, opacity: '0.25' }));
    const circle = svgEl('circle', { r: '11', fill: h.color, stroke: 'white', 'stroke-width': '2', class: 'runner-circle' });
    const text   = svgEl('text', { x: '0', y: '4', 'text-anchor': 'middle', fill: 'white', 'font-size': '10', 'font-weight': 'bold', 'font-family': 'sans-serif', style: 'pointer-events:none' });
    text.textContent = i + 1;
    group.appendChild(circle);
    group.appendChild(text);
    g.appendChild(group);
  });
}

// ===== Race animation =====
function updateProgress(progress) {
  progress.forEach((pct, i) => {
    if (finishedSet.has(i)) return;
    const el = document.getElementById(`svgRunner-${i}`);
    if (!el) return;
    if (pct >= 100) {
      finishedSet.add(i);
      triggerFinish(i, finishedSet.size);
    } else {
      const pos = lanePos(pct, i);
      el.setAttribute('transform', `translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})`);
    }
  });
}

function triggerFinish(runnerIdx, rank) {
  const h  = horses[runnerIdx];
  if (!h) return;
  if (rank === 1) flashFinishLine();
  const el = document.getElementById(`svgRunner-${runnerIdx}`);
  if (!el) return;
  // Start from wherever the runner currently is so there's no jump at the line
  const m = (el.getAttribute('transform') || '').match(/translate\(([^,]+),([^)]+)\)/);
  const startPos = m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : lanePos(100, runnerIdx);
  const endPos   = lanePos(OVERSHOOT, runnerIdx);
  const t0  = performance.now();
  const dur = 600;
  (function step(now) {
    const t     = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const x = startPos.x + (endPos.x - startPos.x) * eased;
    const y = startPos.y + (endPos.y - startPos.y) * eased;
    el.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    if (t < 1) requestAnimationFrame(step);
    else addFinishPulse(x, y, h.color);
  })(t0);
}

function flashFinishLine() {
  const svg   = document.getElementById('trackSVG');
  const flash = svgEl('rect', { x: '284', y: '9', width: '12', height: '130', rx: '3', fill: 'gold', opacity: '0' });
  svg.insertBefore(flash, document.getElementById('runnersGroup'));
  const t0 = performance.now();
  (function anim(now) {
    const t  = Math.min((now - t0) / 700, 1);
    const op = t < 0.15 ? t / 0.15 : (1 - t) / 0.85;
    flash.setAttribute('opacity', (op * 0.85).toFixed(2));
    if (t < 1) requestAnimationFrame(anim);
    else flash.remove();
  })(t0);
}

function addFinishPulse(x, y, color) {
  const svg  = document.getElementById('trackSVG');
  const ring = svgEl('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: '12', fill: 'none', stroke: color, 'stroke-width': '3', opacity: '1' });
  svg.appendChild(ring);
  const t0 = performance.now();
  (function anim(now) {
    const t = Math.min((now - t0) / 600, 1);
    ring.setAttribute('r', (12 + t * 18).toFixed(1));
    ring.setAttribute('opacity', (1 - t).toFixed(2));
    if (t < 1) requestAnimationFrame(anim);
    else ring.remove();
  })(t0);
}

function clearRankBadges() {
  document.getElementById('rankBadgesGroup').innerHTML = '';
  document.querySelectorAll('.runner-info-row').forEach(r => r.classList.remove('is-winner', 'is-second'));
}

function showRankBadges(first, second) {
  const group = document.getElementById('rankBadgesGroup');
  group.innerHTML = '';
  [first, second].forEach((idx, rank) => {
    const pos = lanePos(OVERSHOOT, idx);
    const g   = svgEl('g', { transform: `translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})` });
    const bg  = svgEl('rect', { x: '-14', y: '-11', width: '28', height: '15', rx: '5', fill: rank === 0 ? '#b8860b' : '#666', opacity: '0.9' });
    const txt = svgEl('text', { x: '0', y: '1', 'text-anchor': 'middle', fill: 'white', 'font-size': '10', 'font-weight': 'bold', 'font-family': 'sans-serif', class: 'svg-rank-badge' });
    txt.textContent = rank === 0 ? '1着' : '2着';
    g.appendChild(bg); g.appendChild(txt);
    group.appendChild(g);
    const row = document.getElementById(`info-row-${idx}`);
    if (row) row.classList.add(rank === 0 ? 'is-winner' : 'is-second');
  });
}

// ===== Runner Info Panel =====
function condClass(c) { return c === '良' ? 'cond-good' : c === '悪' ? 'cond-bad' : 'cond-norm'; }

function histBadgeHtml(pos) {
  if (pos === 1)    return '<span class="hist-badge hist-1">1着</span>';
  if (pos === 2)    return '<span class="hist-badge hist-2">2着</span>';
  if (pos === 3)    return '<span class="hist-badge hist-3">3↓</span>';
  return '<span class="hist-badge hist-null">－</span>';
}

function renderRunnerInfoRows() {
  const container = document.getElementById('runnerInfoRows');
  container.innerHTML = '';
  horses.forEach((h, i) => {
    const histRow = Array.isArray(h.history) && h.history.length
      ? `<div class="hist-row">${h.history.map(histBadgeHtml).join('')}</div>`
      : '';
    const row = document.createElement('div');
    row.className = 'runner-info-row';
    row.id = `info-row-${i}`;
    row.innerHTML = `
      <div class="runner-num-dot" style="background:${h.color}">${i + 1}</div>
      <div class="runner-details">
        <div class="runner-name">${h.name}</div>
        <div class="runner-meta">
          <span class="cond-badge ${condClass(h.cond)}">${h.cond}</span>
          <span class="cond-badge ${condClass(h.health)}">${h.health}</span>
          <span class="runner-odds">${h.tanshoOdds}倍</span>
        </div>
        ${histRow}
      </div>
      <div class="runner-betters" id="betters-${i}"></div>`;
    container.appendChild(row);
  });
}

function renderBetDetails(details) {
  horses.forEach((_, i) => {
    const el = document.getElementById(`betters-${i}`);
    if (!el || !details[i]) return;
    el.innerHTML = details[i].map(p => {
      const isMe = p.name === myName;
      return `<div class="player-chip${isMe ? ' is-me' : ''}" style="background:${p.color}" title="${p.name}">${p.name.slice(0,1)}</div>`;
    }).join('');
  });
}

// ===== Bet Panel =====
function renderTanshoButtons() {
  const c = document.getElementById('tanshoSelect');
  c.innerHTML = '';
  horses.forEach((h, i) => {
    const isBet  = betState.tansho[i] !== undefined;
    const btn    = document.createElement('button');
    btn.className = 'horse-pick-btn' + (isBet ? ' selected' : '');
    btn.style.borderColor = h.color + '99';
    const amount = betState.tansho[i];
    btn.innerHTML = `<span class="pick-num">${i + 1}</span>${h.name.slice(0, 5)}${isBet ? `<span class="pick-amount">${amount}枚</span>` : ''}`;
    btn.onclick = () => onTanshoClick(i);
    c.appendChild(btn);
  });
}

function renderNirenfukuSelects() {
  ['nirenfukuA', 'nirenfukuB'].forEach((id, idx) => {
    const sel = document.getElementById(id);
    sel.innerHTML = `<option value="">${idx === 0 ? '馬Aを選択' : '馬Bを選択'}</option>`;
    horses.forEach((h, i) => { sel.innerHTML += `<option value="${i}">${i + 1}. ${h.name}</option>`; });
  });
}

function renderMyBets() {
  const el      = document.getElementById('myBetsList');
  const totalEl = document.getElementById('totalBetDisplay');
  const items   = [];
  let total     = 0;
  const canRemove = phase === 'betting';

  Object.entries(betState.tansho || {}).forEach(([horse, amount]) => {
    const h = horses[parseInt(horse)];
    if (!h) return;
    total += amount;
    items.push(`<div class="bet-list-item">
      <span class="bet-list-label">単勝 <strong>${parseInt(horse)+1}. ${h.name}</strong></span>
      <span class="bet-list-amount">${amount}枚</span>
      ${canRemove ? `<button class="bet-remove-btn" onclick="removeTansho(${horse})">×</button>` : ''}
    </div>`);
  });

  Object.values(betState.nirenfuku || {}).forEach(({ horse1, horse2, amount }) => {
    const h1 = horses[horse1], h2 = horses[horse2];
    if (!h1 || !h2) return;
    total += amount;
    items.push(`<div class="bet-list-item">
      <span class="bet-list-label">2連複 <strong>${horse1+1}.${h1.name.slice(0,4)}＋${horse2+1}.${h2.name.slice(0,4)}</strong></span>
      <span class="bet-list-amount">${amount}枚</span>
      ${canRemove ? `<button class="bet-remove-btn" onclick="removeNirenfuku(${horse1},${horse2})">×</button>` : ''}
    </div>`);
  });

  el.innerHTML = items.length ? items.join('') : '<p class="no-bets-msg">ベットなし</p>';
  if (total > 0) { totalEl.textContent = `合計 ${total.toLocaleString()}枚投資中`; totalEl.classList.remove('hidden'); }
  else totalEl.classList.add('hidden');
}

function onTanshoClick(i) {
  if (phase !== 'betting') return;
  if (betState.tansho[i] !== undefined) {
    send({ type: 'bet', betType: 'removeTansho', horse: i });
  } else {
    const amount = Math.max(10, parseInt(document.getElementById('tanshoAmount').value) || 100);
    if (myMedals < 10) { showToast('メダルが足りません'); return; }
    send({ type: 'bet', betType: 'tansho', horse: i, amount });
  }
}

function removeTansho(horse)           { send({ type: 'bet', betType: 'removeTansho', horse: parseInt(horse) }); }
function removeNirenfuku(horse1, horse2) { send({ type: 'bet', betType: 'removeNirenfuku', horse1, horse2 }); }

function updateNirenfukuPreview() {
  const a  = parseInt(document.getElementById('nirenfukuA').value);
  const b  = parseInt(document.getElementById('nirenfukuB').value);
  const el = document.getElementById('nirenfukuOddsPreview');
  if (!isNaN(a) && !isNaN(b) && a !== b && horses[a] && horses[b]) {
    const pa   = horses[a].winProb, pb = horses[b].winProb;
    const odds = Math.max(1.5, Math.round((1/pa)*(1/pb)*0.40*10)/10);
    el.textContent = `予想オッズ: 約 ${odds}倍`;
  } else { el.textContent = ''; }
}

// ===== Result =====
function showResult(msg) {
  const { first, second, tanshoOdds, nirenfukuOdds, payouts, medals, leaderboard: lb } = msg;
  showRankBadges(first, second);

  const h1 = horses[first], h2 = horses[second];
  document.getElementById('resultHorses').innerHTML = `
    <div class="result-place first">
      <div class="result-place-label">🥇 1着</div>
      <div class="result-place-name" style="color:${h1.color}">${first+1}. ${h1.name}</div>
    </div>
    <div class="result-place second">
      <div class="result-place-label">🥈 2着</div>
      <div class="result-place-name" style="color:${h2.color}">${second+1}. ${h2.name}</div>
    </div>`;
  document.getElementById('resultOdds').innerHTML =
    `単勝: <strong>${tanshoOdds}倍</strong>　2連複: <strong>${nirenfukuOdds}倍</strong>`;

  const payout   = payouts[clientId] || 0;
  const invested = Object.values(betState.tansho||{}).reduce((s,a)=>s+a,0)
                 + Object.values(betState.nirenfuku||{}).reduce((s,b)=>s+b.amount,0);
  const payEl = document.getElementById('myPayout');
  if (!invested)       { payEl.className = 'no-bet'; payEl.textContent = 'ベットなし'; }
  else if (payout > 0) { payEl.className = 'win';    payEl.innerHTML = `🎉 的中！ <strong>${payout.toLocaleString()}枚</strong> 獲得（投資: ${invested}枚）`; }
  else                 { payEl.className = 'lose';   payEl.textContent = '💸 ハズレ...'; }

  if (medals?.[clientId] != null) { myMedals = medals[clientId]; setMedals(myMedals); }
  if (lb) {
    renderLeaderboard(lb);
    document.getElementById('resultLeaderboard').textContent =
      lb.slice(0, 3).map((p, i) => `${'🥇🥈🥉'[i]} ${p.name}: ${p.medals.toLocaleString()}枚`).join('　');
  }

  let n = 9;
  const nextEl = document.getElementById('nextRaceTimer');
  nextEl.textContent = `次のレースまで ${n}秒`;
  if (countdown) clearInterval(countdown);
  countdown = setInterval(() => {
    n--; nextEl.textContent = n > 0 ? `次のレースまで ${n}秒` : 'レース準備中...';
    if (n <= 0) { clearInterval(countdown); countdown = null; }
  }, 1000);

  document.getElementById('resultOverlay').classList.remove('hidden');
  phase = 'result'; updatePhaseUI();
}

function renderLeaderboard(lb) {
  const el = document.getElementById('leaderboard');
  if (!el || !lb) return;
  el.innerHTML = lb.map((p, i) =>
    `<div class="lb-row${p.name === myName ? ' me' : ''}">
      <div class="lb-dot" style="background:${p.color||'#666'}"></div>
      <span class="lb-name">${i+1}. ${p.name}</span>
      <span class="lb-medals">${p.medals.toLocaleString()}枚</span>
    </div>`).join('');
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}
function showLobbyError(msg) {
  const el = document.getElementById('lobbyError');
  el.textContent = msg; el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ===== Events =====
document.addEventListener('DOMContentLoaded', () => {
  connect();

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('startMedals').value = btn.dataset.val;
    });
  });

  document.getElementById('createBtn').onclick = () => {
    const name   = document.getElementById('lobbyName').value.trim() || 'プレイヤー';
    const medals = parseInt(document.getElementById('startMedals').value) || 1000;
    myName = name;
    send({ type: 'createRoom', name, startingMedals: medals });
  };

  document.getElementById('joinBtn').onclick = () => {
    const name = document.getElementById('lobbyName').value.trim() || 'プレイヤー';
    const code = document.getElementById('joinCode').value.trim().toUpperCase();
    if (!code || code.length !== 4) { showLobbyError('4文字の部屋コードを入力してください'); return; }
    myName = name;
    send({ type: 'joinRoom', name, roomId: code });
  };

  document.getElementById('joinCode').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
  });

  document.getElementById('nameBtn').onclick = () => {
    const name = document.getElementById('nameInput').value.trim();
    if (name) { myName = name; send({ type: 'setName', name }); showToast(`名前を「${name}」に変更`); }
  };

  document.querySelectorAll('.chip-buttons').forEach(group => {
    group.addEventListener('click', e => {
      if (e.target.classList.contains('chip-btn')) {
        const input = document.getElementById(group.dataset.target);
        if (input) input.value = e.target.dataset.val;
      }
    });
  });

  document.getElementById('nirenfukuBtn').onclick = () => {
    if (phase !== 'betting') return;
    const a = parseInt(document.getElementById('nirenfukuA').value);
    const b = parseInt(document.getElementById('nirenfukuB').value);
    if (isNaN(a) || isNaN(b)) { showToast('2頭選んでください'); return; }
    if (a === b)               { showToast('別の馬を選んでください'); return; }
    const amount = Math.max(10, parseInt(document.getElementById('nirenfukuAmount').value) || 100);
    send({ type: 'bet', betType: 'nirenfuku', horse1: a, horse2: b, amount });
  };

  document.getElementById('nirenfukuA').addEventListener('change', updateNirenfukuPreview);
  document.getElementById('nirenfukuB').addEventListener('change', updateNirenfukuPreview);

  document.getElementById('resultOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('resultOverlay'))
      document.getElementById('resultOverlay').classList.add('hidden');
  });
});
