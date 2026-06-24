# PS5 Downloader CLI (`ps5dl`) — 구현 문서

> `implementation_plan.md`와 통합된 단일 권위 문서입니다.

---

## 개요

**`ps5dl`** — Node.js 기반 CLI 툴. 로컬 LaunchBox XML(`PS5.xml`)과 `dlpsgame.com` 웹 목록을 비교하여 아직 다운로드하지 않은 PS5 게임을 추적하고, 자동으로 다운로드 링크를 추출하여 실행하는 도구.

다운로드 완료 후:
- `sce_sys/param.json`을 내부 추출하여 실제 타이틀명·PPSA·버전 메타데이터를 획득
- **암호화·분할 압축된 경우**: 해제 → `eboot.bin` 기준 구조 평탄화 → **Bandizip으로 `.7z` 재압축**
- **암호화되지 않은 경우**: 표준 파일명 포맷으로 리네임 후 보존

---

## 확정된 설계 결정사항

| 항목 | 결정 |
|------|------|
| **게임 매칭** | PPSA 코드 기반 (퍼지 매칭 없음) |
| **--limit 방식** | 순차 실행 |
| **우회 링크** | `downloadgameps3.net` 재방문 후 실제 링크 추출 |
| **downloaded.xml 포맷** | XML, `<FileName>`, `<PPSA>`, `<Source>`, `<Region>` 필드 |
| **다운로드 저장 위치** | `.env` `DOWNLOAD_DIR` (기본 `C:\Z`) |
| **압축 해제 도구** | `bin/UnRAR.exe` (자가 사일런트 설치) + 시스템 7-Zip/WinRAR 자동 감지 |
| **압축 재포장 도구** | **Bandizip** `C:\Program Files\Bandizip\bz.exe` — `.7z` 포맷, 압축 레벨 7 |
| **최종 파일명 포맷** | `{Game Title} [PPSAxxxx][vXX.XX].7z` (재압축 시) 또는 원본 확장자 (비암호 시 리네임) |
| **비밀번호 후보 순서** | 웹 스크랩 패스워드 → `DLPSGAME.COM` → `dlpsgame.com` |
| **스크래핑 기반 타입 분류** | 파일명 분석 배제, 본문 문단 원본 타입(`urlInfo.type`) 사용 |
| **백포트 필터링** | 섹션 본문의 `"Works on X.xx and higher"` 노트 파싱 → `USER_FIRMWARE`(기본 7)와 비교 |
| **exFAT 다운로드 실패** | 다음 섹션 시도 없이 `.exfat` → `.failed` 리네임 후 다음 게임으로 skip |
| **다운로드 매니저** | 내장 스트리머 (기본) 또는 FDM (`DOWNLOAD_MANAGER=FDM`) |

---

## 지역 우선순위

| 순위 | 지역 |
|------|------|
| 0 | KOR (exFAT) |
| 1 | KOR |
| 2 | USA (exFAT) |
| 3 | EUR (exFAT) |
| 4 | USA |
| 5 | EUR |
| 6+ | 기타 (exFAT 여부로 추가 분리) |

---

## 백포트 필터링 로직

섹션 본문에서 `"Works on X.xx and higher"` 스타일의 노트를 파싱하여 두 단계로 필터링:

1. **Content-based (우선)**: 섹션 내 노트 발견 시
   - `X.xx ≤ USER_FIRMWARE` → 호환 → 섹션 포함
   - `X.xx > USER_FIRMWARE` → 비호환 → 섹션 skip
2. **Region-name fallback**: 노트가 없고 region 이름에 `backport` 포함 시, region 이름 내 버전 수치를 `USER_FIRMWARE`와 비교

> **예시** (`USER_FIRMWARE=7`):
> - 원본 섹션 `"Works on 9.xx and higher"` → skip
> - BackPort 섹션 `"Works on 7.xx and higher"` → 선택 → 다운로드

---

## 데이터 소스

| 소스 | 내용 | 경로/URL |
|------|------|---------|
| **로컬 보유 목록** | LaunchBox XML, 파일명 + PPSA | `data/PS5.xml` |
| **다운 완료 목록** | 완료 기록, TBD 필터링용 | `data/downloaded.xml` |
| **제외 목록** | 배치 다운로드 제외 목록 | `data/excluded.xml` |
| **실패 로그** | 다운로드 실패 이력 | `data/failed_downloads.json` |
| **웹 게임 목록** | dlpsgame.com 전체 목록 | `https://dlpsgame.com/list-game-ps5/` |
| **웹 게임 서브페이지** | PPSA별 섹션 + Base64 인코딩 링크 | `https://dlpsgame.com/{slug}/` |

---

## 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| **런타임** | Node.js | cheerio DOM 파싱에 적합 |
| **CLI 파싱** | `commander` | 커맨드/옵션 파싱 표준 |
| **HTTP 요청** | `axios` | 다운로드 및 API 통신 |
| **HTML 파싱** | `cheerio` | jQuery-like HTML 파싱 |
| **XML 파싱** | `fast-xml-parser` | PS5.xml, downloaded.xml 처리 |
| **환경변수** | `dotenv` | API 키, 경로, 설정 관리 |
| **진행 표시** | `ora` + `chalk` | 스피너, 컬러 출력 |

---

## 프로젝트 구조

```
C:\Code\PS5_Downloader\
├── bin\
│   ├── UnRAR.exe             ← 자동 사일런트 설치되는 공식 unrar CLI
│   └── Rar.exe               ← WinRAR 콘솔 압축 유틸 (레거시 ZIP 처리용)
├── data\
│   ├── PS5.xml               ← LaunchBox 내보내기 (사용자 제공)
│   ├── downloaded.xml        ← 다운로드 완료 기록
│   ├── excluded.xml          ← 배치 제외 목록
│   └── failed_downloads.json ← 실패 이력 로그
├── src\
│   ├── index.js              ← CLI 엔트리포인트 (Commander 라우팅)
│   ├── commands\
│   │   ├── list.js           ← list 커맨드
│   │   ├── download.js       ← download 커맨드 (단건·배치·FDM·exFAT 실패 처리)
│   │   ├── open.js           ← 브라우저 오픈
│   │   ├── completed.js      ← 완료 상태 수동 관리
│   │   ├── exclude.js        ← 배치 제외 관리
│   │   ├── dupe.js           ← 중복 게임 수동 처리
│   │   └── urldown.js        ← URL 직접 다운로드
│   ├── services\
│   │   ├── localLibrary.js      ← PS5.xml 파싱 + PPSA 추출
│   │   ├── downloadedDb.js      ← downloaded.xml CRUD
│   │   ├── excludedDb.js        ← excluded.xml CRUD
│   │   ├── webScraper.js        ← dlpsgame.com 스크래핑 + JSON 캐싱
│   │   ├── linkExtractor.js     ← Base64 디코딩·링크 추출·우선순위·펌웨어 필터
│   │   ├── rerouteResolver.js   ← downloadgameps3.net 우회 링크 처리
│   │   ├── fichierDownloader.js ← 1fichier API 스트리밍 다운로더
│   │   ├── datanodesDownloader.js ← datanodes.to 다단계 흐름 다운로더
│   │   ├── fdmDownloader.js     ← Free Download Manager CLI 연동
│   │   └── unrarService.js      ← UnRAR 설치, 암호 테스트, 추출, Bandizip 7z 재압축
│   └── utils\
│       ├── ppsaParser.js        ← PPSA 코드 추출
│       ├── versionParser.js     ← 파일명 버전 추출 + param.json contentVersion 도출
│       ├── titleNormalizer.js   ← 타이틀 정규화 (특수문자·로마숫자 변환)
│       ├── postProcessor.js     ← 암호 확인·추출·평탄화·7z 재압축·리네임·DB 등록
│       └── logger.js            ← chalk 컬러 출력
├── design\
│   └── implementation.md     ← 이 문서 (통합 구현 문서)
├── .env                      ← 환경 변수 설정
└── readme.md
```

---

## 환경 변수 (`.env`)

```env
# 1fichier API 키
FICHIER_API_KEY=your_key_here

# 다운로드 저장 경로
DOWNLOAD_DIR=C:\Z

# 웹 목록 캐시 유효 시간 (시간 단위)
CACHE_TTL_HOURS=24

# 현재 PS5 펌웨어 메이저 버전 (백포트 필터링 기준)
USER_FIRMWARE=7

# 다운로드 매니저: 비워두면 내장 스트리머, FDM 시 Free Download Manager 사용
DOWNLOAD_MANAGER=

# FDM 사용 시 파일당 동시 연결 수
DOWNLOADER_SESSION=3
```

---

## 핵심 모듈 설계

### 1. 링크 추출 및 펌웨어 필터 (`linkExtractor.js`)

- **Base64 페이로드 파싱**: JSON 형식(신규 페이지) 및 HTML Cheerio 파싱(구형) 지원
- **`extractFirmwareRequirement(text)`**: `"Works on X.xx and higher"` 패턴에서 최소 펌웨어 버전 추출
- **`shouldDropBackport(text)`**: Content-based 필터가 없을 때 region 이름 기반 fallback
- **호스트 우선순위**: 1fichier → Datanodes → Mediafire → Akia → Viki → Mega → Rootz → Buznew
- **Dead link 재시도**: 링크 사망 시 동일 섹션 내 다음 우선 호스트로 retry, 섹션 자체는 유지

### 2. 다운로드 흐름 (`download.js`)

```
섹션 정렬 (지역 우선순위)
    ↓
각 섹션: 펌웨어 호환 체크 (content note 또는 region 이름 fallback)
    ↓ 호환
링크 추출 → 호스트 선택
    ↓
[DOWNLOAD_MANAGER=FDM?]
  예 → fdmDownloader: API 토큰 취득 → 파일명 획득 → FDM CLI → 완료 폴링
  아니오 → fichierDownloader / datanodesDownloader 스트리밍
    ↓
exFAT 섹션 실패 시: downloadDir 내 .exfat 파일 → .failed 리네임 → 다음 게임 skip
    ↓ 성공
postProcessor: param.json 추출 → 암호 확인 → 추출+평탄화+Bandizip 7z → DB 등록
```

### 3. 후처리 (`postProcessor.js`)

- **메타데이터 취득**: `getGameInfoFromArchive` — `bz l` listing으로 param.json의 정확한 내부 경로를 찾은 뒤 해당 파일만 추출해 실제 타이틀·PPSA·버전 파싱. 파일이 수천 개인 대형 아카이브는 listing 출력이 execSync 기본 maxBuffer(1MB)를 초과하므로 listing 호출에 `maxBuffer 256MB` 부여 — 미설정 시 ENOBUFS로 listing이 조용히 실패하여 "암호화됨"으로 오진 → 비밀번호 추출 폴백 실패 → param.json이 있는데도 추출 실패로 보고됨
- **버전 도출**: `versionParser.deriveVersionFromParam` — param.json의 `contentVersion`(`NN.NNN.NNN`)을 정본으로 사용. 후행 패치 세그먼트가 전부 0이면 드롭(`01.210.000` → `v01.210`), 0이 아니면 유지(`01.000.004` → `v01.000.004`). 폴백: `contentVersion` → `masterVersion` → `01.00`. RAR(`unrarService`)·exFAT(`osfmountService`)·UFS2(`ufs2Reader`) 세 리더가 공유 (이전엔 각각 `masterVersion`/존재하지 않는 `applicationVersion`을 참조해 실제 버전 대신 `v01.00`으로 폴백하는 버그가 있었음)
- **암호화·분할 압축 세트**: UnRAR 추출 → eboot.bin 기준 평탄화 → `bz a -r -fmt:7z -l:7` 재압축
- **단순 리네임**: 비암호·비분할 아카이브는 `{Title} [PPSA][ver]{ext}` 포맷으로 리네임 보존
- **exFAT 파일**: Bandizip으로 `.7z`에 포함하여 압축 보존
- **타입별 분리**: GAME, DLC, UNLOCK, UPDATE, BACKPORT, INSTALL_GUIDE 각각 독립 처리

### 4. Bandizip 압축 (`unrarService.js`)

```js
// 폴더 전체 → 7z
bz.exe a -r -fmt:7z -l:7 -y "output.7z" "folder\*"

// 단일 파일 → 7z
bz.exe a -fmt:7z -l:7 -y "output.7z" "file.exfat"
```

실행 파일 경로: `C:\Program Files\Bandizip\bz.exe`

### 5. FDM 다운로더 (`fdmDownloader.js`)

1. **1fichier**: API `get_token` → direct URL 취득 → HEAD 요청으로 파일명 확인
2. **Datanodes**: step1~4 흐름 실행하여 direct URL + 파일명 획득
3. FDM CLI 실행: `fdm.exe /add "URL" /s /saveto "DIR" /filename "NAME" /n SESSION수`
4. 3초 간격 폴링 → 파일 크기 15초 안정 시 완료 판정 (최대 72시간 대기)

---

## 구현 단계 (완료)

- [x] Phase 1: 프로젝트 초기화
- [x] Phase 2: 유틸리티 (`ppsaParser`, `titleNormalizer`, `logger`)
- [x] Phase 3: 데이터 서비스 (`localLibrary`, `downloadedDb`)
- [x] Phase 4: 웹 스크래퍼 (`webScraper`)
- [x] Phase 5: 링크 추출 (`linkExtractor`, `rerouteResolver`)
- [x] Phase 6: 1fichier 다운로더
- [x] Phase 7: CLI 커맨드 (`list`, `download`, `open`)
- [x] Phase 8: 에러 핸들링
- [x] Phase 9: WordPress REST API 연동 및 로컬 HTML 캐시 폴백
- [x] Phase 10~11: 스포일러 파싱, 지역 폴백, Base64 페이로드 직접 파싱
- [x] Phase 12: UnRAR 자가 설치, param.json 기반 암호 감지
- [x] Phase 13: eboot.bin 평탄화 + Rar.exe 재압축
- [x] Phase 14: 분할 압축 감지 정밀화 (`.r00~.r99`, `.z01~.z99`), 독립 아카이브 개별 처리
- [x] Phase 15: `completed` 및 `--completed` 수동 완료 관리
- [x] Phase 16: `exclude` 배치 제외 관리
- [x] Phase 17: `dupe` 중복 처리 커맨드
- [x] Phase 18: `urldown` URL 직접 다운로드
- [x] Phase 19: Datanodes 다운로더 (`datanodesDownloader.js`) 연동
- [x] Phase 20: ZIP 및 7z 아카이브 지원 (7-Zip/WinRAR 자동 감지)
- [x] Phase 21: 압축 재포장 Rar.exe → **Bandizip 7z** 전환
- [x] Phase 22: exFAT 다운로드 실패 시 `.failed` 리네임 + 게임 skip 처리
- [x] Phase 23: FDM 다운로드 매니저 연동 (`DOWNLOAD_MANAGER=FDM`)
- [x] Phase 24: 백포트 필터링 — region 이름 기반 → 섹션 본문 `"Works on X.xx"` content-based 방식으로 전환
- [x] Phase 25: 대형 아카이브 param.json 메타데이터 추출 안정화 — 출력 캡처하는 `bz l` 호출(`findParamPathInArchive`, `archiveContainsExfat`)에 maxBuffer 256MB 부여. 파일 수천 개 아카이브의 1MB 초과 listing이 ENOBUFS로 실패 → "암호화됨" 오진 → param.json 추출 실패로 보고되던 문제 수정
- [x] Phase 26: 버전 도출을 param.json `contentVersion` 기준으로 통일 — 후행 `.000` 패치 세그먼트 드롭, `versionParser.deriveVersionFromParam`로 RAR·exFAT·UFS2 리더 공유. exFAT/UFS2가 존재하지 않는 `applicationVersion`을 참조해 항상 `v01.00`으로 폴백하던 버그 수정

---

## 아카이브 지원 포맷

| 포맷 | 해제 도구 | 재압축 |
|------|---------|--------|
| `.rar`, `.partN.rar` | `UnRAR.exe` | Bandizip → `.7z` |
| `.zip`, `.partN.zip` | PowerShell `Expand-Archive` 또는 `Rar.exe` | Bandizip → `.7z` |
| `.7z` | 시스템 7z.exe 또는 WinRAR.exe | Bandizip → `.7z` |
| `.r00`~`.r99`, `.z01`~`.z99` | 분할로 감지 후 위와 동일 | Bandizip → `.7z` |
| `.exfat` (비압축 raw) | 해제 없음 | Bandizip → `.7z` |
