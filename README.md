# peng-kkaki
펭귄 알까기 — 원형 빙판 위에서 2~30명이 동시에 방향·세기를 정해 미끄러지고, 부딪혀서 상대를 떨어트리는 턴제 파티 게임.

## 실행

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # 코드가 바뀌면 서버 자동 재시작
npm test           # 규칙/물리 단위 테스트 + 서버 E2E
```

- **혼자 연습**: 메뉴에서 봇 수(1~29명)를 정하고 "연습 시작" → 봇과 바로 대결
- 방: "방 만들기" → 코드 또는 "링크 복사"로 초대 (`/?room=코드`), 다른 사람은 메뉴의 **방 목록**(실시간 갱신)이나 코드로 참가. 게임 중인 방은 관전. 최대 30명
- 대기실에서 방장이 "🤖 봇 추가"로 빈자리를 채울 수 있음

## 조작

| | 웹 (가로) | 모바일 (세로) |
|---|---|---|
| 조준 | 화면을 마우스로 당겼다 놓기 (화살표가 세기만큼 채워짐) | 판 아래 빈 영역을 당겼다 놓기 |
| 시점 좌우 회전 | 우클릭 드래그 좌우, Q/E, ⟲⟳ 버튼 | 판 위 스와이프 좌우, ⟲⟳ 버튼 |
| 시점 상하 (앞 보기 ↔ 위에서 보기) | 우클릭 드래그 위아래, W/S·↑/↓, ▲▼ 버튼 | 판 위 스와이프 위아래, ▲▼ 버튼 |
| 확정 | 확정 버튼 / Enter / Space | 확정 버튼 |
| 유령 균열 | 판 위 아무 곳 클릭 | 판 위 아무 곳 탭 |

## 배포

서버 하나(Node.js 20+)가 웹 페이지와 WebSocket을 같은 포트로 함께 제공합니다. DB는 없고 방·게임 상태는 메모리에만 있어서, **서버 프로세스는 1개만** 띄워야 합니다(여러 대로 늘리면 방이 서로 안 보임). 재시작하면 진행 중인 게임은 사라집니다.

**Docker**
```bash
docker build -t peng-kkaki .
docker run -d -p 3000:3000 --restart unless-stopped --name peng-kkaki peng-kkaki
```

**Docker 없이 (VM 등)**
```bash
npm ci --omit=dev
PORT=3000 node server/index.js     # pm2/systemd 등으로 상시 실행
```

- 헬스체크: `GET /healthz` → `{"ok":true,"rooms":N,"connections":N}`
- HTTPS 사이트에서는 자동으로 `wss://`로 접속합니다. 앞단에 nginx 등 리버스 프록시를 두면 WebSocket 업그레이드를 넘겨줘야 합니다:
  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
  }
  ```
- 환경변수: `PORT`(기본 3000), `HOST`(기본: 모든 IPv4·IPv6 주소), `AIM_TIME_MS`(조준 시간 덮어쓰기, 테스트용), `WARMING_CHANCE`(지구 온난화 확률 덮어쓰기, 테스트용 — 기본 0.1), `DEBUG_WS=1`(수신 메시지 로그)
- 신고는 서버 작업 폴더의 `reports.log`에 쌓입니다(컨테이너면 재생성 시 사라짐).

## 구조

```
shared/config.js    조정 가능한 수치(판 크기·이동 거리 등) + 서버/클라 공용 계산
shared/physics.js   바닥 평면 2D 물리 (일정 감속, 반발계수 0.9, 낙하·상자 획득 판정)
server/game.js      매치 진행: 조준 → 발사 → 정리(탈락·아이템·녹기·상자·승리) / 순위·점수
server/bot.js       연습용 봇 (가까운 상대 조준, 아이템 사용, 유령이면 균열)
server/lobby.js     접속·재접속, 방 목록/만들기/코드 참가, 봇, 채팅 채널, 신고(reports.log)
server/index.js     정적 파일 + WebSocket 서버 (요청 크기·빈도 제한, 핑, 헬스체크)
public/js/scene.js  Three.js 3D 렌더링, 카메라, 발사 재생(슬로모), 얼음 깨짐 연출
public/js/main.js   화면 전환, 조준 입력, HUD·미니맵·시점 표시, 채팅 UI
```

물리는 서버에서만 돌리고, 클라이언트는 서버가 보낸 프레임을 재생만 합니다.
