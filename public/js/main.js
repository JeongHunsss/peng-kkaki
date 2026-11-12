import { CONFIG, ITEMS, QUICK_CHATS, PROTOCOL, clonePosition, startBoardRadius } from '../shared/config.js';
import { GameScene } from './scene.js';
import { sound } from './sound.js';

const $ = (s) => document.querySelector(s);
// 게임이 올라간 경로 (예: '/' 또는 '/pengkkaki/'). nginx 하위 경로 배포 지원
const BASE_PATH = location.pathname.replace(/[^/]*$/, '');
const $$ = (s) => [...document.querySelectorAll(s)];

// ───────── 상태 ─────────
// 접속 정보(token)는 탭마다 따로(sessionStorage): 같은 브라우저 탭끼리 서로 끊어내는 문제 방지. 새로고침해도 유지됨
const me = { id: null, token: sessionStorage.getItem('pk_token') || '', name: localStorage.getItem('pk_name') || '' };
let ws = null;
let room = null;
let game = null; // { players(meta), state, duel, startRadius }
let pendingRoomJoin = new URLSearchParams(location.search).get('room');
const queued = []; // 재생 중에 도착한 메시지
const aim = newAim();
const muted = new Set();
let scene = null;
let deadline = 0;
let lastRound = 0;
let lastTurn = 0;
let myCrackPlaced = false; // 유령: 이번 턴에 균열을 놓았는지
let wasAlive = false; // 유령이 된 순간을 알기 위해
let matchResultOpen = false; // 최종 결과창을 닫기 전까지 화면 유지
let practiceTip = false; // 혼자 연습 첫 턴에만 조작 안내 배너
let lastTickSec = -1; // 조준 마지막 3초 소리

function newAim() {
  return { main: { angle: 0, power: 0 }, clone: { angle: 0, power: 0 }, target: 'main', useItem: false, confirmed: false };
}

// ───────── 네트워크 ─────────
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BASE_PATH}`);
  ws.onopen = () => send({ t: 'hello', name: me.name, token: me.token, proto: PROTOCOL });
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = (ev) => {
    if (ev.code === 4000) {
      // 다른 창(탭 복제 등)이 이 접속을 이어받음 → 서로 끊어내는 무한 반복을 막기 위해 재접속하지 않음
      showReplaced();
      return;
    }
    if (ev.code === 4003) {
      toast('이 주소에서는 접속할 수 없어요. 공식 주소로 열어 주세요.');
      return; // 서버가 거부한 것이라 다시 시도해도 같음
    }
    if (ev.code === 4029) {
      toast('같은 네트워크에서 접속이 너무 많아요. 잠시 뒤 다시 시도합니다…');
      setTimeout(connect, 10000);
      return;
    }
    toast('서버 연결이 끊겼어요. 다시 연결 중…');
    setTimeout(connect, 1500);
  };
}
function showReplaced() {
  for (const s of ['menu', 'room', 'game']) $(`#screen-${s}`).classList.add('hidden');
  const box = document.createElement('div');
  box.className = 'screen card-screen';
  box.innerHTML = `<div class="card center"><h2>다른 창에서 접속했어요</h2>
    <p class="muted">같은 접속이 다른 창(탭)으로 옮겨가서 이 창은 연결을 끊었어요.</p>
    <button class="btn primary" id="btn-reconnect-here">이 창에서 새로 접속</button></div>`;
  document.body.append(box);
  box.querySelector('#btn-reconnect-here').onclick = () => {
    sessionStorage.removeItem('pk_token'); // 새 플레이어로 접속
    location.reload();
  };
}

const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function onMessage(m) {
  // 발사 재생 중에는 다음 상태를 미뤘다가 재생이 끝난 뒤 적용
  if (scene?.playback && (m.t === 'state' || m.t === 'roundEnd' || m.t === 'matchEnd' || m.t === 'turnResult')) {
    queued.push(m);
    return;
  }
  switch (m.t) {
    case 'welcome':
      me.id = m.id;
      me.token = m.token;
      me.name = m.name;
      sessionStorage.setItem('pk_token', m.token);
      localStorage.setItem('pk_name', m.name);
      $('#name-input').value = m.name;
      break;
    case 'outdated':
      // 서버가 새 버전: 한 번만 자동 새로고침, 그래도 같으면(캐시 등) 직접 하라고 안내
      if (Date.now() - Number(sessionStorage.getItem('pk_reloaded') || 0) > 30_000) {
        sessionStorage.setItem('pk_reloaded', String(Date.now()));
        toast('새 버전이 있어요. 새로고침합니다…');
        setTimeout(() => location.reload(), 800);
      } else toast('새 버전이 있어요. 새로고침(F5)해 주세요.');
      break;
    case 'menu':
      room = null;
      game = null;
      clearChat(); // 방을 나오면 그 방의 대화는 지운다
      resetGameUi();
      show('menu');
      if (pendingRoomJoin) {
        send({ t: 'joinRoom', code: pendingRoomJoin });
        pendingRoomJoin = null;
        history.replaceState(null, '', BASE_PATH);
      }
      break;
    case 'roomList':
      renderRoomList(m.rooms);
      break;
    case 'room':
      syncChatRoom(m);
      room = m;
      renderRoom();
      if (!m.inGame && !game && !matchResultOpen) show('room');
      if (m.inGame && !game) {
        // 관전자로 입장
        game = { players: [], duel: false };
        show('game');
      }
      setChatMode();
      break;
    case 'gameStart':
      game = { players: m.players, duel: m.duel, startRadius: startBoardRadius(m.players.length) };
      matchResultOpen = false;
      for (const p of m.players) knownNames.set(p.id, p.name);
      lastRound = 0;
      lastTurn = 0;
      scene.resetRound();
      show('game');
      $('#overlay').classList.add('hidden');
      sysChat('게임 시작!');
      if (m.practice) {
        sysChat('🐧 처음이면: 화면을 당겼다 놓으면 반대 방향으로 미끄러져요. 세기 100%면 약 30칸, 판 반지름은 28칸이에요. 끝까지 당기면 혼자서도 밖으로 나갈 수 있으니 조심!');
        practiceTip = true;
      }
      break;
    case 'state':
      applyState(m);
      break;
    case 'crackOk':
      scene.setMyCrack({ x: m.x, y: m.y });
      myCrackPlaced = true;
      updateAimUi();
      break;
    case 'turnResult':
      playTurn(m);
      break;
    case 'roundEnd':
      showRoundEnd(m);
      break;
    case 'matchEnd':
      showMatchEnd(m);
      break;
    case 'chat':
      onChat(m);
      break;
    case 'error':
    case 'notice':
      toast(m.msg);
      break;
    default:
      break;
  }
}

function flushQueue() {
  while (queued.length && !scene.playback) onMessage(queued.shift());
}

// ───────── 화면 전환 ─────────
function show(name) {
  for (const s of ['menu', 'room', 'game']) $(`#screen-${s}`).classList.toggle('hidden', s !== name);
  if (name === 'game') requestAnimationFrame(() => scene.resize());
  setChatMode();
}

function setChatMode() {
  const chat = $('#chat');
  const inGame = !$('#screen-game').classList.contains('hidden');
  const inRoom = !$('#screen-room').classList.contains('hidden');
  const slot = inGame ? $('#chat-dock') : inRoom ? $('#room-chat-slot') : null;
  // 이미 그 자리에 있으면 다시 붙이지 않는다 — DOM에서 떼었다 붙이면 로그 스크롤이 맨 위로 돌아간다
  const moved = slot && chat.parentElement !== slot;
  const wasHidden = chat.classList.contains('hidden');
  if (moved) slot.append(chat);
  chat.classList.toggle('hidden', !slot);
  if (slot && (moved || wasHidden)) scrollChatToEnd(true); // 옮기거나 다시 보일 때는 맨 아래부터
  const free = room?.settings?.freeChat !== false;
  $('#chat-input').disabled = !free;
  $('#chat-input').placeholder = free ? '메시지 (60자)' : '빠른 채팅만 가능';
}

// ───────── 메뉴 / 방 ─────────
$('#name-input').addEventListener('change', (e) => {
  me.name = e.target.value.trim();
  send({ t: 'setName', name: me.name });
});
$('#btn-create').onclick = () => send({ t: 'createRoom' });
$('#btn-quick').onclick = () => send({ t: 'quickMatch' });
$('#btn-practice').onclick = () => send({ t: 'practice', bots: Number($('#practice-bots').value) });
$('#btn-add-bot').onclick = () => send({ t: 'addBot' });
$('#btn-remove-bot').onclick = () => send({ t: 'removeBot' });
$('#btn-join').onclick = () => {
  const code = $('#code-input').value.trim().toUpperCase();
  if (code) send({ t: 'joinRoom', code });
};
$('#code-input').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btn-join').click());
$('#btn-refresh-rooms').onclick = () => send({ t: 'listRooms' });
$('#room-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-join]');
  if (b) send({ t: 'joinRoom', code: b.dataset.join });
});

function renderRoomList(rooms) {
  const el = $('#room-list');
  if (!rooms.length) {
    el.innerHTML = '<li class="muted">열린 방이 없어요. 방을 만들어 보세요!</li>';
    return;
  }
  // 대기 중인 방 먼저, 그다음 게임 중인 방
  rooms.sort((a, b) => a.inGame - b.inGame || b.players - a.players);
  el.innerHTML = rooms
    .map((r) => {
      const full = !r.inGame && r.players >= r.maxPlayers;
      const btn = r.inGame ? '관전' : full ? '가득 참' : '참가';
      const bots = r.bots ? ` · 봇 ${r.bots}` : '';
      const tag = r.inGame ? '<span class="tag play">게임 중</span>' : r.auto ? '<span class="tag auto">자동 매칭</span>' : '<span class="tag">대기 중</span>';
      return `<li>
        ${tag}
        <span class="rl-main"><div class="rl-host">${r.auto ? '자동 매칭 방' : `${esc(r.host)}의 방`}</div>
          <div class="rl-sub">${r.code} · ${r.players}/${r.maxPlayers}명${bots}</div></span>
        <button class="btn small" data-join="${r.code}" ${full ? 'disabled' : ''}>${btn}</button></li>`;
    })
    .join('');
}

$('#room-members').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (!b) return;
  const m = room?.members.find((x) => x.id === b.dataset.kick);
  if (m && confirm(`${m.name} 님을 내보낼까요?\n이 방에는 다시 들어올 수 없어요.`)) send({ t: 'kick', id: m.id });
});
$('#btn-leave-room').onclick = () => send({ t: 'leaveRoom' });
$('#btn-start').onclick = () => send({ t: 'start' });
$('#btn-copy-link').onclick = async () => {
  const link = `${location.origin}${BASE_PATH}?room=${room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('초대 링크를 복사했어요.');
  } catch {
    prompt('초대 링크', link);
  }
};
$('#set-max').onchange = (e) => send({ t: 'settings', maxPlayers: Number(e.target.value) });
$('#set-rounds').onchange = (e) => send({ t: 'settings', rounds: Number(e.target.value) });
$('#set-items').onchange = (e) => send({ t: 'settings', items: e.target.checked });
$('#set-freechat').onchange = (e) => send({ t: 'settings', freeChat: e.target.checked });

function renderRoom() {
  if (!room) return;
  const isHost = room.hostId === me.id;
  $('#room-code').textContent = room.code;
  $('#room-count').textContent = `${room.members.length}/${room.settings.maxPlayers}`;
  const kickable = (m) => isHost && m.id !== me.id && !m.bot;
  $('#room-members').innerHTML = room.members
    .map((m) => `<li>${m.id === room.hostId ? '👑 ' : ''}${m.bot ? '🤖 ' : ''}${esc(m.name)}${m.id === me.id ? ' (나)' : ''}${m.connected ? '' : ' 📴'}`
      + (kickable(m) ? `<button class="btn tiny kick" data-kick="${m.id}" title="내보내기 (다시 못 들어와요)">내보내기</button>` : '') + '</li>')
    .join('');
  $('#room-spectators').textContent = room.spectators.length ? `관전: ${room.spectators.map((s) => s.name).join(', ')}` : '';
  const sel = $('#set-max');
  sel.innerHTML = '';
  for (let n = Math.max(CONFIG.minPlayers, room.members.length); n <= CONFIG.maxPlayers; n++) sel.add(new Option(n, n));
  sel.value = room.settings.maxPlayers;
  $('#set-rounds').value = room.settings.rounds;
  $('#set-items').checked = room.settings.items;
  $('#set-freechat').checked = room.settings.freeChat;
  for (const id of ['#set-max', '#set-rounds', '#set-items', '#set-freechat']) $(id).disabled = !isHost;
  $('#btn-start').disabled = !isHost || room.members.filter((m) => m.connected).length < CONFIG.minPlayers;
  $('#btn-start').textContent = isHost ? '시작' : '방장이 시작해요';
  $('#bot-buttons').classList.toggle('hidden', !isHost);
  $('#btn-add-bot').disabled = room.members.length >= room.settings.maxPlayers;
  $('#btn-remove-bot').disabled = !room.members.some((m) => m.bot);
  // 자동 매칭 방: 방장 대신 카운트다운으로 시작
  $('#room-title').textContent = room.auto ? '⚡ 자동 매칭' : '방 코드';
  $('#btn-start').classList.toggle('hidden', !!room.auto);
  $('#btn-leave-room').textContent = room.auto ? '매칭 취소' : '나가기';
  autoDeadline = room.auto && room.autoStartIn != null ? Date.now() + room.autoStartIn : 0;
  renderAutoStatus();
}

// 자동 매칭 대기실 안내: 혼자면 "기다리는 중", 2명 이상이면 남은 초를 센다
let autoDeadline = 0;
function renderAutoStatus() {
  const el = $('#auto-status');
  const on = !!room?.auto && !room.inGame;
  el.classList.toggle('hidden', !on);
  if (!on) return;
  const here = room.members.filter((m) => m.connected).length;
  const left = Math.max(0, Math.ceil((autoDeadline - Date.now()) / 1000));
  el.classList.toggle('go', !!autoDeadline);
  el.innerHTML = autoDeadline
    ? `<span class="big">${left}</span>초 뒤 시작 · ${here}/${room.settings.maxPlayers}명 (사람이 더 오면 같이 해요)`
    : '다른 펭귄을 기다리는 중… 🐧 2명이 모이면 카운트다운이 시작돼요';
}
setInterval(() => {
  if (autoDeadline && !$('#screen-room').classList.contains('hidden')) renderAutoStatus();
}, 250);

// ───────── 게임 상태 ─────────
function applyState(s) {
  if (!game) game = { players: s.players, duel: s.duel };
  game.state = s;
  for (const p of s.players) knownNames.set(p.id, p.name);
  game.duel = s.duel;
  game.startRadius ??= startBoardRadius(s.players.length);
  if (s.round !== lastRound) {
    scene.resetRound();
    $('#overlay').classList.add('hidden');
    lastRound = s.round;
    lastTurn = 0;
    banner(`${s.round}판 시작!`, 1500);
  }
  scene.setPlayers(s.players, me.id);
  scene.setBoxes(s.boxes);
  scene.setHoles(s.holes);
  scene.setBoard(s.radius, s.phase === 'aim' ? s.nextRadius : null);
  const mine = myPlayer();
  myCrackPlaced = !!s.myCrack;
  if (mine && wasAlive && !mine.alive) {
    banner('👻 유령이 되었어요!<br><small>판 위 아무 곳에나 균열을 놓아 산 사람을 방해할 수 있어요</small>', 3200);
    sysChat('👻 유령이 되었어요. 조준 단계마다 판 위 아무 곳이나 눌러 균열을 놓을 수 있어요. 균열 위에 멈춘 펭귄은 다음 턴 세기가 최대 50%가 돼요.');
    sound.play('ghost');
  }
  wasAlive = !!mine?.alive;
  if (s.phase === 'aim' && s.turn !== lastTurn) {
    lastTurn = s.turn;
    Object.assign(aim, newAim());
    if (s.turn === 1 && mine?.alive) scene.faceCenter(mine.x, mine.y); // 판 시작은 중심을 바라봄
    if (s.myAfkWarn) banner('⚠️ 지난 턴에 입력이 없었어요<br><small>이번에도 없으면 자리를 비운 것으로 보고 탈락해요</small>', 3000);
    else if (practiceTip && s.turn === 1 && mine?.alive) {
      setTimeout(() => banner('화면을 당겼다 놓으면 발사!<br><small>세기 100% = 약 30칸 · 판 반지름 28칸 · 판 밖은 탈락</small>', 4000), 1600);
      practiceTip = false;
    }
  }
  deadline = performance.now() + s.timeLeftMs;
  aim.confirmed = !!mine?.confirmed;
  updateAimUi();
  renderPlayers();
}

function myPlayer() {
  return game?.state?.players.find((p) => p.id === me.id) ?? null;
}

function canAim() {
  const s = game?.state;
  const mine = myPlayer();
  return s?.phase === 'aim' && mine?.alive && !aim.confirmed && !scene.playback;
}

function isGhost() {
  const s = game?.state;
  const mine = myPlayer();
  return s?.phase === 'aim' && mine && !mine.alive && !scene.playback;
}

function updateAimUi() {
  const s = game?.state;
  const aiming = canAim();
  const mine = myPlayer();
  const ghost = isGhost();
  scene.setMode(mine?.alive && s?.phase === 'aim' && !scene.playback ? 'aim' : 'overview');
  scene.setGhostZone(ghost);
  $('#ghost-hint').classList.toggle('hidden', !ghost);
  const hint = $('#ghost-hint');
  if (!mine && s) hint.innerHTML = '👀 관전 중';
  else if (ghost && myCrackPlaced) {
    hint.innerHTML = '✔ <b>균열을 놓았어요</b> — 발사 때 모두에게 공개돼요<span class="sub">다른 곳을 누르면 위치를 옮길 수 있어요</span>';
  } else if (ghost) {
    const quota = s ? ` · 이번 턴 균열 ${s.crackCount}/${s.crackMax} (생존자 수만큼, 먼저 놓은 순)` : '';
    hint.innerHTML = '👻 <b>유령도 판에 영향을 줄 수 있어요!</b> 판 위 아무 곳이나 눌러 균열을 놓으세요'
      + `<span class="sub">균열 위에 멈춘 펭귄은 다음 턴 세기가 최대 50%로 제한돼요${quota}</span>`;
  }
  hint.classList.toggle('done', ghost && myCrackPlaced);
  hint.classList.toggle('hidden', !(ghost || (!mine && s)));
  $('#aim-panel').classList.toggle('hidden', !(mine?.alive && s?.phase === 'aim' && !scene.playback));
  $('#aim-pad').classList.toggle('hidden', !aiming);

  const item = s?.myItem;
  const usable = s?.myItemUsable;
  const btn = $('#btn-item');
  btn.disabled = !aiming || !item || !usable;
  btn.classList.toggle('active', aim.useItem);
  btn.textContent = item ? `${aim.useItem ? '✔ ' : ''}${ITEMS[item].name}${usable ? '' : ' (다음 턴)'}` : '아이템 없음';
  btn.title = item ? ITEMS[item].desc : '';
  $('#btn-confirm').disabled = !aiming;
  $('#btn-confirm').textContent = aim.confirmed ? '확정됨 ✔' : '확정';
  const cloneOn = aim.useItem && item === 'clone';
  $('#clone-toggle').classList.toggle('hidden', !cloneOn || !aiming);
  if (!cloneOn) aim.target = 'main';
  $$('#clone-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.target === aim.target));
  drawAim();
}

function aimMods() {
  const s = game.state;
  const mine = myPlayer();
  const item = aim.useItem ? s.myItem : null;
  return { item, capped: !!mine?.capped, mul: item === 'power2x' ? 2 : 1 };
}

function effectivePower(p, target) {
  const { capped } = aimMods();
  return capped ? Math.min(p, CONFIG.crackPowerCap) : p;
}

function clonePos() {
  const mine = myPlayer();
  const others = game.state.players.filter((p) => p.alive && p.id !== me.id).map((p) => ({ x: p.x, y: p.y }));
  return clonePosition(mine, others);
}

function drawAim() {
  const mine = myPlayer();
  if (!mine?.alive || game?.state?.phase !== 'aim' || scene.playback) {
    scene.setAim('main', null);
    scene.setAim('clone', null);
    scene.setClonePreview(null);
    $('#aim-readout').textContent = '';
    return;
  }
  const { item, mul, capped } = aimMods();
  const mp = effectivePower(aim.main.power);
  if (item === 'anchor') scene.setAim('main', null);
  else scene.setAim('main', { x: mine.x, y: mine.y, angle: aim.main.angle, power: mp });
  if (item === 'clone') {
    const cp = clonePos();
    scene.setClonePreview(cp, mine.color);
    scene.setAim('clone', { x: cp.x, y: cp.y, angle: aim.clone.angle, power: effectivePower(aim.clone.power) });
  } else {
    scene.setClonePreview(null);
    scene.setAim('clone', null);
  }
  const cur = aim[aim.target];
  let txt = item === 'anchor' && aim.target === 'main' ? '⚓ 앵커: 제자리 고정' : `${aim.target === 'clone' ? '분신 ' : ''}세기 ${Math.round(cur.power * 100)}%`;
  if (mul === 2 && aim.target === 'main') txt += ' ×2';
  if (capped) txt += ' (균열: 최대 50%)';
  $('#aim-readout').textContent = txt;
}

$('#btn-item').onclick = () => {
  if (!canAim()) return;
  aim.useItem = !aim.useItem;
  updateAimUi();
};
$$('#clone-toggle button').forEach((b) =>
  b.addEventListener('click', () => {
    aim.target = b.dataset.target;
    updateAimUi();
  }),
);
$('#btn-confirm').onclick = () => {
  if (!canAim()) return;
  const s = game.state;
  send({
    t: 'aim',
    angle: aim.main.angle,
    power: aim.main.power,
    useItem: aim.useItem,
    clone: aim.useItem && s.myItem === 'clone' ? aim.clone : undefined,
  });
  aim.confirmed = true;
  updateAimUi();
};

// ───────── 입력: 조준(당겼다 놓기) / 카메라 회전 / 유령 균열 ─────────
let drag = null;
const MAX_PULL = () => Math.min(220, Math.min(innerWidth, innerHeight) * 0.3);

function startAimDrag(e) {
  if (!canAim()) return false;
  drag = { kind: 'aim', id: e.pointerId, x: e.clientX, y: e.clientY };
  return true;
}

function onPointerDown(e, fromPad) {
  const portrait = innerHeight > innerWidth;
  if (e.button === 2) {
    drag = { kind: 'rotate', id: e.pointerId, x: e.clientX, y: e.clientY };
    return;
  }
  if (fromPad || !portrait) {
    if (startAimDrag(e)) {
      e.target.setPointerCapture?.(e.pointerId);
      return;
    }
  }
  // 모바일 판 위 스와이프 = 카메라 회전, 짧게 탭 = (유령) 균열
  drag = { kind: 'rotate', id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, tap: true };
}

function onPointerMove(e) {
  if (!drag || drag.id !== e.pointerId) return;
  if (drag.kind === 'rotate') {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.tap && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag.tap = false;
    if (!drag.tap) {
      rotateView(dx * 0.008);
      tiltView(dy * 0.006); // 위로 밀면 앞을 보고, 아래로 밀면 위에서 내려다봄
    }
    return;
  }
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  const len = Math.hypot(dx, dy);
  if (len < 6) return;
  // 당긴 반대 방향으로 발사. 화면 기준 → 카메라 기준 → 판 절대 방향
  const sx = -dx;
  const su = dy;
  const yaw = scene.yaw;
  const fx = Math.cos(yaw);
  const fy = Math.sin(yaw);
  const rx = -Math.sin(yaw);
  const ry = Math.cos(yaw);
  const wx = sx * rx + su * fx;
  const wy = sx * ry + su * fy;
  const t = aim[aim.target];
  t.angle = Math.atan2(wy, wx);
  t.power = Math.min(1, len / MAX_PULL());
  drawAim();
}

function onPointerUp(e) {
  if (!drag || drag.id !== e.pointerId) return;
  if (drag.kind === 'rotate' && drag.tap && e.button !== 2) placeCrack(e);
  drag = null;
}

function placeCrack(e) {
  if (!isGhost()) return;
  const p = scene.screenToBoard(e.clientX, e.clientY);
  if (!p) return;
  const R = game.state.radius;
  const d = Math.hypot(p.x, p.y);
  if (d > R) return toast('판 위에만 놓을 수 있어요.');
  send({ t: 'crack', x: p.x, y: p.y });
}

function initInput() {
  const canvas = $('#three');
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    // 가로 화면에서 마우스 왼쪽 클릭: 유령이면 균열, 아니면 조준
    if (isGhost() && e.button === 0 && e.pointerType === 'mouse') {
      drag = { kind: 'rotate', id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, tap: true };
      return;
    }
    onPointerDown(e, false);
  });
  $('#aim-pad').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    onPointerDown(e, true);
    e.target.setPointerCapture?.(e.pointerId);
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => (drag = null));
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    keys.add(e.code); // 한/영 상태와 무관 (한글이면 e.key가 'ㅈ' 등으로 들어옴)
    if (e.key === 'Enter' || e.key === ' ') $('#btn-confirm').click();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  let last = performance.now();
  const loop = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    if (keys.has('KeyQ') || keys.has('ArrowLeft')) rotateView(-dt * 2);
    if (keys.has('KeyE') || keys.has('ArrowRight')) rotateView(dt * 2);
    if (keys.has('KeyW') || keys.has('ArrowUp')) tiltView(-dt * 1.2); // 앞을 봄
    if (keys.has('KeyS') || keys.has('ArrowDown')) tiltView(dt * 1.2); // 위에서 내려다봄
    if (hold.yaw) rotateView(hold.yaw * dt * 2);
    if (hold.pitch) tiltView(hold.pitch * dt * 1.2);
    tickHud();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ───────── 발사 재생 ─────────
function playTurn(res) {
  aim.confirmed = true;
  const names = Object.fromEntries((game.state?.players ?? []).map((p) => [p.id, p.name]));
  const launchBanner = () => {
    if (res.revealed.length) banner(res.revealed.map((r) => `${names[r.id]}: ${ITEMS[r.item].name}!`).join('<br>'), 1400);
    else banner('발사!', 700);
  };
  // 이벤트 안내를 차례로 띄우고 (지구 온난화 → 눈보라) 그다음 발사
  let delay = 0;
  if (res.warming) {
    banner('🌍 지구 온난화가 왔어요!<br><small>얼음에 구멍이 뚫립니다</small>', CONFIG.warmingSec * 1000 - 100);
    sysChat('🌍 지구 온난화! 얼음에 구멍이 뚫렸어요.');
    delay += CONFIG.warmingSec * 1000;
  }
  if (res.blizzard) {
    const show = () => banner('🌨️ 눈보라가 몰아쳐요!<br><small>이번 턴은 얼음이 50% 더 미끄러워요</small>', CONFIG.blizzardSec * 1000 - 100);
    if (delay) setTimeout(show, delay);
    else show();
    sysChat('🌨️ 눈보라! 이번 턴은 같은 세기로 1.5배 더 멀리 미끄러져요.');
    delay += CONFIG.blizzardSec * 1000;
  }
  if (delay) setTimeout(launchBanner, delay);
  else launchBanner();
  if (res.cracks.length) {
    sysChat(`👻 유령 균열 ${res.cracks.length}개 공개! 위에 멈추면 다음 턴 세기가 최대 50%가 돼요.`);
  }
  scene.playTurn(res, () => {
    for (const h of res.crackHits ?? []) {
      sysChat(`🧊 ${names[h.victim]}이(가) ${names[h.ghost] ?? '유령'}의 균열에 걸렸어요 — 다음 턴 세기 최대 50%`);
      if (h.ghost === me.id) toast(`👻 내 균열에 ${names[h.victim]}이(가) 걸렸어요!`);
    }
    const falls = res.falls.filter((f) => !f.id.includes('#')).map((f) => f.id);
    for (const id of [...falls, ...res.meltOut]) sysChat(`${names[id]} 탈락!`);
    for (const id of res.afkOut ?? []) sysChat(`💤 ${names[id]}이(가) 자리를 비워 탈락했어요.`);
    for (const p of res.pickups) if (p.id === me.id && p.gained) toast('아이템을 획득했어요! 다음 턴부터 쓸 수 있어요.');
    if (res.capped.includes(me.id)) toast('🧊 유령 균열 위에 멈췄어요. 다음 턴 세기 최대 50%!');
    flushQueue();
    updateAimUi();
  });
  updateAimUi();
}

// ───────── 판/매치 결과 ─────────
const knownNames = new Map(); // 게임이 끝난 뒤에도 결과창에 이름을 보여주기 위해 보관
function nameOf(id) {
  return knownNames.get(id) ?? '?';
}

function showRoundEnd(m) {
  sound.play('fanfare');
  const ids = Object.keys(m.ranks).sort((a, b) => m.ranks[a] - m.ranks[b]);
  const rows = ids
    .map((id) => `<tr><td>${m.ranks[id]}위</td><td>${esc(nameOf(id))}</td><td>${m.duel ? `${m.wins[id]}승` : `${m.scores[id]}점`}</td></tr>`)
    .join('');
  const head = m.draw && m.duel ? '무승부!' : `${esc(nameOf(ids[0]))} 승리!`;
  overlay(`<div class="card center"><h2>${m.round}판 결과 — ${head}</h2>
    <table class="result-table"><tr><th>순위</th><th>이름</th><th>${m.duel ? '승수' : '누적'}</th></tr>${rows}</table>
    <p class="muted">${m.matchOver ? '매치 종료!' : '곧 다음 판이 시작돼요…'}</p></div>`);
}

function showMatchEnd(m) {
  game = null;
  const rows = m.standings
    .map((s) => `<tr><td>${s.place}위</td><td>${esc(nameOf(s.id))}</td><td>${s.score}점 · ${s.wins}승 · 1등 ${s.firsts}회</td></tr>`)
    .join('');
  matchResultOpen = true;
  overlay(`<div class="card center"><h2>🏆 최종 결과</h2>
    <table class="result-table">${rows}</table>
    ${room?.auto ? '<p class="muted">이 방에 남아 있으면 2명 이상일 때 다음 판이 자동으로 시작돼요.</p>' : ''}
    <div class="row"><button class="btn" id="btn-match-exit">메뉴로 나가기</button>
    <button class="btn primary" id="btn-after-match">${room?.auto ? '한 판 더' : '대기실로'}</button></div></div>`);
  $('#btn-match-exit').onclick = () => send({ t: 'leaveRoom' });
  $('#btn-after-match').onclick = () => {
    matchResultOpen = false;
    $('#overlay').classList.add('hidden');
    if (room) show('room');
    else show('menu');
  };
}

// 메뉴로 돌아갈 때 게임 화면 상태를 전부 초기화
function resetGameUi() {
  queued.length = 0;
  matchResultOpen = false;
  lastRound = 0;
  lastTurn = 0;
  $('#overlay').classList.add('hidden');
  $('#banner').classList.remove('show');
  scene.clearAll();
}

function exitGame() {
  const s = game?.state;
  const playing = s && s.players.some((p) => p.id === me.id) && !matchResultOpen;
  if (playing && !confirm('게임에서 나갈까요?\n이번 매치에서 빠지고, 남은 사람들은 계속 진행해요.')) return;
  send({ t: 'leaveRoom' }); // 서버가 방에서 빼고 메뉴로 보내줌
}
$('#btn-exit').onclick = exitGame;

function overlay(html) {
  const o = $('#overlay');
  o.innerHTML = html;
  o.classList.remove('hidden');
}

// ───────── HUD ─────────
function renderPlayers() {
  const s = game?.state;
  if (!s) return;
  $('#players').innerHTML = s.players
    .map((p) => {
      const st = [];
      if (!p.alive) st.push('👻');
      else if (s.phase === 'aim') st.push(p.confirmed ? '✅' : '⌛');
      if (p.hasItem && p.alive) st.push('🎁');
      if (p.capped && p.alive) st.push('🧊');
      if (!p.connected) st.push('📴');
      const score = s.duel ? `${s.wins[p.id]}승` : `${s.scores[p.id]}점`;
      const acts =
        p.id === me.id
          ? ''
          : `<span class="acts"><button data-mute="${p.id}" title="음소거">${muted.has(p.id) ? '🔇' : '🔈'}</button><button data-report="${p.id}" title="신고">🚩</button></span>`;
      return `<div class="pl ${p.id === me.id ? 'me' : ''} ${p.alive ? '' : 'dead'}">
        <span class="dot" style="background:${p.color}"></span><span class="nm">${esc(p.name)}</span>
        <span class="st">${st.join('')}</span><span class="sc">${score}</span>${acts}</div>`;
    })
    .join('');
}

$('#players').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mute]');
  const r = e.target.closest('[data-report]');
  if (m) {
    const id = m.dataset.mute;
    muted.has(id) ? muted.delete(id) : muted.add(id);
    renderPlayers();
  }
  if (r && confirm(`${nameOf(r.dataset.report)} 님을 신고할까요?`)) {
    send({ t: 'report', target: r.dataset.report, reason: 'in-game' });
  }
});

// ───────── 시점 표시 / 회전 ─────────
const hold = { yaw: 0, pitch: 0 }; // 화면 버튼을 누르고 있는 동안의 회전/기울기 방향
let lastCamMode = '';
const camHintKey = 'pk_rotated';

function rotateView(d) {
  scene.rotateYaw(d);
  markCamUsed();
}

function tiltView(d) {
  scene.tiltPitch(d);
  markCamUsed();
}

function markCamUsed() {
  if (!localStorage.getItem(camHintKey)) {
    localStorage.setItem(camHintKey, '1'); // 한 번 돌려 봤으면 안내 문구는 숨김
    $('#cam-hint').classList.add('done');
  }
}

for (const [id, axis, dir] of [
  ['#rot-left', 'yaw', -1],
  ['#rot-right', 'yaw', 1],
  ['#tilt-up', 'pitch', 1], // 카메라를 위로 → 내려다봄
  ['#tilt-down', 'pitch', -1], // 카메라를 아래로 → 앞을 봄
]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    hold[axis] = dir;
    b.setPointerCapture?.(e.pointerId);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => (hold[axis] = 0));
}

function updateCamBadge() {
  $('#cam-angle').textContent = `${scene.pitchDeg}°`;
  const s = game?.state;
  const mine = myPlayer();
  let mode;
  if (scene.playback) mode = '🗺 전체 시점 (발사)';
  else if (scene.mode === 'aim') mode = '🎯 내 시점 (조준)';
  else if (mine && !mine.alive) mode = '👻 전체 시점 (유령)';
  else if (!mine && s) mode = '👀 전체 시점 (관전)';
  else mode = '🗺 전체 시점';
  if (mode === lastCamMode) return;
  const el = $('#cam-mode');
  el.textContent = mode;
  // 시점이 바뀌는 순간 잠깐 강조
  if (lastCamMode) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 600);
  }
  lastCamMode = mode;
}

function initCamHint() {
  const portrait = innerHeight > innerWidth;
  $('#cam-hint').textContent = portrait
    ? '판을 밀어서 시점을 돌려요 (좌우 = 회전, 위아래 = 앞/위에서 보기). ⟲⟳▲▼ 버튼도 돼요'
    : '우클릭 드래그로 시점 조절 (좌우 = 회전, 위아래 = 앞/위에서 보기). Q/E·W/S 키, ⟲⟳▲▼ 버튼도 돼요';
  $('#cam-hint').classList.toggle('done', !!localStorage.getItem(camHintKey));
}
initCamHint();
window.addEventListener('resize', initCamHint);

function tickHud() {
  const s = game?.state;
  if (!s || $('#screen-game').classList.contains('hidden')) return;
  updateCamBadge();
  const left = Math.max(0, deadline - performance.now());
  const t = $('#timer');
  if (s.phase === 'aim' && !scene.playback) {
    const sec = Math.ceil(left / 1000);
    t.textContent = sec;
    t.classList.toggle('urgent', left < 3000);
    if (left < 3000 && left > 0 && sec !== lastTickSec && canAim()) sound.play('tick');
    lastTickSec = sec;
  } else t.textContent = '';
  $('#round-info').textContent = s.duel
    ? `${s.round}판째 (${Math.ceil(s.totalRounds / 2)}선승) · ${s.turn}턴`
    : `${s.round} / ${s.totalRounds}판 · ${s.turn}턴`;
  drawMinimap();
}

function drawMinimap() {
  const c = $('#minimap');
  const x = c.getContext('2d');
  const W = c.width;
  const R0 = game.startRadius || 16;
  const k = (W / 2 - 8) / R0;
  x.clearRect(0, 0, W, W);
  x.save();
  x.translate(W / 2, W / 2);
  const s = game.state;
  const R = scene.displayRadius;
  x.fillStyle = '#cfefff';
  x.beginPath();
  x.arc(0, 0, R * k, 0, Math.PI * 2);
  x.fill();
  if (s.phase === 'aim' && !scene.playback && s.nextRadius < s.radius) {
    x.setLineDash([6, 5]);
    x.strokeStyle = '#ff4d6d';
    x.lineWidth = 2;
    x.beginPath();
    x.arc(0, 0, s.nextRadius * k, 0, Math.PI * 2);
    x.stroke();
    x.setLineDash([]);
  }
  for (const h of scene.holeList) {
    x.fillStyle = '#05253f';
    x.beginPath();
    x.arc(h.x * k, h.y * k, h.r * k, 0, Math.PI * 2);
    x.fill();
  }
  for (const b of scene.boxes.values()) {
    x.fillStyle = '#f77f00';
    x.fillRect(b.x * k - 5, b.y * k - 5, 10, 10);
  }
  for (const e of scene.pieces.values()) {
    if (!e.group.visible || e.group.position.y < -0.5) continue;
    const px = e.group.position.x * k;
    const py = e.group.position.z * k;
    x.globalAlpha = e.clone ? 0.5 : 1;
    x.fillStyle = e.color;
    x.beginPath();
    x.arc(px, py, Math.max(5, CONFIG.pieceRadius * k * e.group.scale.x), 0, Math.PI * 2);
    x.fill();
    if (e.id === me.id) {
      x.strokeStyle = '#fff';
      x.lineWidth = 3;
      x.stroke();
    }
    x.globalAlpha = 1;
  }
  // 내 카메라 방향
  const mine = scene.pieces.get(me.id);
  if (mine?.group.visible) {
    x.strokeStyle = '#ffffff';
    x.lineWidth = 2;
    x.beginPath();
    const px = mine.group.position.x * k;
    const py = mine.group.position.z * k;
    x.moveTo(px, py);
    x.lineTo(px + Math.cos(scene.yaw) * 20, py + Math.sin(scene.yaw) * 20);
    x.stroke();
  }
  x.restore();
}

let bannerTimer = null;
function banner(html, ms) {
  const b = $('#banner');
  b.innerHTML = html;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ───────── 채팅 ─────────
const BAD_WORDS = ['씨발', '시발', 'ㅅㅂ', '병신', 'ㅂㅅ', '개새끼', '좆', '지랄', 'fuck', 'shit', 'bitch'];
function filterText(t) {
  if (!$('#chat-filter').checked) return t;
  let out = t;
  for (const w of BAD_WORDS) out = out.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
  return out;
}

function onChat(m) {
  if (muted.has(m.from) || $('#chat-off').checked) return;
  const text = filterText(m.text);
  const line = document.createElement('div');
  line.className = `msg ${m.channel === 'ghost' ? 'ghost' : ''} ${m.from === me.id ? 'me' : ''}`;
  line.innerHTML = `${m.channel === 'ghost' ? '👻 ' : ''}<b>${esc(m.name)}</b> ${esc(text)}`;
  appendLog(line, true);
  if (m.bubble) scene.showBubble(m.from, text);
}

function sysChat(text) {
  const line = document.createElement('div');
  line.className = 'msg sys';
  line.textContent = text;
  appendLog(line);
}

// 채팅 로그 스크롤: 맨 아래를 보고 있을 때만 따라 내려가고, 위로 올려 읽는 중이면 "새 메시지" 버튼만 띄운다
let chatStick = true; // 로그가 맨 아래에 붙어 있는지
let chatUnread = 0; // 안 본 메시지 수 (위로 올렸거나 접혀 있는 동안)
let chatRoomCode = null; // 지금 로그가 속한 방

function appendLog(line, countUnread = false) {
  const log = $('#chat-log');
  log.append(line);
  while (log.children.length > 100) log.firstChild.remove();
  // 세로 화면에서 접혀 있으면(펼치기 버튼이 보이면) 미리보기만 보이는 상태
  const collapsed = $('#chat-expand').offsetParent !== null && !$('#chat').classList.contains('open');
  if (chatStick) log.scrollTop = log.scrollHeight;
  if (countUnread && (collapsed || !chatStick)) {
    chatUnread++;
    renderChatUnread();
  }
}

function scrollChatToEnd(force = false) {
  if (!force && !chatStick) return;
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
  chatStick = true;
  chatUnread = 0;
  renderChatUnread();
}

function renderChatUnread() {
  const open = $('#chat').classList.contains('open');
  const n = chatUnread > 99 ? '99+' : String(chatUnread);
  $('#chat-expand').textContent = open ? '접기' : chatUnread ? `펼치기 (${n})` : '펼치기';
  $('#chat-new').classList.toggle('hidden', !chatUnread || chatStick);
  $('#chat-new').textContent = `새 메시지 ${n}개 ↓`;
}

function clearChat() {
  $('#chat-log').replaceChildren();
  chatRoomCode = null;
  chatStick = true;
  chatUnread = 0;
  renderChatUnread();
}

// 방이 바뀌면 로그를 비우고, 같은 방이면 들어오고 나간 사람을 알린다
function syncChatRoom(next) {
  if (next.code !== chatRoomCode) {
    clearChat();
    chatRoomCode = next.code;
    sysChat(next.auto ? '⚡ 자동 매칭 방에 들어왔어요.' : `방 ${next.code}에 들어왔어요.`);
    return;
  }
  if (!room) return;
  const people = (r) => new Map([...r.members, ...r.spectators].map((p) => [p.id, p]));
  const before = people(room);
  const after = people(next);
  for (const [id, p] of after) if (!before.has(id) && id !== me.id) sysChat(`${p.bot ? '🤖 ' : ''}${p.name}님이 들어왔어요.`);
  for (const [id, p] of before) if (!after.has(id) && id !== me.id) sysChat(`${p.bot ? '🤖 ' : ''}${p.name}님이 나갔어요.`);
}

$('#chat-log').addEventListener('scroll', () => {
  const log = $('#chat-log');
  chatStick = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  if (chatStick && chatUnread) {
    chatUnread = 0;
    renderChatUnread();
  }
});
$('#chat-new').onclick = () => scrollChatToEnd(true);

// 서버와 같은 규칙(1초 1개, 같은 말 연속 금지)을 먼저 확인해서, 거부될 메시지로 입력창이 비워지지 않게 한다
let lastChatSentAt = 0;
let lastChatSentText = '';
function trySendChat(text, msg) {
  const now = Date.now();
  const why = now - lastChatSentAt < CONFIG.chatMinIntervalMs ? '채팅은 1초에 1개만 보낼 수 있어요.'
    : text === lastChatSentText ? '같은 메시지를 연속으로 보낼 수 없어요.' : '';
  if (why) {
    toast(why);
    return false;
  }
  lastChatSentAt = now;
  lastChatSentText = text;
  send(msg);
  return true;
}

$('#chat-quick').innerHTML = QUICK_CHATS.map((q, i) => `<button type="button" data-q="${i}">${q}</button>`).join('');
$('#chat-quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (b) trySendChat(QUICK_CHATS[b.dataset.q], { t: 'chat', quick: Number(b.dataset.q) });
});
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const v = input.value.trim();
  if (!v) return;
  if (!trySendChat(v, { t: 'chat', text: v })) return;
  input.value = '';
  input.focus(); // 전송 버튼을 눌러도 바로 다음 말을 이어 칠 수 있게
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') e.target.blur(); // 채팅에서 빠져나와 조준 단축키(Enter/Space)를 다시 쓸 수 있게
});
$('#chat-expand').onclick = () => {
  const c = $('#chat');
  c.classList.toggle('open');
  if (c.classList.contains('open')) scrollChatToEnd(true);
  else renderChatUnread();
};
$('#chat-off').onchange = (e) => {
  $('#chat-log').style.visibility = e.target.checked ? 'hidden' : '';
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ───────── 소리 ─────────
function renderSoundBtn() {
  $('#btn-sound').textContent = sound.muted ? '🔇' : '🔊';
  $('#btn-sound').title = sound.muted ? '소리 켜기' : '소리 끄기';
}
$('#btn-sound').onclick = () => {
  sound.setMuted(!sound.muted);
  renderSoundBtn();
  sound.play('click');
};
renderSoundBtn();
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => sound.unlock(), { once: true });

// ───────── 시작 ─────────
scene = new GameScene($('#three'), $('#labels'));
scene.onEvent = (name, data) => sound.play(name, data);
if (location.search.includes('debug')) window.__peng = { scene }; // 자동 테스트용
initInput();
$('#name-input').value = me.name;
connect();
