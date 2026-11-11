import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';
import { CONFIG } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // 기본: IPv4·IPv6 모두에서 받음
// 테스트용: 조준 제한시간 덮어쓰기 (예: AIM_TIME_MS=60000)
if (Number(process.env.AIM_TIME_MS) > 0) CONFIG.aimTimeMs = Number(process.env.AIM_TIME_MS);
// 테스트용: 지구 온난화 확률 덮어쓰기 (예: WARMING_CHANCE=1 이면 매 턴)
if (process.env.WARMING_CHANCE !== undefined) CONFIG.warmingChance = Math.min(1, Math.max(0, Number(process.env.WARMING_CHANCE) || 0));
// 테스트용: 눈보라 확률 덮어쓰기 (예: BLIZZARD_CHANCE=1 이면 매 턴)
if (process.env.BLIZZARD_CHANCE !== undefined) CONFIG.blizzardChance = Math.min(1, Math.max(0, Number(process.env.BLIZZARD_CHANCE) || 0));

const MAX_MSG_BYTES = 16 * 1024; // 클라이언트 메시지는 아주 작음
const MAX_MSGS_PER_SEC = 30; // 연결당 초당 메시지 상한 (넘으면 버림)
const PING_MS = 25_000; // 프록시 유휴 타임아웃 방지 + 죽은 연결 정리

const STATIC = [
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/', path.join(ROOT, 'node_modules', 'three', 'build')],
  ['/', path.join(ROOT, 'public')],
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

const lobby = new Lobby();

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
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
    return;
  }
  res.writeHead(404).end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES });

wss.on('connection', (ws) => {
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
