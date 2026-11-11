// 접속·방(만들기/코드 참가)·봇·채팅을 관리한다.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CONFIG, PLAYER_COLORS, QUICK_CHATS } from '../shared/config.js';
import { Game } from './game.js';
import { BOT_NAMES } from './bot.js';

const LOBBY_GRACE_MS = 15_000;
const REPORT_INTERVAL_MS = 10_000; // 사용자당 신고 간격
const REPORT_MAX_BYTES = 10 * 1024 * 1024; // 신고 파일 상한 (넘으면 저장하지 않고 경고만)

export class Lobby {
  /**
   * @param {{reportsFile?: string|null, graceMs?: number}} [opts]
   *  reportsFile: 신고를 한 줄씩 덧붙일 파일. null이면 저장하지 않음(테스트)
   *  graceMs: 접속이 끊긴 뒤 방에서 내보내기까지 기다리는 시간
   */
  constructor(opts = {}) {
    this.users = new Map(); // token → user
    this.byId = new Map(); // id → user
    this.rooms = new Map(); // code → room
    this.reportsFile = opts.reportsFile ?? null;
    this.graceMs = opts.graceMs ?? LOBBY_GRACE_MS;
    this.reportBytes = 0; // 신고 파일에 지금까지 쓴 양 (시작할 때 기존 크기를 더함)
    if (this.reportsFile) {
      try {
        this.reportBytes = fs.statSync(this.reportsFile).size;
      } catch {
        /* 아직 파일 없음 */
      }
    }
  }

  // ───────── 접속 ─────────
  hello(ws, name, token) {
    let user = this.users.get(token);
    if (!user) {
      user = { id: crypto.randomUUID().slice(0, 8), token, name: '', ws: null, room: null, lastChat: 0, lastText: '', lastReport: 0, disconnectedAt: 0 };
      this.users.set(token, user);
      this.byId.set(user.id, user);
    }
    // 같은 접속 정보로 다른 창이 들어오면 기존 창은 '교체됨'(4000)으로 끊음 → 기존 창은 재접속하지 않음
    if (user.ws && user.ws !== ws) user.ws.close(4000, 'replaced');
    user.ws = ws;
    user.name = cleanName(name) || user.name || `펭귄${Math.floor(Math.random() * 900 + 100)}`;
    clearTimeout(user.leaveTimer);
    send(user, { t: 'welcome', id: user.id, token: user.token, name: user.name });
    const room = user.room && this.rooms.get(user.room);
    if (room) {
      this.sendRoom(room);
      room.game?.onReconnect(user.id);
      if (room.game) room.game.broadcastState();
    } else {
      user.room = null;
      this.toMenu(user);
    }
    return user;
  }

  disconnect(user, ws) {
    if (user.ws !== ws) return;
    user.ws = null;
    user.disconnectedAt = Date.now();
    const room = user.room && this.rooms.get(user.room);
    if (room?.game) {
      room.game.onDisconnect(user.id);
      room.game.broadcastState();
    }
    // 잠시 기다렸다가(재접속 유예) 방에서 내보내고 기록 삭제. 게임 중이면 게임이 끝날 때 정리
    user.leaveTimer = setTimeout(() => {
      if (user.ws) return;
      const r = user.room && this.rooms.get(user.room);
      if (r?.game) return;
      if (r) this.leaveRoom(user);
      this.forget(user);
    }, this.graceMs);
    if (room) this.sendRoom(room);
  }

  // 게임이 끝나거나 멈춘 뒤: 게임 중에 끊겨서 재접속 유예가 이미 지난 사람을 방에서 빼고 기록 삭제.
  // (유예 타이머는 게임 중이면 정리를 건너뛰므로 여기서 마저 해 줘야 방이 영원히 남지 않음)
  // 아직 유예 중인 사람은 타이머가 알아서 처리한다.
  purgeDisconnected(room) {
    const now = Date.now();
    for (const id of [...room.members, ...room.spectators]) {
      const u = this.userById(id);
      if (!u || u.bot || u.ws) continue;
      if (now - u.disconnectedAt < this.graceMs) continue;
      this.leaveRoom(u);
      this.forget(u);
    }
  }

  forget(user) {
    clearTimeout(user.leaveTimer);
    this.users.delete(user.token);
    this.byId.delete(user.id);
  }

  handle(user, msg) {
    switch (msg.t) {
      case 'setName':
        user.name = cleanName(msg.name) || user.name;
        send(user, { t: 'welcome', id: user.id, token: user.token, name: user.name });
        if (user.room) this.sendRoom(this.rooms.get(user.room));
        break;
      case 'createRoom':
        this.createRoom(user);
        break;
      case 'joinRoom':
        this.joinRoom(user, String(msg.code ?? '').toUpperCase());
        break;
      case 'leaveRoom':
        this.leaveRoom(user);
        this.toMenu(user);
        break;
      case 'listRooms':
        this.sendRoomList(user);
        break;
      case 'settings':
        this.updateSettings(user, msg);
        break;
      case 'start':
        this.startFriendGame(user);
        break;
      case 'practice':
        this.practice(user, Number(msg.bots));
        break;
      case 'addBot':
        this.addBot(user);
        break;
      case 'removeBot':
        this.removeBot(user);
        break;
      case 'kick':
        this.kick(user, String(msg.id ?? ''));
        break;
      case 'aim':
        this.gameOf(user)?.onAim(user.id, msg);
        break;
      case 'crack':
        this.gameOf(user)?.onCrack(user.id, msg);
        break;
      case 'chat':
        this.chat(user, msg);
        break;
      case 'report':
        this.report(user, String(msg.target ?? ''), String(msg.reason ?? ''));
        break;
      default:
        send(user, { t: 'error', msg: `알 수 없는 요청: ${msg.t}` });
        break;
    }
  }

  // ───────── 방 목록 (메뉴 화면에 실시간 표시) ─────────
  toMenu(user) {
    send(user, { t: 'menu' });
    this.sendRoomList(user);
  }

  roomList() {
    return [...this.rooms.values()].map((room) => {
      const bots = room.members.filter((id) => this.userById(id)?.bot).length;
      return {
        code: room.code,
        host: this.userById(room.hostId)?.name ?? '?',
        players: room.members.length,
        bots,
        maxPlayers: room.settings.maxPlayers,
        inGame: !!room.game,
        spectators: room.spectators.length,
      };
    });
  }

  sendRoomList(user) {
    send(user, { t: 'roomList', rooms: this.roomList() });
  }

  // 메뉴에 있는(방에 안 들어간) 사람들에게 목록 갱신
  broadcastRoomList() {
    const msg = { t: 'roomList', rooms: this.roomList() };
    for (const u of this.users.values()) if (u.ws && !u.room && !u.bot) send(u, msg);
  }

  gameOf(user) {
    return (user.room && this.rooms.get(user.room)?.game) || null;
  }

  // ───────── 방 ─────────
  newRoom(hostId) {
    let code;
    do code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
    while (this.rooms.has(code));
    const room = {
      code,
      hostId,
      members: [],
      spectators: [],
      settings: { maxPlayers: CONFIG.maxPlayers, rounds: CONFIG.defaultRounds, items: true, freeChat: true },
      game: null,
      banned: new Set(), // 강퇴된 사람의 토큰. 방이 사라지면 같이 사라짐
    };
    this.rooms.set(code, room);
    return room;
  }

  createRoom(user) {
    if (user.room) this.leaveRoom(user);
    const room = this.newRoom(user.id);
    room.members.push(user.id);
    user.room = room.code;
    this.sendRoom(room);
  }

  joinRoom(user, code) {
    const room = this.rooms.get(code);
    if (!room) return send(user, { t: 'error', msg: '방을 찾을 수 없어요.' });
    if (room.banned.has(user.token)) return send(user, { t: 'error', msg: '이 방에서 내보내져서 다시 들어갈 수 없어요.' });
    if (user.room === code) return this.sendRoom(room);
    if (user.room) this.leaveRoom(user);
    if (room.game) {
      room.spectators.push(user.id); // 도중 참가 불가 → 관전
    } else {
      if (room.members.length >= room.settings.maxPlayers) return send(user, { t: 'error', msg: '방이 가득 찼어요.' });
      room.members.push(user.id);
    }
    user.room = code;
    this.sendRoom(room);
    if (room.game) send(user, room.game.publicState());
  }

  leaveRoom(user) {
    const room = user.room && this.rooms.get(user.room);
    user.room = null;
    if (!room) return;
    room.spectators = room.spectators.filter((id) => id !== user.id);
    if (room.game && room.game.players.some((p) => p.id === user.id)) {
      // 게임 중 나가면 그 판은 제자리 입력 처리 (접속 끊김과 동일)
      room.leftDuringGame = room.leftDuringGame ?? new Set();
      room.leftDuringGame.add(user.id);
      room.game.onDisconnect(user.id);
    }
    room.members = room.members.filter((id) => id !== user.id);
    const humans = [...room.members, ...room.spectators].filter((id) => !this.userById(id)?.bot);
    if (!humans.length) {
      room.game?.stop();
      for (const id of room.members) if (this.userById(id)?.bot) this.forget(this.userById(id));
      this.rooms.delete(room.code);
      this.broadcastRoomList();
      return;
    }
    if (room.hostId === user.id) room.hostId = humans[0];
    this.sendRoom(room);
    const humanPlayers = room.game?.players.filter((p) => !this.userById(p.id)?.bot) ?? [];
    if (room.game && humanPlayers.every((p) => !this.isConnected(room, p.id))) {
      room.game.stop();
      room.game = null;
      this.purgeDisconnected(room);
      if (this.rooms.has(room.code)) this.sendRoom(room);
    }
  }

  // 방장이 대기실에서 사람을 내보냄. 내보내진 사람은 같은 방 코드로 다시 못 들어옴 (봇은 removeBot)
  kick(user, id) {
    const room = user.room && this.rooms.get(user.room);
    if (!room || room.hostId !== user.id || room.game) return;
    const target = this.userById(id);
    if (!target || target.bot || target.id === user.id || target.room !== room.code) return;
    room.banned.add(target.token);
    this.leaveRoom(target);
    send(target, { t: 'notice', msg: '방장이 방에서 내보냈어요.' });
    this.toMenu(target);
    if (this.rooms.has(room.code)) this.sendRoom(room);
  }

  // ───────── 봇 (혼자 테스트용) ─────────
  newBot(room) {
    const used = new Set(room.members.map((id) => this.userById(id)?.name));
    let name = BOT_NAMES.find((n) => !used.has(n));
    for (let k = 1; !name; k++) if (!used.has(`봇 ${k}`)) name = `봇 ${k}`;
    const id = `bot-${crypto.randomUUID().slice(0, 6)}`;
    const bot = { id, token: id, name, ws: null, bot: true, room: room.code };
    this.users.set(id, bot);
    this.byId.set(id, bot);
    room.members.push(id);
    return bot;
  }

  addBot(user) {
    const room = user.room && this.rooms.get(user.room);
    if (!room || room.hostId !== user.id || room.game) return;
    if (room.members.length >= room.settings.maxPlayers) return send(user, { t: 'error', msg: '방이 가득 찼어요.' });
    this.newBot(room);
    this.sendRoom(room);
  }

  removeBot(user) {
    const room = user.room && this.rooms.get(user.room);
    if (!room || room.hostId !== user.id || room.game) return;
    const botId = [...room.members].reverse().find((id) => this.userById(id)?.bot);
    if (!botId) return;
    room.members = room.members.filter((id) => id !== botId);
    this.forget(this.userById(botId));
    this.sendRoom(room);
  }

  // 메뉴의 "혼자 연습": 방을 만들고 봇을 채운 뒤 바로 시작
  practice(user, bots) {
    if (user.room) this.leaveRoom(user); // 이전 방에 남아 있어도 바로 연습 시작
    const n = clampInt(bots, 1, CONFIG.maxPlayers - 1);
    this.createRoom(user);
    const room = this.rooms.get(user.room);
    for (let i = 0; i < n; i++) this.newBot(room);
    this.startGame(room);
    this.sendRoom(room);
  }

  updateSettings(user, msg) {
    const room = user.room && this.rooms.get(user.room);
    if (!room || room.hostId !== user.id || room.game) return;
    const s = room.settings;
    if (msg.maxPlayers !== undefined) s.maxPlayers = clampInt(msg.maxPlayers, Math.max(CONFIG.minPlayers, room.members.length), CONFIG.maxPlayers);
    if (CONFIG.roundOptions.includes(Number(msg.rounds))) s.rounds = Number(msg.rounds);
    if (msg.items !== undefined) s.items = !!msg.items;
    if (msg.freeChat !== undefined) s.freeChat = !!msg.freeChat;
    this.sendRoom(room);
  }

  startFriendGame(user) {
    const room = user.room && this.rooms.get(user.room);
    if (!room || room.hostId !== user.id || room.game) return;
    const players = room.members.filter((id) => this.present(id));
    if (players.length < CONFIG.minPlayers) return send(user, { t: 'error', msg: '2명 이상 있어야 시작할 수 있어요.' });
    this.startGame(room);
    this.sendRoom(room);
  }

  startGame(room) {
    const ids = room.members.filter((id) => this.present(id)).slice(0, CONFIG.maxPlayers);
    room.leftDuringGame = new Set();
    const players = ids.map((id, i) => ({ id, name: this.userById(id).name, color: PLAYER_COLORS[i % PLAYER_COLORS.length] }));
    room.game = new Game({
      players,
      rounds: room.settings.rounds,
      items: room.settings.items,
      bots: ids.filter((id) => this.userById(id)?.bot),
      broadcast: (msg, filter) => this.roomBroadcast(room, msg, filter),
      sendTo: (id, msg) => {
        const u = this.userById(id);
        if (u && u.room === room.code) send(u, msg);
      },
      isConnected: (id) => this.isConnected(room, id),
      onEnd: (standings) => this.endGame(room, standings),
    });
    this.roomBroadcast(room, { t: 'gameStart', players, settings: room.settings, duel: players.length === 2 });
    room.game.start();
  }

  endGame(room, standings) {
    room.game = null;
    this.roomBroadcast(room, { t: 'matchEnd', standings });
    // 관전자를 멤버로 합치고 대기실로
    for (const id of room.spectators) if (room.members.length < room.settings.maxPlayers) room.members.push(id);
    room.spectators = room.spectators.filter((id) => !room.members.includes(id));
    room.members = room.members.filter((id) => this.userById(id)?.room === room.code); // 봇도 room 코드를 가짐
    this.purgeDisconnected(room);
    if (this.rooms.has(room.code)) this.sendRoom(room);
  }

  // 봇은 항상 접속 중으로 취급
  present(id) {
    const u = this.userById(id);
    return !!u && (u.bot || !!u.ws);
  }

  isConnected(room, id) {
    const u = this.userById(id);
    if (u?.bot) return true;
    return !!u?.ws && u.room === room.code && !room.leftDuringGame?.has(id);
  }

  sendRoom(room) {
    if (!room) return;
    const info = {
      t: 'room',
      code: room.code,
      hostId: room.hostId,
      settings: room.settings,
      inGame: !!room.game,
      members: room.members.map((id) => {
        const u = this.userById(id);
        return { id, name: u?.name ?? '?', connected: !!u?.ws || !!u?.bot, bot: !!u?.bot };
      }),
      spectators: room.spectators.map((id) => ({ id, name: this.userById(id)?.name ?? '?' })),
    };
    this.roomBroadcast(room, info);
    this.broadcastRoomList();
  }

  roomBroadcast(room, msg, filter) {
    for (const id of [...room.members, ...room.spectators]) {
      if (filter && !filter(id)) continue;
      const u = this.userById(id);
      if (u && u.room === room.code) send(u, msg);
    }
  }

  // ───────── 채팅 ─────────
  chat(user, msg) {
    const room = user.room && this.rooms.get(user.room);
    if (!room) return;
    const now = Date.now();
    let text;
    let quick = false;
    if (Number.isInteger(msg.quick) && QUICK_CHATS[msg.quick]) {
      text = QUICK_CHATS[msg.quick];
      quick = true;
    } else {
      if (!room.settings.freeChat) return send(user, { t: 'error', msg: '이 방은 빠른 채팅만 쓸 수 있어요.' });
      text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, CONFIG.chatMaxLen);
    }
    if (!text) return;
    if (now - user.lastChat < CONFIG.chatMinIntervalMs) return send(user, { t: 'error', msg: '채팅은 1초에 1개만 보낼 수 있어요.' });
    if (text === user.lastText) return send(user, { t: 'error', msg: '같은 메시지를 연속으로 보낼 수 없어요.' });
    user.lastChat = now;
    user.lastText = text;

    const game = room.game;
    const phase = game?.round?.phase;
    const inRound = game && phase !== 'roundEnd';
    // 탈락자·관전자 채팅은 'ghost'로 표시(👻)만 하고, 산 사람·죽은 사람 모두에게 보냄
    const pc = game?.round.pieces[user.id];
    const ghost = !!inRound && (!pc || !pc.alive);
    const out = {
      t: 'chat',
      from: user.id,
      name: user.name,
      text,
      quick,
      channel: ghost ? 'ghost' : 'all',
      bubble: !ghost && inRound ? phase !== 'launch' : !ghost, // 유령은 판 위에 말이 없으니 말풍선 없음
    };
    this.roomBroadcast(room, out);
  }

  // 신고: 같은 방 사람만, 10초에 한 번, 파일 크기 상한 안에서 한 줄씩 저장
  report(user, target, reason) {
    const room = user.room && this.rooms.get(user.room);
    if (!room) return send(user, { t: 'error', msg: '방 안에서만 신고할 수 있어요.' });
    const inRoom = room.members.includes(target) || room.spectators.includes(target) || !!room.game?.players.some((p) => p.id === target);
    if (!inRoom || target === user.id) return send(user, { t: 'error', msg: '신고할 수 없는 대상이에요.' });
    const now = Date.now();
    if (now - user.lastReport < REPORT_INTERVAL_MS) return send(user, { t: 'error', msg: '신고는 10초에 한 번만 할 수 있어요.' });
    user.lastReport = now;
    const line = JSON.stringify({
      at: new Date().toISOString(), room: room.code, reporter: user.id, reporterName: user.name,
      target, targetName: this.userById(target)?.name ?? null, reason: reason.slice(0, 200),
    }) + '\n';
    if (this.reportsFile) {
      const bytes = Buffer.byteLength(line);
      if (this.reportBytes + bytes > REPORT_MAX_BYTES) {
        console.error(`신고 파일이 상한(${REPORT_MAX_BYTES}바이트)에 닿아 저장하지 않음: ${this.reportsFile}`);
      } else {
        this.reportBytes += bytes;
        fs.appendFile(this.reportsFile, line, (err) => {
          if (err) console.error('신고 저장 실패', this.reportsFile, err.message);
        });
      }
    }
    send(user, { t: 'notice', msg: '신고가 접수됐어요.' });
  }

  userById(id) {
    return this.byId.get(id) ?? null;
  }
}

function send(user, msg) {
  if (user?.ws && user.ws.readyState === 1) user.ws.send(JSON.stringify(msg));
}
function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
}
function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}
