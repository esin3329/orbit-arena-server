// @ts-check
/**
 * 효과음 — 오디오 파일 없이 Web Audio API 로 실시간 합성한다.
 * (다운로드할 에셋이 없고, 저작권 걱정이 없으며, 피치·패닝을 상황마다 바꿀 수 있다)
 *
 * - 브라우저 자동재생 정책 때문에 첫 사용자 입력(클릭/키) 때 AudioContext 를 연다
 * - 다른 플레이어 소리는 내 위치 기준 거리 감쇠 + 좌우 패닝
 * - 같은 종류 소리가 한 프레임에 몰리면(난전) 최소 간격으로 솎아 내 귀가 아프지 않게 한다
 */

const STORAGE_KEY = 'oa.sfx.volume';
/** 이 거리(px) 밖의 소리는 들리지 않음 */
const HEARING_RANGE = 900;

/** @type {AudioContext | null} */
let ac = null;
/** @type {GainNode | null} */
let master = null;
/** @type {AudioBuffer | null} */
let noise = null;
let volume = readVolume();
/** @type {Map<string, number>} 종류별 마지막 재생 시각 (솎아내기용) */
const lastPlayed = new Map();

function readVolume() {
  const v = Number(localStorage.getItem(STORAGE_KEY));
  return localStorage.getItem(STORAGE_KEY) === null || !Number.isFinite(v) ? 0.6 : Math.min(1, Math.max(0, v));
}

/** 첫 사용자 입력에서 호출 (그 전에는 AudioContext 가 suspended 상태로 소리가 나지 않음) */
export function unlock() {
  if (!ac) {
    const Ctor = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) return;
    ac = new Ctor();
    const ctx = /** @type {AudioContext} */ (ac);
    master = ctx.createGain();
    master.gain.value = volume;
    // 여러 소리가 겹칠 때 클리핑 방지
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);

    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') void ac.resume();
}

export function getVolume() {
  return volume;
}

/** @param {number} v 0..1 */
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v));
  localStorage.setItem(STORAGE_KEY, String(volume));
  if (master && ac) master.gain.setTargetAtTime(volume, ac.currentTime, 0.02);
}

/**
 * @param {string} kind
 * @param {number} minGapMs
 */
function throttled(kind, minGapMs) {
  const now = performance.now();
  if (now - (lastPlayed.get(kind) ?? -Infinity) < minGapMs) return true;
  lastPlayed.set(kind, now);
  return false;
}

/**
 * 출력 체인: (소스) → 엔벨로프 gain → [panner] → master
 * @param {number} gain
 * @param {number} pan -1..1
 */
function out(gain, pan = 0) {
  const ctx = /** @type {AudioContext} */ (ac);
  const g = ctx.createGain();
  g.gain.value = gain;
  if (pan !== 0) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(/** @type {GainNode} */ (master));
  } else {
    g.connect(/** @type {GainNode} */ (master));
  }
  return g;
}

/**
 * 피치가 변하는 단일 오실레이터 + 빠른 어택/지수 감쇠 엔벨로프
 * @param {{type: OscillatorType, from: number, to: number, dur: number, gain: number, pan?: number, delay?: number}} o
 */
function tone({ type, from, to, dur, gain, pan = 0, delay = 0 }) {
  const ctx = /** @type {AudioContext} */ (ac);
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(1, t + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env).connect(out(gain, pan));
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/**
 * 필터를 통과시킨 노이즈 버스트 (타격감, 바람 소리)
 * @param {{filter: BiquadFilterType, from: number, to: number, q?: number, dur: number, gain: number, pan?: number, delay?: number}} o
 */
function hiss({ filter, from, to, q = 1, dur, gain, pan = 0, delay = 0 }) {
  const ctx = /** @type {AudioContext} */ (ac);
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(1, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(env).connect(out(gain, pan));
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

const ready = () => !!ac && ac.state === 'running' && volume > 0;
/** 미세한 피치 흔들림 — 같은 소리가 반복돼도 기계적으로 들리지 않게 */
const jitter = (/** @type {number} */ f, amt = 0.06) => f * (1 + (Math.random() * 2 - 1) * amt);

/**
 * 내 위치 기준 거리 감쇠(0..1)와 패닝(-1..1)
 * @param {{x:number,y:number} | null} me
 * @param {number} x
 * @param {number} y
 */
export function spatial(me, x, y) {
  if (!me) return { att: 0.5, pan: 0 };
  const dx = x - me.x;
  const d = Math.hypot(dx, y - me.y);
  const att = Math.max(0, 1 - d / HEARING_RANGE) ** 1.5;
  return { att, pan: Math.max(-0.8, Math.min(0.8, dx / 600)) };
}

// ─────────────────────────── 효과음 ───────────────────────────

/** 내 사격 — 짧고 단단한 "퓻" */
export function shoot() {
  if (!ready() || throttled('shoot', 40)) return;
  tone({ type: 'square', from: jitter(1250), to: 260, dur: 0.075, gain: 0.09 });
  hiss({ filter: 'highpass', from: 3000, to: 1500, dur: 0.03, gain: 0.05 });
}

/** 다른 플레이어 사격 — 더 낮고 멀게, 위치에 따라 패닝 */
export function remoteShoot(/** @type {number} */ att, /** @type {number} */ pan) {
  if (!ready() || att < 0.03 || throttled('remoteShoot', 45)) return;
  tone({ type: 'square', from: jitter(900), to: 200, dur: 0.07, gain: 0.06 * att, pan });
}

/** 다른 대상이 맞음 — 둔탁한 "톡" */
export function hit(/** @type {number} */ att, /** @type {number} */ pan) {
  if (!ready() || att < 0.03 || throttled('hit', 35)) return;
  hiss({ filter: 'bandpass', from: 1800, to: 700, q: 2, dur: 0.06, gain: 0.25 * att, pan });
  tone({ type: 'triangle', from: jitter(520), to: 300, dur: 0.05, gain: 0.08 * att, pan });
}

/** 내가 맞음 — 낮은 충격음 */
export function hurt() {
  if (!ready() || throttled('hurt', 60)) return;
  tone({ type: 'sine', from: 180, to: 55, dur: 0.18, gain: 0.35 });
  hiss({ filter: 'lowpass', from: 1600, to: 200, dur: 0.14, gain: 0.3 });
}

/** 내가 처치 — 상승 아르페지오 */
export function kill() {
  if (!ready()) return;
  [660, 880, 1320].forEach((f, i) => tone({ type: 'triangle', from: f, to: f * 1.01, dur: 0.16, gain: 0.13, delay: i * 0.06 }));
  hiss({ filter: 'highpass', from: 5000, to: 8000, dur: 0.2, gain: 0.04, delay: 0.12 });
}

/** 내가 사망 — 하강 */
export function death() {
  if (!ready()) return;
  tone({ type: 'sawtooth', from: 340, to: 50, dur: 0.6, gain: 0.12 });
  hiss({ filter: 'lowpass', from: 1200, to: 80, dur: 0.5, gain: 0.25 });
}

/** 오브 획득 — 맑은 "띵" */
export function orb() {
  if (!ready() || throttled('orb', 50)) return;
  const base = jitter(988, 0.03);
  tone({ type: 'sine', from: base, to: base * 2, dur: 0.09, gain: 0.12 });
  tone({ type: 'sine', from: base * 2, to: base * 2, dur: 0.14, gain: 0.07, delay: 0.05 });
}

/** 대시 — 바람 가르는 소리 */
export function dash() {
  if (!ready()) return;
  hiss({ filter: 'bandpass', from: 500, to: 2600, q: 1.5, dur: 0.2, gain: 0.35 });
}

/** 리스폰 */
export function respawn() {
  if (!ready()) return;
  tone({ type: 'sine', from: 330, to: 660, dur: 0.22, gain: 0.1 });
}

/** 매치 시작 — 카운트 비프 3번 */
export function matchStart() {
  if (!ready()) return;
  [0, 0.16, 0.32].forEach((d, i) => tone({ type: 'square', from: i === 2 ? 1046 : 523, to: i === 2 ? 1046 : 523, dur: 0.11, gain: 0.06, delay: d }));
}

/** 매치 종료 — 1위면 장조 화음, 아니면 단조 */
export function matchEnd(/** @type {boolean} */ won) {
  if (!ready()) return;
  const chord = won ? [523, 659, 784, 1046] : [440, 523, 659];
  chord.forEach((f, i) => tone({ type: 'triangle', from: f, to: f, dur: 0.7, gain: 0.08, delay: i * 0.07 }));
}
