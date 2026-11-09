// 실제 서버를 띄우고 WebSocket 클라이언트 3명이 친구 방에서 한 판을 끝까지 진행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3999;

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const c = {
    ws, inbox, name,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (pred, ms = 20000) =>
      new Promise((resolve, reject) => {
        const found = inbox.find(pred);
        if (found) return resolve(found);
        const t = setTimeout(() => reject(new Error(`${name} timeout`)), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      }),
  };
  return new Promise((r) => ws.on('open', () => (c.send({ t: 'hello', name }), r(c))));
}

test('친구 방: 생성 → 참가 → 시작 → 발사 → 채팅 채널', { timeout: 60000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const a = await client('A');
    const b = await client('B');
    const c = await client('C');
    a.send({ t: 'createRoom' });
    const room = await a.wait((m) => m.t === 'room');
    b.send({ t: 'joinRoom', code: room.code });
    c.send({ t: 'joinRoom', code: room.code.toLowerCase() });
    await a.wait((m) => m.t === 'room' && m.members.length === 3);
    a.send({ t: 'settings', rounds: 1 });
    await a.wait((m) => m.t === 'room' && m.settings.rounds === 1);
    a.send({ t: 'start' });

    const st = await a.wait((m) => m.t === 'state' && m.phase === 'aim');
    assert.equal(st.players.length, 3);
    assert.equal(st.radius, 28); // 3명이어도 10명 크기: 8 + 2 × 10
    const meA = st.players.find((p) => p.name === 'A');
    const meB = st.players.find((p) => p.name === 'B');

    // 조준 중 다른 사람의 입력은 확정 여부만 보임
    a.send({ t: 'aim', angle: Math.atan2(meB.y - meA.y, meB.x - meA.x), power: 1 });
    const st2 = await b.wait((m) => m.t === 'state' && m.players.find((p) => p.name === 'A').confirmed);
    assert.equal(JSON.stringify(st2).includes('angle'), false);

    // 자유 채팅 (조준 단계: 말풍선 O)
    b.send({ t: 'chat', text: '동맹 할래?' });
    const ch = await c.wait((m) => m.t === 'chat');
    assert.equal(ch.bubble, true);
    assert.equal(ch.channel, 'all');

    b.send({ t: 'aim', angle: 0, power: 0 });
    c.send({ t: 'aim', angle: 0, power: 0 });
    const tr = await a.wait((m) => m.t === 'turnResult');
    assert.ok(tr.frames.length > 2);
    assert.ok(tr.newRadius < tr.oldRadius);

    // 남은 턴은 모두 바깥으로 돌진 → 판이 끝날 때까지
    const end = a.wait((m) => m.t === 'matchEnd', 50000);
    let turn = tr.turn;
    const loop = async () => {
      for (;;) {
        const s = await a.wait((m) => m.t === 'state' && m.phase === 'aim' && m.turn > turn, 15000).catch(() => null);
        if (!s) return;
        turn = s.turn;
        for (const cl of [a, b, c]) {
          const p = s.players.find((x) => x.name === cl.name);
          if (p.alive) cl.send({ t: 'aim', angle: Math.atan2(p.y, p.x), power: 1 });
        }
      }
    };
    loop();
    const re = await a.wait((m) => m.t === 'roundEnd', 50000);
    assert.equal(Object.keys(re.ranks).length, 3);
    const me = await end;
    assert.equal(me.standings.length, 3);
    const after = a.inbox.indexOf(me);
    const backToRoom = await a.wait((m) => m.t === 'room' && !m.inGame && a.inbox.indexOf(m) > after);
    assert.equal(backToRoom.members.length, 3);
    for (const cl of [a, b, c]) cl.ws.close();
  } finally {
    srv.kill();
  }
});

test('혼자 연습: 봇 3명이 알아서 조준하고 판이 진행됨', { timeout: 60000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT + 1), AIM_TIME_MS: '4000' }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const ws = new WebSocket(`ws://localhost:${PORT + 1}`);
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello', name: '나' }));
    ws.send(JSON.stringify({ t: 'practice', bots: 3 }));
    const until = async (pred, ms = 20000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = inbox.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('timeout');
    };
    const st = await until((m) => m.t === 'state' && m.phase === 'aim');
    assert.equal(st.players.length, 4);
    assert.equal(st.radius, 28); // 4명이어도 10명 크기
    // 봇들은 사람 입력 없이도 확정함
    await until((m) => m.t === 'state' && m.players.filter((p) => p.name.startsWith('봇') && p.confirmed).length === 3);
    ws.send(JSON.stringify({ t: 'aim', angle: 0, power: 0.3 }));
    const tr = await until((m) => m.t === 'turnResult');
    assert.equal(tr.bodies.length >= 4, true);
    // 사람이 아무것도 안 해도(제한시간 초과) 다음 턴이 계속 진행됨
    await until((m) => m.t === 'state' && m.phase === 'aim' && m.turn === 3, 40000);
    const room = inbox.filter((m) => m.t === 'room').at(-1);
    assert.equal(room.members.filter((m) => m.bot).length, 3);
    ws.close();
  } finally {
    srv.kill();
  }
});

test('방 최대 30명: 봇 29명 연습, 그 이상은 잘림', { timeout: 30000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT + 2) }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const ws = new WebSocket(`ws://localhost:${PORT + 2}`);
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ t: 'hello', name: '나' }));
    ws.send(JSON.stringify({ t: 'practice', bots: 50 }));
    ws.send(JSON.stringify({ t: 'quickMatch', size: 2 })); // 빠른 매칭은 없어졌음
    const until = async (pred) => {
      for (let i = 0; i < 200; i++) {
        const m = inbox.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('timeout');
    };
    const st = await until((m) => m.t === 'state');
    assert.equal(st.players.length, 30);
    assert.equal(st.radius, 68); // 8 + 2 × 30
    assert.equal(new Set(st.players.map((p) => p.color)).size, 30);
    assert.equal(new Set(st.players.map((p) => p.name)).size, 30);
    const err = await until((m) => m.t === 'error');
    assert.match(err.msg, /quickMatch/);
    ws.close();
  } finally {
    srv.kill();
  }
});

test('방 목록: 메뉴에 있는 사람에게 방이 실시간으로 보이고, 목록에서 참가', { timeout: 30000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT + 3) }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const open = async (name) => {
      const ws = new WebSocket(`ws://localhost:${PORT + 3}`);
      const inbox = [];
      ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify({ t: 'hello', name }));
      const until = async (pred) => {
        for (let i = 0; i < 200; i++) {
          const m = inbox.findLast(pred);
          if (m) return m;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`${name} timeout`);
      };
      return { ws, inbox, until, send: (m) => ws.send(JSON.stringify(m)) };
    };
    const a = await open('방장');
    const b = await open('구경꾼');
    const empty = await b.until((m) => m.t === 'roomList');
    assert.equal(empty.rooms.length, 0);
    a.send({ t: 'createRoom' });
    const listed = await b.until((m) => m.t === 'roomList' && m.rooms.length === 1);
    assert.equal(listed.rooms[0].host, '방장');
    assert.equal(listed.rooms[0].players, 1);
    assert.equal(listed.rooms[0].inGame, false);
    a.send({ t: 'addBot' });
    await b.until((m) => m.t === 'roomList' && m.rooms[0]?.bots === 1);
    b.send({ t: 'joinRoom', code: listed.rooms[0].code });
    const room = await a.until((m) => m.t === 'room' && m.members.length === 3);
    assert.ok(room.members.some((m) => m.name === '구경꾼'));
    // 방장이 나가고 구경꾼도 나가면 목록에서 사라짐
    a.send({ t: 'leaveRoom' });
    b.send({ t: 'leaveRoom' });
    await a.until((m) => m.t === 'roomList' && m.rooms.length === 0);
    a.ws.close();
    b.ws.close();
  } finally {
    srv.kill();
  }
});

test('게임 중 나가기: 나간 사람은 메뉴로, 남은 사람은 계속 진행', { timeout: 40000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT + 4), AIM_TIME_MS: '3000' }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const a = await client2(PORT + 4, 'A');
    const b = await client2(PORT + 4, 'B');
    a.send({ t: 'createRoom' });
    const room = await a.until((m) => m.t === 'room');
    b.send({ t: 'joinRoom', code: room.code });
    a.send({ t: 'addBot' });
    await a.until((m) => m.t === 'room' && m.members.length === 3);
    a.send({ t: 'start' });
    await b.until((m) => m.t === 'state' && m.phase === 'aim');
    b.send({ t: 'leaveRoom' });
    await b.until((m) => m.t === 'menu');
    const st = await a.until((m) => m.t === 'state' && m.players.find((p) => p.name === 'B')?.connected === false);
    assert.equal(st.players.length, 3, '나간 사람 말은 판에 남고 제자리 처리');
    a.send({ t: 'aim', angle: 0, power: 0.2 });
    await a.until((m) => m.t === 'turnResult'); // B를 기다리지 않고 진행
    const bAfter = b.inbox.length;
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(b.inbox.slice(bAfter).some((m) => m.t === 'state' || m.t === 'turnResult'), false, '나간 사람에겐 게임 메시지가 안 감');
    a.ws.close();
    b.ws.close();
  } finally {
    srv.kill();
  }
});

async function client2(port, name) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', name }));
  const until = async (pred) => {
    for (let i = 0; i < 300; i++) {
      const m = inbox.findLast(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${name} timeout`);
  };
  return { ws, inbox, until, send: (m) => ws.send(JSON.stringify(m)) };
}

test('유령(탈락자) 채팅도 산 사람에게 보이고 👻 표시용 channel=ghost', { timeout: 30000 }, async () => {
  const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT + 5), AIM_TIME_MS: '60000' }, stdio: 'pipe' });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const a = await client2(PORT + 5, 'A');
    const b = await client2(PORT + 5, 'B');
    a.send({ t: 'createRoom' });
    const room = await a.until((m) => m.t === 'room');
    b.send({ t: 'joinRoom', code: room.code });
    await a.until((m) => m.t === 'room' && m.members.length === 2);
    a.send({ t: 'addBot' });
    await a.until((m) => m.t === 'room' && m.members.length === 3);
    a.send({ t: 'start' });
    const st = await b.until((m) => m.t === 'state' && m.phase === 'aim');
    const pb = st.players.find((p) => p.name === 'B');
    // B가 혼자 바깥으로 세게 날아가 탈락
    b.send({ t: 'aim', angle: Math.atan2(pb.y, pb.x), power: 1 });
    a.send({ t: 'aim', angle: 0, power: 0 });
    await a.until((m) => m.t === 'state' && m.phase === 'aim' && m.turn === 2 && m.players.find((p) => p.name === 'B').alive === false);
    b.send({ t: 'chat', text: '유령이다' });
    const msg = await a.until((m) => m.t === 'chat' && m.text === '유령이다');
    assert.equal(msg.channel, 'ghost');
    assert.equal(msg.bubble, false);
    a.ws.close();
    b.ws.close();
  } finally {
    srv.kill();
  }
});
