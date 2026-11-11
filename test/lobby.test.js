// Lobby를 가짜 WebSocket으로 직접 호출해 방·접속·신고 규칙을 확인한다 (서버를 띄우지 않음).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Lobby } from '../server/lobby.js';
import { CONFIG } from '../shared/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close() {
      this.readyState = 3;
    },
  };
}

function setup(opts = {}) {
  const lobby = new Lobby({ graceMs: 80, ...opts });
  const join = (name) => {
    const ws = fakeWs();
    const user = lobby.hello(ws, name, `tok-${name}`);
    return { user, ws, last: (t) => ws.sent.findLast((m) => m.t === t) };
  };
  return { lobby, join };
}

test('게임 중 끊긴 사람이 있고 나머지가 나가기를 누르면 방과 기록이 정리됨 (유령 방 방지)', async () => {
  const { lobby, join } = setup();
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'createRoom' });
  const code = a.user.room;
  lobby.handle(b.user, { t: 'joinRoom', code });
  lobby.handle(a.user, { t: 'start' });
  assert.ok(lobby.rooms.get(code).game, '게임 시작');
  // B 접속 끊김 → 유예가 지나도 게임 중이라 정리 안 됨
  lobby.disconnect(b.user, b.ws);
  await sleep(120);
  assert.ok(lobby.rooms.has(code));
  // A 나가기 → 게임 멈춤 + 끊긴 B 정리 + 방 삭제
  lobby.handle(a.user, { t: 'leaveRoom' });
  assert.equal(lobby.rooms.has(code), false, '방이 남지 않음');
  assert.equal(lobby.users.has('tok-B'), false, '끊긴 사용자 기록 삭제');
  assert.deepEqual(lobby.roomList(), []);
});

test('게임 중 끊긴 지 얼마 안 된 사람은 게임이 끝나도 유예 동안 재접속할 수 있음', async () => {
  const { lobby, join } = setup({ graceMs: 300 });
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'createRoom' });
  const code = a.user.room;
  lobby.handle(b.user, { t: 'joinRoom', code });
  lobby.handle(a.user, { t: 'start' });
  lobby.disconnect(b.user, b.ws);
  lobby.handle(a.user, { t: 'leaveRoom' }); // 바로 나감 → B는 아직 유예 중
  assert.ok(lobby.users.has('tok-B'), '유예 중에는 남아 있음');
  const ws2 = fakeWs();
  lobby.hello(ws2, 'B', 'tok-B');
  await sleep(400);
  assert.ok(lobby.users.has('tok-B'), '재접속했으면 유지');
  assert.equal(ws2.readyState, 1);
});

test('신고: 같은 방 사람만, 10초에 한 번, 파일에 한 줄씩 저장', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')), 'reports.log');
  const { lobby, join } = setup({ reportsFile: file });
  const a = join('A');
  const b = join('B');
  const c = join('C');
  lobby.handle(a.user, { t: 'createRoom' });
  lobby.handle(b.user, { t: 'joinRoom', code: a.user.room });
  // 방 밖 사람(C)은 신고 불가, 자기 자신·다른 방 사람도 불가
  lobby.handle(c.user, { t: 'report', target: a.user.id, reason: 'x' });
  assert.equal(c.last('error').msg, '방 안에서만 신고할 수 있어요.');
  lobby.handle(a.user, { t: 'report', target: a.user.id, reason: 'x' });
  assert.equal(a.last('error').msg, '신고할 수 없는 대상이에요.');
  lobby.handle(a.user, { t: 'report', target: c.user.id, reason: 'x' });
  assert.equal(a.last('error').msg, '신고할 수 없는 대상이에요.');
  // 정상 신고 → 접수, 연속 신고 → 간격 제한
  lobby.handle(a.user, { t: 'report', target: b.user.id, reason: 'in-game' });
  assert.equal(a.last('notice').msg, '신고가 접수됐어요.');
  lobby.handle(a.user, { t: 'report', target: b.user.id, reason: 'again' });
  assert.equal(a.last('error').msg, '신고는 10초에 한 번만 할 수 있어요.');
  return new Promise((resolve) => {
    setTimeout(() => {
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1, '통과한 신고만 저장');
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.target, b.user.id);
      assert.equal(rec.targetName, 'B');
      assert.equal(rec.reporterName, 'A');
      resolve();
    }, 100);
  });
});

test('신고 파일이 상한을 넘으면 저장하지 않지만 접수 응답은 보냄', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')), 'reports.log');
  const { lobby, join } = setup({ reportsFile: file });
  lobby.reportBytes = 10 * 1024 * 1024; // 이미 가득 찬 상태로 가정
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'createRoom' });
  lobby.handle(b.user, { t: 'joinRoom', code: a.user.room });
  lobby.handle(a.user, { t: 'report', target: b.user.id, reason: 'x' });
  assert.equal(a.last('notice').msg, '신고가 접수됐어요.');
  assert.equal(fs.existsSync(file), false);
});

test('방 설정은 방장만, 인원 상한은 CONFIG 범위 안', () => {
  const { lobby, join } = setup();
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'createRoom' });
  lobby.handle(b.user, { t: 'joinRoom', code: a.user.room });
  lobby.handle(b.user, { t: 'settings', maxPlayers: 5 });
  assert.equal(lobby.rooms.get(a.user.room).settings.maxPlayers, CONFIG.maxPlayers, '방장이 아니면 무시');
  lobby.handle(a.user, { t: 'settings', maxPlayers: 999 });
  assert.equal(lobby.rooms.get(a.user.room).settings.maxPlayers, CONFIG.maxPlayers);
});
