// @ts-check
/**
 * 스냅샷 바이너리 코덱 — 서버(인코딩)와 브라우저(디코딩)가 같은 파일을 쓴다.
 *
 * 스냅샷은 초당 15회 × 접속자 수만큼 나가는, 대역폭의 대부분을 차지하는 메시지다.
 * JSON 튜플 대신 고정 레이아웃 바이너리(리틀 엔디언)로 보내고,
 * 거의 바뀌지 않는 오브 목록은 "그 클라이언트가 마지막으로 받은 버전"과 다를 때만 싣는다(델타).
 *
 * 레이아웃
 *   헤더 18B : u8 type(=1) · u32 ack · u32 tick · u32 rem · u8 flags · u8 nP · u16 nB · u8 nEv
 *   플레이어 22B × nP : u16 eid · f32 x · f32 y · u8 hp · u8 alive · u16 score · i16 aim(×2000)
 *                       · u8 dashTicks · u8 dashCd · u16 kills · u16 deaths
 *   탄환 8B × nB      : u32 id · i16 x(×16) · i16 y(×16)
 *   (flags&1) u8 nO + 오브 5B × nO : u8 id · u16 x · u16 y
 *   이벤트 5B × nEv   : u8 kind(1 hit, 2 kill, 3 orb) · u16 a · u16 b
 *
 * 플레이어 좌표는 f32 로 보낸다. 클라이언트가 자기 위치를 서버 값으로 되돌린 뒤 입력을 재적용(보정)하므로
 * 양자화 오차가 곧 보정 오차가 된다. 탄환·오브는 그리기만 하므로 1/16px·1px 고정소수점으로 충분하다.
 */

export const MSG_SNAPSHOT = 1;
export const MSG_SNAPSHOT_DELTA = 2;
export const SNAP_FLAG_ORBS = 1;

/** ack 필드 위치 — 서버는 공통 본문을 한 번 인코딩한 뒤 플레이어별 ack 만 덮어쓴다 */
export const SNAP_ACK_OFFSET = 1;

const HEADER = 18;
const PLAYER = 22;
const BULLET = 8;
const ORB = 5;
const EVENT = 5;
const BASE_TICK_BYTES = 4;

/** @param {Uint8Array} frame */
const frameView = (frame) => new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

/** @param {DataView} frame */
const entityBytes = (frame) => frame.getUint8(14) * PLAYER + frame.getUint16(15, true) * BULLET;

/**
 * Encode changed player and projectile bytes against the previous full frame.
 * The snapshot header, orbs and events belong to the current tick.
 * @param {Uint8Array} full @param {Uint8Array} base
 * @returns {Uint8Array | null}
 */
export function encodeSnapshotDelta(full, base) {
  const current = frameView(full);
  const previous = frameView(base);
  if (current.getUint8(14) !== previous.getUint8(14) || current.getUint16(15, true) !== previous.getUint16(15, true)) {
    return null;
  }

  const length = entityBytes(current);
  const maskStart = HEADER + BASE_TICK_BYTES;
  const maskEnd = maskStart + Math.ceil(length / 8);
  const tail = full.subarray(HEADER + length);
  const limit = full.length - tail.length;
  if (maskEnd >= limit) return null;

  const delta = new Uint8Array(full.length);
  let write = maskEnd;
  for (let i = 0; i < length; i++) {
    const value = full[HEADER + i];
    if (value === base[HEADER + i]) continue;
    delta[maskStart + (i >> 3)] |= 1 << (i & 7);
    delta[write++] = value;
    if (write >= limit) return null;
  }
  delta.set(full.subarray(0, HEADER));
  delta[0] = MSG_SNAPSHOT_DELTA;
  frameView(delta).setUint32(HEADER, previous.getUint32(5, true), true);
  delta.set(tail, write);
  return delta.subarray(0, write + tail.length);
}

/** @param {Uint8Array} delta @param {Uint8Array | null} base */
function expandSnapshotDelta(delta, base) {
  const frame = frameView(delta);
  if (!base || frame.byteLength < HEADER + BASE_TICK_BYTES) throw new Error('snapshot delta missing baseline');
  const previous = frameView(base);
  if (frame.getUint32(HEADER, true) !== previous.getUint32(5, true) ||
      frame.getUint8(14) !== previous.getUint8(14) || frame.getUint16(15, true) !== previous.getUint16(15, true)) {
    throw new Error('snapshot baseline mismatch');
  }
  const length = entityBytes(frame);
  const maskStart = HEADER + BASE_TICK_BYTES;
  let read = maskStart + Math.ceil(length / 8);
  if (read > delta.length) throw new Error('truncated snapshot mask');
  const entities = base.slice(HEADER, HEADER + length);
  for (let i = 0; i < length; i++) {
    if (!(delta[maskStart + (i >> 3)] & (1 << (i & 7)))) continue;
    if (read >= delta.length) throw new Error('truncated snapshot delta');
    entities[i] = delta[read++];
  }
  const full = new Uint8Array(HEADER + length + delta.length - read);
  full.set(delta.subarray(0, HEADER));
  full[0] = MSG_SNAPSHOT;
  full.set(entities, HEADER);
  full.set(delta.subarray(read), HEADER + length);
  return full;
}

/** Create a decoder for one ordered WebSocket stream. */
export function createSnapshotDecoder() {
  /** @type {Uint8Array | null} */
  let base = null;
  return (/** @type {ArrayBuffer | ArrayBufferView} */ data) => {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const frame = bytes[0] === MSG_SNAPSHOT_DELTA ? expandSnapshotDelta(bytes, base) : bytes;
    const snapshot = decodeSnapshot(frame);
    base = frame;
    return snapshot;
  };
}

const AIM_SCALE = 2000;
const BULLET_POS_SCALE = 16;

/** @type {Record<string, number>} */
const EVENT_KIND = { hit: 1, kill: 2, orb: 3 };

/** @param {number} v @param {number} lo @param {number} hi */
const clampInt = (v, lo, hi) => {
  const r = Math.round(v);
  return r < lo ? lo : r > hi ? hi : r;
};

/**
 * @typedef {{ k: 'hit', v: number } | { k: 'kill', by: number, v: number } | { k: 'orb', by: number }} SnapEvent
 * @typedef {{
 *   tick: number, rem: number,
 *   p: number[][], b: number[][], o?: number[][], ev: SnapEvent[]
 * }} SnapshotData
 */

/**
 * @param {SnapshotData} d
 * @param {number} ack
 * @param {boolean} withOrbs
 * @returns {Uint8Array}
 */
export function encodeSnapshot(d, ack, withOrbs) {
  const orbs = withOrbs ? (d.o ?? []) : null;
  // 개수 필드 폭(u8)을 넘는 이벤트는 버린다 — 피드/이펙트용이라 게임 상태에는 영향이 없다
  const events = d.ev.length > 0xff ? d.ev.slice(0, 0xff) : d.ev;
  const size = HEADER + d.p.length * PLAYER + d.b.length * BULLET + (orbs ? 1 + orbs.length * ORB : 0) + events.length * EVENT;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  let o = 0;

  v.setUint8(o, MSG_SNAPSHOT);
  v.setUint32(o + 1, ack >>> 0, true);
  v.setUint32(o + 5, d.tick >>> 0, true);
  v.setUint32(o + 9, Math.max(0, d.rem) >>> 0, true);
  v.setUint8(o + 13, orbs ? SNAP_FLAG_ORBS : 0);
  v.setUint8(o + 14, d.p.length);
  v.setUint16(o + 15, d.b.length, true);
  v.setUint8(o + 17, events.length);
  o = HEADER;

  for (const p of d.p) {
    v.setUint16(o, p[0], true);
    v.setFloat32(o + 2, p[1], true);
    v.setFloat32(o + 6, p[2], true);
    v.setUint8(o + 10, clampInt(p[3], 0, 255));
    v.setUint8(o + 11, p[4] ? 1 : 0);
    v.setUint16(o + 12, clampInt(p[5], 0, 0xffff), true);
    v.setInt16(o + 14, clampInt(p[6] * AIM_SCALE, -0x8000, 0x7fff), true);
    v.setUint8(o + 16, clampInt(p[7], 0, 255));
    v.setUint8(o + 17, clampInt(p[8], 0, 255));
    v.setUint16(o + 18, clampInt(p[9], 0, 0xffff), true);
    v.setUint16(o + 20, clampInt(p[10], 0, 0xffff), true);
    o += PLAYER;
  }
  for (const b of d.b) {
    v.setUint32(o, b[0] >>> 0, true);
    v.setInt16(o + 4, clampInt(b[1] * BULLET_POS_SCALE, -0x8000, 0x7fff), true);
    v.setInt16(o + 6, clampInt(b[2] * BULLET_POS_SCALE, -0x8000, 0x7fff), true);
    o += BULLET;
  }
  if (orbs) {
    v.setUint8(o, orbs.length);
    o += 1;
    for (const ob of orbs) {
      v.setUint8(o, ob[0]);
      v.setUint16(o + 1, clampInt(ob[1], 0, 0xffff), true);
      v.setUint16(o + 3, clampInt(ob[2], 0, 0xffff), true);
      o += ORB;
    }
  }
  for (const ev of events) {
    v.setUint8(o, EVENT_KIND[ev.k]);
    v.setUint16(o + 1, ev.k === 'hit' ? ev.v : ev.by, true);
    v.setUint16(o + 3, ev.k === 'kill' ? ev.v : 0, true);
    o += EVENT;
  }
  return buf;
}

/**
 * JSON 스냅샷 메시지와 같은 모양으로 디코딩한다. 오브가 실리지 않았으면 `d.o` 는 undefined
 * (클라이언트는 직전 오브 목록을 그대로 쓴다).
 * @param {ArrayBuffer | ArrayBufferView} data
 * @returns {{ t: 'snap', ack: number, d: SnapshotData }}
 */
export function decodeSnapshot(data) {
  const v = ArrayBuffer.isView(data) ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  if (v.byteLength < HEADER || v.getUint8(0) !== MSG_SNAPSHOT) throw new Error('not a snapshot frame');
  const ack = v.getUint32(1, true);
  const tick = v.getUint32(5, true);
  const rem = v.getUint32(9, true);
  const flags = v.getUint8(13);
  const nP = v.getUint8(14);
  const nB = v.getUint16(15, true);
  const nEv = v.getUint8(17);
  let o = HEADER;

  const p = new Array(nP);
  for (let i = 0; i < nP; i++, o += PLAYER) {
    p[i] = [
      v.getUint16(o, true),
      v.getFloat32(o + 2, true),
      v.getFloat32(o + 6, true),
      v.getUint8(o + 10),
      v.getUint8(o + 11),
      v.getUint16(o + 12, true),
      v.getInt16(o + 14, true) / AIM_SCALE,
      v.getUint8(o + 16),
      v.getUint8(o + 17),
      v.getUint16(o + 18, true),
      v.getUint16(o + 20, true),
    ];
  }
  const b = new Array(nB);
  for (let i = 0; i < nB; i++, o += BULLET) {
    b[i] = [v.getUint32(o, true), v.getInt16(o + 4, true) / BULLET_POS_SCALE, v.getInt16(o + 6, true) / BULLET_POS_SCALE];
  }
  /** @type {number[][] | undefined} */
  let orbs;
  if (flags & SNAP_FLAG_ORBS) {
    const nO = v.getUint8(o);
    o += 1;
    orbs = new Array(nO);
    for (let i = 0; i < nO; i++, o += ORB) orbs[i] = [v.getUint8(o), v.getUint16(o + 1, true), v.getUint16(o + 3, true)];
  }
  /** @type {SnapEvent[]} */
  const ev = [];
  for (let i = 0; i < nEv; i++, o += EVENT) {
    const kind = v.getUint8(o);
    const a = v.getUint16(o + 1, true);
    if (kind === 1) ev.push({ k: 'hit', v: a });
    else if (kind === 2) ev.push({ k: 'kill', by: a, v: v.getUint16(o + 3, true) });
    else if (kind === 3) ev.push({ k: 'orb', by: a });
  }
  if (o !== v.byteLength) throw new Error(`snapshot length mismatch: ${o} != ${v.byteLength}`);
  return { t: 'snap', ack, d: { tick, rem, p, b, o: orbs, ev } };
}
