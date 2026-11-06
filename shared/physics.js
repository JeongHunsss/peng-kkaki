// 바닥 평면 2D 물리. 서버에서만 실행하고 결과(프레임)를 클라이언트에 뿌린다.
import { CONFIG, inAnyHole } from './config.js';

const SUBSTEPS = 4;
const EPS_V = 0.01;

/**
 * @param {Array<{id:string,x:number,y:number,vx:number,vy:number,r:number,m:number,real:boolean}>} input
 * @param {{boardRadius:number, boxes?:Array<{id:string,x:number,y:number}>, holes?:Array<{x:number,y:number,r:number}>}} opts
 */
export function simulate(input, { boardRadius, boxes = [], holes = [] }) {
  const bodies = input.map((b) => ({ ...b, fallen: false }));
  const dt = 1 / CONFIG.tickRate;
  const h = dt / SUBSTEPS;
  const maxTicks = Math.round(CONFIG.launchMaxSec * CONFIG.tickRate);
  const frames = [snapshot(bodies)];
  const falls = []; // {id, tick, vx, vy}
  const pickups = []; // {boxId, id, tick}
  const taken = new Set();
  let tick = 0;
  let timedOut = false;

  const pickupR = CONFIG.itemBoxRadius;
  const checkPickup = (t) => {
    for (const box of boxes) {
      if (taken.has(box.id)) continue;
      let best = null;
      for (const b of bodies) {
        if (b.fallen || !b.real) continue;
        const d = Math.hypot(b.x - box.x, b.y - box.y);
        if (d < b.r + pickupR && (!best || d < best.d)) best = { id: b.id, d };
      }
      if (best) {
        taken.add(box.id);
        pickups.push({ boxId: box.id, id: best.id, tick: t });
      }
    }
  };
  checkPickup(0);

  while (tick < maxTicks) {
    tick++;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const b of bodies) {
        if (b.fallen) continue;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > 0) {
          const ns = Math.max(0, sp - CONFIG.friction * h);
          b.vx *= ns / sp;
          b.vy *= ns / sp;
        }
        b.x += b.vx * h;
        b.y += b.vy * h;
      }
      resolveCollisions(bodies);
      for (const b of bodies) {
        if (!b.fallen && (Math.hypot(b.x, b.y) > boardRadius || inAnyHole(b.x, b.y, holes))) {
          b.fallen = true;
          falls.push({ id: b.id, tick, vx: b.vx, vy: b.vy, real: b.real });
        }
      }
      checkPickup(tick);
    }
    if (tick % CONFIG.frameEvery === 0) frames.push(snapshot(bodies));
    if (bodies.every((b) => b.fallen || Math.hypot(b.vx, b.vy) < EPS_V)) break;
  }
  if (tick >= maxTicks) timedOut = true;
  if (tick % CONFIG.frameEvery !== 0) frames.push(snapshot(bodies));

  return {
    frames,
    falls,
    pickups,
    ticks: tick,
    timedOut,
    final: bodies.map((b) => ({ id: b.id, x: b.x, y: b.y, fallen: b.fallen })),
  };
}

function snapshot(bodies) {
  return bodies.map((b) => [round(b.x), round(b.y)]);
}
const round = (v) => Math.round(v * 1000) / 1000;

export function resolveCollisions(bodies) {
  const e = CONFIG.restitution;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.fallen) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b.fallen) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minD = a.r + b.r;
      if (dist >= minD) continue;
      const nx = dist > 1e-9 ? dx / dist : 1;
      const ny = dist > 1e-9 ? dy / dist : 0;
      const ia = a.m === Infinity ? 0 : 1 / a.m;
      const ib = b.m === Infinity ? 0 : 1 / b.m;
      const isum = ia + ib;
      if (isum === 0) continue;
      // 위치 보정 (질량 역수 비율로 밀어냄)
      const pen = minD - dist;
      a.x -= nx * pen * (ia / isum);
      a.y -= ny * pen * (ia / isum);
      b.x += nx * pen * (ib / isum);
      b.y += ny * pen * (ib / isum);
      // 충격량
      const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vn >= 0) continue;
      const jImp = (-(1 + e) * vn) / isum;
      a.vx -= jImp * ia * nx;
      a.vy -= jImp * ia * ny;
      b.vx += jImp * ib * nx;
      b.vy += jImp * ib * ny;
    }
  }
}

// 크기 2배 해제 후 등 겹친 말을 밀어내며 복원 (속도 없이 위치만)
export function separate(bodies, iterations = 20) {
  for (let k = 0; k < iterations; k++) {
    let moved = false;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minD = a.r + b.r;
        if (dist >= minD - 1e-6) continue;
        const nx = dist > 1e-9 ? dx / dist : 1;
        const ny = dist > 1e-9 ? dy / dist : 0;
        const pen = (minD - dist) / 2;
        a.x -= nx * pen;
        a.y -= ny * pen;
        b.x += nx * pen;
        b.y += ny * pen;
        moved = true;
      }
    }
    if (!moved) break;
  }
}
