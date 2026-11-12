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

test('강퇴: 방장만 대기실에서, 내보내진 사람은 메뉴로 가고 같은 방에 다시 못 들어옴', () => {
  const { lobby, join } = setup();
  const a = join('A');
  const b = join('B');
  const c = join('C');
  lobby.handle(a.user, { t: 'createRoom' });
  const code = a.user.room;
  lobby.handle(b.user, { t: 'joinRoom', code });
  lobby.handle(c.user, { t: 'joinRoom', code });
  // 방장이 아니면 무시
  lobby.handle(b.user, { t: 'kick', id: c.user.id });
  assert.equal(lobby.rooms.get(code).members.length, 3);
  // 방장은 자기 자신을 못 내보냄
  lobby.handle(a.user, { t: 'kick', id: a.user.id });
  assert.equal(lobby.rooms.get(code).members.length, 3);
  // 정상 강퇴
  lobby.handle(a.user, { t: 'kick', id: c.user.id });
  assert.equal(lobby.rooms.get(code).members.length, 2);
  assert.equal(c.user.room, null);
  assert.equal(c.last('notice').msg, '방장이 방에서 내보냈어요.');
  assert.equal(c.last('menu').t, 'menu');
  lobby.handle(c.user, { t: 'joinRoom', code });
  assert.match(c.last('error').msg, /다시 들어갈 수 없어요/);
  assert.equal(c.user.room, null);
  // 게임 중에는 강퇴 불가
  lobby.handle(a.user, { t: 'start' });
  lobby.handle(a.user, { t: 'kick', id: b.user.id });
  assert.equal(lobby.rooms.get(code).members.length, 2);
  lobby.rooms.get(code).game.stop(); // 타이머를 멈춰야 테스트 프로세스가 끝남
});

// ───────── 자동 매칭 ─────────
test('자동 매칭: 혼자면 대기, 2명이 되면 카운트다운 뒤 저절로 시작', async () => {
  const { lobby, join } = setup({ autoWaitMs: 60, autoFullWaitMs: 20 });
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'quickMatch' });
  const code = a.user.room;
  const room = lobby.rooms.get(code);
  assert.equal(room.auto, true);
  assert.equal(room.hostId, null);
  assert.equal(room.settings.maxPlayers, CONFIG.autoMatchMaxPlayers);
  assert.equal(a.last('room').autoStartIn, null); // 혼자서는 카운트다운 없음
  lobby.handle(b.user, { t: 'quickMatch' });
  assert.equal(b.user.room, code); // 같은 방으로 모임
  const info = b.last('room');
  assert.equal(info.auto, true);
  assert.ok(info.autoStartIn > 0 && info.autoStartIn <= 60);
  await sleep(120);
  assert.ok(room.game, '카운트다운이 끝나면 게임이 시작돼야 함');
  assert.ok(a.last('gameStart'));
  // 게임 중인 자동 방에는 새로 매칭하지 않음 → 새 방
  const c = join('C');
  lobby.handle(c.user, { t: 'quickMatch' });
  assert.notEqual(c.user.room, code);
  // 판이 끝나고 남아 있으면 다음 판 카운트다운이 다시 걸림
  room.game.stop();
  lobby.endGame(room, []);
  assert.equal(room.game, null);
  assert.ok(a.last('room').autoStartIn > 0);
  lobby.cancelAutoStart(room);
  lobby.cancelAutoStart(lobby.rooms.get(c.user.room));
});

test('자동 매칭: 2명 미만으로 줄면 카운트다운 취소, 친구 방에는 넣지 않음', async () => {
  const { lobby, join } = setup({ autoWaitMs: 60, autoFullWaitMs: 20 });
  const host = join('H');
  lobby.handle(host.user, { t: 'createRoom' }); // 일반 방
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'quickMatch' });
  assert.notEqual(a.user.room, host.user.room);
  lobby.handle(b.user, { t: 'quickMatch' });
  const room = lobby.rooms.get(a.user.room);
  assert.ok(room.autoTimer);
  lobby.handle(b.user, { t: 'leaveRoom' });
  assert.equal(room.autoTimer, null);
  assert.equal(a.last('room').autoStartIn, null);
  await sleep(100);
  assert.equal(room.game, null);
  // 마지막 사람이 나가면 방이 사라짐
  lobby.handle(a.user, { t: 'leaveRoom' });
  assert.equal(lobby.rooms.has(room.code), false);
});

test('자동 매칭: 정원이 차면 짧게 기다리고 시작, 다음 사람은 새 방', async () => {
  const { lobby, join } = setup({ autoWaitMs: 5000, autoFullWaitMs: 30 });
  const users = Array.from({ length: CONFIG.autoMatchMaxPlayers }, (_, i) => join(`P${i}`));
  for (const u of users) lobby.handle(u.user, { t: 'quickMatch' });
  const room = lobby.rooms.get(users[0].user.room);
  assert.ok(users.every((u) => u.user.room === room.code));
  assert.ok(users.at(-1).last('room').autoStartIn <= 30);
  const extra = join('X');
  lobby.handle(extra.user, { t: 'quickMatch' });
  assert.notEqual(extra.user.room, room.code);
  await sleep(80);
  assert.ok(room.game);
  assert.equal(room.game.players.length, CONFIG.autoMatchMaxPlayers);
  room.game.stop();
});

test('자동 매칭 방에서는 방장 기능(설정·강퇴·봇·시작)이 막힘', () => {
  const { lobby, join } = setup({ autoWaitMs: 5000 });
  const a = join('A');
  const b = join('B');
  lobby.handle(a.user, { t: 'quickMatch' });
  lobby.handle(b.user, { t: 'quickMatch' });
  const room = lobby.rooms.get(a.user.room);
  for (const u of [a, b]) {
    lobby.handle(u.user, { t: 'settings', rounds: 1, maxPlayers: 30 });
    lobby.handle(u.user, { t: 'kick', id: u === a ? b.user.id : a.user.id });
    lobby.handle(u.user, { t: 'addBot' });
    lobby.handle(u.user, { t: 'start' });
  }
  assert.equal(room.settings.rounds, CONFIG.defaultRounds);
  assert.equal(room.settings.maxPlayers, CONFIG.autoMatchMaxPlayers);
  assert.equal(room.members.length, 2);
  assert.equal(room.game, null);
  // 첫 사람이 나가도 방장이 생기지 않음
  lobby.handle(a.user, { t: 'leaveRoom' });
  assert.equal(room.hostId, null);
  lobby.cancelAutoStart(room);
});
