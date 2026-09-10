# 텍스트 뷰어 PWA

모바일(안드로이드, 삼성 인터넷 기준)용 txt 텍스트 뷰어입니다. 프레임워크와 빌드 도구 없이 순수 HTML/CSS/JS로 작성되어 정적 파일만으로 배포할 수 있습니다.

## 기능

- 서재: 열었던 파일 목록, 진행률, 마지막 읽던 책 자동 이어읽기, 길게 눌러 삭제
- 뷰어: 페이지 모드(탭/스와이프) 와 스크롤 모드, 진행률 슬라이더
- 설정: 글자 크기, 줄간격, 여백, 글꼴(고딕/명조), 테마(밝게/어둡게/세피아)
- 책갈피, 본문 검색(결과 강조)
- 인코딩 자동 감지(UTF-8, EUC-KR, UTF-16) 및 수동 변경
- PWA: 홈 화면 설치, 오프라인 동작, 파일 관리자 "공유"로 txt 받기(Web Share Target)

## 실행

```bash
npm start
```

기본으로는 `127.0.0.1` 에만 바인딩되어 같은 PC의 `http://localhost:8080/` 에서만 접근할 수 있습니다.

휴대폰 등 같은 와이파이의 다른 기기에서 접속하려면 LAN 공개 모드로 실행하세요.

```bash
npm run start:lan
```

콘솔에 LAN 주소(예: `http://172.30.1.32:8080/`)가 함께 출력됩니다. Windows 방화벽이 8080 포트의 인바운드 연결을 허용해야 합니다. `HOST=0.0.0.0` 또는 `LAN=1` 환경변수로도 같은 동작을 켤 수 있고, `PORT` 로 포트를 바꿀 수 있습니다.

## LAN(HTTP) 테스트 시 제한

브라우저는 HTTPS 또는 `localhost` 에서만 Service Worker를 허용합니다. LAN IP 주소로 접속하면 읽기 기능은 모두 동작하지만, 아래 기능은 동작하지 않습니다.

- 홈 화면 "앱 설치" 및 standalone 실행
- 오프라인 캐시
- 파일 관리자 공유(Share Target)

이 기능까지 실제 기기에서 확인하려면 다음 중 하나를 사용하세요.

1. 브라우저 플래그: Chrome은 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 에 `http://172.30.1.32:8080` 을 등록하면 HTTP에서도 보안 컨텍스트로 취급합니다. 삼성 인터넷은 `internet://flags` 에서 같은 플래그를 찾을 수 있습니다.
2. HTTPS 터널: `npx cloudflared tunnel --url http://localhost:8080` 또는 `npx localtunnel --port 8080` 으로 임시 HTTPS 주소를 만듭니다.
3. 정적 호스팅: GitHub Pages, Cloudflare Pages 등에 폴더를 그대로 올립니다. 상대 경로만 사용하므로 하위 경로 배포도 됩니다.

## 스크립트

| 명령 | 설명 |
|---|---|
| `npm start` | 개발 서버 (localhost 전용, 127.0.0.1:8080) |
| `npm run start:lan` | 개발 서버를 LAN에 공개 (0.0.0.0:8080) |
| `npm run icons` | `icons/` PNG 아이콘 재생성 |
| `npm run demo` | `demo/` 데모 텍스트 재생성 (UTF-8, EUC-KR) |

## 구조

```
index.html            앱 셸 (서재, 뷰어, 시트/패널 마크업)
css/style.css         스타일, 테마
js/app.js             라우팅, 서재, 뷰어 UI, 설정/검색/책갈피
js/reader.js          뷰어 엔진 (페이지 모드: CSS 다단 + 가로 이동, 스크롤 모드: 청크 윈도우)
js/text.js            본문 블록/청크 색인
js/encoding.js        인코딩 감지, 디코딩
js/db.js              IndexedDB (books 메타, contents 원본 버퍼)
js/ui.js              오버레이 스택(뒤로가기 연동), 토스트, 유틸
sw.js                 Service Worker (앱 셸 캐시, share_target)
manifest.webmanifest  PWA 매니페스트
server.js             개발 서버
scripts/              아이콘/데모 생성 스크립트
demo/                 데모 텍스트
```

## 저장 구조

- 파일 원본은 IndexedDB `contents` 에 ArrayBuffer로 저장하고, 열 때마다 선택한 인코딩으로 디코딩합니다.
- 읽던 위치는 글자 오프셋으로 저장하므로 글꼴 크기나 화면 크기가 바뀌어도 같은 문장에서 이어집니다.
- 설정은 `localStorage` 의 `tv.settings` 에 저장됩니다.
