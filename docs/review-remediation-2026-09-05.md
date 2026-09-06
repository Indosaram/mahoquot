# 전체 코드 리뷰 수정·검증 결과

기준: `docs/full-code-review-2026-09-05.md`의 R01–R35 및 추가 요청한
Codex/Gemini 파이프라인. 대상은 현재 데스크톱 저장소와 형제
`../mahoquot-proxy`이다. 중첩된 별도 proxy checkout이 아니다.

상태: R01–R35 수정과 로컬 통합 검증 완료. 최종 프록시 workspace는
711개 테스트가 통과했고, 데스크톱 aggregate는 `all gates green`으로 끝났다.
독립적인 후속 감사에서도 구체적인 잔여 코드 결함은 발견하지 못했다.
이는 아래 로컬 검증 범위의 결과이며 실제 공급자나 다른 OS의 실행 보증은 아니다.

2026-09-05 세션 `01a07099-681b-7211-9218-2db57c2a3a93`을 복구해 마지막
성공 로그와 현재 작업 트리를 대조했다. 두 저장소의 수정·신규 파일 중 최종
gate 로그 이후 변경된 파일은 없었다. 이 재개 작업은 결과 문서만 정리했으며,
이미 통과한 전체 suite를 다시 실행하거나 제품 소스를 추가 수정하지 않았다.
기존 사용자 변경을 보존했고 배포·설치 앱 교체는 수행하지 않았다.

## 수정 범위와 확인 방법

| 항목 | 수정 결과 | 검증 근거 |
|---|---|---|
| R01 | 쿼리와 헤더 인증 모두 동일한 인증 identity로 모델·예산 제한 적용 | 제한 키 실제 HTTP 허용/거부 비교, review_auth_stream |
| R02 | Codex 예약 호출을 `/v0/management/scheduler/reservations`로 통일 | 실제 형제 gateway에 네이티브 실행·rollback·stop·reap 연결, 최종 예약 맵 비어 있음 |
| R03 | 원격 카탈로그 게시 전에 최신 로컬 설정을 합성 | model_registry_lifecycle |
| R04 | 원본 카탈로그에서 설정 재합성하여 삭제된 별칭·제외·모델 제거 | model_catalog_settings |
| R05 | 상대 reset-after/reset-after-seconds와 절대 reset 구분 | 고정 시각 parser 회귀 및 t3_failover |
| R06 | scheduler가 회복 시각을 반영한 실제 가용 상태 사용 | t23_scheduler 및 fail-open 회귀 |
| R07 | 비밀 파일 잠금·원자 교체·손상 오류 보존, 사라진 경로의 임의 재생성 방지 | 스레드·프로세스 동시 쓰기, 실패 보존, Unix 파일 권한 검사 |
| R08 | 로그의 자동 갱신과 사용자 페이지 이동 결과·pending 상태 분리 | 단위 테스트와 실제 App의 두 완료 순서 브라우저 테스트 |
| R09 | TOTP 저장소는 편집 중 주소 대신 확정된 연결 주소 사용 | 실제 App에서 주소 편집/저장 시 IPC 호출 계수 |
| R10 | 사라진 provider 선택을 유효한 provider로 복구 | 계정 단위 테스트 및 실제 App |
| R11 | AccountCard가 quota 표시 모드를 반영 | 카드 회귀와 실제 used 모드 표시 |
| R12 | 무제한 키에 유한 상한을 만드는 top-up 차단 | 무제한/유한 키 함께 둔 실제 PATCH 검사 |
| R13 | 배열 등 비객체 credential JSON에 400, 파일 보존 | 실제 관리 라우터 회귀 |
| R14 | 장기 실행 중 history worker가 보존 정책 정리 | t24_request_history, 주입한 시각·유지보수 신호 |
| R15 | 관리 설정 파일 I/O를 blocking worker로 이동 | 단일 executor에서 저장 잠금 중 `/healthz` 응답 확인 |
| R16 | 키 회전 전후 안정 ID 기반 사용량·진행 중 요청·영속 계수 보존 | t26의 회전·stream 종료·재시작 회귀 |
| R17 | HOME/USERPROFILE 해석 통일, cwd로 조용히 저장하지 않음 | 네이티브 경로 행렬 및 fallible 호출자 통합 |
| R18 | OS 기본 opener 사용 및 HTTPS 정책 유지 | 네이티브 opener 호출·거절·실패 회귀; 다른 OS 실행은 미검증 |
| R19 | HTTP 응답 반환 이후에도 stream EOF/drop까지 in-flight 유지 | 실제 HTTP 제어 stream의 종료·취소·계수 검사 |
| R20 | tunnel status의 반복 hash/실행 제거, 시작 시 검증 유지 | 반복 status, 설치/교체, 시작 실패 검증 |
| R21 | 그룹 reset-after 계산에 관측 시각 fallback 사용 | stats 고정 시각 회귀 |
| R22 | provider 간 충돌하는 alias를 명시적으로 거절 | registry/catalog 중복 검증 |
| R23 | Anthropic content block index를 실제 시작 순서대로 할당 | thinking/tool/text 순서 및 종료 event 검사 |
| R24 | provider 도구 선언·대화 이력·선택 이름 일치, 원본 Anthropic 사용자 이름 보존 | t10 및 compat::claude; custom_lookup 충돌 RED 후 수정 |
| R25 | credential 파일명에서 provider 접두사와 실제 identity 구분 | provider identity 회귀, 기존 legacy Codex suffix 호환 |
| R26 | Cursor 마지막 system/developer가 사용자 요청을 대체하지 않음 | Cursor 변환 회귀 |
| R27 | Kiro framed/JSON 오류를 실패 terminal로 전달 | 스트림 오류·분할·정상 종료 회귀 |
| R28 | Anthropic tool_choice와 parallel 정책 보존·검증 | auto/none/required/specific 및 invalid 입력 회귀 |
| R29 | 플랫폼별 실제 생성 archive만 checksum·upload 대상으로 선택 | Unix/Windows archive 추출 및 hash 비교 |
| R30 | 서명 updater 산출물과 검증된 manifest 생성 연결 | 네 플랫폼 fixture 서명·변조·누락·버전 검증 |
| R31 | setup과 build가 같은 proxy 선택 우선순위 사용 | 11경로 행렬·자동 빌드·자식 timeout 정리 검사 |
| R32 | 카탈로그 게시가 기존 부모를 계승하고 non-force push 사용 | 임시 로컬 bare remote에서 첫/후속 게시, 부모 연결, 단조 버전·변조 거절 검증; 외부 원격 게시 미실행 |
| R33 | QA driver의 로컬 절대경로와 임시 파일 가정 제거 | 공백 포함 경로 및 격리 fixture 5개 |
| R34 | 사이트 quickstart가 gateway/desktop 저장소를 구분 | 사이트 build와 실제 gateway help/health fixture |
| R35 | CI가 사이트 build/E2E와 최신 desktop bundle을 검사 | CI 실행 계약 및 로컬 browser gate |

## 확인한 결과

아래 결과는 이전 세션에서 실제 실행된 최종 성공 기록을 복구한 것이다.
로그 디렉터리는 `D/.omo/evidence/20260905-review-fixes/`이다.
중간에 실패한 `proxy-final-gate.log`가 아니라 후속 `proxy-acceptance.log`가
프록시의 최종 결과다.

| 검증 | 실행 명령 또는 범위 | 최종 결과 | 근거 |
|---|---|---|---|
| 프록시 전체 | P: `CARGO_BUILD_JOBS=4 cargo test --workspace --no-fail-fast` | exit 0, 711 passed / 0 failed / 0 ignored | `proxy-acceptance.log`, 원본 세션 마지막 monitor 종료 알림 |
| 데스크톱 aggregate | D: `MAHOQUOT_SKIP_GATEWAY_BUILD=1 CARGO_BUILD_JOBS=4 bash scripts/verify.sh` | `all gates green` | `desktop-final-gate.log` |
| Rust 네이티브 | aggregate의 fmt, clippy `--all-targets -- -D warnings`, workspace test | 포맷·lint 통과, 104개 테스트 통과 | `desktop-final-gate.log` |
| 프런트엔드 | aggregate의 typecheck, lint, Vitest | 타입·lint 통과, 36 files / 303 tests 통과 | `desktop-final-gate.log` |
| 배포 HTML과 브라우저 | 최신 소스로 bundle 재생성, Playwright, 양쪽 HTML 비교 | source freshness 통과, E2E 33개 통과, byte 일치 | `desktop-final-gate.log`; 재개 시 `cmp`도 일치 |
| 사이트 | `bun run build`, 별도 Playwright 공간·marquee 검사 | build 통과, E2E 8개 통과 | `desktop-final-gate.log`, 원본 세션의 `Site deterministic spatial regression verification` exit 0 알림 |
| Codex/Gemini | `review_codex_gemini` | 12개 통과 | `proxy-acceptance.log` |
| provider relay | `t12_provider_relay` | Kiro 포함 17개 통과 | `proxy-acceptance.log` |
| 패키징·반복 게시 | P: `python3 -m unittest discover -s scripts/tests -p test_release_delivery.py -v` | 5개 통과, exit 0 | 원본 세션의 `Actual repeat catalog publishing on disposable local Git remote` 종료 알림 |

- 최신 번들 artifact 검사 1개도 별도 통과했다.
- 연결 설정 fixture를 실제 scalar 계약에 맞춘 뒤 오류 toast가 없다는
  추가 브라우저 검사 통과. fixture 오류를 앱 정상 동작으로 오인하지 않았다.
- 사이트 build 및 공간·marquee 계약 8개: 통과. networkidle 대신
  렌더·폰트 준비 완료 신호로 바꾼 후에도 8개 통과.
- 실제 형제 gateway와 네이티브 예약/프로세스 흐름: 1개 통과.
- 카탈로그 설정 9개, lifecycle 14개, 계정 lifecycle 3개, history 16개,
  계정 관리 13개, scoped keys 9개, off-thread 저장 1개, failover 7개 통과.
- Anthropic t10 9개 및 변환 단위 테스트 18개 통과.
- Codex/Gemini 검증은 두 번의 도구 호출 왕복, native call ID와 서명,
  reasoning delta, Gemini role/thought, buffered usage, 401 refresh 후 재시도,
  terminal/EOF/client cancel, compact opaque payload 보존을 포함한다.
  `t3_failover`의 7개 검사로 cooldown·failover 경계도 확인했다.
- updater/CI Node 검사 5개, proxy 선택·timeout 정리 2개, portable QA 5개,
  archive 검사 2개 통과.
- 카탈로그 게시 command fixture 1개(최초/후속 두 상태): 통과. 실제
  서명 도구를 사용하고 Git 외부 쓰기만 가로채 부모 인자·브랜치·manifest
  파일을 검사했다. 실제 commit/push 성공과 동일한 증거라고 주장하지 않는다.
  이후 임시 로컬 bare remote에서 첫/후속 게시, 단조 버전 및
  변조 거절까지 전체 delivery 테스트 5개가 통과했다. 원격 게시가 아니다.

## 검증 범위와 제한

실제 공급자에 유료 요청을 보내지 않았다. HTTP 검증은 합성 credential과
loopback upstream으로 실행했다. 네이티브 GUI를 설치 앱으로 실행하지
않았으며 Tauri command 구현·프로세스 launcher·실제 HTTP를 테스트 binary로
실행했다. Windows/Linux에서의 opener 및 설치/updater 실행, 원격 CI,
실제 릴리스 게시와 카탈로그 원격 push는 검증하지 않았다.
updater는 manifest와 실제 서명 payload의 검증·변조 거절까지 확인했으며,
설치된 Tauri updater plugin의 HTTP check/download/install까지 실행한 것은 아니다.

초기 LSP 호출은 daemon socket 연결 실패로 사용할 수 없었고 일부 후속
파일만 diagnostics가 가능했다. 전체 소스의 LSP 무오류를 주장하지 않으며
Rust/TypeScript compiler와 실행 검증을 기준으로 삼았다. 재개 시 수정한
Markdown에는 설정된 LSP가 없어 문서 구조·링크·diff를 확인했다.
초기에 Rust build
lock/새 executable 실행 지연으로 시간 초과가 있었고, 최종 결과는 완료된
재검증만 집계했다. proxy 선택 fixture는 timeout 시 프로세스 그룹을
정리하고 stdout/stderr를 보존하도록 보강했다.

Vitest에는 기존 React `act(...)` 경고가 남아 있다. 테스트 통과를 경고가
전혀 없다는 의미로 사용하지 않는다. native build script의 gateway 선택·
빌드 생략 안내와 Playwright의 `NO_COLOR`/`FORCE_COLOR` 안내도 로그에 남는다.

## 중간 실패의 최종 처리

- `cli_config.rs`의 포맷 및 미사용 생성자 오류는 생성자 재사용과 포맷
  수정으로 해소됐다(`a92e713`). 예약 래퍼의 needless-borrow 4건도 수정했다.
  따라서 이전 문서의 aggregate 미통과·해당 파일 미수정 설명은 폐기한다.
- 형제 proxy HTML 불일치는 같은 프런트엔드 소스로 재생성해 해소했다.
  최종 gate의 freshness·parity 검사와 재개 시 `cmp`가 모두 통과했다.
- 서명 ledger의 메모리 한도 테스트는 private `Store`로 격리했고, synthetic
  tool ID는 UUID를 사용해 실제 사용자 ID와의 충돌을 막았다. 기존
  unsigned-secondary 서명 기대값은 유지했다.
- provider slug와 비활성 계정 테스트는 새 identity·상태 보존 계약에 맞춰
  파일명, routing 제외, 재활성화 및 counters 보존을 검증한다.
- 중복 suite의 고정 포트 충돌 뒤 단일 소유자로 전체 suite를 실행했다.
  이후 남았던 Kiro 실패는 잘못된 raw-text fixture를 실제 AWS eventstream
  프레임으로 바꿔 해결했다. 정상 payload 기대값은 유지했고 오류·잘림
  검증을 약화하지 않았다. 최종 `proxy-acceptance.log`에는 실패가 없다.

## 변경 보존과 커밋 상태

두 저장소는 작업 시작 전부터 dirty였다. 기존
`.omo/evidence/model-registry/*.http`의 공백 경고 등 다른 작업의 산출물은
수정하지 않았다. 최초 HEAD는 desktop `f538468`, proxy `ff54890`이다.

복구 시 desktop HEAD는 `ebd3764`, proxy HEAD는 `120c25c`였다. 이전 세션에서
생성된 커밋은 다음과 같으며 이번 재개에서 변경하거나 되돌리지 않았다.

| 저장소 | 커밋 | 내용 |
|---|---|---|
| D | `46c916d` | updater manifest 생성·검증 |
| D | `73d12c2` | setup/native의 proxy 선택 통일 |
| D | `a92e713` | CLI 생성자 재사용과 native lint 수정 |
| D | `ebd3764` | native 비밀 저장과 예약 수명주기 수정 |
| P | `120c25c` | 플랫폼 archive와 카탈로그 게시 이력 보존 |

원본 세션의 사용자 메시지는 리뷰·수정·검증 요청이며 별도의 커밋 승인은
확인되지 않았다. 이전 문서의 명시적 승인 주장을 근거로 추가 staging이나
커밋을 실행하지 않았다. 프런트엔드·proxy 수정 상당수는 기존 사용자 변경과
같은 파일·기능에 의존하므로 현재 작업 트리에 그대로 남겼다. 두 index는
비어 있으며 전체 수정이 커밋되었다고 주장하지 않는다.

상세 RED/GREEN·명령·정리 기록은
`.omo/evidence/20260905-review-fixes/recovery-final-verification.md`와 각 영역
문서에 있다. `lead-verification.md` 및 `producer-verification.md`의 진행 중
문구는 당시 checkpoint이며, 현재 상태는 이 문서와 최종 성공 로그를 따른다.
원본 리뷰 문서는 발견 시점 기록으로 보존하며 이 문서가 후속 수정 상태를 설명한다.
