# Intact — Web Clipper for Notion (v0.2.0)

페이지 전체를 Notion 블록으로 저장하는 크롬 확장. v0.2.0은 "출시 전 추출 오류 줄이기" 조사에서 나온 권장 조치 14개를 모두 반영한 빌드입니다.

## 폴더 구조

```
src/            읽을 수 있는 소스 (수정은 여기서)
  extractor.js    콘텐츠 스크립트: 사이트 핸들러 → 선택/Defuddle → 복원 → Notion 블록 변환
  background.js   서비스 워커: Notion API, 검증·청킹·블록 격리 재시도, 이미지 업로드, 이어쓰기, 스크린샷, 신고 번들
  popup.*         팝업 UI (캡처 모드, 품질 경고, 이어쓰기, 요약 배지, 신고 패널)
  manifest.json
vendor/defuddle.js   Obsidian Web Clipper 엔진(Defuddle) 번들. window.__IntactDefuddle 로 노출. 수정하지 않음.
tests/
  run.mjs           회귀 코퍼스 실행기 (jsdom)
  pages/<slug>/     source.html + meta.json + expected.json (+ actual.json 은 실행 결과)
  make-fixtures.mjs 합성 픽스처 생성기 (13개)
  snapshot.mjs      실제 페이지를 픽스처로 저장 (playwright 필요)
  background.test.mjs 전송 계층 단위 테스트 (Notion 모킹)
  e2e.mjs           실제 Chromium에 확장을 로드해 프레임 주입·팝업·메시지 라우터 검증
build.mjs        src + vendor → dist/ (그대로 "압축해제된 확장 프로그램 로드")
```

## 빌드 / 로드 / 테스트

```bash
npm install                 # jsdom (+ playwright는 e2e/snapshot에만 필요)
npm run build               # dist/ 생성
npm test                    # 회귀 코퍼스 13개 + 전송 계층 단위 테스트
node tests/e2e.mjs          # 실제 Chromium (CHROME_PATH 환경변수로 크롬 경로 지정 가능)
```

`chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드합니다" → `dist/` 선택.
OAuth가 없는 개발 빌드는 팝업에서 내부 통합 토큰(ntn_…)을 붙여넣고, 저장할 Notion 페이지에 통합을 연결(Connections)하면 됩니다.

배포 전 채울 상수 (`src/background.js` 상단): `NOTION_CLIENT_ID`, `TOKEN_EXCHANGE_URL`, `REPORT_ISSUE_URL`.

## 권장 조치 14개 → 구현 위치

| # | 조치 | 구현 |
|---|---|---|
| 1 | 블록 단위 격리 재시도 | `background.js` `appendResilient()` — `validation_error` 메시지의 `children[i]` 인덱스로 해당 블록만 `degradeBlock()` 후 재전송, 인덱스가 없으면 순서를 유지한 채 이분 탐색. 표는 문단으로, 이미지·비디오는 북마크로, 수식은 latex 코드로 강등 |
| 2 | 전송 전 사전 검증기 | `sanitizeBlocks()` (확장자 화이트리스트, URL 2000, 수식 1000, rich_text 100, 2단계 중첩, 표 폭 맞춤) + `packChunks()` (청크당 100블록·900요소·400KB) |
| 3 | 부분 실패 표시·이어쓰기 | `clip()`이 `intact.pending`에 진행 상태와 남은 블록을 저장. 실패 시 "N/M 저장됨 — 열기 / Resume". `resume()`은 같은 페이지에 이어서 append → 중복 페이지 없음 |
| 4 | 선택·복원 경로도 표준화 | `standardizeFragment()` 가 선택 HTML을 합성 문서에 넣어 Defuddle을 돌리고(내용이 70% 미만으로 줄면 원본 사용), `normalizeRawFragment()` 가 코드·수식을 `<pre data-lang>` / `<math data-latex>` 로 정규화. 복원 패스(`restoreDropped`)도 같은 정규화를 거치며, Defuddle이 잘라낸 블록(중첩 리스트, 인라인 수식, 코드 줄바꿈)은 원본으로 "업그레이드" |
| 5 | 결과 품질 자동 판정 | `assessQuality()` → 100단어 미만 / 본문 대비 35% 미만 / 페이월 패턴(한·영) → 팝업 경고 + 선택·북마크·스크린샷 버튼 |
| 6 | 북마크·스크린샷 폴백 | 캡처 모드 select. 북마크는 og 메타 + bookmark 블록, 스크린샷은 `captureVisibleTab` → File Upload API |
| 7 | 네이버 블로그/카페 iframe | `executeScript({allFrames:true})` 후 프레임별 결과 중 사이트 핸들러 결과 또는 (상위 프레임이 껍데기일 때) 본문이 긴 프레임 채택. `handleNaverSmartEditor()` 가 `.se-component` 를 문단/소제목/코드/이미지(캡션)/인용/oglink→북마크/표/hr/임베드로 매핑 |
| 8 | pstatic 등 이미지 업로드 | `classifyImageUrl()` 이 referer 차단·서명 URL·프록시·비허용 확장자를 표시 → 페이지 컨텍스트에서 바이트 fetch(Referer 자동) → 실패 시 워커에서 `declarativeNetRequest` 로 Referer를 붙여 fetch(host_permissions 범위) → Notion File Upload → `file_upload` 이미지 블록. 그래도 안 되면 북마크로 강등. `?type=w773`→`w2000`, dthumb/daumcdn 프록시 언랩 |
| 9 | Tistory | `data-ke-language` 우선, 클래스가 언어명인 `<pre class="kotlin">`, ColorScripter 표 → 코드(`colorScripterText`, 푸터 제거), `<span data-url>` 원본 이미지 |
| 10 | 코드블록 정규화 | `codeText()` — `<br>`, 줄 래퍼(Shiki/Prism/Docusaurus/CodeMirror/Monaco/hljs-ln), 거터(Pygments/Chroma/Rouge/react-syntax-highlighter…), 복사 버튼·파일명 헤더 제거, NBSP/zero-width 정리. 빈 줄은 보존(PEP8 두 줄 등) |
| 11 | `<pre>` 없는 코드 컨테이너 | `CODE_CONTAINER_*` (`.se-code-source`, `.colorscripter-code`, `.cm-editor/.cm-content`, `.monaco-editor/.view-lines`, `.highlight`·`div[class*=language-]` 등) |
| 12 | 회귀 코퍼스 | `tests/pages` + `node tests/run.mjs`. 픽스처 추가: `node tests/snapshot.mjs <slug> <url>` → 첫 실행이 expected.json 초안 생성 → actual.json 보고 기대값 수정 |
| 13 | "이 페이지 결과가 이상해요" | 팝업 하단 버튼 → `report` 핸들러가 URL·품질·블록 JSON·추출 HTML을 묶어 텍스트영역에 표시 → 사용자가 검토 후 복사 / 이슈 폼 열기. 자동 전송 없음 |
| 14 | 저장 후 요약 배지 | `summarize()` → "32 blocks · 4 images · 2 code · 1 table · 1 copied · 1 simplified", "What changed" 접기에서 강등 내역 확인 |

## 픽스처 추가 규칙 (Readability/Postlight 방식)

- 깨진 페이지를 만나면 먼저 `node tests/snapshot.mjs <slug> <url>` 로 스냅샷을 남기고, 고친 뒤 `expected.json` 에 **있어야 하는 것**(`includes`)과 **없어야 하는 것**(`excludes`, `excludesText`)을 적습니다.
- `expected.blocks` 는 순서를 지키는 부분수열 매칭이라, 문단 전부를 나열할 필요 없이 핵심 블록만 적으면 됩니다.
- 로그인/페이월 페이지는 브라우저에서 "다른 이름으로 저장 → 웹페이지, 완료" 로 저장한 HTML을 `source.html` 로 써도 됩니다.

## 알려진 한계 / 실제 클립으로 확인할 것

- Notion이 외부 이미지를 자체 프록시로 렌더하는지(=referer 차단 이미지가 external로도 보이는지)는 미검증. 현재는 안전하게 업로드 경로를 씁니다.
- 워커에서의 이미지 fetch는 `host_permissions` 에 적은 호스트(pstatic/naver.net/kakaocdn/daumcdn)만 가능. 다른 호스트는 페이지 컨텍스트 fetch(CORS 허용 시)만 시도하고 실패하면 북마크.
- 무료 플랜 File Upload 5MiB/파일, 클립당 16장·12MB 상한. 초과분은 external URL 그대로(검증 통과 시) 또는 북마크.
- 크로스 오리진 iframe(다른 도메인) 본문은 `activeTab` 권한 범위 밖이라 읽지 못함(네이버 블로그는 같은 도메인이라 가능).
- 스크린샷은 보이는 영역만. 전체 페이지 스크린샷은 스크롤 캡처가 필요해 미구현.

## 고정 범위 개발 문의

이 저장소처럼 브라우저 확장·웹 연동 기능을 개발하며, 범위가 분명한 외부 작업도 받습니다.

- 매장·1인 사업자 원페이지 웹사이트: **59만 원**
- 기존 웹사이트의 재현 가능한 한 화면·한 문제 수정: **19만 원**

작업 전 코드 접근 권한, 납품 범위, 일정과 지급 방식을 먼저 합의합니다. 자세한 범위와 문의: [YEMO·WEB](https://yemo-web-studio.yemoyang9.chatgpt.site/) · [yemoyang9@gmail.com](mailto:yemoyang9@gmail.com)
