import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';
import { CONFIG, PROTOCOL } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // 기본: IPv4·IPv6 모두에서 받음
// 테스트용: 조준 제한시간 덮어쓰기 (예: AIM_TIME_MS=60000)
if (Number(process.env.AIM_TIME_MS) > 0) CONFIG.aimTimeMs = Number(process.env.AIM_TIME_MS);
// 테스트용: 지구 온난화 확률 덮어쓰기 (예: WARMING_CHANCE=1 이면 매 턴)
if (process.env.WARMING_CHANCE !== undefined) CONFIG.warmingChance = Math.min(1, Math.max(0, Number(process.env.WARMING_CHANCE) || 0));
// 테스트용: 눈보라 확률 덮어쓰기 (예: BLIZZARD_CHANCE=1 이면 매 턴)
if (process.env.BLIZZARD_CHANCE !== undefined) CONFIG.blizzardChance = Math.min(1, Math.max(0, Number(process.env.BLIZZARD_CHANCE) || 0));

// 접속 보호
// ALLOWED_ORIGINS: 쉼표로 구분한 허용 Origin (예: https://t1516.p.ssafy.io). 비우면 검사 안 함(로컬 개발)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
// MAX_CONN_PER_IP: 같은 IP의 동시 접속 상한. 교실처럼 공용 IP를 쓰는 곳을 생각해 넉넉히
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 20;
// TRUST_PROXY=0 이면 X-Forwarded-For를 무시하고 소켓 주소를 씀. 기본은 nginx 뒤에 있다고 보고 믿음
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';

const MAX_MSG_BYTES = 16 * 1024; // 클라이언트 메시지는 아주 작음
const MAX_MSGS_PER_SEC = 30; // 연결당 초당 메시지 상한 (넘으면 버림)
const PING_MS = 25_000; // 프록시 유휴 타임아웃 방지 + 죽은 연결 정리

const STATIC = [
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/', path.join(ROOT, 'public')],
];
// 보안 헤더. 인라인 스크립트는 index.html의 importmap 하나뿐이라 그 해시만 허용한다
const importmapHash = (() => {
  try {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    return m ? `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'` : '';
  } catch {
    return '';
  }
})();
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    `script-src 'self' ${importmapHash}`.trim(),
    "style-src 'self' 'unsafe-inline'", // 펭귄 색 등 style 속성을 씀
    "img-src 'self' data:", // 파비콘이 data: URL
    "connect-src 'self' ws: wss:",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

// 신고 저장 위치. Docker에서는 /app/data 를 볼륨으로 붙인다 (README 참고)
const REPORTS_FILE = process.env.REPORTS_FILE || path.join(ROOT, 'data', 'reports.log');
try {
  fs.mkdirSync(path.dirname(REPORTS_FILE), { recursive: true });
  fs.accessSync(path.dirname(REPORTS_FILE), fs.constants.W_OK);
} catch (e) {
  console.error(`신고 저장 폴더에 쓸 수 없음: ${path.dirname(REPORTS_FILE)} (${e.message}). 신고가 저장되지 않습니다`);
}

const lobby = new Lobby({ reportsFile: REPORTS_FILE });

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return res.writeHead(400).end('Bad request'); // 깨진 URL 인코딩으로 서버가 죽지 않게
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: lobby.rooms.size, connections: wss.clients.size }));
  }
  if (pathname === '/') pathname = '/index.html';
  for (const [prefix, dir] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.join(dir, pathname.slice(prefix.length));
    if (!file.startsWith(dir + path.sep)) break; // 경로 탈출 방지
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        // three.js는 버전 고정이라 오래 캐시, 게임 코드는 배포 즉시 반영되게 매번 확인
        'Cache-Control': prefix === '/vendor/' ? 'public, max-age=604800' : 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }
  res.writeHead(404).end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

const connsPerIp = new Map();
const clientIp = (req) => {
  const fwd = TRUST_PROXY ? req.headers['x-forwarded-for'] : null;
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || '?';
};

wss.on('connection', (ws, req) => {
  // 다른 사이트가 방문자 브라우저로 접속하는 것(CSWSH) 차단. 브라우저는 WebSocket에 항상 Origin을 보냄
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    ws.close(4003, 'origin not allowed');
    return;
  }
  const ip = clientIp(req);
  const n = (connsPerIp.get(ip) ?? 0) + 1;
  if (n > MAX_CONN_PER_IP) {
    ws.close(4029, 'too many connections');
    return;
  }
  connsPerIp.set(ip, n);
  ws.once('close', () => {
    const left = (connsPerIp.get(ip) ?? 1) - 1;
    if (left <= 0) connsPerIp.delete(ip);
    else connsPerIp.set(ip, left);
  });

  let user = null;
  let windowStart = Date.now();
  let count = 0;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      count = 0;
    }
    if (++count > MAX_MSGS_PER_SEC) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    if (process.env.DEBUG_WS) console.log('[ws]', user?.name ?? '-', raw.toString().slice(0, 200));
    try {
      if (msg.t === 'hello') {
        // 배포 전에 열려 있던 탭: 형식 버전이 다르면 새로고침하라고 알림 (접속은 받아 줌 — 클라이언트가 바로 새로고침)
        if (msg.proto !== undefined && msg.proto !== PROTOCOL) ws.send(JSON.stringify({ t: 'outdated', proto: PROTOCOL }));
        user = lobby.hello(ws, String(msg.name ?? ''), String(msg.token ?? '').slice(0, 64) || crypto.randomUUID());
        return;
      }
      if (user) lobby.handle(user, msg);
    } catch (e) {
      console.error('handle error', msg.t, e);
    }
  });
  ws.on('close', () => {
    if (user) lobby.disconnect(user, ws);
  });
  ws.on('error', () => {});
});

// 응답 없는 연결 정리
const pinger = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_MS);
wss.on('close', () => clearInterval(pinger));

// 게임 타이머 안에서 예외가 나도 다른 방까지 같이 죽지 않게 기록만 하고 계속
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

// 배포 플랫폼이 재시작할 때 깔끔하게 종료
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} 받음, 종료합니다`);
    for (const ws of wss.clients) ws.close(1001, 'server restart');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(PORT, HOST, () => {
  console.log(`펭까기 서버 실행 중: http://localhost:${PORT}`);
});
