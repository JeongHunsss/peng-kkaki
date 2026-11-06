// 테스트하면서 조정하는 값(규칙서 "수치 요약")을 한곳에 모아둔다.
// 서버와 클라이언트가 같은 파일을 import 한다. 길이 단위는 말 반지름 = 1.

export const CONFIG = {
  pieceRadius: 1,
  boardRadiusBase: 8,
  boardRadiusPerPlayer: 2, // 2명 12, 10명 28, 30명 68
  spawnRadiusRatio: 0.6,

  // 세기 100% 마찰만으로 미끄러지는 거리. 규칙서(8칸)보다 훨씬 세게 조정됨 → 2인 판에선 혼자서도 끝까지 날아감
  maxSlideDistance: 30,
  friction: 10, // 일정 감속 (칸/s²). 높을수록 빠르게 튀어나가고 빨리 멈춤
  restitution: 0.9,

  aimTimeMs: 10_000,
  launchMaxSec: 6,
  tickRate: 60,
  frameEvery: 2, // 클라이언트로 보내는 프레임 간격(틱)

  meltBase: 0.08,
  meltPerElimination: 0.02,
  minBoardRadius: 2,

  itemEveryTurns: 2,
  itemBoxRadius: 0.6,
  itemMinDistFromPiece: 2,
  itemHoldLimit: 1,

  cloneOffset: 2.3,

  ghostCrackZone: 0.3, // 바깥쪽 30% 영역
  crackRadius: 1.2,
  crackPowerCap: 0.5,

  // 지구 온난화 이벤트: 모두 조준을 마친 뒤 출발 직전에 무작위 위치에 구멍. 판이 끝날 때까지 남음
  warmingChance: 0.1, // 턴마다 확률
  holeRadiusMin: 2, // 구멍 반지름은 이 범위에서 무작위 (판 크기와 무관)
  holeRadiusMax: 7,
  warmingSec: 1.8, // 안내 문구 + 얼음 깨지는 연출 시간

  launchIntroSec: 0.5, // 출발 순간 카메라가 위로 빠지는 시간
  slowmoSec: 0.3, // 낙하 슬로모 길이 (게임 시간)
  slowmoSpeed: 0.25,
  cleanupSec: 1.6, // 얼음 깨짐 연출

  chatMaxLen: 60,
  bubbleMs: 2000,
  chatMinIntervalMs: 1000,

  roundOptions: [1, 3, 5],
  defaultRounds: 3,
  minPlayers: 2,
  maxPlayers: 30,
};

export const ITEMS = {
  anchor: { name: '앵커', desc: '이번 턴 제자리 고정, 부딪혀도 안 밀림 (본인도 못 움직임)' },
  power2x: { name: '세기 2배', desc: '이번 턴 최대 이동 거리 2배 (최대 약 60칸)' },
  size2x: { name: '크기 2배', desc: '이번 턴 반지름 2배 + 무게 2배' },
  clone: { name: '분신', desc: '옆에 분신 1개 생성, 분신도 따로 조준' },
};
export const ITEM_KEYS = Object.keys(ITEMS);

export const QUICK_CHATS = ['ㅋㅋㅋ', '잘가~', '동맹?', '배신이다', '조심해!', 'GG', '😎', '😱'];

export const PLAYER_COLORS = [
  '#ff5a5f', '#3a86ff', '#ffbe0b', '#2ec4b6', '#8338ec', '#fb5607', '#06d6a0', '#ff70a6',
  '#a0c4ff', '#b5e48c', '#f15bb5', '#9b5de5', '#00bbf9', '#fee440', '#e76f51', '#90be6d',
  '#c77dff', '#ff9e00', '#4cc9f0', '#d00000', '#80ffdb', '#ffafcc', '#bc6c25', '#7209b7',
  '#caffbf', '#ff595e', '#1982c4', '#ffca3a', '#6a4c93', '#f4a261',
]; // 최대 인원(30)만큼

export const startBoardRadius = (n) => CONFIG.boardRadiusBase + CONFIG.boardRadiusPerPlayer * n;

// 세기(0~1) → 초속. 감속이 일정하므로 v0 = sqrt(2·a·d).
export const maxSpeed = () => Math.sqrt(2 * CONFIG.friction * CONFIG.maxSlideDistance);
export const slideDistance = (power, distanceMul = 1) => power * power * CONFIG.maxSlideDistance * distanceMul;
// 이동 거리를 k배로 하려면 초속은 √k배 (일정 감속이라 거리 ∝ 초속²)
export const speedMulForDistance = (k) => Math.sqrt(k);

// 분신 생성 위치: 판 중심 방향 기준 오른쪽(겹치면 왼쪽). 서버/클라 동일 계산.
export function clonePosition(piece, others) {
  const toC = Math.atan2(-piece.y, -piece.x);
  const len = Math.hypot(piece.x, piece.y);
  const base = len < 1e-6 ? 0 : toC;
  for (const side of [-1, 1]) {
    const a = base + (side * Math.PI) / 2;
    const p = { x: piece.x + Math.cos(a) * CONFIG.cloneOffset, y: piece.y + Math.sin(a) * CONFIG.cloneOffset };
    const blocked = others.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < (o.r ?? 1) + CONFIG.pieceRadius);
    if (!blocked) return p;
  }
  const a = base - Math.PI / 2;
  return { x: piece.x + Math.cos(a) * CONFIG.cloneOffset, y: piece.y + Math.sin(a) * CONFIG.cloneOffset };
}

// 낙하 슬로모 구간. 동시에(0.3초 안에) 여러 명이 떨어지면 한 번만.
export function slowmoWindows(falls) {
  const out = [];
  const sorted = [...falls].sort((a, b) => a.tick - b.tick);
  for (const f of sorted) {
    const t = f.tick / CONFIG.tickRate;
    const last = out[out.length - 1];
    if (last && t < last.end) continue;
    out.push({ start: t, end: t + CONFIG.slowmoSec, id: f.id });
  }
  return out;
}

// 클라이언트가 한 턴을 재생하는 데 걸리는 시간(초). 서버는 이만큼 기다렸다가 다음 조준 단계로.
export function playbackSeconds(ticks, realFalls, warming = false) {
  const slow = slowmoWindows(realFalls).length * CONFIG.slowmoSec * (1 / CONFIG.slowmoSpeed - 1);
  return (warming ? CONFIG.warmingSec : 0) + CONFIG.launchIntroSec + ticks / CONFIG.tickRate + slow + CONFIG.cleanupSec + 0.3;
}

// 무작위 구멍 반지름. 판이 아주 작아졌으면 판보다 크지 않게만 제한
export const randomHoleRadius = (rnd, boardRadius) =>
  Math.min(boardRadius * 0.9, CONFIG.holeRadiusMin + rnd() * (CONFIG.holeRadiusMax - CONFIG.holeRadiusMin));

// 말 중심이 구멍 안에 있으면 빠짐 (가장자리 낙하와 같은 기준)
export const inAnyHole = (x, y, holes = []) => holes.some((h) => Math.hypot(x - h.x, y - h.y) < h.r);
