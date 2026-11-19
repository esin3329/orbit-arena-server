// @ts-check
/**
 * Orbit Arena 브라우저 클라이언트
 *
 * 네트워크 모델
 *  - 입력: 30Hz 고정 주기로 {seq, dx, dy, aim, fire, dash} 전송
 *  - 내 캐릭터: 클라이언트 예측(입력 즉시 로컬 시뮬레이션) → 스냅샷의 ack 이후 입력만 재적용(reconciliation)
 *  - 다른 플레이어: 서버 틱 기준 INTERP_DELAY 만큼 과거 시점을 두 스냅샷 사이에서 보간
 *  - 서버와 "같은" shared/sim.js 를 import 해서 예측 결과가 서버와 일치
 */
import * as sim from '/shared/sim.js';

const INTERP_DELAY_MS = 110;
const MAX_SNAPS = 40;

const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

// ─────────────────────────── 상태 ───────────────────────────
let token = localStorage.getItem('oa_token');
/** @type {any} */ let me = null;
/** @type {WebSocket | null} */ let ws = null;
let reconnectDelay = 500;
let lagMs = 0;
let rtt = 0;
let queued = false;

const opts = { predict: true, interp: true, ghost: false };

const G = {
  active: false,
  ended: false,
  you: 0,
  /** @type {Map<number, {nick: string, bot: boolean}>} */ roster: new Map(),
  /** @type {any[]} */ snaps: [],
  /** @type {any[]} */ pending: [],
  seq: 0,
  /** @type {any} */ pred: null,
  /** @type {any} */ serverMe: null,
  offset: /** @type {number | null} */ (null),
  correction: { x: 0, y: 0 },
  reconErr: 0,
  snapTimes: /** @type {number[]} */ ([]),
  remTicks: 0,
  /** @type {{text: string, at: number}[]} */ feed: [],
  /** @type {{x:number,y:number,at:number,color:string}[]} */ fx: [],
};

// ─────────────────────────── REST ───────────────────────────
async function api(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status });
  return body;
}

const esc = (/** @type {any} */ s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtDelta = (/** @type {number|null} */ d) => (d == null ? '-' : d > 0 ? `<span class="up">+${d}</span>` : d < 0 ? `<span class="down">${d}</span>` : '±0');
const timeAgo = (/** @type {string} */ iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
};

async function refreshLobby() {
  const [lb, recent, stats] = await Promise.all([
    api('/api/leaderboard?limit=10').catch(() => null),
    api('/api/matches/recent?limit=6').catch(() => null),
    api('/api/stats').catch(() => null),
  ]);
  if (lb && lb.players.length) {
    $('leaderboard').innerHTML = lb.players
      .map((p, i) => `<tr class="${me && p.id === me.id ? 'me' : ''}"><td>${i + 1}</td><td>${esc(p.nickname)}</td><td>${p.rating}</td><td>${p.wins}</td><td>${p.kills}/${p.deaths}</td><td>${p.bestScore}</td></tr>`)
      .join('');
  }
  if (recent && recent.matches.length) {
    $('recent').innerHTML = recent.matches
      .map((m) => {
        const names = m.participants.map((p) => `${p.placement}위 ${esc(p.nickname)} (${p.score})`).join(', ');
        return `<li>${names}${m.botCount ? ` <span class="muted">+ 봇 ${m.botCount}</span>` : ''}<div class="when">${timeAgo(m.endedAt)}</div></li>`;
      })
      .join('');
  }
  if (stats) {
    $('server-stats').innerHTML = [
      ['접속자', stats.online],
      ['진행 중 룸', stats.rooms],
      ['대기열', stats.queue],
      ['틱 p50', `${stats.tick.p50Ms}ms`],
      ['틱 p99', `${stats.tick.p99Ms}ms`],
      ['DB', stats.db],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('');
  }
  if (token && me) {
    const res = await api('/api/me').catch(() => null);
    if (res) {
      me = res.player;
      renderProfile();
    }
  }
}

function renderProfile() {
  $('login-form').hidden = !!me;
  $('profile').hidden = !me;
  if (!me) return;
  $('me-nick').textContent = me.nickname;
  $('me-rating').textContent = `레이팅 ${me.rating}`;
  const kd = me.deaths ? (me.kills / me.deaths).toFixed(2) : me.kills.toFixed(2);
  $('me-stats').innerHTML = [
    ['게임', me.games],
    ['승리', me.wins],
    ['K/D', kd],
    ['킬', me.kills],
    ['데스', me.deaths],
    ['최고 점수', me.bestScore],
  ]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}

$('login-form').addEventListener('submit', async (/** @type {Event} */ e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const res = await api('/api/auth/guest', { method: 'POST', body: JSON.stringify({ nickname: $('nick').value }) });
    token = res.token;
    me = res.player;
    localStorage.setItem('oa_token', /** @type {string} */ (token));
    renderProfile();
    connect();
  } catch (err) {
    $('login-error').textContent = /** @type {Error} */ (err).message;
  }
});

$('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('oa_token');
  token = null;
  me = null;
  ws?.close(1000);
  ws = null;
  renderProfile();
});

$('play-btn').addEventListener('click', () => {
  if (queued) {
    send({ t: 'leave' });
    setQueued(false);
  } else {
    send({ t: 'queue' });
  }
});

function setQueued(/** @type {boolean} */ v, text = '') {
  queued = v;
  $('play-btn').textContent = v ? '매칭 취소' : '매치 찾기';
  $('queue-status').textContent = text;
}

// ─────────────────────────── WebSocket ───────────────────────────
function connect() {
  if (!token) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws = sock;
  sock.onopen = () => {
    reconnectDelay = 500;
    setBadge(true);
  };
  sock.onmessage = (ev) => {
    if (lagMs) setTimeout(() => handle(JSON.parse(ev.data)), lagMs / 2);
    else handle(JSON.parse(ev.data));
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    setBadge(false);
    ws = null;
    if (ev.code === 4001) {
      $('queue-status').textContent = '다른 탭/기기에서 접속하여 연결이 종료되었습니다.';
      return;
    }
    if (ev.code === 1000 || !token) return;
    // 지수 백오프 재접속 — 서버는 유예 시간 동안 매치 자리를 유지한다
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

function setBadge(/** @type {boolean} */ on) {
  const b = $('conn-badge');
  b.className = `badge ${on ? 'on' : 'off'}`;
  b.textContent = on ? '서버 연결됨' : '오프라인';
}

function send(/** @type {any} */ msg) {
  const data = JSON.stringify(msg);
  const sock = ws;
  if (!sock) return;
  const go = () => sock.readyState === WebSocket.OPEN && sock.send(data);
  if (lagMs) setTimeout(go, lagMs / 2);
  else go();
}

setInterval(() => send({ t: 'ping', ts: performance.now() }), 1000);

function handle(/** @type {any} */ msg) {
  switch (msg.t) {
    case 'welcome':
      break;
    case 'queued':
      setQueued(true, `매칭 중… 대기 ${msg.size}명 · ${Math.round(msg.botFillAfterMs / 1000)}초 후 봇이 채워집니다`);
      break;
    case 'match_start':
      enterGame(msg);
      break;
    case 'roster':
      G.roster = new Map(msg.roster.map((/** @type {any[]} */ r) => [r[0], { nick: r[1], bot: !!r[2] }]));
      break;
    case 'snap':
      onSnapshot(msg);
      break;
    case 'match_end':
      showResult(msg);
      break;
    case 'pong':
      rtt = performance.now() - msg.ts;
      break;
    case 'left':
      exitGame();
      break;
    case 'error':
      $('queue-status').textContent = `오류: ${msg.code}`;
      setQueued(false, `오류: ${msg.code}`);
      break;
  }
}

// ─────────────────────────── 게임 진입/종료 ───────────────────────────
function enterGame(/** @type {any} */ msg) {
  setQueued(false);
  Object.assign(G, {
    active: true,
    ended: false,
    you: msg.you,
    roster: new Map(msg.roster.map((/** @type {any[]} */ r) => [r[0], { nick: r[1], bot: !!r[2] }])),
    snaps: [],
    pending: [],
    pred: null,
    serverMe: null,
    offset: null,
    correction: { x: 0, y: 0 },
    remTicks: msg.remainingTicks,
    feed: [],
    fx: [],
  });
  $('lobby').hidden = true;
  $('game').hidden = false;
  $('result').hidden = true;
  resize();
}

function exitGame() {
  G.active = false;
  $('game').hidden = true;
  $('lobby').hidden = false;
  refreshLobby();
}

function showResult(/** @type {any} */ msg) {
  G.ended = true;
  const mine = msg.results.find((/** @type {any} */ r) => r.eid === G.you);
  $('result-title').textContent = mine ? `${mine.placement}위로 매치 종료` : '매치 종료';
  $('result-body').innerHTML = msg.results
    .map(
      (/** @type {any} */ r) =>
        `<tr class="${r.eid === G.you ? 'me' : ''}"><td>${r.placement}</td><td>${esc(r.nickname)}${r.isBot ? ' <span class="muted">(봇)</span>' : ''}</td><td>${r.score}</td><td>${r.kills}</td><td>${r.deaths}</td><td>${r.isBot ? '' : fmtDelta(r.ratingDelta)}</td></tr>`,
    )
    .join('');
  $('result').hidden = false;
}

$('back-btn').addEventListener('click', exitGame);
$('again-btn').addEventListener('click', () => {
  exitGame();
  send({ t: 'queue' });
});

// ─────────────────────────── 입력 ───────────────────────────
const keys = new Set();
let mouseDown = false;
const mouse = { x: 0, y: 0 };

addEventListener('keydown', (e) => {
  if (!G.active) return;
  if (e.code === 'Escape' && !G.ended) {
    if (confirm('매치에서 나가시겠습니까? (현재까지의 기록이 저장됩니다)')) send({ t: 'leave' });
    return;
  }
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => {
  keys.clear();
  mouseDown = false;
});
const canvas = /** @type {HTMLCanvasElement} */ ($('canvas'));
canvas.addEventListener('mousedown', () => (mouseDown = true));
addEventListener('mouseup', () => (mouseDown = false));
canvas.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

$('lag').addEventListener('change', (/** @type {any} */ e) => (lagMs = Number(e.target.value)));
$('opt-predict').addEventListener('change', (/** @type {any} */ e) => (opts.predict = e.target.checked));
$('opt-interp').addEventListener('change', (/** @type {any} */ e) => (opts.interp = e.target.checked));
$('opt-ghost').addEventListener('change', (/** @type {any} */ e) => (opts.ghost = e.target.checked));

/** 30Hz 고정 주기 입력 생성 + 로컬 예측 */
function inputTick() {
  if (!G.active || G.ended || !G.pred) return;
  const k = (/** @type {string[]} */ ...codes) => codes.some((c) => keys.has(c));
  const self = renderSelfPos();
  const world = screenToWorld(mouse.x, mouse.y);
  const input = {
    seq: ++G.seq,
    dx: (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0),
    dy: (k('KeyS', 'ArrowDown') ? 1 : 0) - (k('KeyW', 'ArrowUp') ? 1 : 0),
    aim: Math.round(Math.atan2(world.y - self.y, world.x - self.x) * 100) / 100,
    fire: mouseDown,
    dash: k('Space', 'ShiftLeft'),
  };
  send({ t: 'input', ...input });
  if (G.pred.alive) sim.stepMovement(G.pred, input);
  G.pred.aim = input.aim;
  G.pending.push(input);
  if (G.pending.length > 90) G.pending.shift();
}

// ─────────────────────────── 스냅샷 처리 ───────────────────────────
function onSnapshot(/** @type {any} */ msg) {
  if (!G.active) return;
  const d = msg.d;
  const now = performance.now();

  // 서버 틱 ↔ 로컬 시계 오프셋 추정: 가장 빨리 도착한 샘플(=지연이 가장 짧은 경로)에 맞추고 천천히 드리프트 보정
  const sample = now - d.tick * sim.TICK_MS;
  if (G.offset === null || sample < G.offset) G.offset = sample;
  else G.offset += (sample - G.offset) * 0.01;

  const players = new Map();
  for (const p of d.p) {
    players.set(p[0], { eid: p[0], x: p[1], y: p[2], hp: p[3], alive: !!p[4], score: p[5], aim: p[6], dashTicks: p[7], dashCd: p[8], kills: p[9], deaths: p[10] });
  }
  const bullets = new Map(d.b.map((/** @type {number[]} */ b) => [b[0], { x: b[1], y: b[2] }]));
  G.snaps.push({ tick: d.tick, players, bullets, orbs: d.o });
  if (G.snaps.length > MAX_SNAPS) G.snaps.shift();
  G.remTicks = d.rem;
  G.snapTimes.push(now);
  while (G.snapTimes.length && now - G.snapTimes[0] > 1000) G.snapTimes.shift();

  for (const ev of d.ev) handleEvent(ev, players);

  // ── 서버 보정(reconciliation) ──
  const mine = players.get(G.you);
  if (!mine) return;
  G.serverMe = mine;
  G.pending = G.pending.filter((i) => i.seq > msg.ack);
  const before = G.pred ? { x: G.pred.x, y: G.pred.y } : null;
  G.pred = { x: mine.x, y: mine.y, dashTicks: mine.dashTicks, dashCd: mine.dashCd, alive: mine.alive, hp: mine.hp, aim: G.pred?.aim ?? mine.aim };
  if (mine.alive) for (const i of G.pending) sim.stepMovement(G.pred, i);

  if (before) {
    const ex = before.x - G.pred.x;
    const ey = before.y - G.pred.y;
    G.reconErr = Math.hypot(ex, ey);
    // 작은 오차는 화면상에서 부드럽게 흡수, 큰 오차(리스폰/텔레포트)는 즉시 스냅
    if (G.reconErr < 80) {
      G.correction.x += ex;
      G.correction.y += ey;
    } else {
      G.correction.x = 0;
      G.correction.y = 0;
    }
  }
}

function handleEvent(/** @type {any} */ ev, /** @type {Map<number, any>} */ players) {
  const name = (/** @type {number} */ eid) => G.roster.get(eid)?.nick ?? '???';
  if (ev.k === 'kill') {
    G.feed.push({ text: `${name(ev.by)} ⟶ ${name(ev.v)}`, at: performance.now() });
    if (G.feed.length > 5) G.feed.shift();
  } else if (ev.k === 'hit') {
    const p = players.get(ev.v);
    if (p) G.fx.push({ x: p.x, y: p.y, at: performance.now(), color: '#f87171' });
  } else if (ev.k === 'orb') {
    const p = players.get(ev.by);
    if (p) G.fx.push({ x: p.x, y: p.y, at: performance.now(), color: '#fbbf24' });
  }
}

// ─────────────────────────── 렌더링 ───────────────────────────
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const view = { scale: 1, ox: 0, oy: 0 };

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const pad = 20;
  view.scale = Math.min((innerWidth - pad * 2) / sim.ARENA_W, (innerHeight - pad * 2) / sim.ARENA_H);
  view.ox = (innerWidth - sim.ARENA_W * view.scale) / 2;
  view.oy = (innerHeight - sim.ARENA_H * view.scale) / 2;
}
addEventListener('resize', resize);

function screenToWorld(/** @type {number} */ x, /** @type {number} */ y) {
  return { x: (x - view.ox) / view.scale, y: (y - view.oy) / view.scale };
}

function renderSelfPos() {
  if (opts.predict && G.pred) return { x: G.pred.x + G.correction.x, y: G.pred.y + G.correction.y };
  const s = G.serverMe ?? G.pred;
  return s ? { x: s.x, y: s.y } : { x: 0, y: 0 };
}

/** 렌더 시점(서버 시간 - INTERP_DELAY)을 감싸는 두 스냅샷을 찾아 보간 */
function sampleWorld() {
  const snaps = G.snaps;
  if (!snaps.length) return null;
  const latest = snaps[snaps.length - 1];
  if (!opts.interp || G.offset === null) return { a: latest, b: latest, t: 0 };
  const renderTick = (performance.now() - G.offset - INTERP_DELAY_MS) / sim.TICK_MS;
  for (let i = snaps.length - 1; i > 0; i--) {
    const a = snaps[i - 1];
    const b = snaps[i];
    if (a.tick <= renderTick && renderTick <= b.tick) return { a, b, t: (renderTick - a.tick) / (b.tick - a.tick) };
  }
  return renderTick < snaps[0].tick ? { a: snaps[0], b: snaps[0], t: 0 } : { a: latest, b: latest, t: 0 };
}

const lerp = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ t) => a + (b - a) * t;
const lerpAngle = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

const COLORS = ['#f472b6', '#fb923c', '#a3e635', '#2dd4bf', '#c084fc', '#facc15', '#60a5fa', '#f87171'];

let lastFrame = performance.now();
let fps = 0;

// 입력 생성은 렌더링(rAF) 주기와 분리: 화면 주사율/렌더 부하와 무관하게 정확히 30Hz (누산기 방식)
// 탭이 멈췄다 돌아온 경우 밀린 시간을 한꺼번에 보내지 않고 버린다(서버 입력 예산과 동일하게 최대 4개)
let inputAcc = 0;
let lastInputAt = performance.now();
setInterval(() => {
  const now = performance.now();
  inputAcc += now - lastInputAt;
  lastInputAt = now;
  if (!G.active) return void (inputAcc = 0);
  let n = 0;
  while (inputAcc >= sim.TICK_MS && n < 4) {
    inputTick();
    inputAcc -= sim.TICK_MS;
    n++;
  }
  if (inputAcc >= sim.TICK_MS) inputAcc = 0;
}, 4);

function frame(/** @type {number} */ now) {
  const dt = now - lastFrame;
  lastFrame = now;
  fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;

  if (G.active) {
    // 보정 오차를 지수적으로 감쇠 (약 100ms)
    const decay = Math.exp(-dt / 100);
    G.correction.x *= decay;
    G.correction.y *= decay;
    render(now);
  }
  requestAnimationFrame(frame);
}

function render(/** @type {number} */ now) {
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(innerWidth * dpr) || canvas.height !== Math.round(innerHeight * dpr)) resize();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);

  // 아레나
  ctx.fillStyle = '#0d1428';
  ctx.fillRect(0, 0, sim.ARENA_W, sim.ARENA_H);
  ctx.strokeStyle = '#ffffff0a';
  ctx.lineWidth = 1;
  for (let x = 0; x <= sim.ARENA_W; x += 50) line(x, 0, x, sim.ARENA_H);
  for (let y = 0; y <= sim.ARENA_H; y += 50) line(0, y, sim.ARENA_W, y);
  ctx.strokeStyle = '#38bdf855';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, sim.ARENA_W, sim.ARENA_H);
  ctx.fillStyle = '#1e2a4a';
  ctx.strokeStyle = '#38bdf833';
  for (const o of sim.OBSTACLES) {
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeRect(o.x, o.y, o.w, o.h);
  }

  const w = sampleWorld();
  if (w) {
    const { a, b, t } = w;
    // 오브
    const pulse = 1 + Math.sin(now / 200) * 0.15;
    for (const o of b.orbs) {
      ctx.fillStyle = '#fbbf2433';
      circle(o[1], o[2], sim.ORB_RADIUS * 2 * pulse);
      ctx.fillStyle = '#fbbf24';
      circle(o[1], o[2], sim.ORB_RADIUS * 0.7);
    }
    // 탄환
    ctx.fillStyle = '#e0f2fe';
    for (const [id, bb] of b.bullets) {
      const ab = a.bullets.get(id);
      circle(ab ? lerp(ab.x, bb.x, t) : bb.x, ab ? lerp(ab.y, bb.y, t) : bb.y, sim.BULLET_RADIUS);
    }
    // 플레이어
    for (const [eid, pb] of b.players) {
      const pa = a.players.get(eid) ?? pb;
      let x = lerp(pa.x, pb.x, t);
      let y = lerp(pa.y, pb.y, t);
      let aim = lerpAngle(pa.aim, pb.aim, t);
      let alive = pb.alive;
      const isMe = eid === G.you;
      if (isMe && opts.predict && G.pred) {
        const s = renderSelfPos();
        x = s.x;
        y = s.y;
        aim = G.pred.aim;
        alive = G.serverMe?.alive ?? alive;
      }
      if (!alive) continue;
      drawPlayer(eid, x, y, aim, pb.hp, isMe, pb.dashTicks > 0);
    }
    // 서버 권위 위치(고스트) — 예측 오차 시각화
    if (opts.ghost && G.serverMe?.alive) {
      ctx.strokeStyle = '#ffffff88';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(G.serverMe.x, G.serverMe.y, sim.PLAYER_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 이펙트
  G.fx = G.fx.filter((f) => now - f.at < 300);
  for (const f of G.fx) {
    const k = (now - f.at) / 300;
    ctx.strokeStyle = f.color;
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(f.x, f.y, sim.PLAYER_RADIUS + k * 20, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  renderHud(now);
}

function drawPlayer(/** @type {number} */ eid, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ aim, /** @type {number} */ hp, /** @type {boolean} */ isMe, /** @type {boolean} */ dashing) {
  const color = isMe ? '#38bdf8' : COLORS[eid % COLORS.length];
  if (dashing) {
    ctx.fillStyle = color + '33';
    circle(x, y, sim.PLAYER_RADIUS * 1.6);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  line(x, y, x + Math.cos(aim) * (sim.PLAYER_RADIUS + 10), y + Math.sin(aim) * (sim.PLAYER_RADIUS + 10));
  ctx.fillStyle = color;
  circle(x, y, sim.PLAYER_RADIUS);
  if (isMe) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, sim.PLAYER_RADIUS + 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  // HP 바 + 이름
  const bw = 40;
  ctx.fillStyle = '#00000088';
  ctx.fillRect(x - bw / 2, y - sim.PLAYER_RADIUS - 14, bw, 5);
  ctx.fillStyle = hp > 50 ? '#34d399' : hp > 25 ? '#fbbf24' : '#f87171';
  ctx.fillRect(x - bw / 2, y - sim.PLAYER_RADIUS - 14, (bw * hp) / sim.MAX_HP, 5);
  ctx.fillStyle = '#e6ebf5';
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(G.roster.get(eid)?.nick ?? '', x, y - sim.PLAYER_RADIUS - 20);
}

function circle(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
function line(/** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ x2, /** @type {number} */ y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

let hudAt = 0;
function renderHud(/** @type {number} */ now) {
  if (now - hudAt < 100) return; // DOM 갱신은 10Hz 로 제한
  hudAt = now;
  const sec = Math.ceil(G.remTicks / sim.TICK_RATE);
  $('timer').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const meS = G.serverMe;
  $('hp-fill').style.width = `${meS ? (meS.hp / sim.MAX_HP) * 100 : 0}%`;
  $('dash').textContent = G.pred ? (G.pred.dashCd > 0 ? `대시 쿨다운 ${(G.pred.dashCd / sim.TICK_RATE).toFixed(1)}s` : '대시 준비됨') : '';
  $('dead-msg').hidden = !meS || meS.alive || G.ended;

  const latest = G.snaps[G.snaps.length - 1];
  if (latest) {
    const rows = [...latest.players.values()].sort((a, b) => b.score - a.score);
    $('scoreboard').innerHTML = rows
      .map((p) => {
        const r = G.roster.get(p.eid);
        return `<li class="${p.eid === G.you ? 'me' : r?.bot ? 'bot' : ''}"><span>${esc(r?.nick ?? '?')}</span><span>${p.score} · ${p.kills}/${p.deaths}</span></li>`;
      })
      .join('');
  }
  G.feed = G.feed.filter((f) => now - f.at < 5000);
  $('killfeed').innerHTML = G.feed.map((f) => `<li>${esc(f.text)}</li>`).join('');
  $('netinfo').textContent = [
    `RTT        ${rtt.toFixed(0)} ms${lagMs ? ` (+${lagMs} 시뮬)` : ''}`,
    `스냅샷     ${G.snapTimes.length} Hz`,
    `미확인 입력 ${G.pending.length}`,
    `보정 오차   ${G.reconErr.toFixed(2)} px`,
    `FPS        ${fps.toFixed(0)}`,
  ].join('\n');
}

// ─────────────────────────── 시작 ───────────────────────────
async function init() {
  if (token) {
    try {
      me = (await api('/api/me')).player;
    } catch {
      token = null;
      localStorage.removeItem('oa_token');
    }
  }
  renderProfile();
  refreshLobby();
  setInterval(() => !G.active && refreshLobby(), 5000);
  if (me) connect();
  requestAnimationFrame(frame);
}
init();
