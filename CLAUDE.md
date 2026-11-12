# 펭까기 — AI 작업 가이드

펭귄들이 서로 밀어 줄어드는 얼음판에서 떨어뜨리는 멀티플레이 웹 파티 게임. 규칙 원본은 작성자의 Claude Doc "빙판 밀치기 게임 규칙서". 플레이어는 익명(닉네임 + 탭별 무작위 토큰).

할 일 목록은 `docs/BACKLOG.md`에 있다. 작업을 고를 때 거기서 고르고, 끝나면 그 항목을 지운다.

## 명령

- `npm start` 서버 실행 (포트 3000). `npm run dev`는 server/shared 변경 시 자동 재시작
- `npm test` — `node --test test/*.test.js`. 머지 전 반드시 통과해야 함
- 테스트용 환경변수: `AIM_TIME_MS`(조준 시간), `WARMING_CHANCE`, `BLIZZARD_CHANCE`(0~1, 1이면 매 턴), `DEBUG_WS=1`(수신 메시지 로그)
- 브라우저 확인은 `?debug`를 붙이면 `window.__peng.scene`이 노출된다. headless Chrome + puppeteer-core로 자동 확인할 때 쓴다 (스크립트는 저장소에 없음)

## 구조

```
shared/config.js   상수(CONFIG, ITEMS, QUICK_CHATS, PLAYER_COLORS)와 순수 계산식. 서버·클라이언트가 같이 씀
shared/physics.js  simulate(): 2D 미끄러짐·충돌·낙하. 서버에서만 실행, 프레임을 클라이언트에 보냄
server/index.js    HTTP 정적 파일 + /healthz + WebSocket. 메시지 크기 16KB, 연결당 초당 30개 제한
server/lobby.js    접속(hello/토큰), 방 만들기·코드 참가·관전, 봇, 설정, 채팅, 신고
server/game.js     Game 클래스. 판 → 턴(aim → launch → cleanup) → 점수. 모든 판정은 여기서(서버 권위)
server/bot.js      혼자 연습용 봇의 조준·균열
public/js/main.js  UI·WebSocket 클라이언트·입력. BASE_PATH는 location.pathname에서 계산(서브경로 배포)
public/js/scene.js Three.js 장면: 판·펭귄·화살표·구멍·균열·눈보라 연출·카메라
test/rules.test.js 규칙 단위 테스트 (Game을 직접 만들어 호출)
test/e2e.test.js   서버를 띄우고 WebSocket으로 흐름 확인
```

핵심 흐름: 조준 단계에 모두 `aim`을 보내면(또는 10초 지나면) 서버가 `simulate()`를 돌리고 `turnResult`(프레임 전체)를 뿌린다. 클라이언트는 그걸 재생만 한다. 남의 조준은 절대 클라이언트에 보내지 않는다(`stateFor`에는 본인 것만).

## 규칙과 관례

- **커밋·PR 제목은 Conventional Commits**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`. 본문은 한국어
- main에는 직접 push 못 함(저장소 규칙). 브랜치 → PR → 작성자가 머지. PR 본문에는 무엇을·왜·어떻게 확인했는지 적는다
- 코드 주석·UI 문구·문서는 한국어. 식별자는 영어
- 설정값은 `shared/config.js`에 모으고 주석으로 단위를 적는다 (예: 칸, 초)
- 새 규칙을 넣으면 `test/rules.test.js`에 테스트를 같이 넣는다. 테스트는 `makeGame(n, extra)`로 Game을 만들고 `random`을 고정 시드로 준다. 이벤트 확률(`warmingChance`, `blizzardChance`)은 테스트에서 0으로 끄고 필요할 때만 1로 켠다
- 사용자에게 보이는 문구를 바꾸면 `public/index.html`의 규칙 요약과 `README.md` 조작표도 맞춘다
- 클라이언트에 사용자 입력을 넣을 때는 `esc()`를 거친다(`main.js` 끝). `textContent`가 가능하면 그쪽을 쓴다

## 배포

- Docker: `node:22-alpine`, 비root(`USER node`), `/healthz` 헬스체크. 서버 프로세스는 반드시 1개(상태가 메모리에만 있음)
- 운영 서버: SSAFY EC2(Ubuntu), nginx가 `/pengkkaki/`를 `127.0.0.1:3000`으로 프록시(Upgrade 헤더 있음). 같은 nginx가 다른 프로젝트도 서빙하므로 `/`는 건드리지 않는다
- 재배포: `cd ~/peng-kkaki && git pull && docker build -t peng-kkaki . && docker rm -f peng-kkaki && docker run -d --name peng-kkaki --restart unless-stopped -p 3000:3000 peng-kkaki`
- 재시작하면 진행 중인 게임이 사라진다(설계상 허용)
