# API Usage Quota Service

멀티테넌트 프로젝트가 API Key를 발급·폐기하고, UTC 일일 사용량을 멱등하게 수집하면서 동시 요청에서도 쿼터 초과를 막는 NestJS/PostgreSQL 서비스입니다. 원문 Key는 발급 응답에서 한 번만 반환하며 HMAC-SHA-256 digest만 저장합니다.

## 보장 범위

- API Key scope 및 Project 격리, 활성 Key 20개 상한
- Project 범위 idempotency key와 저장된 terminal decision replay
- PostgreSQL 조건부 갱신을 이용한 quota 원자성
- Key 생명주기 감사 로그, 구조화 로그, 보호된 Prometheus metrics
- OpenAPI drift, PostgreSQL 통합·동시성·보안 테스트

세부 계약은 [API 계약](docs/specs/api-contract.md), [DB 명세](docs/specs/database-schema.md), [서비스 설계](docs/architecture/service-design.md), [ERD](docs/architecture/erd.md)를 참고합니다.

## 요구 환경

- Docker Engine과 Docker Compose v2 호환 CLI
- 로컬 검증 시 Node.js 24.16.0, npm 11.13.0

## Docker Compose 실행

`.env.example`을 `.env`로 복사하고 모든 `CHANGE_ME_*`를 서로 다른 난수로 교체합니다. 애플리케이션 secret은 256-bit 난수의 base64url(43자), DB password는 URI-safe hex/base64url을 권장합니다. `.env`나 출력된 API Key를 Git·shell history·로그에 남기지 마세요.

Bash:

```sh
cp .env.example .env
# 안전한 편집기로 .env의 모든 CHANGE_ME_*를 교체
docker compose config --quiet
docker compose up --build --wait
npm run test:smoke
```

PowerShell:

```powershell
Copy-Item .env.example .env
# 안전한 편집기로 .env의 모든 CHANGE_ME_*를 교체
docker compose config --quiet
docker compose up --build --wait
npm run test:smoke
```

Compose는 `postgres healthy → migrate completed → app healthy` 순서를 강제하고 host의 loopback interface에만 app port를 공개합니다. PostgreSQL 18 volume은 새 layout의 `/var/lib/postgresql`에 연결합니다. `.env.example`의 `SWAGGER_ENABLED=true`는 이 로컬 Compose 환경의 명시적 opt-in이며, Swagger UI는 `http://127.0.0.1:3000/docs`, 계약 JSON은 `/openapi.json`입니다.

`npm run test:smoke`, `demo`, `benchmark`는 로컬 `.env`를 읽고 `PORT`를 기본 접속 주소에 반영합니다. 다른 서버를 검증하려면 `BASE_URL`로 주소를 지정할 수 있으며, 이미 export한 환경 변수가 `.env`보다 우선합니다. smoke는 예제 설정처럼 Swagger가 활성화되어 있고 `METRICS_TOKEN`이 설정된 환경을 검증합니다. Stack은 아래 데모와 측정을 위해 계속 실행하고, 작업이 끝나면 마지막 정리 절차를 실행합니다.

## 데모

관리 token은 명령 인수가 아니라 환경 변수로만 전달합니다. PowerShell의 `curl`은 `Invoke-WebRequest` alias일 수 있으므로 REST 예시는 `curl.exe` 또는 `Invoke-RestMethod`를 명시적으로 사용하세요.

```sh
read -rsp 'System admin token: ' SYSTEM_ADMIN_TOKEN && echo
export SYSTEM_ADMIN_TOKEN
npm run demo
unset SYSTEM_ADMIN_TOKEN
```

```powershell
$adminSecret = Read-Host 'System admin token' -AsSecureString
$env:SYSTEM_ADMIN_TOKEN = [System.Net.NetworkCredential]::new('', $adminSecret).Password
npm run demo
Remove-Item Env:SYSTEM_ADMIN_TOKEN
Remove-Variable adminSecret
```

데모는 Project bootstrap, 보조 Key 생성·목록, 사용량 승인과 동일 idempotency replay, 일별 조회, 감사 조회, Key 폐기와 폐기 Key 거부를 검증합니다. 출력에는 credential을 포함하지 않습니다.

## 전체 검증

```sh
npm ci
npm run audit:runtime && npm run audit:all
DATABASE_URL='postgresql://generate:generate@127.0.0.1:5432/not-connected' npm run prisma:generate
npm run format:check && npm run lint && npm run typecheck
npm run test:unit && npm run test:scripts
npm run test:integration && npm run test:e2e && npm run test:concurrency
npm run test:contract && npm run test:security
npm run openapi:check && npm run docs:check && npm run build
```

실제 결과는 [테스트 보고서](docs/reports/test-report.md)에 기록합니다. CI는 static, postgres-tests, docker 세 job이며 benchmark는 수동 workflow로 분리합니다.

## 측정

벤치마크 전에는 일일 quota가 충분한 전용 Project/Key를 만들고 credential을 환경 변수에 둡니다. 고정 warmup과 worker당 요청 수, 각 HTTP status/decision을 검증합니다.

Bash:

```sh
read -rsp 'Benchmark API key: ' BENCHMARK_API_KEY && echo
export BENCHMARK_API_KEY
export APP_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "$(docker compose images -q app)")"
export POSTGRES_VERSION="$(docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SHOW server_version"')"
npm run --silent benchmark > benchmark.json
unset BENCHMARK_API_KEY APP_IMAGE_DIGEST POSTGRES_VERSION
COMMIT_SHA="$(git rev-parse HEAD)" docker compose run --rm --no-deps --no-TTY -e COMMIT_SHA --entrypoint node migrate scripts/explain-audit.mjs > explain-audit.json
```

PowerShell:

```powershell
$benchmarkSecret = Read-Host 'Benchmark API key' -AsSecureString
$env:BENCHMARK_API_KEY = [System.Net.NetworkCredential]::new('', $benchmarkSecret).Password
$appImage = docker compose images -q app
$env:APP_IMAGE_DIGEST = docker image inspect --format '{{.Id}}' $appImage
$env:POSTGRES_VERSION = docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SHOW server_version"'
npm run --silent benchmark | Set-Content -Encoding utf8 benchmark.json
$env:COMMIT_SHA = git rev-parse HEAD
docker compose run --rm --no-deps --no-TTY -e COMMIT_SHA --entrypoint node migrate scripts/explain-audit.mjs | Set-Content -Encoding utf8 explain-audit.json
Remove-Item Env:BENCHMARK_API_KEY,Env:APP_IMAGE_DIGEST,Env:POSTGRES_VERSION
Remove-Item Env:COMMIT_SHA
Remove-Variable benchmarkSecret
```

측정 방법과 실측값은 [벤치마크 보고서](docs/reports/benchmark-report.md)에만 기록하며 측정하지 않은 수치를 만들지 않습니다.

## 로컬 Stack 정리

데모와 측정까지 마쳤거나 smoke만 확인한 경우 다음 명령으로 이 Compose project의 container, network, volume을 제거합니다. 기본 project name은 디렉터리 이름을 사용합니다. 같은 이름의 clone이나 여러 작업을 동시에 실행할 때는 각 shell에서 서로 다른 `COMPOSE_PROJECT_NAME`을 지정하고, 정리할 때도 같은 값을 유지하세요.

```sh
docker compose down --volumes --remove-orphans
```

## 설계 기록과 한계

- [ADR 0001: PostgreSQL 조건부 쿼터](docs/adr/0001-postgresql-conditional-quota.md)
- [ADR 0002: API Key HMAC 저장](docs/adr/0002-api-key-hmac-storage.md)
- [ADR 0003: Project 범위 멱등성](docs/adr/0003-project-idempotency-scope.md)
- [알려진 제한](docs/known-limitations.md)
- [기여·Git 운영 규칙](CONTRIBUTING.md)
