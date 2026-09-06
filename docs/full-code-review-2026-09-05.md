# Mahoquot 전체 코드 리뷰 및 해결안

작성일: 2026-09-05. 대상: Tauri 데스크톱 앱과 프록시 백엔드의 현재 작업 트리.

후속 수정·검증 상태는 [review-remediation-2026-09-05.md](review-remediation-2026-09-05.md)에 있다.
이 문서는 발견 시점의 리뷰 기록이며 아래 결함이 현재도 모두 남아 있다는 뜻은 아니다.

## 판정과 읽는 방법

이 문서는 수정 패치가 아니라 코드 리뷰 결과다. 각 항목은 발생 조건, 코드 근거, 영향, 해결 방법과 회귀 검증을 함께 기록한다. P1은 인증 경계 또는 핵심 기능 차단, P2는 기능·데이터·운영 정확성 문제, P3는 표시·성능·관측성 문제다. 별도 표시가 없는 발견 사항은 **현재 코드와 호출 경로를 대조한 정적 분석**이며, 개별 재현 테스트를 추가 실행했다는 뜻이 아니다.

현재까지 가장 먼저 처리할 문제는 제한 API 키의 쿼리 인증 경로, Codex 실행 예약 URL, 카탈로그와 로컬 설정의 합성 경로다. 기존 테스트 통과만으로 이 경계들을 검증했다고 볼 수 없다.

### 기준 저장소

| 구분 | 경로 | 확인한 HEAD |
|---|---|---|
| 데스크톱 (`D`) | `/Volumes/T9-Mac/project/mahoquot` | `f538468cea6329553f7fdec4281f046d56f409a8` |
| 실행·개발 프록시 (`P`) | `/Volumes/T9-Mac/project/mahoquot-proxy` | `ff54890c0bc1dc72b4f35289a1f9b876137f6cb6` |
| 데스크톱 내부 프록시 체크아웃 | `D/mahoquot-proxy` | `f70a813085d4392d386f7d25486cdf061cf7ffda` |

이하 `D/`, `P/`는 위 절대 경로를 뜻한다. 두 프록시 디렉터리는 같은 디렉터리로 연결된 심볼릭 링크가 아니고 HEAD도 다르다. 백엔드 발견 사항과 테스트 결과는 **형제 저장소 P** 기준이다.

두 저장소에 기존 미커밋 변경이 있었고, 리뷰 중에도 `App.tsx`, `AccountsSurface.tsx`, 테스트 등에 다른 작업의 변경이 관찰됐다. 따라서 고정된 단일 커밋의 인증 보고서가 아니다. 발견 사항은 원문 재확인 시점 기준이며 이후 수정으로 줄 번호와 결과가 달라질 수 있다. 이 리뷰에서는 제품 소스를 수정하지 않았다.

## 우선 수정할 발견 사항

### R01 · P1 · 쿼리 파라미터 인증은 통과하지만 제한 API 키의 권한·예산 적용이 빠진다

- **근거:** `P/crates/gateway/src/inbound.rs:194-255`, `P/crates/gateway/src/relay.rs:1503-1540`, `P/crates/gateway/src/routes.rs:240-261`.
- **조건·영향:** `?key=<scoped-key>`로 요청하면 미들웨어는 인증하고 `AuthIdentity`를 extensions에 넣는다. 그러나 relay와 모델 목록은 헤더만 읽는 `presented_api_key`로 다시 키를 찾는다. 쿼리 키는 `scoped_entry=None`이 되어 모델·프로바이더·계정 제한, 토큰 예산 검사와 사용량 귀속을 건너뛴다. 마스터 키를 설정한 인증 모드에서도 발생하는 별개의 결함이다.
- **해결:** 미들웨어가 확정한 identity와 안정적인 키 식별자를 모든 추론·모델 조회 핸들러에 전달한다. 헤더 재파싱을 권한 판정의 근거로 쓰지 않는다. 계정 바인딩과 사용량 기록도 같은 identity를 사용한다.
- **회귀 검증:** 헤더 인증과 쿼리 인증 각각에 대해 허용·금지 모델, 계정, 프로바이더와 예산 초과를 검증한다. 허용 요청의 사용량이 같은 scoped key에 적립되는지, 모델 목록도 같은 범위로 제한되는지 확인한다. mock upstream만 사용한다.

### R02 · P1 · Codex 실행 예약 요청의 `/v0` 누락으로 실행이 막힌다

- **근거:** `D/crates/monitor-ui/src/main.rs:778-867`, `P/crates/gateway/src/routes.rs:192-196`.
- **조건·영향:** 실행 전 예약은 `/management/scheduler/reservations`로 보내지만 gateway는 `/v0/management`에만 관리 라우터를 mount한다. 네이티브 helper는 base URL과 path를 그대로 연결하므로 404가 나고 `launch_codex_instance`가 프로세스 생성 전에 실패한다. 중지·실패 롤백·crash 정리의 해제 URL도 동일하게 틀려 있다.
- **해결:** 네 가지 예약 생성·삭제 경로를 `/v0/management/scheduler/reservations` 계약에 맞춘다. 시작 경로만 수정하지 말고 rollback 및 reaper까지 함께 수정한다.
- **회귀 검증:** 실제 관리 라우터와 네이티브 HTTP helper를 연결해 예약 생성, 실행 실패 시 해제, 중지, crash 정리를 검증한다. 성공 응답만 반환하는 가짜 IPC 테스트로 대체하지 않는다.

### R03 · P1 · 원격 카탈로그 갱신이 로컬 모델 설정을 런타임에서 제거한다

- **근거:** `P/crates/gateway/src/registry/manager.rs:277-299`, `P/crates/gateway/src/runtime_state.rs:329-350`.
- **조건·영향:** 검증된 원격 카탈로그를 적용하면 원본 snapshot이 `runtime.update_registry`에 직접 전달된다. 현재 Settings의 제외 규칙·별칭·사용자 모델을 재합성하지 않는다. 설정 파일은 남아 있어도 활성 모델 목록과 라우팅이 바뀌어 제외했던 모델이 다시 노출되거나 사용자 별칭이 사라질 수 있다.
- **해결:** 원본 카탈로그와 사용자 설정을 구분해 보관하고, 최신 원본 + 현재 로컬 설정으로 후보 composition을 검증한 뒤 한 번에 publish한다. 검증 실패 시 기존 composition을 유지하고 refresh 상태에도 실패를 반영한다.
- **회귀 검증:** 제외·별칭·사용자 모델을 설정한 상태에서 서명된 새 fixture 카탈로그를 적용한다. 갱신 전후 `/v1/models`와 실제 mock 라우팅이 로컬 정책을 유지하는지 확인한다.

### R04 · P2 · 설정 합성에 이전 합성본을 재사용해 삭제한 규칙이 남는다

- **근거:** `P/crates/gateway/src/state.rs:324-333`, `P/crates/gateway/src/management/store.rs:135-170`, `P/crates/registry/src/lib.rs:1333-1357`.
- **조건·영향:** snapshot provider가 이미 로컬 설정을 포함한 runtime registry를 돌려준다. 다음 합성에서 기존 models·aliases·exclusions를 clone하고 추가하므로 설정에서 지운 규칙이 새 snapshot에도 남는다. 관리 API 성공과 실제 라우팅 상태가 어긋난다.
- **해결:** 설정 변경도 항상 현재의 **원본 카탈로그**에 전체 로컬 설정을 한 번 적용한다. 원격 기본 별칭까지 일괄 삭제하는 식의 수정은 피한다. R03과 같은 합성 경로로 통일한다.
- **회귀 검증:** 추가 → 조회·라우팅 확인 → 삭제 → 조회·라우팅 확인을 제외 규칙·별칭·사용자 모델 각각에 수행한다. 재시작 없이 원상복구되는지 검사한다.

### R05 · P2 · 상대 reset 초를 Unix 시각으로 해석해 429 cooldown이 잘못된다

- **근거:** `P/crates/gateway/src/relay.rs:774-801`.
- **조건·영향:** `Retry-After` 없이 `*-reset-after-seconds: 60` 같은 헤더가 오면 `*-reset-at`과 함께 epoch 차감이 적용된다. 결과가 0으로 버려져 기본 300초가 된다. 짧은 제한은 필요 이상 지속되고 긴 제한은 너무 일찍 재시도한다.
- **해결:** 상대 초는 그대로 duration으로, 절대 시각은 현재 시각과의 차이로 처리한다. 기존 overflow 방어는 유지한다.
- **회귀 검증:** 주입한 시각으로 상대 42초, 미래 절대 시각, 지난 절대 시각, 잘못된 값과 큰 값을 검증한다. 실제 시간을 기다리지 않는다.

### R06 · P2 · 만료된 cooldown 계정이 스케줄러 후보에서 계속 제외될 수 있다

- **근거:** `P/crates/gateway/src/scheduler/mod.rs:317-328,347-390`.
- **조건·영향:** 후보 생성은 `Health::Available` variant만 허용한다. 시간이 지나 사용 가능해진 `Health::Cooldown`도 제외된다. 다른 정상 후보가 선택돼 있으면 복구 계정이 계속 parked 상태에 남을 수 있다. 단, 모든 후보가 없으면 `fail_open`이므로 모든 상황에서 영구 차단된다는 주장은 하지 않는다.
- **해결:** 시간 기반 `health.is_available(now_ms)`를 사용하고 수동 비활성·인증 실패·실패 횟수·최소 hold 정책을 구분한다.
- **회귀 검증:** 정상 계정과 만료 cooldown 계정을 함께 두고 후자에 우선순위를 부여한다. 과거·미래 deadline에서 선택 여부가 바뀌는지 검증한다.

### R07 · P2 · 비밀 저장 파일이 원자적으로 교체되지 않고 읽기 오류를 빈 저장소로 취급한다

- **근거:** `D/crates/monitor-ui/src/secrets.rs:106-168`, `D/crates/monitor-ui/src/main.rs:1378-1379`.
- **조건·영향:** production `SecretStore<PlainFileBackend>`는 `secrets.json`을 읽고 전체를 `std::fs::write`로 다시 쓴다. 쓰기 도중 실패하면 파일이 잘릴 수 있고 다음 load는 파싱·읽기 실패를 빈 map으로 바꾼다. 이후 저장이 이전 항목 전체를 덮을 수 있다. read-modify-write에 공유 lock도 없어 병렬 접근이 발생하면 lost update 위험이 있다.
- **해결:** NotFound만 빈 저장소로 처리하고 파싱·권한·I/O 오류는 반환한다. 읽기-변경-저장을 한 임계 구역으로 묶고, 같은 디렉터리의 고유 임시 파일을 처음부터 0600으로 생성해 flush/sync 후 atomic rename한다. 다중 프로세스 접근을 지원한다면 파일 lock도 필요하다.
- **회귀 검증:** 손상된 JSON, 쓰기 실패, 서로 다른 키의 동시 갱신을 임시 경로에서 검증한다. 동시 순서는 barrier로 제어하며 실제 사용자 비밀 파일은 사용하지 않는다.

### R08 · P2 · 실시간 로그 갱신과 페이지 이동의 경합으로 버튼이 잠긴다

- **근거:** `D/crates/monitor-ui/frontend/src/components/DurableLogs.tsx:123-158,173-231`.
- **조건·영향:** 첫 페이지에서 Next 또는 provider 변경 요청이 pending인 동안 `liveTick`이 background fetch를 시작한다. 공유 sequence가 증가해 사용자 요청의 finally는 pending 해제를 건너뛰고, background finally는 refreshing만 해제한다. pending이 남아 페이지 버튼이 비활성화된다.
- **해결:** 데이터 freshness sequence와 사용자 작업의 pending 소유권을 분리한다. background refresh가 pagination 결과를 무효화하지 않도록 하거나 사용자 요청 중 갱신을 합친다. 단순히 모든 finally에서 pending=false로 바꾸면 새 사용자 요청의 pending까지 지울 수 있다.
- **회귀 검증:** 수동 deferred promise로 페이지 요청 → liveTick → background 완료 → 페이지 요청 완료 순서를 제어한다. 두 순서 모두 최신 결과와 버튼 활성화를 검증한다. 고정 sleep은 사용하지 않는다.

### R09 · P2 · 저장 전 Gateway URL 입력이 TOTP 저장소를 즉시 바꾼다

- **근거:** `D/crates/monitor-ui/frontend/src/App.tsx:212`, `D/crates/monitor-ui/frontend/src/hooks/useTotpVault.ts:24-55`.
- **조건·영향:** `useTotpVault(baseUrl)`가 편집 중 URL을 받는다. 타이핑마다 store/vault/reload가 재생성돼 불완전한 endpoint로 secret IPC를 호출하고 표시 항목을 다시 읽는다. 현재 네이티브 backend는 plain file이므로 OS Keychain 팝업 발생까지 주장하지 않는다.
- **해결:** `committedBaseUrl`에 vault를 연결한다. endpoint 전환 후 이전 reload가 새 상태를 덮지 않도록 취소·generation 보호도 점검한다.
- **회귀 검증:** URL 입력 중 TOTP `read_secret` 호출과 vault 변경이 없는지 확인하고 Save & reconnect 후에만 전환되는지 검사한다.

### R10 · P2 · 사라진 provider 선택값 때문에 Accounts가 빈 화면을 표시한다

- **근거:** `D/crates/monitor-ui/frontend/src/App.tsx:640-648`.
- **조건·영향:** 선택 provider의 마지막 계정을 지우거나 오래된 sessionStorage 선택값으로 시작하면, 현재 providers에 없는 문자열로 accounts를 필터한다. 다른 계정은 있어도 빈 목록이며 선택된 탭이 없다. 다른 탭 클릭으로 복구 가능하므로 영구 잠금은 아니다.
- **해결:** 선택값이 현재 providers에 있을 때만 사용하고 아니면 첫 provider로 fallback한다. 계정이 없는 경우도 별도 처리한다.
- **회귀 검증:** 마지막 계정 삭제와 stale sessionStorage 두 경우에 유효한 탭·계정이 자동 선택되는지 확인한다.

### R11 · P2 · 메인 계정 카드가 remaining/used 표시 설정을 무시한다

- **근거:** `D/crates/monitor-ui/frontend/src/components/AccountCard.tsx:455-472`, `AccountsSurface.tsx:96-124`, `SettingsSurface.tsx:490-500` (앞 두 상대 파일도 같은 components 디렉터리).
- **조건·영향:** 설정을 used로 바꿔도 AccountCard는 `100 - usedPercent`를 표시한다. 트레이·노치와 메인 콘솔의 숫자 해석이 달라진다.
- **해결:** App → AccountsSurface → AccountCard에 설정을 전달하고 숫자·막대·접근성 설명을 같은 의미로 맞춘다.
- **회귀 검증:** 사용량 25% fixture에서 설정에 따라 25%/75%와 막대 폭이 함께 바뀌는지 확인한다.

### R12 · P2 · 무제한 공유 키의 Top up이 오히려 제한을 만든다

- **근거:** `D/crates/monitor-ui/frontend/src/components/SharedKeysCard.tsx:384-391,774-791`.
- **조건·영향:** `token_limit=0`은 무제한인데 `0 + additional`을 새 limit로 보낸다. 이미 쓴 토큰이 새 limit보다 크면 즉시 exhausted가 된다.
- **해결:** 무제한 키에서는 Top up을 제공하지 않는다. 유한 제한으로 바꾸는 기능은 별도 편집 작업으로 취급한다. 사용량에 additional을 더하는 방식도 무제한을 유한으로 바꾸므로 기본 해결로 삼지 않는다.
- **회귀 검증:** 사용량 1,000,000, limit 0인 키에서 Top up이 quota를 제한하는 PATCH를 보내지 않는지 확인한다.

### R13 · P2 · credential status API가 배열 JSON에 문자열 인덱스를 써 panic한다

- **근거:** `P/crates/gateway/src/management/creds.rs:506-536`.
- **조건·영향:** auth 디렉터리의 JSON 배열 파일을 지정하면 JSON parse는 성공하지만 `value["disabled"]` 대입이 panic한다. 요청 작업이 실패하고 연결이 끊길 수 있다. 프로세스 전체 종료 여부는 panic 설정에 따라 달라지므로 단정하지 않는다.
- **해결:** credential 파일 이름·종류를 확인하고 `as_object_mut` 실패 시 400을 반환한다. 내부 account-order 파일은 변경 대상으로 허용하지 않는다.
- **회귀 검증:** 배열·문자열·숫자 JSON 및 내부 상태 파일 이름에 400이 반환되고 파일 내용이 유지되는지 확인한다.

### R14 · P2 · 실행 중 요청 이력 보존 정책이 적용되지 않는다

- **근거:** `P/crates/gateway/src/state.rs:257-266`, `P/crates/gateway/src/request_history.rs:399-455,926-966`.
- **조건·영향:** prune은 시작 시 한 번 호출된다. ingest worker와 DB worker는 주기적으로 prune을 요청하지 않는다. 장기 실행 시 기간·용량 정책을 넘어 이력이 계속 쌓일 수 있다.
- **해결:** 종료 가능한 유지관리 작업 또는 DB worker의 명시적 maintenance 명령으로 주기적 prune을 연결한다. retention, DB/WAL 용량, 실패 관측을 함께 다룬다.
- **회귀 검증:** 주입 가능한 maintenance trigger와 고정 시각으로 만료·용량 초과 레코드를 만든 뒤 정책 적용을 검증한다. 실제 한 시간 대기는 필요 없다.

### R15 · P2 · 일부 관리 변경이 async worker에서 동기 디스크 저장을 실행한다

- **근거:** `P/crates/gateway/src/management/scoped_keys.rs:176-245`, `management/accounts.rs:868-878`, `management/scalars.rs:66-76`, `management/store.rs:149-166` (후속 상대 경로도 `P/crates/gateway/src/`).
- **조건·영향:** key 수정·삭제, binding 저장 및 scalar 편집에서 `settings.mutate`를 직접 실행한다. 파일 저장·동기화가 느리면 Tokio worker를 점유해 중계 지연에 영향을 준다. 실제 지연 크기는 측정하지 않았다.
- **해결:** handler가 소유한 입력과 Arc를 blocking 작업에 넘기고 완료를 await한다. 일부 신규 handler만 적용하지 말고 공통 편집 경로의 호출 문맥을 함께 수정한다.
- **회귀 검증:** 저장 진입을 신호로 잡고 barrier로 완료를 제어해, 저장 중 독립 요청이 진행되는지 확인한다. sleep 기반 성능 단언은 피한다.

### R16 · P2 · 공유 키 secret 회전 시 누적 사용량이 유지되지 않는다

- **근거:** `P/crates/gateway/src/management/scoped_keys.rs:183-193`, `P/crates/gateway/src/state.rs:104-118`.
- **조건·영향:** 같은 key ID의 raw key를 바꾸면 hash 식별자가 바뀐다. reconcile은 이전 항목을 hash로만 찾아 counter를 가져오므로 아직 영속화되지 않은 live usage를 잃을 수 있다. 관리자가 수행하는 회전 문제이며 일반 사용자가 임의 회전할 수 있다는 뜻은 아니다.
- **해결:** 안정적인 key ID에 사용량 counter를 귀속하고 secret hash는 조회 인덱스로만 쓴다. 회전 시 진행 중 요청의 사용량도 같은 ID에 귀속해야 한다.
- **회귀 검증:** 사용량 적립 후 회전, 회전 도중 요청 완료, 재시작 각각에서 소비량이 보존되는지 확인한다.

### R17 · P2 · Windows의 HOME 미설정 시 인증 디렉터리가 현재 디렉터리에 만들어진다

- **근거:** `D/crates/monitor-ui/src/main.rs:551-554,1627-1631`, `D/crates/monitor-ui/src/secrets.rs:112-118`.
- **조건·영향:** Windows에서 HOME 없이 USERPROFILE만 있으면 gateway/마스터 키는 `./.mahoquot/auth`, secrets 등은 USERPROFILE 기준을 사용한다. 실행 위치에 따라 설정이 갈라진다. macOS에서 재현한 문제는 아니다.
- **해결:** OS 홈 디렉터리 해석을 통일하고 찾을 수 없으면 오류로 처리한다. 작업 디렉터리 fallback으로 인증 상태를 생성하지 않는다.
- **회귀 검증:** 환경을 직접 전역 변경하는 병렬 테스트 대신 홈 해석 입력을 주입해 HOME/USERPROFILE/없음 조합을 검증한다.

### R18 · P2 · 외부 URL 열기가 macOS 명령에 고정돼 있다

- **근거:** `D/crates/monitor-ui/src/main.rs:1552-1562`.
- **조건·영향:** Linux/Windows에도 `open` 실행을 시도한다. 지원하는 opener가 없는 환경에서 OAuth·외부 문서 링크가 열리지 않는다.
- **해결:** 플랫폼 opener API를 사용하되 기존 HTTPS 제한은 유지한다. URL을 shell 문자열에 삽입하지 않는다.
- **회귀 검증:** 각 OS의 실제 패키지에서 mock HTTPS URL 열기를 확인한다. 이 리뷰 환경은 macOS여서 타 OS 실행 검증은 하지 않았다.

### R19 · P3 · 스트리밍 본문이 끝나기 전에 in-flight가 감소한다

- **근거:** `P/crates/gateway/src/relay.rs:1520-1521,1848-1863`, `P/crates/gateway/src/monitor.rs:123-131`.
- **조건·영향:** guard가 handle_relay 지역변수여서 Response 반환 시 drop된다. 본문을 전송 중이어도 in-flight 통계는 요청을 끝난 것으로 센다.
- **해결:** streaming body 또는 outcome이 guard를 소유하도록 해 EOF·오류·취소 시 해제한다. non-stream 응답은 기존 수명과 맞춘다.
- **회귀 검증:** 첫 chunk를 전달하고 upstream 완료를 보류한 동안 gauge가 1인지 확인하고 EOF와 client 취소 모두에서 0으로 복귀하는지 검사한다.

### R20 · P3 · 터널 상태 조회가 바이너리 전체 검증 또는 프로세스 실행을 반복한다

- **근거:** `D/crates/monitor-ui/src/tunnel.rs:60-74,402-430`.
- **조건·영향:** status는 mutex를 가진 채 managed binary 전체 read+SHA256, 또는 외부 `--version` 종료 대기를 수행한다. 반복 조회가 불필요한 작업을 만들며 외부 바이너리가 멈추면 상태 조회도 기다린다. 특정 바이너리 크기나 지연 수치는 측정하지 않았다.
- **해결:** 표시용 상태 조회와 실행 전 신뢰 검증을 분리한다. 표시 결과는 변경 감지로 갱신하고 검증 작업은 blocking 경로로 옮긴다. mtime 캐시만으로 실행 전 검증까지 생략하지 않는다.
- **회귀 검증:** 반복 status가 매번 전체 read/process 실행을 하지 않는지, 실제 실행 전 변조된 바이너리는 여전히 거부하는지 확인한다.

### R21 · P3 · 네이티브 그룹 quota의 상대 reset countdown이 빠진다

- **근거:** `D/crates/monitor-ui/src/stats.rs:275-293`.
- **조건·영향:** bucket에 `reset_after_seconds`만 있고 `reset_at_unix`가 없으면 reset 정보가 없어지는 반면 primary/secondary window는 관측 시각 기반 상대 계산을 한다.
- **해결:** bucket도 같은 시간 변환 정책을 사용한다. observed_at 없이 남은 시간을 지어내지 않는다.
- **회귀 검증:** 절대 reset 없음, 상대 3600초, 관측 후 60초 fixture에서 3540초를 표시하는지 검사한다.

### R22 · P3 · provider별 동일 이름 별칭이 조용히 덮어써진다

- **근거:** `P/crates/registry/src/lib.rs:1210-1219,1340-1344`, `P/crates/gateway/src/management/settings.rs:470-604`.
- **조건·영향:** provider 차원을 가진 별칭 규칙을 파싱하지만 저장은 alias ModelId 하나를 키로 삼는다. 두 provider가 같은 별칭을 정의하면 마지막 규칙만 남는다.
- **해결:** 우선 지원 계약을 명확히 한다. 글로벌 별칭만 지원할 경우 중복을 오류로 반환하고, provider별 별칭이 계약이면 저장·검증·해석 전 과정에 provider를 포함한다. 자료구조만 바꾸고 라우팅 해석을 그대로 두지 않는다.
- **회귀 검증:** 같은 별칭·다른 provider의 두 규칙이 명시적으로 거부되거나 각각 올바르게 해석되는지 확인한다. 조용한 덮어쓰기는 허용하지 않는다.

## 프로토콜·프로바이더 추가 발견 사항

### R23 · P1 · Anthropic 스트림의 첫 블록 번호가 1이 될 수 있다

- **근거:** `P/crates/gateway/src/compat/claude.rs:682-694,716-765,785-799,834-847`.
- **조건·영향:** text는 index 0에 고정하고 thinking/tool은 1부터 할당한다. thinking 또는 tool이 먼저 나오면 0번 블록 없이 1번이 시작된다. 이후 text가 나오면 인덱스 순서도 역전된다. content 배열의 순서대로 블록을 조립하는 클라이언트와 호환되지 않는다. 특정 SDK 버전의 예외 메시지는 이 리뷰에서 재현하지 않았다.
- **해결:** text·thinking·tool 모두 실제 생성 순서대로 0부터 인덱스를 할당한다. 한 번 닫힌 text가 다시 열릴 때도 이전 0번을 재사용하지 않는다.
- **회귀 검증:** thinking→text→tool, tool-only, text→tool→text의 SSE를 파싱해 start/delta/stop의 인덱스가 일관적인지 확인하고 실제 Anthropic SDK로 소비한다.

### R24 · P1 · Anthropic 도구 정의와 이전 호출 이력의 이름이 다르다

- **근거:** `P/crates/gateway/src/compat/claude.rs:294-307,325-339`.
- **조건·영향:** tools 정의에는 `anthropic_tool_name`으로 `custom_` 이름을 적용하지만 assistant tool_calls의 tool_use 이름은 원문 그대로 복사한다. 다음 대화 턴에서 `lookup` 호출 이력과 `custom_lookup` 정의가 어긋나 upstream 거절 또는 잘못된 도구 문맥을 유발한다.
- **해결:** 정의·이력·명시적 tool_choice에서 같은 이름 변환을 사용하고 응답 역변환과 대칭을 맞춘다. 이미 변환된 이름의 중복 prefix도 방지한다.
- **회귀 검증:** 도구 정의 → 모델 호출 → 도구 결과 → 후속 호출의 두 턴을 wire-level fixture로 검사한다. history의 tool_use.name과 tools.name이 일치해야 한다.

### R25 · P2 · 파일 이름에서 계정 ID를 유도할 때 비-Codex 계정이 충돌한다

- **근거:** `P/crates/providers/src/account.rs:119-132`, `P/crates/gateway/src/account.rs:1438-1452`.
- **조건·영향:** identity_slug가 없는 `claude-work.json`, `claude-personal.json`은 공통 helper가 마지막 하이픈 뒤를 무조건 제거해 모두 `claude`가 된다. ID 기반 조회·통계·스케줄링이 두 계정을 구분하지 못한다. 각 Arc의 refresh mutex가 실제 공유된다는 주장은 하지 않는다.
- **해결:** provider와 파일명 계약을 고려해 stable ID를 유도한다. suffix는 알려진 legacy plan suffix인 경우에만 제거한다. 기존 설치 ID 변경은 binding·순서·통계에 영향을 주므로 migration을 설계하고 로드 시 중복 ID를 명시적으로 거부한다.
- **회귀 검증:** 같은 provider의 두 파일, 하이픈 포함 계정명, explicit slug와 legacy Codex 파일명으로 전체 pool을 로드해 ID 유일성과 기존 binding 보존을 확인한다.

### R26 · P2 · Cursor 요청 끝의 system 메시지가 사용자 질문을 대체한다

- **근거:** `P/crates/gateway/src/compat/cursor.rs:19-28,55-74`.
- **조건·영향:** `[user, system]`처럼 system/developer가 마지막에 있으면 text는 전체 messages.last에서 가져오고 history는 conversational 마지막 항목을 버린다. 사용자 질문은 빠지고 system이 사용자 text로 들어간다.
- **해결:** 현재 턴 text와 history 분할을 같은 conversational 목록에서 계산한다. root prompt는 별도로 유지한다.
- **회귀 검증:** 앞·뒤·중간에 system/developer가 있는 요청의 protobuf를 decode해 사용자 질문이 한 번만 나타나고 root prompt와 분리되는지 확인한다.

### R27 · P2 · Kiro 스트림 오류 payload가 성공 종료로 바뀔 수 있다

- **근거:** `P/crates/gateway/src/compat/kiro.rs:294-345`.
- **조건·영향:** `__type`/error 형태의 JSON을 받으면 처리 branch가 없어 버리고 finish가 Completed를 만든다. 명시적 오류가 빈 성공처럼 보일 수 있다. 실제 AWS event-stream framing fixture와의 최종 통합 검증은 필요하다.
- **해결:** 지원하는 upstream 오류 envelope를 명시적으로 decode해 Failed로 전달한다. 임의의 `message` 필드만으로 정상 이벤트를 오류 처리하지 않는다. 이미 downstream에 헤더/바이트를 보냈으면 재시도하지 말고 프로토콜 오류 이벤트로 종료한다.
- **회귀 검증:** 정상·오류 event-stream fixture와 chunk 분할을 검증한다. 오류 뒤에 성공 Completed가 나오지 않아야 한다.

### R28 · P2 · Anthropic/OpenAI 변환이 tool_choice를 버린다

- **근거:** `P/crates/gateway/src/compat/claude.rs:213-245,340-365`.
- **조건·영향:** required 또는 이름 지정 도구 선택이 출력 요청에 반영되지 않아 모델이 도구를 쓰지 않아도 되는 요청으로 변한다.
- **해결:** 양방향 auto/required/none/이름 지정 선택을 각 API 계약에 맞게 변환하고 지원하지 않는 조합은 명시적으로 거부한다. 이름 변환은 R24와 공유한다.
- **회귀 검증:** 입력 선택값별 출력 JSON 구조를 검사하고 mock upstream에서 도구 강제 조건이 보존되는지 확인한다.

## 릴리스·도구·사이트 발견 사항

### R29 · P1 · Windows 프록시 릴리스가 없는 tar.gz의 checksum을 계산한다

- **근거:** `P/.github/workflows/release.yml:45-60`.
- **조건·영향:** Windows branch는 zip을 만들고 checksum까지 계산하지만 분기 이후 공통 코드가 tar.gz를 다시 해시한다. 생성하지 않은 파일 때문에 packaging step이 실패한다.
- **해결:** OS별 산출물 이름을 하나의 변수로 정하고 그 파일만 한 번 해시·업로드한다.
- **회귀 검증:** 네트워크 없는 임시 디렉터리에서 Windows/Unix 분기 각각을 실행해 실제 생성한 파일만 checksum 대상인지 확인하고 Windows CI에서도 검증한다.

### R30 · P1 · 데스크톱 updater manifest를 릴리스 workflow가 생성하지 않는다

- **근거:** `D/.github/workflows/release.yml:57-84`, `D/crates/monitor-ui/tauri.conf.json:81-87`.
- **조건·영향:** 앱은 release root의 latest.json을 요청하지만 workflow는 bundle artifact만 업로드하고 manifest를 합성하지 않는다. 이 workflow만으로 만든 릴리스는 updater endpoint 계약을 충족하지 않는다. 외부에서 수동 업로드한 실제 release asset 유무는 확인하지 않았다.
- **해결:** 플랫폼별 bundle URL·signature·version을 수집해 latest.json을 생성·검증하고 release root에 포함한다. 서명 파일의 존재뿐 아니라 대응 bundle과 일치하는지 검사한다.
- **회귀 검증:** fixture 산출물로 manifest를 생성하고 Tauri updater가 기대하는 platform key와 서명을 검증한다. staging release에서 실제 update check까지 확인한다.

### R31 · P2 · setup과 build가 서로 다른 프록시 체크아웃을 선택한다

- **근거:** `D/scripts/setup-gateway.sh:20-27`, `D/crates/monitor-ui/build.rs:67-101` 및 위 기준 HEAD 표.
- **조건·영향:** 두 디렉터리가 있으면 setup은 내부 submodule, build는 형제 저장소를 우선한다. 실제 두 HEAD가 달라 빌드 명령에 따라 다른 백엔드를 검증·stage할 수 있다. 뒤따르는 build.rs가 sidecar를 다시 stage할 수 있으므로 setup 결과가 항상 최종 배포된다고 단정하지 않는다.
- **해결:** 환경 override·경로 파일·fallback 순서를 통일하고 선택 경로와 commit을 build evidence에 기록한다. submodule은 검증된 릴리스 버전으로 명시적으로 갱신한다. 개발 중 두 HEAD가 다르다는 이유만으로 모든 검증을 실패시키지는 않는다.
- **회귀 검증:** 한 디렉터리만 존재/둘 다 존재/override 존재의 fixture에서 setup과 build가 같은 경로를 고르는지 검사한다.

### R32 · P2 · 카탈로그 두 번째 배포부터 orphan branch push가 거절된다

- **근거:** `P/.github/workflows/model-catalog.yml:113-127`.
- **조건·영향:** 매번 orphan root commit을 만들고 기존 remote branch로 일반 push한다. 이미 branch가 있으면 non-fast-forward로 실패한다.
- **해결:** 기존 publication branch를 fetch해 그 위에 새 commit을 만드는 방식을 우선한다. 최신본만 유지하는 계약이라면 expected remote OID를 고정한 force-with-lease와 배포 concurrency 제어를 명시적으로 설계한다. 무조건 force push를 기본 해결로 권하지 않는다.
- **회귀 검증:** 임시 bare remote에 두 번 연속 publication하고 버전 단조성과 두 번째 성공을 검사한다. 실제 origin에는 push하지 않는다.

### R33 · P2 · QA 스크립트의 저장소 경로가 작성자 컴퓨터에 고정돼 있다

- **근거:** `P/scripts/run-task-17-gates.py:21-22`, `P/scripts/task-17-qa-driver.py:38-39`.
- **조건·영향:** `/Users/indo/code/project/...`를 cwd 및 출력 루트로 사용한다. 다른 checkout에서 실행하면 잘못된 저장소를 검증하거나 경로 오류를 낸다.
- **해결:** 스크립트 위치로 proxy root를 구하고 desktop root는 명시적 인자/환경값과 검증된 기본값으로 해석한다. 실행 전에 선택 경로를 출력하고 쓰기 작업 전에 유효성을 확인한다.
- **회귀 검증:** 이름·위치가 다른 임시 checkout에서 dry-run으로 cwd와 evidence 출력 위치를 확인한다.

### R34 · P3 · 사이트 quickstart가 데스크톱 저장소에서 실행할 수 없는 패키지를 안내한다

- **근거:** `D/site/src/content/site.ts:7,143-147`, `D/Cargo.toml:1-5`.
- **조건·영향:** 링크된 mahoquot 저장소를 받은 사용자가 `cargo run -p mahoquot-gateway`를 실행하면 해당 workspace member가 없어 실패한다.
- **해결:** desktop 실행과 proxy 실행 안내를 구분하고 필요한 저장소·작업 디렉터리를 명시한다.
- **회귀 검증:** 깨끗한 checkout에서 문서의 명령을 실제 실행한다. 자연어 문구를 고정하는 테스트는 추가하지 않는다.

### R35 · P3 · CI가 사이트 build와 최신 데스크톱 bundle 동작을 검증하지 않는다

- **근거:** `D/.github/workflows/ci.yml:12-49`.
- **조건·영향:** 현재 CI는 native와 frontend typecheck/lint/unit까지이고 site build 및 frontend build→E2E가 없다. 소스 테스트가 통과해도 배포 site 오류나 오래된 bundle 기반 동작을 놓칠 수 있다.
- **해결:** site build/typecheck와 관련 browser gate, frontend build 후 E2E를 독립 gate로 추가한다. freshness 검사는 단순 수정 시각이 아니라 재생성한 산출물과 계약을 검사한다.
- **회귀 검증:** 해당 경로가 변경된 PR에서 관련 gate가 실제 실행되는지 workflow 로그로 확인한다.

## 리뷰 범위와 한계

여섯 영역을 병렬로 나눠 검토한 뒤 위 발견 사항은 상위 리뷰에서 원문과 호출 경로를 다시 확인했다. 전체 제품 영역을 대상으로 한 리뷰이지 모든 코드 줄과 모든 입력 조합의 무결함 보증은 아니다.

| 영역 | 검토한 주요 소스·경계 |
|---|---|
| 네이티브 | `main.rs`, gateway_process, tray/notch/platform, bootstrap, cli_config, codex_launcher, secrets, tunnel, stats, os_integration, self_certification, Tauri/build 설정 및 native tests |
| 프런트엔드 | App, 모든 hooks/lib, Accounts/Agents/Settings/Overview/Logs/Notch/Tray, 공유 키·TOTP·Codex·터널 UI, 공통 primitives, dither-kit 차트, 스타일 및 unit/e2e 코드 |
| 프록시 실행 | server/state/runtime_state, inbound/routes/cp_routes, relay, models/v1beta/realtime, scheduler/router/types, account/quota/usage/capability/warmup |
| 관리·저장 | management 전체, registry manager/cache/domain/envelope, signing 도구, history/telemetry/metrics/monitor, 설정 영속화와 scoped key |
| 프로바이더·변환 | providers의 credential·refresh·provider별 모듈, compat의 OpenAI/Anthropic/Gemini/Cursor/Kiro/Responses 변환·stream renderer·signature ledger와 관련 tests |
| 전달·사이트 | 두 저장소 CI/release/catalog workflow, setup/verify/parity/QA/benchmark 도구, docs 계약, site source/config/browser tests, static_pages와 공유 UI bundle 관계 |

생성 schema·minified bundle·이미지·외부 의존성은 authored source와 같은 깊이로 줄별 리뷰하지 않았다. 동작의 권위는 authored source에 두고 빌드·동기화 경계를 확인했다. 내부 submodule 전체를 형제 proxy와 별개로 다시 리뷰한 것은 아니다.

## 실행한 검증

검증은 리뷰 중 약 17:07 KST에 시작한 작업 트리 기준이다. 이후 동시 수정까지 모두 검증했다는 의미는 아니다.

| 명령 | 위치 | 결과 |
|---|---|---|
| `cargo test --workspace` | D | exit 0, 93 passed |
| `bun run typecheck` | D/crates/monitor-ui/frontend | exit 0 |
| `bun run test` | D/crates/monitor-ui/frontend | exit 0, 36 files / 289 tests passed |
| `cargo test --workspace` | P | exit 101, 첫 실패에서 중단 |
| `cargo test --workspace --no-fail-fast` | P | exit 101, 전체 합산 664 passed / 2 failed / 0 ignored |

프런트 테스트에는 React `act(...)` 경고가 남았다. 테스트 종료 코드가 성공이라는 사실과 경고가 없다는 주장은 구분한다. 네이티브 테스트 build script는 gateway debug 빌드·sidecar staging도 실행했다.

### 실패한 기존 테스트의 판단

1. `P/crates/gateway/tests/t17_account_lifecycle.rs:87`: `disabled_credentials_leave_and_rejoin_the_pool`에서 stats accounts 길이 expected 0 / actual 1.
2. `P/crates/gateway/tests/t25_account_management.rs:651`: `bulk_status_order_and_manual_priority_persist_across_restart`에서 `find_member("alpha").is_none()` 실패.

`account.rs:1464-1472`는 disabled credential을 `Health::Disabled`로 로드해 상태·통계를 보존한다. `find_member`는 identity 조회이지 사용 가능한 계정만의 조회가 아니다. 따라서 위 실패만으로 비활성 계정이 추론 요청을 처리한다고 결론 내리면 안 된다.

**수정 방향:** 테스트를 삭제하거나 약화하지 말고 비활성 상태 보존, 모델 목록 제외, mock upstream에 요청이 가지 않음, 재활성화 후 counters 보존을 함께 검증하도록 계약을 갱신한다. 현 상태에서 프록시 게이트는 실패이며 리뷰에서는 이를 수정하지 않았다.

### 실행하지 않은 검증

- 제품 수정 없는 리뷰이므로 프런트 bundle 재생성, 배포·설치, 실제 provider 호출은 수행하지 않았다.
- desktop/browser E2E, 마케팅 사이트 build/browser 검사, 릴리스 패키지, Windows/Linux 실행, 다중 모니터 실측은 수행하지 않았다. 기존 bundled HTML이 현재 동시 수정 소스와 일치한다고 보증하지 않는다.
- LSP 호출은 daemon socket 연결 실패로 사용할 수 없었다. 따라서 전체 LSP 무오류라고 보고하지 않으며 위 컴파일·타입검사 결과만 채택한다.

## 오탐으로 제외하거나 추가 검증이 필요한 항목

- **마스터 키 없는 open mode:** 무인증 요청도 Master를 부여하는 명시적 모드다. 잘못된 키만 거부해도 header를 빼면 같은 권한이므로 독립적인 권한 상승 결함으로 세지 않았다. 외부 공개 시 마스터 키 설정 여부를 배포 계약으로 검증해야 한다. R01은 이 모드와 무관하다.
- **시작 시 카탈로그 설정 미적용:** 현재 `state.rs:302-310`에 `validate_against_registry`가 있어 일반적인 미적용 주장은 제외했다. R03/R04의 갱신·삭제 경로는 별개다.
- **macOS 다중 모니터 좌표:** Tauri 좌표와 AppKit 좌표 혼용 우려가 있으나 혼합 DPI/상하 배치 실측이 없다. NSScreen과 창 bounds를 함께 기록한 후 판단한다. 검증되지 않은 Y 반전 공식을 그대로 적용하지 않는다.
- **AuthIsolated 알림:** production caller가 첫 isolated 계정 하나를 대표 상태로 관찰한다. 다중 계정 알림 요구가 확정되지 않아 동일 kind dedupe를 버그로 세지 않았다.
- **Codex auth.json 권한:** 해당 파일은 account_id만 저장한다. 이를 bearer token 노출이라고 표현하지 않는다.
- **scoped key 클라이언트 raw_key 타입 누락:** 실제 UI 호출자가 없는 API 확장 가능성만으로 사용자 기능 결함으로 세지 않았다. 회전 UI를 구현할 때 계약을 맞춘다.
- **Prometheus 기본 counters 누락:** 현재 metrics가 모든 GatewayMetrics 필드를 노출하지 않는다는 지적은 있으나 요구하는 metric 계약 확인이 부족해 확정 결함과 분리했다.
- **router affinity retain, 대용량 요청 메모리, Windows 경로 구분자:** 부하·플랫폼 검증이 없는 우려다. 처리량 수치나 악용 성공을 주장하지 않는다.
- **Gemini 병렬 tool signature:** 첫 호출에만 sentinel을 넣는 코드가 곧바로 프로토콜 위반인지 모델별 공식 계약과 실제 fixture 확인이 부족하다. 모든 호출에 sentinel을 강제로 넣는 수정안은 채택하지 않았다.
- **기타 provider 지적:** generic credential의 type 없는 refresh는 로더 허용 계약, legacy `render_anthropic_stream`의 도구 누락은 production caller 경로가 충분히 확정되지 않아 본문 결함으로 세지 않았다. Cursor heartbeat 수명·Vertex 지역 endpoint도 별도 재현이 필요하다.
- **sidecar staging 위치:** release workflow는 root gateways에 복사하지만 `build.rs:276-308`이 crate gateways로 자동 stage한다. workflow 경로 정리는 권장하되 이것만으로 릴리스가 반드시 실패한다고 보지 않았다.
- **route-set reference 파일:** 현재 `.omo/upstream/internal__api__server_management.go`는 존재했다. 항상 FileNotFound라는 지적은 제외했다. 깨끗한 checkout에서도 reference를 준비하는 절차가 필요하며, 없을 때 성공으로 skip해 parity 검증을 약화해서는 안 된다.
- **parity manifest의 missing 상태:** 구현 파일 존재나 unit 통과만으로 covered로 바꾸지 않는다. R02처럼 구현이 있어도 실제 통합이 깨진 기능이 있으므로 수용 조건별 증거로 갱신해야 한다.

## 권장 수정 순서

1. R01 인증 identity 전달과 R02 예약 URL 계약을 회귀 테스트로 고정한다.
2. R03/R04를 하나의 원본 카탈로그 + 로컬 설정 합성 경로로 해결한다.
3. R05/R06 quota·scheduler 복구, R07/R14/R16 데이터 보존 문제를 수정한다.
4. R08-R13 UI·관리 API 정확성과 R15 async 저장 경로를 수정한다.
5. 플랫폼별 R17/R18을 실제 패키지에서 확인하고 R19-R22 관측·표시·별칭 계약을 보완한다.
6. R23/R24/R25의 도구 호출·identity 손실을 우선 수정하고 R26-R28 변환을 wire fixture와 실제 SDK로 검증한다.
7. 다음 릴리스 전에 R29/R30/R32를 해결하고 R31/R33-R35로 빌드·검증·설치 안내를 일치시킨다.
8. 프록시의 두 기존 테스트를 새 비활성 계약에 맞는 더 강한 검증으로 갱신한 뒤 모든 게이트를 다시 실행한다. 프런트 수정 후에는 bundle을 재생성하고 E2E를 실행해야 한다.
