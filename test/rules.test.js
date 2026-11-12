import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, maxSpeed, startBoardRadius, clonePosition, slideDistance } from '../shared/config.js';
import { simulate } from '../shared/physics.js';
import { Game } from '../server/game.js';

const body = (id, x, y, vx = 0, vy = 0, extra = {}) => ({ id, x, y, vx, vy, r: 1, m: 1, real: true, ...extra });

test('판 시작 반지름 = 8 + 2 × max(인원수, 10)', () => {
  assert.equal(startBoardRadius(2), 28, '10명보다 적어도 10명 크기');
  assert.equal(startBoardRadius(4), 28);
  assert.equal(startBoardRadius(10), 28);
  assert.equal(startBoardRadius(11), 30);
  assert.equal(startBoardRadius(30), 68);
});

test('세기 100%면 약 30칸 미끄러짐, 세기 2배는 약 60칸', () => {
  const res = simulate([body('a', 0, 0, maxSpeed(), 0)], { boardRadius: 200 });
  assert.ok(Math.abs(res.final[0].x - 30) < 0.3, `moved ${res.final[0].x}`);
  const res2 = simulate([body('a', 0, 0, maxSpeed() * Math.SQRT2, 0)], { boardRadius: 200 });
  assert.ok(Math.abs(res2.final[0].x - 60) < 0.6, `moved ${res2.final[0].x}`);
  assert.equal(slideDistance(1, 2), 60);
});

test('2인 판(반지름 28): 시작 위치에서 혼자 최대 세기로는 반대편 밖까지 못 감, 세기 2배면 감', () => {
  const R = startBoardRadius(2);
  const full = simulate([body('a', -R * 0.6, 0, maxSpeed(), 0)], { boardRadius: R });
  assert.equal(full.falls.length, 0);
  const double = simulate([body('a', -R * 0.6, 0, maxSpeed() * Math.SQRT2, 0)], { boardRadius: R });
  assert.equal(double.falls.length, 1);
});

test('정면 충돌: 반발계수 0.9로 운동량 전달', () => {
  const res = simulate([body('a', 0, 0, 5, 0), body('b', 3, 0)], { boardRadius: 100 });
  const [a, b] = res.final;
  assert.ok(b.x > a.x + 2);
  assert.ok(a.x < 3, 'a는 거의 멈춤');
});

test('앵커는 부딪혀도 안 밀림', () => {
  const res = simulate([body('a', 0, 0, 8, 0), body('b', 3, 0, 0, 0, { m: Infinity })], { boardRadius: 100 });
  assert.equal(res.final[1].x, 3);
  assert.ok(res.final[0].x < 1.5, '튕겨나옴');
});

test('중심이 가장자리를 넘으면 낙하 + 상자 획득', () => {
  const res = simulate([body('a', 0, 0, maxSpeed(), 0)], { boardRadius: 5, boxes: [{ id: 'b1', x: 3, y: 0 }] });
  assert.equal(res.falls[0].id, 'a');
  assert.equal(res.pickups[0].id, 'a');
});

test('분신 위치는 판 중심 방향 기준 옆', () => {
  const p = clonePosition({ x: 5, y: 0 }, []);
  assert.ok(Math.abs(Math.hypot(p.x - 5, p.y) - CONFIG.cloneOffset) < 1e-9);
});

function makeGame(n, extra = {}) {
  const sent = [];
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: '#fff' }));
  let seed = 1;
  const g = new Game({
    players,
    rounds: 3,
    items: true,
    broadcast: (m) => sent.push(m),
    sendTo: (id, m) => sent.push({ to: id, ...m }),
    isConnected: () => true,
    onEnd: () => {},
    warmingChance: 0,
    blizzardChance: 0,
    random: () => ((seed = (seed * 16807) % 2147483647) / 2147483647),
    ...extra,
  });
  return { g, sent };
}

test('정리 단계: 판이 8% 녹고, 탈락자마다 +2%p', () => {
  const { g, sent } = makeGame(2);
  g.start();
  const R = g.round.radius;
  const [a, b] = Object.keys(g.round.pieces);
  // a를 바깥으로 세게 밀어 자멸 (세기 2배 아이템 부여)
  g.round.pieces[a].item = 'power2x';
  g.round.pieces[a].itemTurn = -1;
  const pa = g.round.pieces[a];
  g.onAim(a, { angle: Math.atan2(pa.y, pa.x), power: 1, useItem: true });
  g.onAim(b, { angle: 0, power: 0 });
  const tr = sent.find((m) => m.t === 'turnResult');
  assert.ok(tr.falls.some((f) => f.id === a));
  assert.ok(Math.abs(tr.newRadius - R * (1 - 0.1)) < 1e-9);
  assert.equal(tr.roundOver, true);
  g.stop();
});

test('순위 점수: 늦게 떨어질수록 높음, 동시 낙하는 공동 순위', () => {
  const { g, sent } = makeGame(4);
  g.start();
  g.stop();
  g.round.fallSeq = [['p0'], ['p1', 'p2']];
  for (const id of ['p0', 'p1', 'p2']) g.round.pieces[id].alive = false;
  g.endRound();
  g.stop();
  const re = sent.find((m) => m.t === 'roundEnd');
  assert.deepEqual(re.ranks, { p3: 1, p1: 2, p2: 2, p0: 4 });
  assert.deepEqual(re.scores, { p0: 1, p1: 3, p2: 3, p3: 4 });
});

test('1:1에서 같은 틱 동시 낙하는 무승부', () => {
  const { g, sent } = makeGame(2);
  g.start();
  g.stop();
  g.round.fallSeq = [['p0', 'p1']];
  g.round.pieces.p0.alive = false;
  g.round.pieces.p1.alive = false;
  g.endRound();
  g.stop();
  const re = sent.find((m) => m.t === 'roundEnd');
  assert.equal(re.draw, true);
  assert.deepEqual(re.wins, { p0: 0, p1: 0 });
});

test('균열 위에 멈춘 말은 다음 턴 세기 50% 제한', () => {
  const { g, sent } = makeGame(3);
  g.start();
  const [a, b, c] = Object.keys(g.round.pieces);
  g.round.pieces[c].alive = false; // c는 유령
  const pa = g.round.pieces[a];
  // a 위치가 바깥쪽 30% 영역에 들어가도록 반지름을 맞춤
  const d = Math.hypot(pa.x, pa.y);
  g.round.radius = d / 0.8;
  g.onCrack(c, { x: pa.x, y: pa.y });
  g.onAim(a, { angle: 0, power: 0 });
  g.onAim(b, { angle: 0, power: 0 });
  const tr = sent.find((m) => m.t === 'turnResult');
  assert.deepEqual(tr.capped, [a]);
  assert.equal(g.round.pieces[a].capped, true);
  assert.deepEqual(tr.crackHits, [{ ghost: c, victim: a }], '누구 균열에 누가 걸렸는지');
  g.stop();
});

test('아이템 사용 턴: 분신·크기 2배·앵커 공개, 분신은 턴 끝에 사라지고 아이템 소모', () => {
  const { g, sent } = makeGame(3);
  g.start();
  const [a, b, c] = Object.keys(g.round.pieces);
  const give = (id, item) => Object.assign(g.round.pieces[id], { item, itemTurn: 0 });
  give(a, 'clone');
  give(b, 'size2x');
  give(c, 'anchor');
  const st = g.stateFor(a);
  assert.equal(st.myItem, 'clone');
  assert.equal(st.myItemUsable, true);
  g.onAim(a, { angle: 0, power: 0.5, useItem: true, clone: { angle: 1, power: 0.5 } });
  g.onAim(b, { angle: 0, power: 0.5, useItem: true });
  g.onAim(c, { angle: 0, power: 1, useItem: true });
  const tr = sent.find((m) => m.t === 'turnResult');
  assert.deepEqual(tr.revealed.map((r) => r.item).sort(), ['anchor', 'clone', 'size2x']);
  assert.ok(tr.bodies.some((x) => x.clone && x.owner === a));
  assert.equal(tr.bodies.find((x) => x.id === b).r, 2);
  assert.equal(tr.bodies.find((x) => x.id === c).anchor, true);
  assert.equal(Object.keys(g.round.pieces).length, 3, '분신은 말 목록에 남지 않음');
  for (const id of [a, b, c]) assert.equal(g.round.pieces[id].item, null);
  // 앵커는 세기 입력을 무시하고 제자리
  const ci = tr.bodies.findIndex((x) => x.id === c);
  assert.deepEqual(tr.frames.at(-1)[ci], tr.frames[0][ci]);
  g.stop();
});

test('획득한 턴에는 아이템을 못 씀', () => {
  const { g } = makeGame(2);
  g.start();
  const [a] = Object.keys(g.round.pieces);
  Object.assign(g.round.pieces[a], { item: 'power2x', itemTurn: g.round.turn });
  assert.equal(g.itemUsable(a), false);
  g.stop();
});

test('상자 획득은 닿은 순간(tick)과 함께 전송됨 → 클라이언트가 그 순간 상자를 지움', () => {
  const { g, sent } = makeGame(2);
  g.start();
  const [a, b] = Object.keys(g.round.pieces);
  const pa = g.round.pieces[a];
  // a 앞쪽(중심 방향) 3칸에 상자를 놓고 중심으로 발사
  const ang = Math.atan2(-pa.y, -pa.x);
  g.round.boxes = [{ id: 'bx', x: pa.x + Math.cos(ang) * 3, y: pa.y + Math.sin(ang) * 3 }];
  g.onAim(a, { angle: ang, power: 0.5 });
  g.onAim(b, { angle: 0, power: 0 });
  const tr = sent.find((m) => m.t === 'turnResult');
  const p = tr.pickups.find((x) => x.boxId === 'bx');
  assert.ok(p, '획득 정보가 있어야 함');
  assert.equal(p.id, a);
  assert.ok(p.tick > 0 && p.tick < tr.frames.length * CONFIG.frameEvery, `tick=${p.tick}`);
  assert.equal(p.gained, true);
  assert.equal(tr.boxes.some((x) => x.id === 'bx'), false);
  g.stop();
});

test('구멍 위를 지나가면 빠짐', () => {
  const res = simulate([body('a', 0, 0, maxSpeed(), 0)], { boardRadius: 100, holes: [{ x: 10, y: 0, r: 2.5 }] });
  assert.equal(res.falls[0].id, 'a');
  assert.ok(res.final[0].x < 10, '구멍 가장자리에서 빠짐');
});

test('지구 온난화: 출발 직전 구멍이 뚫리고, 그 위의 펭귄은 빠지고, 구멍은 판 끝까지 남음', () => {
  const { g, sent } = makeGame(3, { warmingChance: 1 });
  g.start();
  const [a, b, c] = Object.keys(g.round.pieces);
  const pa = g.round.pieces[a];
  g.spawnHole = () => ({ x: pa.x, y: pa.y, r: 2.5 }); // a 발밑에 구멍
  for (const id of [a, b, c]) g.onAim(id, { angle: 0, power: 0 });
  const tr = sent.find((m) => m.t === 'turnResult');
  assert.deepEqual(tr.warming, { x: pa.x, y: pa.y, r: 2.5 });
  assert.equal(tr.holes.length, 1);
  assert.deepEqual(tr.falls.map((f) => f.id), [a]);
  assert.equal(g.round.pieces[a].alive, false);
  assert.equal(g.publicState().holes.length, 1, '다음 턴에도 구멍 유지');
  g.stop();
});

test('지구 온난화 구멍은 판 안쪽에 생기고 크기는 판과 무관하게 무작위(1.5~4)', () => {
  for (const n of [2, 30]) {
    const { g } = makeGame(n, { warmingChance: 1 });
    g.start();
    const sizes = new Set();
    for (let i = 0; i < 200; i++) {
      const h = g.spawnHole();
      assert.ok(Math.hypot(h.x, h.y) + h.r <= g.round.radius + 0.01);
      assert.ok(h.r >= 1.5 && h.r <= 4, `r=${h.r}`);
      sizes.add(h.r.toFixed(1));
    }
    assert.ok(sizes.size >= 10, '크기가 다양해야 함');
    g.stop();
  }
});

test('유령 균열은 판 위 어디든(중앙 포함) 놓을 수 있고, 판 밖은 안 됨', () => {
  const { g, sent } = makeGame(3);
  g.start();
  const [, , c] = Object.keys(g.round.pieces);
  g.round.pieces[c].alive = false;
  g.onCrack(c, { x: 0, y: 0 });
  assert.ok(sent.some((m) => m.to === c && m.t === 'crackOk' && m.x === 0), '중앙 허용');
  const n = sent.length;
  g.onCrack(c, { x: g.round.radius + 1, y: 0 });
  assert.equal(sent.length, n, '판 밖 거부');
  g.stop();
});

test('마찰을 1/1.5로 줄이면 같은 세기로 1.5배 멀리 미끄러짐', () => {
  const res = simulate([body('a', 0, 0, maxSpeed(), 0)], { boardRadius: 200, friction: CONFIG.friction / CONFIG.blizzardSlideMul });
  assert.ok(Math.abs(res.final[0].x - 45) < 0.5, `moved ${res.final[0].x}`);
});

test('눈보라: 결과에 표시되고, 그 턴만 1.5배 멀리 미끄러짐', () => {
  const run = (blizzardChance) => {
    const { g, sent } = makeGame(2, { blizzardChance });
    g.start();
    const [a, b] = Object.keys(g.round.pieces);
    const pa = g.round.pieces[a];
    const x0 = pa.x;
    const y0 = pa.y;
    const ang = Math.atan2(-pa.y, -pa.x); // 중심 방향 (판 안에서 멈춤)
    g.onAim(a, { angle: ang, power: 0.5 });
    g.onAim(b, { angle: 0, power: 0 });
    const tr = sent.find((m) => m.t === 'turnResult');
    const moved = Math.hypot(g.round.pieces[a].x - x0, g.round.pieces[a].y - y0);
    g.stop();
    return { tr, moved };
  };
  const calm = run(0);
  const storm = run(1);
  assert.equal(calm.tr.blizzard, false);
  assert.equal(storm.tr.blizzard, true);
  assert.ok(Math.abs(storm.moved / calm.moved - 1.5) < 0.02, `${calm.moved} → ${storm.moved}`);
  assert.ok(storm.tr.playbackSec > calm.tr.playbackSec, '안내 연출 시간만큼 재생이 길어짐');
});

test('균열 상한: 한 턴에 공개되는 균열은 생존자 수만큼, 먼저 놓은 순. 꽉 차면 새 균열은 거부', () => {
  const { g, sent } = makeGame(7);
  g.start();
  const ids = Object.keys(g.round.pieces);
  const [a, b] = ids; // 생존 2명
  const ghosts = ids.slice(2); // 유령 5명
  for (const id of ghosts) g.round.pieces[id].alive = false;
  assert.equal(g.crackMax(), 2);
  // 유령 5명이 서로 멀리 떨어진 곳에 균열 → 앞 2개만 채택, 3번째부터 거부
  ghosts.forEach((id, i) => g.onCrack(id, { x: (i - 2) * 5, y: 10 }));
  const errs = sent.filter((m) => m.t === 'error');
  assert.equal(errs.length, 3);
  assert.match(errs[0].msg, /최대 2개/);
  // 먼저 놓은 사람은 옮겨도 자리를 잃지 않음
  g.onCrack(ghosts[0], { x: 0, y: -10 });
  g.onAim(a, { angle: 0, power: 0 });
  g.onAim(b, { angle: 0, power: 0 });
  const tr = sent.find((m) => m.t === 'turnResult');
  assert.equal(tr.cracks.length, 2);
  assert.deepEqual(tr.cracks.map((c) => c.owner), [ghosts[0], ghosts[1]]);
  assert.deepEqual(tr.cracks[0], { x: 0, y: -10, owner: ghosts[0] });
  g.stop();
});

test('자리 비움: 연속 2턴 입력이 없으면 탈락, 중간에 입력하면 초기화. 봇은 해당 없음', () => {
  const { g, sent } = makeGame(3, { bots: ['p2'] });
  g.start();
  const turn = () => {
    g.onAim('p0', { angle: 0, power: 0 });
    g.onAim('p2', { angle: 0, power: 0 }); // 봇
    clearTimeout(g.timer);
    g.launch(); // p1은 입력 없음(시간 초과)
    const tr = sent.filter((m) => m.t === 'turnResult').at(-1);
    g.startAim();
    return tr;
  };
  const t1 = turn();
  assert.deepEqual(t1.afkOut, []);
  assert.equal(g.stateFor('p1').myAfkWarn, true, '한 번 비우면 경고');
  // p1이 이번 턴에는 입력 → 초기화
  g.onAim('p1', { angle: 0, power: 0 });
  const t2 = turn();
  assert.deepEqual(t2.afkOut, []);
  assert.equal(g.round.pieces.p1.autoTurns, 0, '입력한 턴은 0으로');
  const t3 = turn();
  assert.deepEqual(t3.afkOut, []);
  assert.equal(g.round.pieces.p1.autoTurns, 1);
  const t4 = turn();
  assert.deepEqual(t4.afkOut, ['p1'], '연속 2턴 비우면 탈락');
  assert.equal(g.round.pieces.p1.alive, false);
  assert.equal(g.round.pieces.p2.alive, true, '봇은 탈락하지 않음');
  g.stop();
});

test('충돌은 효과음용으로 {tick, v}가 결과에 실림', () => {
  const res = simulate([body('a', 0, 0, 5, 0), body('b', 3, 0)], { boardRadius: 100 });
  assert.ok(res.hits.length >= 1);
  assert.ok(res.hits[0].v > 1 && res.hits[0].tick > 0, JSON.stringify(res.hits[0])); // 마찰로 줄어든 뒤 충돌
});
