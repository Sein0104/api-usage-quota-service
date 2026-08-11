# API Usage Metering and Quota Service Design

## 문서 관계

- 이 문서: 범위, 아키텍처, 보장과 trade-off
- [`API Contract`](./2026-08-11-api-contract-spec.md): HTTP 인증, DTO, 성공·오류 schema, pagination, idempotency replay
- [`Database Schema`](./2026-08-11-database-schema-spec.md): PostgreSQL type, constraint, FK, index, transaction, Prisma/raw SQL 경계

세 문서가 충돌하면 구현을 시작하기 전에 함께 수정한다. 실제 dependency patch version은 `package.json`과 lockfile, 실행 이미지는 Docker tag/digest, 실제 schema는 review된 migration을 단일 진실 공급원으로 사용한다.

## 1. 목적

이 프로젝트는 여러 고객 프로젝트가 API Key로 인증하고, 일일 사용량을 기록하며, 설정된 쿼터를 초과한 요청을 정확히 거절하는 소형 백엔드 서비스다.

포트폴리오에서 다음 역량을 개인 저장소의 코드·테스트·운영 산출물로 독립적으로 증명하는 것이 목표다. 멱등성과 동시성 자체를 새 기술처럼 내세우기보다, 이를 실제 HTTP API의 인증·tenant 격리·데이터 제약·운영 계약까지 완결하는 업무 사례로 사용한다.

- HTTP 인증·인가, API Key 생명주기와 일관된 오류 계약
- PostgreSQL 관계 제약을 포함한 멀티테넌트 데이터 모델링
- 멱등한 요청 처리와 동시성 안전한 쿼터 차감
- 실제 PostgreSQL을 사용하는 통합·동시성 테스트
- 감사 로그, 구조화 로그, 메트릭, 상태 점검
- Docker 기반 재현 환경과 GitHub Actions CI

프로젝트의 핵심은 기능 수가 아니라 다음 두 보장을 코드와 테스트로 증명하는 것이다.

1. 같은 사용량 요청은 재시도되어도 한 번만 집계된다.
2. 동시 요청이 몰려도 일일 쿼터를 초과해 허용되지 않는다.

## 2. 범위

### 포함

- 시스템 관리자 토큰으로 Project 생성
- Project 관리자 API Key 최초 발급
- Project 관리자 Key로 하위 API Key 발급·목록 조회·폐기
- API Key별 `usage:write`, `usage:read`, `keys:manage`, `audit:read` scope
- API Key 인증을 거친 사용량 이벤트 수집
- Project 단위 UTC 일일 쿼터 적용
- `Idempotency-Key` 기반 중복 요청 처리
- 일별 사용량과 남은 쿼터 조회
- Project 생성 audit에 최초 Key 발급 근거를 포함하고, 이후 Key 생성·폐기는 별도 audit log로 기록
- JSON 구조화 로그, Prometheus 메트릭, health/readiness endpoint
- Swagger/OpenAPI 문서
- Docker Compose와 GitHub Actions

### 제외

- 회원가입, 비밀번호 로그인, 소셜 로그인, OAuth 서버
- 프런트엔드와 관리자 대시보드
- 실제 결제, 요금제, 월별 청구서
- 외부 API로 요청을 전달하는 reverse proxy
- 분·시간 단위 rate limit, token bucket 등 여러 제한 알고리즘
- Redis, Kafka, Kubernetes, 마이크로서비스
- PostgreSQL RLS
- 사용자별 시간대와 일광절약시간 처리
- Project 삭제, 자동 보존·정리 job, 외부 abuse 방지

쿼터는 Project 생성 시 정한 고정 일일 한도이며 MVP에서는 변경하지 않는다. 사용량 날짜는 클라이언트가 보낸 시간이 아니라 애플리케이션 진입 시 한 번 캡처한 `received_at`의 UTC 날짜로 결정한다. usage event와 audit log는 MVP 데이터셋 수명 동안 삭제하지 않으며, 이 선택에 따른 저장 공간 증가와 production 보존 정책의 필요성을 README의 한계로 명시한다.

## 3. 기술 선택

- Runtime: Node.js 24 LTS, TypeScript 5.9
- Framework: NestJS 11, Express adapter
- Database: PostgreSQL 18
- Data access: Prisma ORM 7과 `@prisma/adapter-pg`를 사용하되, 쿼터의 조건부 원자 갱신은 명시적 SQL로 구현
- API documentation: NestJS Swagger
- Tests: Jest, Supertest, Testcontainers
- Metrics: Prometheus 형식의 `/metrics`
- Local environment: Docker, Docker Compose
- CI: GitHub Actions

### Toolchain baseline

- package manager는 npm 11이고 `packageManager` field와 `package-lock.json`을 commit하며 CI는 `npm ci`만 사용한다.
- package는 ESM(`"type": "module"`)으로 구성한다. TypeScript는 `target=ES2023`, `module=NodeNext`, `moduleResolution=NodeNext`, `strict=true`를 사용하고 내부 상대 import에 `.js` 확장자를 쓴다.
- Nest CLI의 TypeScript build와 Swagger CLI plugin의 `esmCompatible=true` 설정을 사용한다.
- Jest는 ESM 설정의 `ts-jest` transformer와 Node `--experimental-vm-modules`로 실행한다.
- exact dependency version은 `package.json`과 lockfile에 고정한다. 설계 문서에는 호환 major만 기록한다.
- Node major는 `.node-version`과 `package.json#engines`, PostgreSQL major는 Compose와 Testcontainers에 동일하게 고정한다.
- DTO validation은 `class-validator`·`class-transformer`와 global `ValidationPipe`의 whitelist/unknown-field 거절을 사용한다.
- 환경 변수는 `@nestjs/config`와 Joi schema로 시작 시 fail-fast 검증한다.
- 구조화 로그는 `nestjs-pino`·`pino`와 credential redaction, metric은 `prom-client`, health는 `@nestjs/terminus`를 사용한다.
- PostgreSQL Testcontainers package는 `@testcontainers/postgresql`을 사용한다.
- Prisma 7은 `prisma-client` generator의 `output=../src/generated/prisma`, `moduleFormat=esm`, `runtime=nodejs`를 사용한다. `prisma.config.ts`가 datasource URL을 읽고 build·test 전에 `prisma generate`를 실행한다.
- runtime은 `pg.Pool`과 `PrismaPg` adapter를 `new PrismaClient({adapter})`에 주입한다. 기본 pool은 max 10, connection timeout 3초, idle timeout 30초이며 shutdown 시 Prisma와 pool을 모두 닫는다.
- Prisma `BigInt`는 API mapper에서 공개 범위를 검사한 뒤 JSON number로 변환한다.
- lint와 format은 ESLint·Prettier를 사용하고 CI는 `format:check`, `lint`, `typecheck`를 별도 실행한다.
- 기본 HTTP port는 `3000`이며 Nest shutdown hook으로 graceful shutdown한다.

필수 환경 변수는 `NODE_ENV`, `PORT`, `DATABASE_URL`, `SYSTEM_ADMIN_TOKEN`, `API_KEY_PEPPER`, `LOG_LEVEL`, `TZ=UTC`다. 두 secret은 최소 256-bit 난수여야 하며 validation 실패 시 server를 시작하지 않는다. 실제 값은 `.env`, 로그, example 파일, Git에 기록하지 않는다.

기준 major는 2026-08-11의 공식 지원 상태를 따른다: [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases), [NestJS 11 release](https://github.com/nestjs/nest/releases), [Prisma ORM 7](https://www.prisma.io/docs/orm), [PostgreSQL 18](https://www.postgresql.org/docs/18/).

Redis를 사용하지 않는다. 단일 PostgreSQL 트랜잭션 안에서 멱등성 레코드와 쿼터 갱신을 함께 처리하면, 별도 저장소 간 정합성 문제 없이 핵심 보장을 증명할 수 있기 때문이다.

## 4. 아키텍처

하나의 NestJS 애플리케이션과 하나의 PostgreSQL로 구성된 모듈러 모놀리스로 시작한다.

```text
Client
  |
  v
NestJS API
  |- SystemAdminModule
  |- ProjectsModule
  |- ApiKeysModule
  |- UsageModule
  |- AuditModule
  |- ObservabilityModule
  |
  v
PostgreSQL
```

### 모듈 책임

#### SystemAdminModule

- 환경 변수의 시스템 관리자 토큰 검증
- 최초 Project 생성과 Project 관리자 Key 발급
- 일반 API Key 인증과 분리된 부트스트랩 경계 제공

#### ProjectsModule

- Project 생성 결과와 고정 일일 쿼터 관리
- API 요청에서 Project ID를 헤더나 body로 신뢰하지 않음
- 인증된 Key의 Project를 tenant 문맥으로 사용

#### ApiKeysModule

- 고엔트로피 API Key 생성
- Key prefix와 secret digest 저장
- 원문 Key는 발급 응답에서 한 번만 제공
- scope 검사와 폐기 상태 검사
- Key 목록에는 공개 ID, name, prefix, scope, 상태, 생성·폐기 시각만 노출
- Project별 활성 Key를 최대 20개로 제한

#### UsageModule

- 사용량 이벤트 validation
- `Idempotency-Key` 충돌·재사용 처리
- 일일 쿼터 조건부 원자 갱신
- 일별 사용량 조회
- 허용·거절 결정을 동일 트랜잭션에서 기록

#### AuditModule

- Project 생성과 최초 Key 발급은 하나의 `PROJECT_CREATED` audit에, 이후 Key 생성·폐기는 별도 audit에 기록
- 인증 전 실패와 scope 거절은 영속 audit row 대신 구조화 보안 로그와 metric으로 기록
- 쿼터 거절은 `usage_events`를 근거 기록으로 사용해 중복 audit row를 만들지 않음
- 원문 API Key와 민감한 요청 payload를 기록하지 않음

#### ObservabilityModule

- request ID 생성·전파
- JSON 구조화 로그
- Prometheus 메트릭
- liveness와 readiness endpoint

## 5. 데이터 모델

### `projects`

| 필드 | 설명 |
|---|---|
| `id` | UUID PK |
| `name` | 표시 이름 |
| `daily_quota_units` | UTC 일일 허용량, `1..1,000,000,000` |
| `created_at` | 생성 시각 |

수량 컬럼은 PostgreSQL `bigint`를 사용하고 범위를 `CHECK` 제약으로 강제한다.

### `api_keys`

| 필드 | 설명 |
|---|---|
| `id` | UUID PK, 공개 Key ID로 사용 |
| `project_id` | 소속 Project FK |
| `name` | 사람이 식별할 수 있는 Key 이름 |
| `prefix` | 목록과 로그에 노출 가능한 짧은 식별자 |
| `secret_digest` | 서버 pepper를 사용한 HMAC-SHA-256 digest |
| `scopes` | 허용된 scope 집합 |
| `status` | `ACTIVE` 또는 `REVOKED` |
| `created_at` | 생성 시각 |
| `revoked_at` | 폐기 시각, nullable |

API Key 형식은 `mq_<key-id>.<random-secret>`로 한다. secret은 CSPRNG로 생성한 최소 256-bit 값이다. `key-id`로 레코드를 조회하고, secret의 HMAC digest를 constant-time 비교한다. 원문 secret과 pepper는 DB 및 로그에 저장하지 않는다. `scopes`는 PostgreSQL text array로 저장하되 애플리케이션과 DB 제약에서 허용된 enum 값만 받는다. 복합 FK의 기준이 되도록 `(project_id, id)`에도 unique constraint를 두고, 목록 조회용 `(project_id, created_at DESC, id DESC)` 인덱스를 둔다.

### `usage_events`

| 필드 | 설명 |
|---|---|
| `id` | UUID PK |
| `project_id` | Project FK |
| `api_key_id` | 요청한 Key FK |
| `idempotency_key` | 클라이언트 요청 식별자 |
| `payload_hash` | 동일 키·상이한 payload 탐지 |
| `usage_date` | 서버 수신 시각의 UTC 날짜 |
| `units` | 요청 사용량, `1..10,000` |
| `decision` | 내부 상태 `PENDING`, 최종 상태 `ACCEPTED` 또는 `QUOTA_EXCEEDED` |
| `response_status` | `200` 또는 `429`, 최종 상태에서 필수 |
| `quota_limit_units` | 결정 시점 일일 한도 snapshot, 최종 상태에서 필수 |
| `quota_remaining_units` | 결정 직후 잔여량 snapshot, 최종 상태에서 필수 |
| `quota_reset_at` | 다음 UTC 일일 경계, 최종 상태에서 필수 |
| `received_at` | 애플리케이션 진입 시 한 번 캡처한 시각 |
| `finalized_at` | 최종 결정 시각, `PENDING`일 때 nullable |

`(project_id, idempotency_key)`에 unique constraint를 둔다. `(project_id, api_key_id)`는 `api_keys(project_id, id)`를 참조하는 복합 FK로 만들어 다른 Project의 Key를 연결할 수 없게 한다. MVP에서는 idempotency record를 만료시키지 않으므로 같은 Project에서 해당 Key를 영구 재사용할 수 없다. `PENDING`은 트랜잭션 내부 상태이며 정상 API 응답으로 노출하거나 성공적으로 commit한 뒤 남겨 두지 않는다. DB `CHECK` 제약으로 `PENDING`이면 응답 snapshot과 `finalized_at`이 모두 null이고, 최종 상태면 모두 non-null임을 강제한다.

### `daily_usage`

| 필드 | 설명 |
|---|---|
| `project_id` | Project FK |
| `usage_date` | UTC 날짜 |
| `used_units` | 허용된 누적 사용량 |
| `limit_units` | 해당 날짜에 고정된 한도 snapshot |
| `updated_at` | 마지막 갱신 시각 |

PK는 `(project_id, usage_date)`다. `used_units`와 `limit_units`는 `bigint`이고 `0 <= used_units <= limit_units`를 DB `CHECK`로 강제한다. Project 쿼터가 MVP에서 변경되지 않더라도 한도 snapshot을 저장해 결정 근거를 명시적으로 남긴다.

### `audit_logs`

| 필드 | 설명 |
|---|---|
| `id` | UUID PK |
| `project_id` | 관련 Project FK |
| `actor_key_id` | 행위 주체 API Key, nullable |
| `action` | 행위 종류 |
| `resource_api_key_id` | API Key action의 대상 Key, Project 생성이면 nullable |
| `request_id` | 요청 추적 ID |
| `metadata` | 민감정보를 제거한 JSONB |
| `created_at` | 기록 시각 |

`actor_key_id`와 `resource_api_key_id`가 있을 때 각각 `(project_id, key_id)` 복합 FK로 `api_keys(project_id, id)`를 참조한다. API 응답의 `resourceType`과 `resourceId`는 `action`, `project_id`, `resource_api_key_id`에서 파생한다. `(project_id, created_at DESC, id DESC)`에 cursor 조회 인덱스를 둔다.

MVP는 PostgreSQL RLS를 사용하지 않는다. tenant 접근 권한은 인증된 Key에서 Project 문맥을 만들고 모든 query에 이를 강제하는 애플리케이션 계층이 담당하며, 복합 FK는 저장 데이터의 교차 tenant 참조만 차단한다.

## 6. API 계약

일반 JSON API 오류는 RFC 9457 Problem Details 형식을 따르며 `type`, `title`, `status`, `detail`, `code`, `requestId`를 포함한다. 쿼터 거절에는 `eventId`, `usageDate`, quota snapshot을 extension으로 추가한다. 단순한 container probe 호환성을 위해 health endpoint의 `503`은 `{"status":"not_ready"}` 예외를 사용한다.

### 시스템 관리

#### `POST /v1/admin/projects`

- 인증: `Authorization: Bearer <SYSTEM_ADMIN_TOKEN>`
- 입력: Project 이름 (`1..100`자)과 일일 쿼터 (`1..1,000,000,000` 정수)
- 출력: `201`과 Project, 최초 Project 관리자 API Key 원문
- 원문 Key는 이 응답에서만 반환
- 시스템 관리자 토큰은 최소 256-bit 난수로 생성해 환경 변수로 주입하고, 로그에 남기지 않으며 constant-time으로 비교
- 최초 관리자 Key에는 네 scope를 모두 부여

### API Key 관리

#### `POST /v1/api-keys`

- 필요 scope: `keys:manage`
- 입력: Key 이름 (`1..100`자)과 비어 있지 않은 허용 scope 집합
- 출력: `201`과 Key metadata, 원문 Key
- Project에 활성 Key가 이미 20개면 `409 ACTIVE_KEY_LIMIT_REACHED`

#### `GET /v1/api-keys?cursor=...&limit=...`

- 필요 scope: `keys:manage`
- 출력: 현재 Project의 Key metadata cursor 목록
- 기본 page size 50, 최대 100
- 정렬은 `(created_at DESC, id DESC)`, cursor는 이 두 값을 담은 opaque base64url 문자열

#### `DELETE /v1/api-keys/:id`

- 필요 scope: `keys:manage`
- 자기 Project의 Key만 폐기 가능
- 성공과 이미 폐기된 Key의 반복 요청은 모두 `204`
- 현재 요청을 인증한 Key 자체는 폐기할 수 없으며 `409 CANNOT_REVOKE_CURRENT_KEY` 반환
- 교체가 필요하면 새 관리 Key를 만든 뒤 그 Key로 기존 Key를 폐기

Key 생성은 Project row를 `FOR UPDATE`로 잠근 트랜잭션에서 활성 Key 수를 확인한 뒤 수행해 동시 생성에도 20개 상한을 지킨다. Key 생성·폐기와 대응하는 audit row는 같은 트랜잭션에서 commit한다.

### 사용량

#### `POST /v1/usage-events`

- 필요 scope: `usage:write`
- 필수 header: `Idempotency-Key` (canonical lowercase UUID v4)
- 입력: `units` (`1..10,000` 정수)
- 동일 idempotency key와 동일 payload 재시도: 기존 결정 반환
- 동일 idempotency key와 다른 payload: `409 IDEMPOTENCY_KEY_REUSED`
- 허용: `200`과 `eventId`, `decision`, `usageDate`, `units`, quota snapshot 반환
- 쿼터 초과: `429 QUOTA_EXCEEDED`
- 응답 header: `X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset`
- 동일 요청의 재시도는 최초의 상태 코드·결정·quota snapshot을 재사용한다. request ID만 새 요청에 맞게 달라진다.
- idempotency key는 Project 전체 범위다. 다른 Key가 보내더라도 같은 UUID는 같은 논리 요청으로 취급한다.
- `QUOTA_EXCEEDED`도 영구 확정되므로 reset 후 다시 시도하려면 새 idempotency key를 사용한다. 오해를 피하기 위해 `Retry-After`는 반환하지 않는다.

#### `GET /v1/usage/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`

- 필요 scope: `usage:read`
- 현재 Project의 UTC 일별 사용량만 조회
- `from`, `to`는 필수이고 `daily_usage` row가 없는 날짜는 생략한다. 거절 event로 row가 생성된 날짜는 `usedUnits=0`이어도 포함할 수 있다.
- `from <= to`, 양 끝 포함 최대 90일로 제한

### 감사 로그

#### `GET /v1/audit-logs?cursor=...&limit=...`

- 필요 scope: `audit:read`
- 현재 Project의 로그만 cursor pagination으로 조회
- 기본 page size 50, 최대 100
- 정렬은 `(created_at DESC, id DESC)`, cursor는 이 두 값을 담은 opaque base64url 문자열

### 운영

- `GET /health/live`: 프로세스 생존 여부
- `GET /health/ready`: PostgreSQL 연결과 migration 상태
- `GET /metrics`: Prometheus 형식 메트릭

## 7. 사용량 처리 알고리즘

`POST /v1/usage-events`는 다음 순서로 처리한다.

1. 요청이 애플리케이션에 진입할 때 `received_at`을 한 번 캡처하고 `usage_date`와 `quota_reset_at`을 UTC로 계산한다.
2. API Key 형식, 상태, digest, scope를 검증한다.
3. 인증된 Key에서 Project 문맥을 확정한다.
4. `payload_hash = SHA-256(UTF-8("usage-event:v1:" + units의 10진수 표현))`으로 계산한다.
5. PostgreSQL `READ COMMITTED` 트랜잭션을 시작한다.
6. `usage_events`에 `PENDING` 결정을 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`로 넣는다.
7. 반환된 ID가 없다면 같은 `(project_id, idempotency_key)`의 최종 row를 조회한다.
8. 기존 hash가 같으면 저장된 상태 코드·결정·quota snapshot을 반환하고 쿼터를 다시 차감하지 않는다.
9. 기존 hash가 다르면 `409`로 종료한다. 선행 트랜잭션 rollback 등으로 row가 보이지 않는 예외 경합은 전체 트랜잭션을 최대 3회 재시도한 뒤 `503`으로 종료한다.
10. 신규 요청이면 다음 의미로 해당 UTC 날짜의 `daily_usage` 행을 생성한다.

```sql
INSERT INTO daily_usage (project_id, usage_date, used_units, limit_units)
SELECT id, :usageDate, 0, daily_quota_units
FROM projects
WHERE id = :projectId
ON CONFLICT DO NOTHING;
```

11. 다음 의미의 조건부 UPDATE를 실행한다.

```sql
UPDATE daily_usage
SET used_units = used_units + :units,
    updated_at = now()
WHERE project_id = :projectId
  AND usage_date = :usageDate
  AND used_units + :units <= limit_units
RETURNING used_units, limit_units;
```

12. 행이 반환되면 `200/ACCEPTED`와 quota snapshot을 이벤트에 저장한다. 반환되지 않으면 `daily_usage`를 `SELECT ... FOR UPDATE`로 읽고 `429/QUOTA_EXCEEDED`와 quota snapshot을 저장한다.
13. commit 후 저장된 상태 코드·결정·quota header를 반환한다.

`PENDING` insert, quota 갱신, quota snapshot과 최종 decision 저장은 하나의 트랜잭션 안에서 일어난다. 별도의 `SERIALIZABLE` 격리나 애플리케이션 mutex 없이 unique constraint와 조건부 UPDATE가 경합을 직렬화한다. 동시 중복 insert는 선행 트랜잭션 종료까지 대기한 뒤 최종 row를 읽는다. 트랜잭션이 중간에 실패하면 이벤트 결정과 쿼터 갱신은 모두 rollback되므로 `PENDING` row가 commit되지 않는다. 서비스는 exactly-once 실행을 주장하지 않는다. unique constraint와 저장된 결정·quota snapshot을 이용해 동일 idempotency key의 의미상 결과를 반복해서 반환한다. 거절된 `QUOTA_EXCEEDED` 이벤트도 저장해 재시도 결과를 고정한다.

애플리케이션과 DB session timezone은 UTC로 고정한다. 요청이 자정 직전에 도착해 자정 이후 commit되더라도 처음 캡처한 `received_at` 날짜의 쿼터만 사용한다.

## 8. 인증·인가와 tenant 격리

- 모든 Project API는 인증된 API Key의 `project_id`를 tenant 기준으로 사용한다.
- 요청 body, path, 임의 header로 전달된 Project ID는 접근 권한 판단에 사용하지 않는다.
- Repository 함수는 항상 `project_id`를 필수 인자로 받는다.
- `usage_events`와 `audit_logs`의 복합 FK가 서로 다른 Project의 Key 참조를 DB 수준에서 거부한다.
- 다른 Project의 Key ID를 폐기하려는 요청은 존재 여부를 노출하지 않는 `404`로 응답한다.
- 폐기된 Key로 시작한 새 요청은 `401`이다.
- 폐기와 동시에 이미 트랜잭션을 시작한 요청은 완료될 수 있다. MVP는 폐기 시점 이전에 인증을 완료한 in-flight 요청을 강제 취소하지 않는다.
- 시스템 관리자 토큰은 Project 부트스트랩에만 사용하고 일반 데이터 API에는 사용할 수 없으며 로그에도 기록하지 않는다.

## 9. 오류 처리

| 상태 | 코드 | 조건 |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | 잘못된 body, scope, 날짜 범위 |
| 400 | `INVALID_CURSOR` | cursor decoding 또는 schema 오류 |
| 401 | `INVALID_SYSTEM_ADMIN_TOKEN` | 관리자 token 누락·불일치 |
| 401 | `INVALID_API_KEY` | 누락·형식 오류·digest 불일치·폐기된 Key |
| 403 | `INSUFFICIENT_SCOPE` | 필요한 scope 없음 |
| 404 | `RESOURCE_NOT_FOUND` | 현재 Project 문맥에서 대상 없음 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 동일 키와 다른 payload |
| 409 | `CANNOT_REVOKE_CURRENT_KEY` | 현재 요청을 인증한 Key 자체를 폐기하려 함 |
| 409 | `ACTIVE_KEY_LIMIT_REACHED` | Project의 활성 Key가 20개 |
| 429 | `QUOTA_EXCEEDED` | 일일 쿼터 부족 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | JSON body endpoint에 다른 media type 사용 |
| 500 | `INTERNAL_ERROR` | 예상하지 못한 서버 오류 |
| 503 | `DEPENDENCY_UNAVAILABLE` | PostgreSQL 연결 불가 |
| 503 | `CONCURRENT_REQUEST_RETRY_EXHAUSTED` | 드문 idempotency 경합 재시도 소진 |

서버 로그에는 내부 오류 원인을 기록하되 응답에는 stack trace, SQL, secret을 노출하지 않는다.

## 10. 테스트 전략

### 단위 테스트

- API Key 생성·파싱·digest 비교
- scope 판정
- versioned payload hash
- UTC reset 시각과 quota header 계산
- Problem Details 매핑

### PostgreSQL 통합 테스트

- Project와 Key 생성·폐기
- 자기 Key 폐기 차단과 활성 Key 20개 상한
- 다른 Project의 Key·로그 접근 차단
- raw SQL로 교차 Project 복합 FK insert가 실패하는지 검증
- 동일 idempotency key와 동일 payload의 결과 재사용
- 서로 다른 API Key가 같은 Project idempotency key를 보낼 때 결과 재사용
- 재시도 시 상태 코드와 quota snapshot 동일
- 동일 idempotency key와 다른 payload의 `409`
- 쿼터가 충분할 때 사용량과 이벤트가 함께 commit
- 쿼터 초과 시 `used_units` 미증가
- 강제 오류 시 이벤트와 쿼터가 함께 rollback
- audit log가 Project 경계를 지킴
- 자정 직전 `received_at` 요청이 자정 이후 commit되어도 이전 날짜에 집계

### 동시성 테스트

고정 시나리오를 CI에서 반복 실행한다.

1. 일일 쿼터 20인 Project에 100개의 서로 다른 요청을 동시에 전송한다.
   - `ACCEPTED` 20건
   - `QUOTA_EXCEEDED` 80건
   - 최종 `used_units` 20
   - 초과 허용 0건
2. 동일 idempotency key와 payload를 100회 동시에 전송한다.
   - `usage_events` 1건
   - 사용량 증가 1회
   - 모든 응답의 상태 코드·결정·quota snapshot 동일
3. 다른 payload로 같은 idempotency key를 경합시킨다.
   - 최초 확정 payload 하나만 인정
   - 나머지는 `409`

### 보안 회귀 테스트

- 다른 Project의 Key ID로 조회·폐기 성공 0건
- 폐기된 Key로 보호 API 호출 성공 0건
- DB와 로그에서 원문 API Key 문자열 검출 0건
- scope가 없는 Key의 보호 API 호출 성공 0건

### 부하·측정 테스트

- 동일한 하드웨어·Docker 설정을 기록한다.
- 단일 Project 경합 수준을 동시성 1·10·50·100으로 높이며 사용량 수집 API의 p50, p95, p99와 처리량을 측정한다.
- audit row 10,000건에서 첫 page와 중간 cursor page의 `EXPLAIN ANALYZE`를 보존한다.
- 목표 수치를 사전에 과장해서 정하지 않고 측정 조건과 실제 결과를 README에 공개한다.

## 11. 관측성

### 로그

- JSON 형식
- request ID, route, status, duration, outcome 포함
- 원문 API Key, 관리자 토큰, 전체 Authorization header 제외
- Project ID와 Key ID는 내부 추적용 필드로만 기록

### 메트릭

- `http_requests_total{route,status}`
- `http_request_duration_seconds{route}`
- `api_key_auth_failures_total{reason}`
- `quota_decisions_total{decision}`
- `usage_units_accepted_total`
- `db_transaction_duration_seconds{transaction}`

Project ID와 Key ID는 고카디널리티이므로 metric label에 넣지 않는다. `route`, `reason`, `decision`, `transaction` 값은 코드에 정의한 유한한 allowlist만 사용한다.

### 상태 점검

- liveness는 외부 의존성을 확인하지 않는다.
- readiness는 PostgreSQL 연결과 migration 상태를 확인한다.

## 12. 배포와 CI

### Docker

- multi-stage Dockerfile
- non-root 사용자로 애플리케이션 실행
- Docker Compose에 `app`, `postgres` 구성
- `.env.example`에는 secret 실값을 포함하지 않음

### Database migration

- Prisma migration 파일을 버전 관리한다.
- 애플리케이션 시작과 `prisma migrate deploy` 실행을 분리한다.
- CI는 빈 PostgreSQL에 migration 전체를 적용한 뒤 통합 테스트를 실행한다.

### GitHub Actions

순서는 다음과 같다.

1. 의존성 설치
2. format·lint·typecheck
3. 단위 테스트
4. Testcontainers 통합·동시성 테스트
5. 애플리케이션 build
6. Docker image build

실제 cloud 배포는 필수 범위가 아니지만, 배포한다면 단일 애플리케이션 인스턴스와 관리형 PostgreSQL로 시작한다.

## 13. 문서 산출물

저장소에는 다음 문서를 포함한다.

- README: 문제, 실행법, 보장 범위, 데모 명령
- API Contract: 요청·응답·오류·pagination·멱등 replay 계약
- Database Schema: type·constraint·FK·index·transaction 계약
- OpenAPI 문서
- ERD
- ADR 1: Redis 대신 PostgreSQL 조건부 갱신을 선택한 이유
- ADR 2: API Key 저장 형식과 HMAC digest 선택
- ADR 3: idempotency key의 저장 범위와 재사용 규칙
- Test report: 동시성·보안·rollback 시나리오 결과
- Benchmark report: 환경, 데이터 크기, p50/p95/p99, 실행계획 비교
- Known limitations: RLS, 자동 retention, 외부 rate limit, 실제 cloud 배포가 MVP에 없는 이유와 production 확장 방향

## 14. 완료 기준

다음을 모두 충족해야 이력서에 프로젝트로 추가한다.

- Docker Compose 한 명령으로 실행 가능
- Swagger에서 전체 API 계약 확인 가능
- API Contract와 Database Schema 명세가 구현·OpenAPI·migration과 일치
- 원문 API Key는 발급 응답 외 어디에도 저장·기록되지 않음
- Project 간 접근 차단 테스트 통과
- 교차 Project Key 참조를 복합 FK가 거부
- 쿼터 20 / 동시 요청 100 시나리오가 정확히 20건만 허용
- 동일 idempotency key 100회 동시 요청이 한 번만 집계
- 멱등 재시도의 상태 코드·quota snapshot이 최초 응답과 동일
- 자정 경계 테스트가 캡처한 `received_at` 날짜에 집계
- transaction rollback 테스트 통과
- CI에서 단위·통합·동시성 테스트 통과
- 주요 로그와 Prometheus metric 확인 가능
- README, ADR, 테스트 보고서, 벤치마크 조건 작성 완료

## 15. 이력서에서 강조할 내용

측정 전 수치를 만들어내지 않는다. 완료 후 실제 결과를 다음 구조로 요약한다.

- 문제: 멀티테넌트 API의 Key 관리와 동시 요청 쿼터 초과 방지
- 선택: HMAC digest Key 저장, scope 인가, PostgreSQL 조건부 원자 갱신
- 검증: 중복·동시성·교차 tenant·폐기 Key 통합 테스트
- 결과: 실제 허용·거절 건수, p95, 실행계획 개선 결과
- 운영: Docker, CI, 구조화 로그, metric, 문서화

이 프로젝트는 PILO에서 다룬 멱등성·동시성 사고를 다시 주장하는 데 그치지 않고, 이를 개인 소유의 HTTP API·tenant 모델·보안·자동화 테스트·운영 산출물로 독립 검증하는 역할을 한다.
