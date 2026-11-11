// 혼자 테스트할 때 쓰는 간단한 봇. 서버 안에서 Game의 공개 상태만 보고 입력을 정한다.
import { CONFIG } from '../shared/config.js';

export const BOT_NAMES = [
  '봇 아델리', '봇 젠투', '봇 황제', '봇 킹', '봇 마카로니', '봇 훔볼트', '봇 바위뛰기', '봇 턱끈',
  '봇 갈라파고스', '봇 쇠푸른', '봇 마젤란', '봇 자카스', '봇 로열', '봇 피오르드', '봇 스네어스',
  '봇 노란눈', '봇 볏', '봇 꼬마', '봇 흰날개',
]; // 모자라면 '봇 N'으로 이름 붙임

const jitter = (rnd, amt) => (rnd() - 0.5) * 2 * amt;

/** 생존 봇의 조준 입력 */
export function botAim(game, id) {
  const rnd = game.random;
  const r = game.round;
  const me = r.pieces[id];
  const others = game.aliveIds().filter((o) => o !== id).map((o) => ({ id: o, ...r.pieces[o] }));
  if (!others.length) return { angle: 0, power: 0 };

  // 가장 가까운 상대를 노림. 가끔(25%)은 가장 바깥쪽 상대를 노림
  const byDist = [...others].sort((a, b) => dist(me, a) - dist(me, b));
  const target = rnd() < 0.25 ? [...others].sort((a, b) => Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y))[0] : byDist[0];
  const d = dist(me, target);
  const angle = Math.atan2(target.y - me.y, target.x - me.x) + jitter(rnd, 0.18);
  // 상대 위치보다 조금 더 가는 세기 (거리 ∝ 세기²)
  let power = Math.min(1, Math.sqrt((d + 1 + rnd() * 2) / CONFIG.maxSlideDistance));

  // 판 밖으로 너무 나가는 각이면 세기를 줄여 자멸을 줄임
  const endX = me.x + Math.cos(angle) * power * power * CONFIG.maxSlideDistance;
  const endY = me.y + Math.sin(angle) * power * power * CONFIG.maxSlideDistance;
  if (Math.hypot(endX, endY) > r.radius - 0.5) power *= 0.8;
  if ((r.holes ?? []).some((h) => Math.hypot(endX - h.x, endY - h.y) < h.r + 1)) power *= 0.6;

  const input = { angle, power, useItem: false };
  if (game.itemUsable(id) && rnd() < 0.7) {
    input.useItem = true;
    if (me.item === 'power2x') input.power = power * 0.85; // 거리 2배라서 덜 당겨도 세게 밀어냄
    if (me.item === 'clone') {
      const t2 = byDist[1] ?? target;
      input.clone = { angle: Math.atan2(t2.y - me.y, t2.x - me.x) + jitter(rnd, 0.3), power: 0.7 + rnd() * 0.3 };
    }
  }
  return input;
}

/** 유령 봇의 균열 위치: 살아 있는 말 근처 (판 안) */
export function botCrack(game) {
  const rnd = game.random;
  const r = game.round;
  const alive = game.aliveIds();
  const ref = alive.length ? r.pieces[alive[Math.floor(rnd() * alive.length)]] : { x: 0, y: 0 };
  let x = ref.x + jitter(rnd, 3);
  let y = ref.y + jitter(rnd, 3);
  const d = Math.hypot(x, y);
  const max = r.radius * 0.95;
  if (d > max) [x, y] = [(x / d) * max, (y / d) * max];
  return { x, y };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
