// 한 매치(여러 판)를 진행하는 서버 권위 게임 로직.
import {
  CONFIG, ITEM_KEYS, startBoardRadius, maxSpeed, clonePosition, playbackSeconds, speedMulForDistance, randomHoleRadius, inAnyHole,
} from '../shared/config.js';
import { simulate, separate } from '../shared/physics.js';
import { botAim, botCrack } from './bot.js';

const ROUND_END_SEC = 5;

let boxSeq = 0;

export class Game {
  /**
   * @param {object} opts
   * @param {Array<{id:string,name:string,color:string}>} opts.players
   * @param {number} opts.rounds
   * @param {boolean} opts.items
   * @param {(msg:object, filter?:(id:string)=>boolean)=>void} opts.broadcast
   * @param {(id:string, msg:object)=>void} opts.sendTo
   * @param {(id:string)=>boolean} opts.isConnected
   * @param {()=>void} opts.onEnd
   * @param {() => number} [opts.random]
   */
  constructor(opts) {
    this.opts = opts;
    this.random = opts.random ?? Math.random;
    this.players = opts.players.map((p) => ({ ...p }));
    this.n = this.players.length;
    this.duel = this.n === 2;
    this.totalRounds = opts.rounds;
    this.itemsOn = opts.items;
    this.scores = Object.fromEntries(this.players.map((p) => [p.id, 0]));
    this.wins = Object.fromEntries(this.players.map((p) => [p.id, 0]));
    this.firsts = Object.fromEntries(this.players.map((p) => [p.id, 0]));
    this.lastRank = {};
    this.roundIndex = 0;
    this.timer = null;
    this.over = false;
    this.history = [];
    this.bots = new Set(opts.bots ?? []);
    this.warmingChance = opts.warmingChance ?? CONFIG.warmingChance;
    this.botTimers = [];
  }

  start() {
    this.startRound();
  }

  stop() {
    clearTimeout(this.timer);
    this.clearBotTimers();
    this.over = true;
  }

  // ───────── 판 시작 ─────────
  startRound() {
    this.roundIndex++;
    const R = startBoardRadius(this.n);
    const order = shuffle(this.players.map((p) => p.id), this.random);
    const spawnR = R * CONFIG.spawnRadiusRatio;
    const offset = this.random() * Math.PI * 2;
    this.round = {
      radius: R,
      turn: 0,
      eliminated: 0,
      fallSeq: [], // [{ids:[...], key:number}] 먼저 떨어진 순
      boxes: [],
      holes: [], // 지구 온난화로 뚫린 구멍 {x, y, r}
      pieces: {},
    };
    order.forEach((id, i) => {
      const a = offset + (i / order.length) * Math.PI * 2;
      this.round.pieces[id] = {
        x: Math.cos(a) * spawnR,
        y: Math.sin(a) * spawnR,
        alive: true,
        item: null,
        itemTurn: -1,
        capped: false,
      };
    });
    this.startAim();
  }

  // ───────── 조준 단계 ─────────
  startAim() {
    const r = this.round;
    r.turn++;
    r.phase = 'aim';
    r.inputs = {};
    r.cracks = {};
    r.deadline = Date.now() + CONFIG.aimTimeMs;
    this.broadcastState();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.launch(), CONFIG.aimTimeMs);
    this.autoConfirmDisconnected();
    this.scheduleBots();
  }

  // 봇은 1~3초 고민하는 척하고 입력 (유령 봇은 균열)
  scheduleBots() {
    this.clearBotTimers();
    for (const id of this.bots) {
      const pc = this.round.pieces[id];
      if (!pc) continue;
      const delay = 1000 + this.random() * 2000;
      this.botTimers.push(
        setTimeout(() => {
          if (this.over || this.round.phase !== 'aim') return;
          if (pc.alive) this.onAim(id, botAim(this, id));
          else this.onCrack(id, botCrack(this));
        }, delay),
      );
    }
  }

  clearBotTimers() {
    for (const t of this.botTimers) clearTimeout(t);
    this.botTimers = [];
  }

  autoConfirmDisconnected() {
    if (this.round?.phase !== 'aim') return;
    for (const id of this.aliveIds()) {
      if (!this.opts.isConnected(id) && !this.round.inputs[id]) {
        this.round.inputs[id] = { angle: 0, power: 0, useItem: false, auto: true };
      }
    }
    this.checkAllConfirmed();
  }

  onAim(id, data) {
    const r = this.round;
    if (this.over || r?.phase !== 'aim') return;
    const pc = r.pieces[id];
    if (!pc?.alive || r.inputs[id]) return;
    const input = {
      angle: num(data.angle),
      power: clamp01(num(data.power)),
      useItem: !!data.useItem && this.itemUsable(id),
    };
    if (input.useItem && pc.item === 'clone' && data.clone) {
      input.clone = { angle: num(data.clone.angle), power: clamp01(num(data.clone.power)) };
    }
    r.inputs[id] = input;
    this.broadcastState();
    this.checkAllConfirmed();
  }

  onCrack(id, data) {
    const r = this.round;
    if (this.over || r?.phase !== 'aim') return;
    const pc = r.pieces[id];
    if (!pc || pc.alive) return; // 유령만
    const x = num(data.x);
    const y = num(data.y);
    const d = Math.hypot(x, y);
    if (d > r.radius) return; // 판 위 어디든
    r.cracks[id] = { x, y };
    this.opts.sendTo(id, { t: 'crackOk', x, y });
  }

  checkAllConfirmed() {
    const r = this.round;
    if (r.phase !== 'aim') return;
    if (this.aliveIds().every((id) => r.inputs[id])) {
      clearTimeout(this.timer);
      this.launch();
    }
  }

  itemUsable(id) {
    const pc = this.round.pieces[id];
    return !!pc?.item && pc.itemTurn < this.round.turn;
  }

  // ───────── 발사 단계 ─────────
  launch() {
    const r = this.round;
    if (this.over || r.phase !== 'aim') return;
    r.phase = 'launch';
    clearTimeout(this.timer);
    this.clearBotTimers();

    const vmax = maxSpeed();
    const bodies = [];
    const revealed = [];
    const alive = this.aliveIds();
    for (const id of alive) {
      const pc = r.pieces[id];
      const inp = r.inputs[id] ?? { angle: 0, power: 0, useItem: false };
      const item = inp.useItem ? pc.item : null;
      let power = inp.power;
      if (pc.capped) power = Math.min(power, CONFIG.crackPowerCap);
      const mul = item === 'power2x' ? speedMulForDistance(2) : 1; // 이동 거리 2배
      let rad = CONFIG.pieceRadius;
      let mass = 1;
      if (item === 'size2x') {
        rad *= 2;
        mass = 2;
      }
      if (item === 'anchor') {
        mass = Infinity;
        power = 0;
      }
      const v = power * mul * vmax;
      bodies.push({
        id, owner: id, real: true, x: pc.x, y: pc.y,
        vx: Math.cos(inp.angle) * v, vy: Math.sin(inp.angle) * v, r: rad, m: mass,
      });
      if (item) {
        revealed.push({ id, item });
        pc.item = null;
      }
    }
    // 분신은 본체가 모두 배치된 뒤 생성 (다른 말과 겹치지 않게)
    for (const id of alive) {
      const inp = r.inputs[id];
      if (!revealed.some((x) => x.id === id && x.item === 'clone')) continue;
      const pc = r.pieces[id];
      // 클라이언트 미리보기와 같은 값이 나오도록 다른 생존 말 위치(반지름 1)만으로 계산
      const others = alive.filter((o) => o !== id).map((o) => ({ x: r.pieces[o].x, y: r.pieces[o].y }));
      const pos = clonePosition(pc, others);
      const c = inp.clone ?? { angle: 0, power: 0 };
      const power = pc.capped ? Math.min(c.power, CONFIG.crackPowerCap) : c.power;
      const v = power * vmax;
      bodies.push({
        id: `${id}#clone`, owner: id, real: false, x: pos.x, y: pos.y,
        vx: Math.cos(c.angle) * v, vy: Math.sin(c.angle) * v, r: CONFIG.pieceRadius, m: 1,
      });
    }

    // 지구 온난화: 모두 조준을 마친 뒤, 출발 직전에 무작위 위치에 구멍
    let warming = null;
    if (this.random() < this.warmingChance) {
      warming = this.spawnHole();
      r.holes.push(warming);
      r.boxes = r.boxes.filter((b) => !inAnyHole(b.x, b.y, [warming]));
    }

    const sim = simulate(bodies, { boardRadius: r.radius, boxes: r.boxes, holes: r.holes });

    // ── 정리 단계 ──
    // 1) 탈락 처리 (낙하 순서 기록)
    const realFalls = sim.falls.filter((f) => f.real);
    const byTick = new Map();
    for (const f of realFalls) {
      if (!byTick.has(f.tick)) byTick.set(f.tick, []);
      byTick.get(f.tick).push(f.id);
    }
    for (const [, ids] of [...byTick.entries()].sort((a, b) => a[0] - b[0])) {
      r.fallSeq.push(ids);
      for (const id of ids) r.pieces[id].alive = false;
      r.eliminated += ids.length;
    }
    for (const f of sim.final) {
      const pc = r.pieces[f.id];
      if (pc && pc.alive) {
        pc.x = f.x;
        pc.y = f.y;
      }
    }
    // 크기 2배 해제 → 겹치면 밀어냄
    const restore = this.aliveIds().map((id) => ({ id, x: r.pieces[id].x, y: r.pieces[id].y, r: CONFIG.pieceRadius }));
    separate(restore);
    for (const b of restore) Object.assign(r.pieces[b.id], { x: b.x, y: b.y });

    // 균열 효과: 이번 턴 제한은 해제하고, 균열 위에서 멈춘 말에 다음 턴 제한
    const crackList = dedupeCracks(Object.entries(r.cracks).map(([owner, c]) => ({ ...c, owner })));
    for (const id of Object.keys(r.pieces)) r.pieces[id].capped = false;
    const capped = [];
    const crackHits = []; // {ghost: 균열 놓은 유령, victim: 걸린 사람}
    for (const id of this.aliveIds()) {
      const pc = r.pieces[id];
      const hit = crackList.find((c) => Math.hypot(c.x - pc.x, c.y - pc.y) < CONFIG.crackRadius);
      if (hit) {
        pc.capped = true;
        capped.push(id);
        crackHits.push({ ghost: hit.owner, victim: id });
      }
    }

    // 2) 아이템 획득
    // 클라이언트는 tick을 보고 펭귄이 닿는 순간 상자를 지움. 먹고 같은 턴에 떨어졌으면 상자만 사라지고 아이템은 없음
    const gained = [];
    for (const p of sim.pickups) {
      r.boxes = r.boxes.filter((b) => b.id !== p.boxId);
      const pc = r.pieces[p.id];
      const kept = pc.alive;
      if (kept) {
        pc.item = ITEM_KEYS[Math.floor(this.random() * ITEM_KEYS.length)];
        pc.itemTurn = r.turn;
      }
      gained.push({ id: p.id, boxId: p.boxId, tick: p.tick, gained: kept });
    }

    // 3) 판 녹음
    const oldRadius = r.radius;
    const rate = CONFIG.meltBase + CONFIG.meltPerElimination * r.eliminated;
    r.radius = Math.max(CONFIG.minBoardRadius, r.radius * (1 - rate));
    const meltOut = this.aliveIds()
      .filter((id) => Math.hypot(r.pieces[id].x, r.pieces[id].y) > r.radius)
      .sort((a, b) => hypot(r.pieces[b]) - hypot(r.pieces[a]));
    for (const id of meltOut) {
      r.fallSeq.push([id]); // 먼 순서대로 먼저 떨어진 걸로
      r.pieces[id].alive = false;
      r.eliminated++;
    }
    // 판 밖으로 나간 상자 제거
    r.boxes = r.boxes.filter((b) => Math.hypot(b.x, b.y) < r.radius - CONFIG.itemBoxRadius);

    // 4) 새 아이템 생성
    const newBoxes = [];
    if (this.itemsOn && r.turn % CONFIG.itemEveryTurns === 0) {
      const box = this.spawnBox();
      if (box) {
        r.boxes.push(box);
        newBoxes.push(box);
      }
    }

    // 5) 승리 조건
    const aliveAfter = this.aliveIds();
    const roundOver = aliveAfter.length <= 1;

    const playbackSec = playbackSeconds(sim.ticks, realFalls, !!warming);

    this.opts.broadcast({
      t: 'turnResult',
      turn: r.turn,
      bodies: bodies.map((b) => ({ id: b.id, owner: b.owner, r: b.r, clone: !b.real, anchor: b.m === Infinity })),
      frames: sim.frames,
      frameDt: CONFIG.frameEvery / CONFIG.tickRate,
      falls: sim.falls.map((f) => ({ id: f.id, tick: f.tick, vx: round2(f.vx), vy: round2(f.vy) })),
      pickups: gained,
      revealed,
      cracks: crackList,
      capped,
      crackHits,
      meltOut,
      oldRadius,
      newRadius: r.radius,
      newBoxes,
      boxes: r.boxes,
      warming,
      holes: r.holes,
      roundOver,
      playbackSec,
    });

    this.timer = setTimeout(() => {
      if (roundOver) this.endRound();
      else this.startAim();
    }, playbackSec * 1000);
  }

  // 판 안쪽 무작위 위치 (구멍 전체가 판 안에 들어오게)
  spawnHole() {
    const r = this.round;
    const hr = randomHoleRadius(this.random, r.radius);
    // 깨진 윤곽(최대 1.1배)까지 판 안에 들어오게 여유를 둠 → 화면에서도 온전한 구멍으로 보임
    const maxD = Math.max(0, r.radius - hr * 1.15 - 0.1);
    const a = this.random() * Math.PI * 2;
    const d = Math.sqrt(this.random()) * maxD;
    return { x: round2(Math.cos(a) * d), y: round2(Math.sin(a) * d), r: round2(hr) };
  }

  spawnBox() {
    const r = this.round;
    const nextRate = CONFIG.meltBase + CONFIG.meltPerElimination * r.eliminated;
    const safeR = Math.max(CONFIG.minBoardRadius, r.radius * (1 - nextRate)) - CONFIG.itemBoxRadius;
    if (safeR <= 0) return null;
    for (let i = 0; i < 300; i++) {
      const a = this.random() * Math.PI * 2;
      const d = Math.sqrt(this.random()) * safeR;
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      const ok = this.aliveIds().every(
        (id) => Math.hypot(r.pieces[id].x - x, r.pieces[id].y - y) >= CONFIG.pieceRadius + CONFIG.itemMinDistFromPiece,
      ) && r.boxes.every((b) => Math.hypot(b.x - x, b.y - y) > CONFIG.itemBoxRadius * 3)
        && !r.holes.some((h) => Math.hypot(h.x - x, h.y - y) < h.r + CONFIG.itemBoxRadius);
      if (ok) return { id: `box${++boxSeq}`, x: round2(x), y: round2(y) };
    }
    return null;
  }

  // ───────── 판 종료 / 점수 ─────────
  endRound() {
    const r = this.round;
    r.phase = 'roundEnd';
    // 순위: 생존자 → 늦게 떨어진 그룹 순
    const groups = [];
    const survivors = this.aliveIds();
    if (survivors.length) groups.push(survivors);
    for (let i = r.fallSeq.length - 1; i >= 0; i--) groups.push(r.fallSeq[i]);
    const ranks = {};
    let place = 1;
    for (const g of groups) {
      for (const id of g) ranks[id] = place;
      place += g.length;
    }
    const winners = Object.keys(ranks).filter((id) => ranks[id] === 1);
    for (const id of Object.keys(ranks)) {
      if (ranks[id] === 1) this.firsts[id]++;
      this.scores[id] += this.n - ranks[id] + 1;
    }
    if (this.duel && winners.length === 1) this.wins[winners[0]]++;
    this.lastRank = ranks;
    this.history.push(ranks);

    const matchOver = this.isMatchOver();
    const standings = this.standings();
    this.opts.broadcast({
      t: 'roundEnd',
      round: this.roundIndex,
      ranks,
      draw: winners.length > 1,
      scores: this.scores,
      wins: this.wins,
      duel: this.duel,
      matchOver,
      standings,
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (matchOver) {
        this.over = true;
        this.opts.onEnd(standings);
      } else this.startRound();
    }, ROUND_END_SEC * 1000);
  }

  isMatchOver() {
    if (this.duel) {
      const need = Math.ceil(this.totalRounds / 2);
      if (Object.values(this.wins).some((w) => w >= need)) return true;
      return this.roundIndex >= this.totalRounds * 3; // 무승부가 계속될 때 안전장치
    }
    return this.roundIndex >= this.totalRounds;
  }

  standings() {
    const ids = this.players.map((p) => p.id);
    const key = this.duel
      ? (id) => [this.wins[id], this.firsts[id], -(this.lastRank[id] ?? 99)]
      : (id) => [this.scores[id], this.firsts[id], -(this.lastRank[id] ?? 99)];
    ids.sort((a, b) => cmpArr(key(b), key(a)));
    const out = [];
    ids.forEach((id, i) => {
      const prev = out[i - 1];
      const tied = prev && cmpArr(key(id), key(prev.id)) === 0;
      out.push({ id, place: tied ? prev.place : i + 1, score: this.scores[id], wins: this.wins[id], firsts: this.firsts[id] });
    });
    return out;
  }

  // ───────── 상태 전송 ─────────
  aliveIds() {
    return Object.keys(this.round.pieces).filter((id) => this.round.pieces[id].alive);
  }

  publicState() {
    const r = this.round;
    const rate = CONFIG.meltBase + CONFIG.meltPerElimination * r.eliminated;
    return {
      t: 'state',
      phase: r.phase,
      round: this.roundIndex,
      totalRounds: this.totalRounds,
      duel: this.duel,
      turn: r.turn,
      radius: r.radius,
      nextRadius: Math.max(CONFIG.minBoardRadius, r.radius * (1 - rate)),
      timeLeftMs: Math.max(0, r.deadline - Date.now()),
      boxes: r.boxes,
      holes: r.holes,
      scores: this.scores,
      wins: this.wins,
      players: this.players.map((p) => {
        const pc = r.pieces[p.id];
        return {
          id: p.id, name: p.name, color: p.color,
          x: pc.x, y: pc.y, alive: pc.alive,
          confirmed: !!r.inputs?.[p.id],
          hasItem: !!pc.item,
          capped: pc.capped,
          connected: this.opts.isConnected(p.id),
        };
      }),
    };
  }

  stateFor(id) {
    const s = this.publicState();
    const pc = this.round.pieces[id];
    if (pc) {
      s.myItem = pc.item;
      s.myItemUsable = this.itemUsable(id);
      s.myCrack = this.round.cracks?.[id] ?? null;
    }
    return s;
  }

  broadcastState() {
    for (const p of this.players) this.opts.sendTo(p.id, this.stateFor(p.id));
    this.opts.broadcast(this.publicState(), (id) => !this.round.pieces[id]); // 관전자
  }

  onReconnect(id) {
    if (this.over) return;
    this.opts.sendTo(id, this.stateFor(id));
  }

  onDisconnect() {
    this.autoConfirmDisconnected();
  }
}

// ───────── 유틸 ─────────
function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hypot = (p) => Math.hypot(p.x, p.y);
const round2 = (v) => Math.round(v * 100) / 100;
const cmpArr = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
function dedupeCracks(list) {
  const out = [];
  for (const c of list) {
    if (!out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < CONFIG.crackRadius)) out.push(c);
  }
  return out;
}
