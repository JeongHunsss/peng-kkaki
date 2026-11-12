// 효과음. 파일 없이 WebAudio로 합성한다. 브라우저 정책상 첫 사용자 입력 뒤에만 소리가 나므로
// main.js가 첫 pointerdown/keydown에서 unlock()을 부른다. 음소거는 localStorage에 남는다.
const KEY = 'pk_mute';
let ctx = null;
let master = null;
let muted = localStorage.getItem(KEY) === '1';
let lastAt = {}; // 같은 소리가 너무 촘촘히 나지 않게

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// 기본 음: 주파수가 from→to로 미끄러지는 한 음
function tone({ from, to = from, dur = 0.15, type = 'sine', gain = 0.3, at = 0 }) {
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t0);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

// 잡음: 충돌·물보라·바람
function noise({ dur = 0.2, gain = 0.3, filter = 1000, q = 1, at = 0, sweepTo = null }) {
  const t0 = ctx.currentTime + at;
  const n = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(filter, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const SOUNDS = {
  // 펭귄끼리 부딪힘. v = 접근 속도(최대 약 25)
  hit: (v = 5) => {
    const k = Math.min(1, v / 15);
    noise({ dur: 0.08 + k * 0.06, gain: 0.15 + k * 0.35, filter: 1800 - k * 800, q: 0.8 });
    tone({ from: 220 - k * 80, to: 90, dur: 0.12, type: 'triangle', gain: 0.12 + k * 0.2 });
  },
  // 물에 빠짐
  fall: () => {
    tone({ from: 600, to: 120, dur: 0.35, type: 'sine', gain: 0.25 });
    noise({ dur: 0.45, gain: 0.3, filter: 900, q: 0.6, at: 0.12, sweepTo: 300 });
  },
  // 상자 획득
  pickup: () => {
    tone({ from: 660, dur: 0.09, type: 'square', gain: 0.12 });
    tone({ from: 990, dur: 0.14, type: 'square', gain: 0.12, at: 0.09 });
  },
  // 출발
  launch: () => noise({ dur: 0.5, gain: 0.22, filter: 400, q: 0.7, sweepTo: 2500 }),
  // 판이 녹으며 깨짐
  melt: () => {
    for (let i = 0; i < 5; i++) noise({ dur: 0.05, gain: 0.18, filter: 2500 + Math.random() * 1500, q: 3, at: i * 0.07 });
    tone({ from: 80, to: 40, dur: 0.6, type: 'sawtooth', gain: 0.08 });
  },
  // 지구 온난화: 얼음에 구멍
  crack: () => {
    noise({ dur: 0.3, gain: 0.4, filter: 1500, q: 2 });
    tone({ from: 60, to: 30, dur: 0.9, type: 'sawtooth', gain: 0.15 });
  },
  // 눈보라: 바람
  blizzard: () => noise({ dur: 1.8, gain: 0.25, filter: 500, q: 0.5, sweepTo: 1200 }),
  // 조준 시간 마지막 3초
  tick: () => tone({ from: 1200, dur: 0.05, type: 'square', gain: 0.08 }),
  // 유령이 됨
  ghost: () => tone({ from: 440, to: 220, dur: 0.8, type: 'sine', gain: 0.15 }),
  // 판·매치 결과
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone({ from: f, dur: 0.18, type: 'triangle', gain: 0.18, at: i * 0.12 })),
  // 버튼
  click: () => tone({ from: 800, dur: 0.04, type: 'square', gain: 0.05 }),
};

export const sound = {
  get muted() {
    return muted;
  },
  setMuted(m) {
    muted = !!m;
    localStorage.setItem(KEY, muted ? '1' : '0');
  },
  // 첫 사용자 입력에서 호출: 오디오를 켤 수 있게 됨
  unlock() {
    ensure();
  },
  play(name, arg) {
    if (muted || !SOUNDS[name]) return;
    if (!ensure() || ctx.state !== 'running') return;
    const now = performance.now();
    const minGap = name === 'hit' ? 40 : 0;
    if (now - (lastAt[name] ?? 0) < minGap) return;
    lastAt[name] = now;
    try {
      SOUNDS[name](arg);
    } catch {
      /* 오디오 오류로 게임이 멈추면 안 됨 */
    }
  },
};
