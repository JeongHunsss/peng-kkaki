// 3D 렌더링. 물리는 바닥 평면 2D(x, y) → 월드 (x, 0, y)로 매핑하고, 떨어지는 건 연출만 한다.
import * as THREE from 'three';
import { CONFIG, slowmoWindows } from '../shared/config.js';

const UP = new THREE.Vector3(0, 1, 0);
const ARROW_LEN = 6; // 조준 화살표 길이 (세기와 무관하게 고정)
const PITCH_MIN = 0.14; // 약 8°: 거의 수평으로 앞을 봄
const PITCH_MAX = 1.45; // 약 83°: 거의 바로 위에서 내려다봄
const toWorld = (x, y, h = 0) => new THREE.Vector3(x, h, y);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
// 터치 기기(폰·태블릿)는 해상도·그림자·눈 입자를 낮춰 재생 중 프레임을 지킴
const MOBILE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const MAX_LABELS = 12; // 펭귄이 이보다 많으면 가까운 순으로 이만큼만 이름을 보여줌 (내 것은 항상)

export class GameScene {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MOBILE ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a2a47');
    this.scene.fog = new THREE.Fog('#0a2a47', 70, 260);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1200);
    this.camPos = new THREE.Vector3(0, 30, 30);
    this.camTarget = new THREE.Vector3();
    this.camera.position.copy(this.camPos);

    this.pieces = new Map(); // id → {group, label, bubble, ...}
    this.boxes = new Map();
    this.fx = []; // 파티클 등 일시 효과
    this.radius = 10;
    this.displayRadius = 10;
    this.mode = 'overview';
    this.yaw = 0;
    this.pitch = 0; // 기본 각도에서 더하는 값
    this.myId = null;
    this.playback = null;
    this.clock = new THREE.Clock();
    this.portrait = false;
    this.onEvent = null; // (name, data) => void — 효과음 등 연출 이벤트 (main.js가 연결)

    this.buildWorld();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ───────── 월드 ─────────
  buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#dff4ff', '#14385c', 1.2));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(-20, 40, 15);
    sun.castShadow = true;
    this.sun = sun;
    sun.shadow.mapSize.set(MOBILE ? 1024 : 2048, MOBILE ? 1024 : 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 140 });
    s.add(sun);

    // 바다
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(700, 64),
      new THREE.MeshStandardMaterial({ color: '#0d4f80', roughness: 0.35, metalness: 0.1 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -1.4;
    water.receiveShadow = true;
    s.add(water);
    this.water = water;

    // 주변 떠다니는 유빙 장식
    const floeMat = new THREE.MeshStandardMaterial({ color: '#e6f6ff', roughness: 0.6 });
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = 85 + Math.random() * 120; // 가장 큰 판(30명, 반지름 68) 바깥
      const r = 1 + Math.random() * 3;
      const f = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, 0.6, 7), floeMat);
      f.position.set(Math.cos(a) * d, -1.2, Math.sin(a) * d);
      f.rotation.y = Math.random() * 3;
      s.add(f);
    }

    // 빙판
    const iceTex = makeIceTexture();
    // 판 = (원 - 구멍들) 모양을 두께 1로 뽑아낸 메시. 구멍 안쪽에 얼음 벽이 보이고 그 아래로 바다가 보임
    this.holeList = [];
    this.board = new THREE.Mesh(new THREE.BufferGeometry(), [
      new THREE.MeshStandardMaterial({ map: iceTex, roughness: 0.45, metalness: 0 }), // 윗면 (반사광이 너무 크게 번지지 않게)
      new THREE.MeshStandardMaterial({ color: '#8fcbe8', roughness: 0.35 }), // 옆면·구멍 벽
    ]);
    this.board.receiveShadow = true;
    s.add(this.board);

    // 다음 턴에 녹을 영역 미리보기
    this.meltZone = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 128, 1),
      new THREE.MeshBasicMaterial({ color: '#ff4d6d', transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.meltZone.rotation.x = -Math.PI / 2;
    this.meltZone.position.y = 0.02;
    s.add(this.meltZone);
    this.meltLine = new THREE.LineLoop(jaggedRing(1, 160, 0.012), new THREE.LineBasicMaterial({ color: '#ffd6de' }));
    this.meltLine.position.y = 0.03;
    s.add(this.meltLine);

    // 유령 균열 가능 영역 (판 전체)
    this.ghostZone = new THREE.Mesh(
      new THREE.CircleGeometry(1, 128),
      new THREE.MeshBasicMaterial({ color: '#9b7bff', transparent: true, opacity: 0.18, depthWrite: false }),
    );
    this.ghostZone.rotation.x = -Math.PI / 2;
    this.ghostZone.position.y = 0.025;
    this.ghostZone.visible = false;
    s.add(this.ghostZone);

    // 눈보라: 카메라가 보는 곳 주변에 눈송이를 뿌림
    this.snow = makeSnow();
    this.snow.visible = false;
    this.snowLevel = 0; // 0~1, 부드럽게 켜고 끔
    this.snowOn = false;
    s.add(this.snow);

    this.crackGroup = new THREE.Group();
    s.add(this.crackGroup);
    this.myCrackMarker = makeCrack('#c9b8ff', 0.9);
    const myLabel = makeTextSprite(['내 균열', '발사 때 모두에게 공개'], '#e9ddff');
    myLabel.position.set(0, 2.2, 0);
    this.myCrackMarker.add(myLabel);
    this.myCrackMarker.visible = false;
    s.add(this.myCrackMarker);

    // 조준 화살표 (본체/분신)
    this.arrows = { main: makeArrow('#ffffff'), clone: makeArrow('#a0d8ff') };
    for (const a of Object.values(this.arrows)) s.add(a.group);
    this.clonePreview = makePenguin('#ffffff', { ghost: true });
    this.clonePreview.visible = false;
    s.add(this.clonePreview);

    this.setBoard(10, 10);
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.portrait = h > w;
    this.camera.fov = this.portrait ? 62 : 50;
    this.camera.updateProjectionMatrix();
  }

  setBoard(radius, nextRadius) {
    this.radius = radius;
    this.fitWorld(radius);
    if (!this.playback) this.displayRadius = radius;
    this.applyBoardScale();
    this.setMeltPreview(nextRadius);
  }

  // 판 크기(최대 반지름 68)에 맞춰 안개·그림자 범위를 맞춤
  fitWorld(radius) {
    const R = Math.max(radius, 10);
    this.fogBase = { near: R * 2.2, far: R * 7 + 60 }; // 눈보라 때는 updateSnow가 여기서 당겨 씀
    this.scene.fog.near = this.fogBase.near;
    this.scene.fog.far = this.fogBase.far;
    const sc = this.sun.shadow.camera;
    const half = R + 6;
    if (sc.right !== half) {
      Object.assign(sc, { left: -half, right: half, top: half, bottom: -half, far: R * 4 + 80 });
      this.sun.position.set(-R * 0.6, R + 30, R * 0.4);
      sc.updateProjectionMatrix();
    }
  }

  applyBoardScale() {
    const r = this.displayRadius;
    this.ghostZone.scale.set(r, r, 1);
    // 반지름이나 구멍이 바뀌었을 때만 판 모양을 다시 만듦 (녹는 연출 중에는 프레임마다 조금씩)
    const key = `${r.toFixed(2)}|${this.holeList.length}`;
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.board.geometry.dispose();
    this.board.geometry = buildBoardGeometry(r, this.holeList);
  }

  setMeltPreview(nextRadius) {
    const show = nextRadius != null && nextRadius < this.radius - 1e-3;
    this.meltZone.visible = show;
    this.meltLine.visible = show;
    if (!show) return;
    const inner = nextRadius / this.radius;
    this.meltZone.geometry.dispose();
    this.meltZone.geometry = new THREE.RingGeometry(inner, 1, 128, 1);
    this.meltZone.scale.set(this.radius, this.radius, 1);
    this.meltLine.scale.set(nextRadius, 1, nextRadius);
  }

  setGhostZone(on) {
    this.ghostZone.visible = on;
  }

  setMyCrack(c) {
    this.myCrackMarker.visible = !!c;
    if (c) this.myCrackMarker.position.set(c.x, 0.04, c.y);
  }

  // 공개된 유령 균열 + 위에 뜨는 설명 (산 사람도 뭔지 알 수 있게)
  setCracks(cracks) {
    this.crackGroup.clear();
    for (const c of cracks) {
      const m = makeCrack('#3b2a6b', 1);
      m.position.set(c.x, 0.035, c.y);
      const label = makeTextSprite(['👻 유령 균열', '멈추면 다음 턴 세기 50%'], '#e9ddff');
      label.position.set(0, 2.2, 0);
      m.add(label);
      this.crackGroup.add(m);
    }
  }

  // ───────── 말 ─────────
  setPlayers(players, myId) {
    this.myId = myId;
    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      let e = this.pieces.get(p.id);
      if (!e) {
        e = this.addPiece(p.id, p.color, p.name, false);
      }
      e.data = p;
      if (this.playback) continue;
      e.alive = p.alive;
      e.group.visible = p.alive;
      e.group.position.set(p.x, 0, p.y);
      e.group.scale.setScalar(1);
      e.group.rotation.set(0, e.group.rotation.y, 0);
      e.label.classList.toggle('hidden', !p.alive);
      e.nameEl.textContent = `${p.name}${p.capped ? ' 🧊' : ''}${p.connected === false ? ' 📴' : ''}`;
      if (!e.faced) {
        e.group.rotation.y = -Math.atan2(-p.y, -p.x); // 시작은 중심을 바라봄
        e.faced = true;
      }
    }
    for (const [id, e] of this.pieces) {
      if (!seen.has(id) && !e.clone) this.removePiece(id);
    }
  }

  addPiece(id, color, name, clone) {
    const group = makePenguin(color, { ghost: clone });
    this.scene.add(group);
    const label = document.createElement('div');
    label.className = 'label';
    const bubble = document.createElement('span');
    bubble.className = 'bubble hidden';
    const nameEl = document.createElement('span');
    nameEl.style.color = color;
    nameEl.textContent = clone ? `${name}의 분신` : name;
    label.append(bubble, nameEl);
    this.labelsEl.append(label);
    const e = { id, group, label, bubble, nameEl, color, clone, alive: true, bubbleUntil: 0 };
    this.pieces.set(id, e);
    return e;
  }

  removePiece(id) {
    const e = this.pieces.get(id);
    if (!e) return;
    this.scene.remove(e.group);
    e.label.remove();
    this.pieces.delete(id);
  }

  // 서버가 보낸 구멍 목록과 맞춤 (이미 있는 건 그대로)
  setHoles(holes = []) {
    if (this.holeList.length === holes.length) return;
    this.holeList = holes.map((h) => ({ ...h }));
    this.applyBoardScale();
  }

  // 게임에서 나갈 때: 재생 중단 + 말·상자·구멍·효과 전부 정리
  clearAll() {
    this.playback = null;
    this.snowOn = false;
    this.snowLevel = 0;
    this.snow.visible = false;
    for (const [id] of this.pieces) this.removePiece(id);
    this.resetRound();
    for (const f of this.fx) this.scene.remove(f.obj);
    this.fx = [];
    this.setAim('main', null);
    this.setAim('clone', null);
    this.setClonePreview(null);
    this.setMeltPreview(null);
    this.setGhostZone(false);
  }

  resetRound() {
    this.holeList = [];
    this.applyBoardScale();
    for (const [id, e] of this.pieces) {
      if (e.clone) this.removePiece(id);
      else e.faced = false;
    }
    this.crackGroup.clear();
    this.setMyCrack(null);
    for (const [id] of this.boxes) this.removeBox(id);
  }

  showBubble(id, text) {
    const e = this.pieces.get(id);
    if (!e || !e.alive) return;
    e.bubble.textContent = text;
    e.bubble.classList.remove('hidden');
    e.bubbleUntil = performance.now() + CONFIG.bubbleMs;
  }

  // ───────── 아이템 상자 ─────────
  setBoxes(boxes) {
    const ids = new Set(boxes.map((b) => b.id));
    for (const [id] of this.boxes) if (!ids.has(id)) this.removeBox(id);
    for (const b of boxes) if (!this.boxes.has(b.id)) this.addBox(b, false);
  }

  addBox(b, drop) {
    const m = makeBox();
    m.position.set(b.x, drop ? 14 : 0.7, b.y);
    this.scene.add(m);
    this.boxes.set(b.id, { mesh: m, x: b.x, y: b.y, dropping: drop });
  }

  removeBox(id, pop = false) {
    const b = this.boxes.get(id);
    if (!b) return;
    this.scene.remove(b.mesh);
    this.boxes.delete(id);
    if (pop) {
      this.spawnSparkle(b.mesh.position.clone());
      this.onEvent?.('pickup');
    }
  }

  // ───────── 조준 ─────────
  setAim(target, aim) {
    const a = this.arrows[target];
    if (!aim || aim.power <= 0.005) {
      a.group.visible = false;
      return;
    }
    a.group.visible = true;
    a.group.position.set(aim.x, 0.06, aim.y);
    a.group.rotation.y = -aim.angle;
    a.setPower(aim.power); // 길이는 고정, 세기만큼 안쪽을 채움 (어디까지 가는지는 표시 안 함)
  }

  setClonePreview(pos, color) {
    this.clonePreview.visible = !!pos;
    if (pos) {
      this.clonePreview.position.set(pos.x, 0, pos.y);
      tintPenguin(this.clonePreview, color);
    }
  }

  setMode(mode) {
    this.mode = mode;
  }

  rotateYaw(d) {
    this.yaw += d;
  }

  // 상하 시점 조절 (+ 위에서 내려다보기, - 앞을 보기)
  tiltPitch(d) {
    this.pitch = this.clampPitch(this.pitch + d);
  }

  // 지금 시점(조준/전체)의 기본 각도 기준으로 PITCH_MIN~PITCH_MAX를 넘지 않게
  clampPitch(p) {
    const base = this.pitchBase ?? 0.96;
    return Math.min(PITCH_MAX - base, Math.max(PITCH_MIN - base, p));
  }

  // 현재 카메라가 내려다보는 각도(도) — 화면 표시/디버그용
  get pitchDeg() {
    return Math.round((((this.pitchBase ?? 0.96) + this.pitch) * 180) / Math.PI);
  }

  faceCenter(x, y) {
    this.yaw = Math.atan2(-y, -x);
  }

  // 화면 좌표 → 판 평면 좌표
  screenToBoard(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(UP, 0), hit)) return null;
    return { x: hit.x, y: hit.z };
  }

  // ───────── 발사 재생 ─────────
  playTurn(res, onDone) {
    const bodies = res.bodies.map((b, i) => {
      let e = this.pieces.get(b.id);
      if (b.clone) {
        const owner = this.pieces.get(b.owner);
        e = this.addPiece(b.id, owner?.color ?? '#fff', owner?.data?.name ?? '', true);
      }
      if (!e) return null;
      e.group.visible = true;
      e.group.scale.setScalar(b.r / CONFIG.pieceRadius);
      setAnchorFx(e.group, b.anchor);
      const [x, y] = res.frames[0][i];
      e.group.position.set(x, 0, y);
      e.label.classList.remove('hidden');
      return { ...b, e, fall: res.falls.find((f) => f.id === b.id) ?? null, fallState: null };
    });
    this.setAim('main', null);
    this.setAim('clone', null);
    this.setClonePreview(null);
    this.setMeltPreview(null);
    this.setGhostZone(false);
    this.setMyCrack(null);
    this.setCracks(res.cracks);
    const frameDt = res.frameDt;
    const simEnd = (res.frames.length - 1) * frameDt;
    this.playback = {
      res, bodies, frameDt, simEnd, onDone,
      stage: res.warming ? 'warming' : res.blizzard ? 'blizzard' : 'intro', t: 0, simT: 0,
      holeOpened: false,
      hitIdx: 0, // 다음에 소리 낼 충돌
      windows: slowmoWindows(res.falls.filter((f) => !f.id.includes('#'))),
      shards: false,
      focus: null,
    };
  }

  updatePlayback(dt) {
    const pb = this.playback;
    pb.t += dt;
    if (pb.stage === 'warming') {
      // 안내 문구가 뜨고 잠시 뒤 얼음이 깨지며 구멍이 열림
      const h = pb.res.warming;
      if (!pb.holeOpened && pb.t >= 0.7) {
        pb.holeOpened = true;
        this.holeList.push({ ...h }); // 판에 실제로 구멍을 뚫음
        this.applyBoardScale();
        this.spawnHoleBurst(h);
        this.shake = 0.6;
        this.onEvent?.('crack');
      }
      if (pb.t >= CONFIG.warmingSec) {
        pb.stage = pb.res.blizzard ? 'blizzard' : 'intro';
        pb.t = 0;
      }
      return;
    }
    if (pb.stage === 'blizzard') {
      // 눈보라가 몰아친 뒤 발사 (눈은 재생이 끝날 때까지 계속)
      if (!this.snowOn) this.onEvent?.('blizzard');
      this.snowOn = true;
      if (pb.t >= CONFIG.blizzardSec) {
        pb.stage = 'intro';
        pb.t = 0;
      }
      return;
    }
    if (pb.stage === 'intro') {
      if (pb.t >= CONFIG.launchIntroSec) {
        pb.stage = 'sim';
        pb.t = 0;
        this.onEvent?.('launch');
      }
      return;
    }
    if (pb.stage === 'sim') {
      const win = pb.windows.find((w) => pb.simT >= w.start && pb.simT < w.end);
      const speed = win ? CONFIG.slowmoSpeed : 1;
      pb.focus = win ? win.id : null;
      pb.simT += dt * speed; // 슬로모 구간은 시뮬 끝을 넘어서도 진행

      this.applyFrames(pb, pb.simT);
      const hits = pb.res.hits ?? [];
      while (pb.hitIdx < hits.length && hits[pb.hitIdx].tick <= pb.simT * CONFIG.tickRate) {
        this.onEvent?.('hit', hits[pb.hitIdx].v);
        pb.hitIdx++;
      }
      this.updateFalling(pb, dt * speed);
      for (const p of pb.res.pickups) {
        const box = this.boxes.get(p.boxId);
        if (box && pb.simT * CONFIG.tickRate >= p.tick) this.removeBox(p.boxId, true);
      }
      if (pb.simT >= pb.simEnd && !pb.focus) {
        pb.stage = 'cleanup';
        pb.t = 0;
        this.startCleanup(pb);
      }
      return;
    }
    if (pb.stage === 'cleanup') {
      this.updateFalling(pb, dt);
      const k = Math.min(1, pb.t / 1.0);
      this.displayRadius = pb.res.oldRadius + (pb.res.newRadius - pb.res.oldRadius) * easeOut(k);
      this.applyBoardScale();
      for (const b of pb.bodies) {
        if (!b || b.fallState || !b.e.alive) continue;
        const s = b.e.group.scale.x;
        if (s > 1) b.e.group.scale.setScalar(Math.max(1, s - dt * 3));
      }
      if (pb.t >= CONFIG.cleanupSec) this.finishPlayback();
    }
  }

  applyFrames(pb, simT) {
    const f = simT / pb.frameDt;
    const i0 = Math.min(pb.res.frames.length - 1, Math.floor(f));
    const i1 = Math.min(pb.res.frames.length - 1, i0 + 1);
    const a = Math.min(1, Math.max(0, f - i0));
    pb.bodies.forEach((b, i) => {
      if (!b || b.fallState) return;
      const [x0, y0] = pb.res.frames[i0][i];
      const [x1, y1] = pb.res.frames[i1][i];
      const x = x0 + (x1 - x0) * a;
      const y = y0 + (y1 - y0) * a;
      const g = b.e.group;
      const dx = x - g.position.x;
      const dy = y - g.position.z;
      if (Math.hypot(dx, dy) > 0.002) {
        const target = -Math.atan2(dy, dx);
        g.rotation.y = lerpAngle(g.rotation.y, target, 0.25);
        g.rotation.z = Math.sin(performance.now() / 70) * 0.06; // 미끄러지며 흔들
      }
      g.position.set(x, 0, y);
      if (b.fall && simT * CONFIG.tickRate >= b.fall.tick) {
        b.fallState = { vx: b.fall.vx, vy: b.fall.vy, vz: 0, t: 0, spin: (Math.random() - 0.5) * 6 };
        if (!b.clone) b.e.alive = false;
      }
    });
  }

  updateFalling(pb, dt) {
    for (const b of pb.bodies) {
      if (!b?.fallState) continue;
      const s = b.fallState;
      const g = b.e.group;
      if (!g.visible) continue;
      s.t += dt;
      s.vz -= 25 * dt;
      g.position.x += s.vx * dt;
      g.position.z += s.vy * dt;
      g.position.y += s.vz * dt;
      g.rotation.z += s.spin * dt;
      g.rotation.x += s.spin * 0.5 * dt;
      if (g.position.y < -1.4 && !s.splashed) {
        s.splashed = true;
        this.spawnSplash(g.position.clone());
        if (!b.clone) this.onEvent?.('fall');
      }
      if (g.position.y < -5) {
        g.visible = false;
        b.e.label.classList.add('hidden');
      }
    }
  }

  startCleanup(pb) {
    const { oldRadius, newRadius, meltOut, afkOut = [], newBoxes } = pb.res;
    if (newRadius < oldRadius - 1e-3) {
      this.spawnShards(oldRadius, newRadius);
      this.onEvent?.('melt');
    }
    for (const id of [...meltOut, ...afkOut]) {
      const b = pb.bodies.find((x) => x?.id === id);
      if (!b) continue;
      const g = b.e.group;
      const d = Math.hypot(g.position.x, g.position.z) || 1;
      b.fallState = { vx: (g.position.x / d) * 1.5, vy: (g.position.z / d) * 1.5, vz: 2, t: 0, spin: 2 };
      b.e.alive = false;
    }
    for (const b of pb.bodies) {
      if (b?.clone && !b.fallState) {
        b.fallState = { vx: 0, vy: 0, vz: 3, t: 0, spin: 4 }; // 분신은 퐁 하고 사라짐
        this.spawnSparkle(b.e.group.position.clone());
        b.e.group.visible = false;
      }
    }
    for (const box of newBoxes) this.addBox(box, true);
  }

  finishPlayback() {
    const pb = this.playback;
    this.playback = null;
    for (const b of pb.bodies) {
      if (!b) continue;
      setAnchorFx(b.e.group, false);
      if (b.clone) this.removePiece(b.id);
      else b.e.group.scale.setScalar(1);
    }
    this.displayRadius = pb.res.newRadius;
    this.radius = pb.res.newRadius;
    this.applyBoardScale();
    this.setBoxes(pb.res.boxes);
    this.setHoles(pb.res.holes);
    this.crackGroup.clear(); // 균열은 이번 발사에만 효과 → 다음 조준 때는 지움 (걸린 사람은 🧊로 표시)
    this.snowOn = false; // 눈보라는 이번 턴만
    pb.onDone?.();
  }

  // ───────── 효과 ─────────
  // 눈보라: 바람에 비스듬히 날리는 눈. 카메라가 보는 곳을 중심으로 상자 안에서 순환
  updateSnow(dt) {
    this.snowLevel = Math.min(1, Math.max(0, this.snowLevel + (this.snowOn ? dt * 2 : -dt * 1.2)));
    const sn = this.snow;
    const k = this.snowLevel;
    const wasVisible = sn.visible;
    sn.visible = k > 0;
    if (!sn.visible && !wasVisible) return;
    // 하늘·안개가 하얗게 흐려지고 시야가 짧아짐
    const fog = this.scene.fog;
    fog.color.copy(SKY_COLOR).lerp(BLIZZARD_COLOR, 0.5 * k);
    this.scene.background.copy(fog.color);
    if (this.fogBase) {
      fog.near = this.fogBase.near * (1 - 0.3 * k);
      fog.far = this.fogBase.far * (1 - 0.3 * k);
    }
    if (!sn.visible) return;
    sn.material.opacity = 0.95 * k;
    const { size, height } = sn.userData;
    const pos = sn.geometry.attributes.position;
    const a = pos.array;
    const t = performance.now() / 1000;
    const wind = 14;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += (wind + Math.sin(t * 2 + i) * 3) * dt;
      a[i + 1] -= (6 + (i % 7)) * dt;
      a[i + 2] += Math.cos(t * 1.3 + i) * 2 * dt;
      if (a[i] > size / 2) a[i] -= size;
      if (a[i + 1] < 0) a[i + 1] += height;
    }
    pos.needsUpdate = true;
    sn.position.set(this.camTarget.x, 0, this.camTarget.z);
  }

  // 구멍이 뚫릴 때 얼음 조각이 튀고 물보라
  spawnHoleBurst(h) {
    const mat = new THREE.MeshStandardMaterial({ color: '#d6f1ff', roughness: 0.2, transparent: true });
    const n = Math.round(18 + h.r * 8);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * h.r;
      const s = 0.3 + Math.random() * 0.7;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, 0.35, s * 1.3), mat);
      m.position.set(h.x + Math.cos(a) * d, 0, h.y + Math.sin(a) * d);
      m.rotation.y = Math.random() * 3;
      this.scene.add(m);
      this.fx.push({
        obj: m, life: 1.4,
        v: new THREE.Vector3(Math.cos(a) * (1 + Math.random() * 3), 3 + Math.random() * 5, Math.sin(a) * (1 + Math.random() * 3)),
        spin: new THREE.Vector3(Math.random() * 6, 0, Math.random() * 6), gravity: 16,
      });
    }
    this.spawnSplash(new THREE.Vector3(h.x, 0, h.y));
  }

  spawnShards(oldR, newR) {
    const mat = new THREE.MeshStandardMaterial({ color: '#cdeeff', roughness: 0.2, transparent: true });
    const n = Math.min(90, Math.round(oldR * 6));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = newR + Math.random() * (oldR - newR);
      const s = 0.3 + Math.random() * 0.6;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, 0.4, s * 1.4), mat);
      m.position.set(Math.cos(a) * d, -0.2, Math.sin(a) * d);
      m.rotation.y = Math.random() * 3;
      this.scene.add(m);
      this.fx.push({
        obj: m, life: 1.6, delay: Math.random() * 0.5,
        v: new THREE.Vector3(Math.cos(a) * 1.5, 1 + Math.random() * 2, Math.sin(a) * 1.5),
        spin: new THREE.Vector3(Math.random() * 4, 0, Math.random() * 4), gravity: 14,
      });
    }
  }

  spawnSplash(pos) {
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.6, 0.85, 32),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, -1.35, pos.z);
      this.scene.add(ring);
      this.fx.push({ obj: ring, life: 1.0, delay: i * 0.2, grow: 4 });
    }
  }

  spawnSparkle(pos) {
    const mat = new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true });
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), mat);
      m.position.copy(pos).add(new THREE.Vector3(0, 0.8, 0));
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      this.fx.push({ obj: m, life: 0.7, v: new THREE.Vector3(Math.cos(a) * 3, 2 + Math.random() * 3, Math.sin(a) * 3), gravity: 9 });
    }
  }

  updateFx(dt) {
    this.fx = this.fx.filter((f) => {
      if (f.delay > 0) {
        f.delay -= dt;
        return true;
      }
      f.life -= dt;
      const o = f.obj;
      if (f.v) {
        f.v.y -= (f.gravity ?? 0) * dt;
        o.position.addScaledVector(f.v, dt);
      }
      if (f.spin) {
        o.rotation.x += f.spin.x * dt;
        o.rotation.z += f.spin.z * dt;
      }
      if (f.grow) o.scale.addScalar(f.grow * dt);
      if (o.material?.opacity !== undefined && o.material.transparent) o.material.opacity = Math.max(0, Math.min(1, f.life));
      if (f.life <= 0) {
        this.scene.remove(o);
        return false;
      }
      return true;
    });
  }

  // ───────── 카메라 ─────────
  updateCamera(dt) {
    const me = this.pieces.get(this.myId);
    const pb = this.playback;
    let pos;
    let target;
    const fwd = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    // 상하 시점: 기본 내려다보는 각도 + 사용자가 조절한 pitch. 낮을수록 앞(수평선)을 봄
    const tilt = (base) => {
      this.pitchBase = base;
      this.pitch = this.clampPitch(this.pitch);
      return base + this.pitch;
    };
    if (this.mode === 'aim' && me && me.alive && !pb) {
      const base = me.group.position.clone();
      const phi0 = this.portrait ? 1.06 : 0.96;
      const phi = tilt(phi0);
      const D = this.portrait ? 26 : 20;
      const back = D * Math.cos(phi);
      const height = D * Math.sin(phi) + 1.5;
      pos = base.clone().addScaledVector(fwd, -back).add(new THREE.Vector3(0, height, 0));
      // 낮게 볼수록 더 멀리 앞을 바라봄
      const low = Math.max(0, (phi0 - phi) / (phi0 - PITCH_MIN)); // 기본 각도면 0, 최대로 낮추면 1
      target = base.clone().addScaledVector(fwd, (this.portrait ? 3 : 4.5) + low * 10).add(new THREE.Vector3(0, low * 1.5, 0));
      if (this.portrait) target.addScaledVector(fwd, -4 * (1 - low)); // 판이 화면 위쪽에 오게
    } else {
      const R = Math.max(this.displayRadius, 6) + 2;
      const phi = tilt(this.portrait ? 1.107 : 0.854);
      const D = R * (this.portrait ? 2.8 : 2.05);
      const back = D * Math.cos(phi);
      const height = D * Math.sin(phi) + 2;
      pos = fwd.clone().multiplyScalar(-back).add(new THREE.Vector3(0, height, 0));
      target = new THREE.Vector3();
      if (this.portrait) target.addScaledVector(fwd, -R * 0.5 * Math.min(1, phi / 1.107));
      if (pb?.focus) {
        const b = pb.bodies.find((x) => x?.id === pb.focus);
        if (b) {
          const p = b.e.group.position.clone().setY(0);
          target.lerp(p, 0.35);
          pos.lerp(p.clone().add(new THREE.Vector3(0, height * 0.5, 0)).addScaledVector(fwd, -back * 0.6), 0.25);
        }
      }
    }
    const rate = pb?.stage === 'intro' ? 9 : 5;
    this.camPos.lerp(pos, damp(rate, dt));
    this.camTarget.lerp(target, damp(rate, dt));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
    if (this.shake > 0) {
      // 구멍이 뚫릴 때 화면 흔들림
      this.shake = Math.max(0, this.shake - dt);
      const k = this.shake * 0.8;
      this.camera.position.x += (Math.random() - 0.5) * k;
      this.camera.position.y += (Math.random() - 0.5) * k;
    }
  }

  updateLabels() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const now = performance.now();
    const v = new THREE.Vector3();
    // 펭귄이 많으면 카메라에서 가까운 순으로 MAX_LABELS개만 이름을 보여줌 (내 것·말풍선 있는 것은 항상)
    const visible = [...this.pieces.values()].filter((e) => e.group.visible);
    let allowed = null;
    if (visible.length > MAX_LABELS) {
      const byDist = visible
        .map((e) => ({ e, d: e.group.position.distanceTo(this.camera.position) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_LABELS)
        .map((x) => x.e);
      allowed = new Set(byDist);
    }
    for (const e of this.pieces.values()) {
      if (e.bubbleUntil && now > e.bubbleUntil) {
        e.bubble.classList.add('hidden');
        e.bubbleUntil = 0;
      }
      if (!e.group.visible || (allowed && !allowed.has(e) && e.id !== this.myId && !e.bubbleUntil)) {
        e.label.style.display = 'none';
        continue;
      }
      v.copy(e.group.position);
      v.y += 2.9 * e.group.scale.y;
      v.project(this.camera);
      if (v.z > 1) {
        e.label.style.display = 'none';
        continue;
      }
      e.label.style.display = '';
      e.label.style.left = `${((v.x + 1) / 2) * w}px`;
      e.label.style.top = `${((1 - v.y) / 2) * h}px`;
    }
  }

  tick() {
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.playback) this.updatePlayback(dt);
    const t = performance.now() / 1000;
    for (const b of this.boxes.values()) {
      if (b.dropping) {
        b.mesh.position.y = Math.max(0.7, b.mesh.position.y - dt * 18);
        if (b.mesh.position.y <= 0.7) b.dropping = false;
      } else b.mesh.position.y = 0.7 + Math.sin(t * 2 + b.x) * 0.12;
      b.mesh.rotation.y += dt;
    }
    for (const e of this.pieces.values()) {
      if (!this.playback && e.alive) e.group.children[0].position.y = 1.05 + Math.sin(t * 3 + e.group.position.x) * 0.02;
    }
    this.updateFx(dt);
    this.updateSnow(dt);
    this.updateCamera(dt);
    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
  }
}

// ───────── 모델/텍스처 ─────────
// 깨진 구멍 윤곽: 들쭉날쭉하게. 같은 구멍은 다시 그려도 같은 모양 (위치로 시드)
function holeOutline(h) {
  let seed = (Math.round(h.x * 100) * 73856093) ^ (Math.round(h.y * 100) * 19349663);
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 0) / 4294967296;
  const n = Math.max(14, Math.round(h.r * 9));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
    const rr = h.r * (0.9 + rnd() * 0.2);
    pts.push(new THREE.Vector2(h.x + Math.cos(a) * rr, h.y + Math.sin(a) * rr));
  }
  return pts;
}

// 판 모양 = 반지름 R 원에서 구멍을 뺀 것. 위쪽 y=0, 두께 1
function buildBoardGeometry(R, holes) {
  const SEG = 180;
  // 판 안에 완전히 들어간 구멍은 진짜 구멍으로, 가장자리에 걸친 구멍(판이 녹아서)은 가장자리를 파낸 홈으로
  const inside = holes.filter((h) => Math.hypot(h.x, h.y) + h.r * 1.12 < R - 0.05);
  const edge = holes.filter((h) => !inside.includes(h) && Math.hypot(h.x, h.y) - h.r < R);
  const outer = [];
  for (let i = 0; i < SEG; i++) {
    const a = (i / SEG) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let rho = R;
    for (const h of edge) {
      // 이 방향 반직선이 구멍에 닿으면 구멍 시작점에서 판을 끊음 (가장자리에 홈이 파임)
      const bq = dx * h.x + dy * h.y;
      const disc = bq * bq - (h.x * h.x + h.y * h.y - h.r * h.r);
      if (disc <= 0) continue;
      const t1 = bq - Math.sqrt(disc);
      const t2 = bq + Math.sqrt(disc);
      if (t2 > 0 && t1 < rho) rho = Math.max(0.2, t1);
    }
    outer.push(new THREE.Vector2(dx * rho, dy * rho));
  }
  const shape = new THREE.Shape(outer);
  for (const h of inside) shape.holes.push(new THREE.Path(holeOutline(h)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 1, steps: 1 });
  geo.rotateX(Math.PI / 2); // 모양 (x, y) → 월드 (x, 0, y), 두께는 아래(-y)로
  // 얼음 텍스처를 판 전체에 한 장으로 (중심이 밝은 원형 그라디언트)
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (2 * R) + 0.5, pos.getZ(i) / (2 * R) + 0.5);
  geo.computeVertexNormals();
  return geo;
}

function makePenguin(color, { ghost = false } = {}) {
  const g = new THREE.Group();
  const mat = (c) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, transparent: ghost, opacity: ghost ? 0.5 : 1 });
  const dark = mat('#1f2a38');
  const white = mat('#f8fbff');
  const orange = mat('#ff9f1c');
  const add = (geo, m, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.castShadow = !ghost;
    g.add(mesh);
    return mesh;
  };
  add(new THREE.SphereGeometry(0.85, 24, 18), dark, 0, 1.05, 0, 1, 1.2, 0.95); // 몸 (children[0])
  add(new THREE.SphereGeometry(0.7, 24, 18), white, 0.32, 0.98, 0, 0.75, 1.1, 0.85); // 배
  add(new THREE.SphereGeometry(0.56, 24, 18), dark, 0.05, 2.1, 0); // 머리
  add(new THREE.SphereGeometry(0.42, 20, 14), white, 0.3, 2.08, 0, 0.7, 0.85, 1); // 얼굴
  const eye = new THREE.SphereGeometry(0.08, 10, 8);
  add(eye, mat('#111111'), 0.55, 2.2, 0.17);
  add(eye, mat('#111111'), 0.55, 2.2, -0.17);
  const beak = add(new THREE.ConeGeometry(0.13, 0.36, 12), orange, 0.68, 2.03, 0);
  beak.rotation.z = -Math.PI / 2;
  const fl = new THREE.SphereGeometry(0.3, 12, 10);
  add(fl, dark, -0.05, 1.15, 0.82, 0.6, 1.3, 0.25).rotation.x = -0.35;
  add(fl, dark, -0.05, 1.15, -0.82, 0.6, 1.3, 0.25).rotation.x = 0.35;
  const foot = new THREE.SphereGeometry(0.22, 12, 8);
  add(foot, orange, 0.32, 0.06, 0.28, 1.3, 0.35, 0.8);
  add(foot, orange, 0.32, 0.06, -0.28, 1.3, 0.35, 0.8);
  const scarf = add(new THREE.TorusGeometry(0.5, 0.13, 10, 28), mat(color), 0.02, 1.68, 0);
  scarf.rotation.x = Math.PI / 2;
  scarf.userData.scarf = true;
  const tail = add(new THREE.BoxGeometry(0.22, 0.6, 0.18), mat(color), -0.2, 1.45, 0.42);
  tail.rotation.x = -0.4;
  tail.userData.scarf = true;
  return g;
}

function tintPenguin(g, color) {
  g.traverse((o) => {
    if (o.userData.scarf) o.material.color.set(color);
  });
}

function setAnchorFx(g, on) {
  let fx = g.getObjectByName('anchorFx');
  if (on && !fx) {
    fx = new THREE.Mesh(
      new THREE.TorusGeometry(1.15, 0.12, 8, 40),
      new THREE.MeshStandardMaterial({ color: '#9aa7b4', metalness: 0.9, roughness: 0.3, emissive: '#2b4a66' }),
    );
    fx.name = 'anchorFx';
    fx.rotation.x = Math.PI / 2;
    fx.position.y = 0.1;
    g.add(fx);
  } else if (!on && fx) g.remove(fx);
}

function makeBox() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const grd = x.createLinearGradient(0, 0, 128, 128);
  grd.addColorStop(0, '#ffd166');
  grd.addColorStop(1, '#f77f00');
  x.fillStyle = grd;
  x.fillRect(0, 0, 128, 128);
  x.strokeStyle = '#fff';
  x.lineWidth = 8;
  x.strokeRect(4, 4, 120, 120);
  x.fillStyle = '#fff';
  x.font = 'bold 90px sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText('?', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.9),
    new THREE.MeshStandardMaterial({ map: tex, emissive: '#5a3300', emissiveIntensity: 0.4 }),
  );
  m.castShadow = true;
  return m;
}

function makeIceTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(512, 512, 50, 512, 512, 512);
  g.addColorStop(0, '#f4fcff');
  g.addColorStop(0.75, '#d6f0fd');
  g.addColorStop(1, '#a8d8f0');
  x.fillStyle = g;
  x.fillRect(0, 0, 1024, 1024);
  x.strokeStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 120; i++) {
    x.lineWidth = Math.random() * 2;
    x.beginPath();
    const sx = Math.random() * 1024;
    const sy = Math.random() * 1024;
    x.moveTo(sx, sy);
    x.lineTo(sx + (Math.random() - 0.5) * 300, sy + (Math.random() - 0.5) * 300);
    x.stroke();
  }
  x.strokeStyle = 'rgba(120,180,210,0.25)';
  for (let i = 0; i < 40; i++) {
    x.lineWidth = 1;
    x.beginPath();
    let px = Math.random() * 1024;
    let py = Math.random() * 1024;
    x.moveTo(px, py);
    for (let k = 0; k < 5; k++) {
      px += (Math.random() - 0.5) * 80;
      py += (Math.random() - 0.5) * 80;
      x.lineTo(px, py);
    }
    x.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function jaggedRing(r, n, jitter) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r + (Math.random() - 0.5) * jitter * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

// 카메라를 항상 바라보는 글자 표지판
function makeTextSprite(lines, color) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64 * lines.length + 16;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(20, 10, 45, 0.78)';
  x.beginPath();
  x.roundRect(4, 4, c.width - 8, c.height - 8, 24);
  x.fill();
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  lines.forEach((t, i) => {
    x.font = i === 0 ? 'bold 40px sans-serif' : '32px sans-serif';
    x.fillStyle = i === 0 ? color : '#ffffff';
    x.fillText(t, c.width / 2, 40 + i * 64);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // 거리와 상관없이 화면에서 같은 크기로 보이게 (큰 판을 멀리서 봐도 읽힘)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.renderOrder = 20;
  sp.scale.set(0.26, (0.26 * c.height) / c.width, 1);
  return sp;
}

const SKY_COLOR = new THREE.Color('#0a2a47');
const BLIZZARD_COLOR = new THREE.Color('#c9d9e8');

// 동그랗고 가장자리가 흐린 눈송이
function snowflakeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function makeSnow() {
  const size = 160;
  const height = 50;
  const n = MOBILE ? 2000 : 6000;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = (Math.random() - 0.5) * size;
    a[i * 3 + 1] = Math.random() * height;
    a[i * 3 + 2] = (Math.random() - 0.5) * size;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(a, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: '#ffffff', size: 0.8, map: snowflakeTexture(), transparent: true, opacity: 0, depthWrite: false, fog: false,
  }));
  pts.frustumCulled = false;
  pts.renderOrder = 15;
  pts.userData = { size, height };
  return pts;
}

function makeCrack(color, opacity) {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(CONFIG.crackRadius, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 * opacity, depthWrite: false }),
  );
  disc.rotation.x = -Math.PI / 2;
  g.add(disc);
  const pts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
    let px = 0;
    let py = 0;
    for (let k = 0; k < 3; k++) {
      const nx = px + Math.cos(a + (Math.random() - 0.5) * 0.8) * CONFIG.crackRadius * 0.38;
      const ny = py + Math.sin(a + (Math.random() - 0.5) * 0.8) * CONFIG.crackRadius * 0.38;
      pts.push(new THREE.Vector3(px, 0.005, py), new THREE.Vector3(nx, 0.005, ny));
      px = nx;
      py = ny;
    }
  }
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#0b1d2e' })));
  return g;
}

// 길이 고정 화살표. 테두리 안을 꼬리부터 세기만큼 색으로 채움 (초록 → 노랑 → 빨강)
function makeArrow(outlineColor) {
  const start = 1.1; // 펭귄 몸 바깥에서 시작
  const end = ARROW_LEN;
  const headLen = 1.8;
  const shaftW = 0.38;
  const headW = 1.0;
  const shape = new THREE.Shape();
  shape.moveTo(start, -shaftW);
  shape.lineTo(end - headLen, -shaftW);
  shape.lineTo(end - headLen, -headW);
  shape.lineTo(end, 0);
  shape.lineTo(end - headLen, headW);
  shape.lineTo(end - headLen, shaftW);
  shape.lineTo(start, shaftW);
  shape.closePath();

  const uniforms = {
    uFill: { value: 0 },
    uStart: { value: start },
    uEnd: { value: end },
    uFillColor: { value: new THREE.Color('#4ade80') },
  };
  // 펭귄에 가려지지 않게 항상 위에 그림
  const fillMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    vertexShader: `varying float vX;
      void main() { vX = position.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uFill; uniform float uStart; uniform float uEnd; uniform vec3 uFillColor; varying float vX;
      void main() {
        float t = (vX - uStart) / (uEnd - uStart);
        if (t <= uFill) gl_FragColor = vec4(uFillColor, 0.95);
        else gl_FragColor = vec4(0.05, 0.12, 0.2, 0.35); // 빈 부분
      }`,
  });
  const body = new THREE.Mesh(new THREE.ShapeGeometry(shape), fillMat);
  body.rotation.x = -Math.PI / 2;
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(shape.getPoints()),
    new THREE.LineBasicMaterial({ color: outlineColor, transparent: true, depthTest: false, depthWrite: false }),
  );
  outline.rotation.x = -Math.PI / 2;
  const group = new THREE.Group();
  group.add(body, outline);
  group.traverse((o) => (o.renderOrder = 10));
  group.visible = false;
  const low = new THREE.Color('#4ade80');
  const mid = new THREE.Color('#facc15');
  const high = new THREE.Color('#ef4444');
  return {
    group,
    setPower(p) {
      const k = Math.min(1, Math.max(0, p));
      uniforms.uFill.value = k;
      const c = uniforms.uFillColor.value;
      if (k < 0.5) c.copy(low).lerp(mid, k / 0.5);
      else c.copy(mid).lerp(high, (k - 0.5) / 0.5);
    },
  };
}

const easeOut = (k) => 1 - (1 - k) * (1 - k);
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
