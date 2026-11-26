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
const DELTA_HEADER = 19;
const PLAYER = 22;
const BULLET = 8;
const ORB = 5;
const EVENT = 5;

/**
 * 플레이어 22B 레코드 내 변경 추적 필드 구간 [bitMask, startOffset, endOffset]
 * (0..2 는 eid 로 식별자에 해당하므로 제외)
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
const PLAYER_FIELDS = [
  [0x01, 2, 10],  // f32 x, f32 y (8B)
  [0x02, 10, 11], // u8 hp (1B)
  [0x04, 11, 12], // u8 alive (1B)
  [0x08, 12, 14], // u16 score (2B)
  [0x10, 14, 16], // i16 aim (2B)
  [0x20, 16, 17], // u8 dashTicks (1B)
  [0x40, 17, 18], // u8 dashCd (1B)
  [0x80, 18, 22], // u16 kills, u16 deaths (4B)
];

/** @param {Uint8Array} frame */
const frameView = (frame) => new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

/**
 * 엔티티 ID 기반 스냅샷 델타 인코딩(v5).
 * 플레이어는 eid 로 매칭해 변경된 필드만 전송(미변경 플레이어는 0B),
 * 탄환은 제거 비트맵 + 생존 탄환의 좌표(4B) + 신규 탄환 전체(8B)로 전송한다.
 * 델타가 전체 프레임 이상이거나 순서를 보존할 수 없으면 null 을 반환해 전체 프레임으로 폴백한다.
 * @param {Uint8Array} full @param {Uint8Array} base
 * @returns {Uint8Array | null}
 */
export function encodeSnapshotDelta(full, base) {
  if (full.length < HEADER || base.length < HEADER || full[0] !== MSG_SNAPSHOT || base[0] !== MSG_SNAPSHOT) {
    return null;
  }
  const current = frameView(full);
  const previous = frameView(base);
  const nPCur = current.getUint8(14);
  const nBCur = current.getUint16(15, true);
  const nPBase = previous.getUint8(14);
  const nBBase = previous.getUint16(15, true);

  const curBulletStart = HEADER + nPCur * PLAYER;
  const curTailStart = curBulletStart + nBCur * BULLET;
  const baseBulletStart = HEADER + nPBase * PLAYER;
  const baseTailStart = baseBulletStart + nBBase * BULLET;
  if (full.length < curTailStart || base.length < baseTailStart) return null;

  /** @type {Map<number, number>} */
  const curPlayerIdx = new Map();
  for (let ci = 0; ci < nPCur; ci++) {
    const eid = current.getUint16(HEADER + ci * PLAYER, true);
    if (curPlayerIdx.has(eid)) return null;
    curPlayerIdx.set(eid, ci);
  }

  /** @type {number[]} */
  const removedPlayers = [];
  /** @type {Array<{ off: number, eid: number, mask: number, bytes: number }>} */
  const playerUpdates = [];
  const matchedPlayers = new Uint8Array(nPCur);
  let lastPlayerIdx = -1;

  for (let i = 0; i < nPBase; i++) {
    const baseOff = HEADER + i * PLAYER;
    const eid = previous.getUint16(baseOff, true);
    const ci = curPlayerIdx.get(eid);
    if (ci === undefined) {
      removedPlayers.push(eid);
      continue;
    }
    if (ci <= lastPlayerIdx) return null;
    lastPlayerIdx = ci;
    matchedPlayers[ci] = 1;

    const curOff = HEADER + ci * PLAYER;
    let mask = 0;
    let bytes = 0;
    for (const [bit, s, e] of PLAYER_FIELDS) {
      for (let k = s; k < e; k++) {
        if (full[curOff + k] !== base[baseOff + k]) {
          mask |= bit;
          bytes += e - s;
          break;
        }
      }
    }
    if (mask !== 0) playerUpdates.push({ off: curOff, eid, mask, bytes });
  }

  for (let ci = 0; ci < nPCur; ci++) {
    if (matchedPlayers[ci]) continue;
    if (ci <= lastPlayerIdx) return null;
    const curOff = HEADER + ci * PLAYER;
    playerUpdates.push({ off: curOff, eid: current.getUint16(curOff, true), mask: 0xff, bytes: PLAYER - 2 });
  }

  /** @type {Map<number, number>} */
  const curBulletIdx = new Map();
  for (let ci = 0; ci < nBCur; ci++) {
    const id = current.getUint32(curBulletStart + ci * BULLET, true);
    if (curBulletIdx.has(id)) return null;
    curBulletIdx.set(id, ci);
  }

  const remMaskLen = Math.ceil(nBBase / 8);
  const remMask = new Uint8Array(remMaskLen);
  /** @type {number[]} */
  const survBullets = [];
  /** @type {number[]} */
  const addedBullets = [];
  const matchedBullets = new Uint8Array(nBCur);
  let lastBulletIdx = -1;

  for (let i = 0; i < nBBase; i++) {
    const id = previous.getUint32(baseBulletStart + i * BULLET, true);
    const ci = curBulletIdx.get(id);
    if (ci === undefined) {
      remMask[i >> 3] |= 1 << (i & 7);
      continue;
    }
    if (ci <= lastBulletIdx) return null;
    lastBulletIdx = ci;
    matchedBullets[ci] = 1;
    survBullets.push(ci);
  }

  for (let ci = 0; ci < nBCur; ci++) {
    if (matchedBullets[ci]) continue;
    if (ci <= lastBulletIdx) return null;
    addedBullets.push(ci);
  }

  let playerBytes = 2 + removedPlayers.length * 2;
  for (const u of playerUpdates) playerBytes += 3 + u.bytes;
  const bulletBytes = remMaskLen + survBullets.length * 4 + 2 + addedBullets.length * BULLET;
  const tail = full.subarray(curTailStart);
  const totalLen = DELTA_HEADER + playerBytes + bulletBytes + tail.length;
  if (totalLen >= full.length) return null;

  const delta = new Uint8Array(totalLen);
  const dv = frameView(delta);
  delta[0] = MSG_SNAPSHOT_DELTA;
  delta.set(full.subarray(1, 13), 1); // ack, tick, rem
  dv.setUint32(13, previous.getUint32(5, true), true); // baseTick
  delta[17] = current.getUint8(13); // flags
  delta[18] = current.getUint8(17); // nEv

  let o = DELTA_HEADER;
  delta[o++] = removedPlayers.length;
  for (const eid of removedPlayers) {
    dv.setUint16(o, eid, true);
    o += 2;
  }
  delta[o++] = playerUpdates.length;
  for (const u of playerUpdates) {
    dv.setUint16(o, u.eid, true);
    delta[o + 2] = u.mask;
    o += 3;
    for (const [bit, s, e] of PLAYER_FIELDS) {
      if (!(u.mask & bit)) continue;
      delta.set(full.subarray(u.off + s, u.off + e), o);
      o += e - s;
    }
  }

  delta.set(remMask, o);
  o += remMaskLen;
  for (const ci of survBullets) {
    const bOff = curBulletStart + ci * BULLET;
    delta.set(full.subarray(bOff + 4, bOff + 8), o);
    o += 4;
  }
  dv.setUint16(o, addedBullets.length, true);
  o += 2;
  for (const ci of addedBullets) {
    const bOff = curBulletStart + ci * BULLET;
    delta.set(full.subarray(bOff, bOff + BULLET), o);
    o += BULLET;
  }
  delta.set(tail, o);
  return delta;
}

/** @param {Uint8Array} delta @param {Uint8Array | null} base */
function expandSnapshotDelta(delta, base) {
  if (!base || base.length < HEADER || base[0] !== MSG_SNAPSHOT) {
    throw new Error('snapshot delta missing baseline');
  }
  if (delta.length < DELTA_HEADER || delta[0] !== MSG_SNAPSHOT_DELTA) {
    throw new Error('invalid snapshot delta header');
  }
  const frame = frameView(delta);
  const previous = frameView(base);
  if (frame.getUint32(13, true) !== previous.getUint32(5, true)) {
    throw new Error('snapshot baseline mismatch');
  }

  const nPBase = previous.getUint8(14);
  const nBBase = previous.getUint16(15, true);
  const baseBulletStart = HEADER + nPBase * PLAYER;
  const baseTailStart = baseBulletStart + nBBase * BULLET;
  if (base.length < baseTailStart) throw new Error('corrupt snapshot baseline');

  let read = DELTA_HEADER;
  if (read + 1 > delta.length) throw new Error('truncated snapshot delta');
  const nPRem = delta[read++];
  if (read + nPRem * 2 + 1 > delta.length) throw new Error('truncated snapshot delta players');
  /** @type {Set<number>} */
  const removed = new Set();
  for (let i = 0; i < nPRem; i++) {
    const eid = frame.getUint16(read, true);
    if (removed.has(eid)) throw new Error('duplicate removed player in delta');
    removed.add(eid);
    read += 2;
  }

  const nPUpd = delta[read++];
  /** @type {Map<number, { mask: number, off: number }>} */
  const updates = new Map();
  for (let i = 0; i < nPUpd; i++) {
    if (read + 3 > delta.length) throw new Error('truncated snapshot player update');
    const eid = frame.getUint16(read, true);
    const mask = delta[read + 2];
    read += 3;
    if (removed.has(eid) || updates.has(eid)) throw new Error('conflicting player update in delta');
    const off = read;
    for (const [bit, s, e] of PLAYER_FIELDS) {
      if (mask & bit) read += e - s;
    }
    if (read > delta.length) throw new Error('truncated snapshot player fields');
    updates.set(eid, { mask, off });
  }

  const remMaskLen = Math.ceil(nBBase / 8);
  if (read + remMaskLen > delta.length) throw new Error('truncated snapshot bullet mask');
  const remMaskOff = read;
  read += remMaskLen;
  let nBSurv = 0;
  for (let i = 0; i < nBBase; i++) {
    if (!(delta[remMaskOff + (i >> 3)] & (1 << (i & 7)))) nBSurv++;
  }
  if (read + nBSurv * 4 + 2 > delta.length) throw new Error('truncated snapshot bullets');
  let survOff = read;
  read += nBSurv * 4;
  const nBAdd = frame.getUint16(read, true);
  read += 2;
  if (read + nBAdd * BULLET > delta.length) throw new Error('truncated snapshot added bullets');
  const addOff = read;
  read += nBAdd * BULLET;
  const tail = delta.subarray(read);

  // 생존 + 신규 플레이어 검증 및 수 계산
  let matchedRemoved = 0;
  let survPlayerCount = 0;
  /** @type {Set<number>} */
  const baseEids = new Set();
  for (let i = 0; i < nPBase; i++) {
    const eid = previous.getUint16(HEADER + i * PLAYER, true);
    baseEids.add(eid);
    if (removed.has(eid)) matchedRemoved++;
    else survPlayerCount++;
  }
  if (matchedRemoved !== removed.size) throw new Error('unknown removed player in delta');

  let addedPlayerCount = 0;
  for (const [eid, upd] of updates) {
    if (baseEids.has(eid)) continue;
    if (upd.mask !== 0xff) throw new Error('incomplete new player in delta');
    addedPlayerCount++;
  }

  const nPCur = survPlayerCount + addedPlayerCount;
  const nBCur = nBSurv + nBAdd;
  if (nPCur > 0xff || nBCur > 0xffff) throw new Error('snapshot entity count overflow');

  const full = new Uint8Array(HEADER + nPCur * PLAYER + nBCur * BULLET + tail.length);
  const fv = frameView(full);
  full[0] = MSG_SNAPSHOT;
  full.set(delta.subarray(1, 13), 1); // ack, tick, rem
  full[13] = delta[17]; // flags
  full[14] = nPCur;
  fv.setUint16(15, nBCur, true);
  full[17] = delta[18]; // nEv

  let wo = HEADER;
  for (let i = 0; i < nPBase; i++) {
    const baseOff = HEADER + i * PLAYER;
    const eid = previous.getUint16(baseOff, true);
    if (removed.has(eid)) continue;
    full.set(base.subarray(baseOff, baseOff + PLAYER), wo);
    const upd = updates.get(eid);
    if (upd) {
      let src = upd.off;
      for (const [bit, s, e] of PLAYER_FIELDS) {
        if (!(upd.mask & bit)) continue;
        full.set(delta.subarray(src, src + (e - s)), wo + s);
        src += e - s;
      }
      updates.delete(eid);
    }
    wo += PLAYER;
  }
  for (const [eid, upd] of updates) {
    fv.setUint16(wo, eid, true);
    full.set(delta.subarray(upd.off, upd.off + PLAYER - 2), wo + 2);
    wo += PLAYER;
  }

  for (let i = 0; i < nBBase; i++) {
    if (delta[remMaskOff + (i >> 3)] & (1 << (i & 7))) continue;
    const baseOff = baseBulletStart + i * BULLET;
    full.set(base.subarray(baseOff, baseOff + 4), wo); // id
    full.set(delta.subarray(survOff, survOff + 4), wo + 4); // x, y
    survOff += 4;
    wo += BULLET;
  }
  if (nBAdd > 0) {
    full.set(delta.subarray(addOff, addOff + nBAdd * BULLET), wo);
    wo += nBAdd * BULLET;
  }
  full.set(tail, wo);
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
  const minLen = HEADER + nP * PLAYER + nB * BULLET + (flags & SNAP_FLAG_ORBS ? 1 : 0) + nEv * EVENT;
  if (v.byteLength < minLen) throw new Error(`truncated snapshot: ${v.byteLength} < ${minLen}`);
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
    if (o + nO * ORB + nEv * EVENT !== v.byteLength) throw new Error(`snapshot length mismatch`);
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
