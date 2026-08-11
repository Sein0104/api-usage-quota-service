# API Usage Metering and Quota Service Implementation Plan

> **실행 규칙:** 각 Task는 별도 Issue·Branch·PR로 진행하고, 체크박스 순서대로 RED 확인·최소 구현·전체 검증·self-review를 완료한다.

**Goal:** API Key 인증, tenant 격리, 멱등한 사용량 기록과 동시성 안전한 일일 쿼터를 실제 PostgreSQL·HTTP 테스트로 증명하는 소형 백엔드 서비스를 만든다.

**Architecture:** 하나의 NestJS 모듈러 모놀리스가 하나의 PostgreSQL을 사용한다. 일반 CRUD는 Prisma Client를 사용하고, 사용량의 idempotency insert·조건부 quota update·terminal decision은 하나의 `READ COMMITTED` transaction 안에서 명시적 SQL로 처리한다.

**Tech Stack:** Node.js 24.16.0, npm 11.13.0, TypeScript 5.9, NestJS 11 Express, Prisma ORM 7, PostgreSQL 18, Jest, Supertest, Testcontainers, Pino, Prometheus, Docker Compose, GitHub Actions

## Global Constraints

- package는 ESM이며 `target=ES2023`, `module=NodeNext`, `moduleResolution=NodeNext`, `strict=true`를 사용한다.
- 내부 상대 import에는 `.js` 확장자를 붙인다.
- `packageManager`는 `npm@11.13.0`, Node version은 `.node-version`의 `24.16.0`으로 고정한다.
- 모든 업무 API는 `/v1`, 운영·문서 endpoint는 `/health/*`, `/metrics`, `/docs`, `/openapi.json`을 사용한다.
- `/health/ready` 준비 실패 `503`만 probe JSON이며 나머지 오류는 RFC 9457 Problem Details다.
- `/metrics`는 모든 환경에서 별도 `METRICS_TOKEN` Bearer 인증을 요구한다.
- Swagger는 `SWAGGER_ENABLED`가 `true`일 때만 `/docs`, `/openapi.json` route를 등록한다.
- API Key 원문과 `SYSTEM_ADMIN_TOKEN`, `API_KEY_PEPPER`, `METRICS_TOKEN`, 전체 Authorization header는 DB·로그·문서에 기록하지 않는다.
- 모든 repository 조회·변경 메서드는 `projectId`를 필수 인자로 받아 tenant 문맥을 강제한다.
- production 코드는 실패하는 테스트를 먼저 확인한 뒤 최소 구현한다.
- 각 Task를 시작할 때 GitHub 작업 Issue를 하나 생성한다. GitHub가 반환한 실제 번호를 이하 `N`으로 정의하고 branch와 commit의 `#N`을 그 번호로 치환한다.
- branch는 최신 `dev`에서 `<type>/N-<description>`으로 생성하고, ready PR을 `dev`로 보낸다. commit 요약과 PR 본문은 한국어로 작성한다.

---

## 고정 파일 구조

```text
package.json
package-lock.json
.node-version
nest-cli.json
tsconfig.json
tsconfig.build.json
jest.config.mjs
eslint.config.js
.prettierrc.json
prisma.config.ts
prisma/schema.prisma
prisma/migrations/*/migration.sql

src/
  main.ts
  app.module.ts
  config/environment.schema.ts
  common/
    auth/bearer-credential.parser.ts
    http/request-context.ts
    http/request-id.middleware.ts
    http/problem-code.ts
    http/problem.exception.ts
    http/problem-details.filter.ts
    http/json-content-type.guard.ts
    pagination/cursor-codec.ts
    pagination/page.ts
    time/clock.ts
  database/
  system-admin/
  projects/
  api-keys/
  usage/
  audit/
  observability/
  generated/prisma/
  scripts/generate-openapi.ts

test/
  support/
  integration/
  e2e/
  concurrency/
  security/
  contract/
  smoke/
```

## 고정 TypeScript 인터페이스

```ts
export type ApiScope =
  | 'usage:write'
  | 'usage:read'
  | 'keys:manage'
  | 'audit:read';

export interface RequestContext {
  requestId: string;
  receivedAt: Date;
}

export interface AuthenticatedApiKey {
  id: string;
  projectId: string;
  scopes: readonly ApiScope[];
}

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export interface PageRequest {
  cursor: CursorPosition | null;
  limit: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface IssuedApiKey {
  id: string;
  prefix: string;
  plaintext: string;
  digest: Buffer;
}

export interface QuotaSnapshot {
  limit: number;
  remaining: number;
  resetAt: Date;
}

export interface UsageTerminalResult {
  httpStatus: 200 | 429;
  eventId: string;
  decision: 'ACCEPTED' | 'QUOTA_EXCEEDED';
  usageDate: string;
  units: number;
  quota: QuotaSnapshot;
  replayed: boolean;
}
```

고정 service 경계:

```ts
ProjectsService.bootstrap(command, context): Promise<ProjectBootstrapResult>
ApiKeyAuthService.authenticate(rawCredential): Promise<AuthenticatedApiKey>
ApiKeysService.create(actor, command, context): Promise<CreateApiKeyResult>
ApiKeysService.list(actor, page): Promise<CursorPage<ApiKeyMetadata>>
ApiKeysService.revoke(actor, targetKeyId, context): Promise<void>
UsageService.ingest(actor, idempotencyKey, units, context): Promise<UsageTerminalResult>
UsageService.listDaily(actor, from, to): Promise<DailyUsageItem[]>
AuditService.list(actor, page): Promise<CursorPage<AuditLogItem>>
```

---

### Task 1: NestJS ESM 플랫폼과 공통 HTTP 계약

**Files:**
- Create: `package.json`, `package-lock.json`, `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`
- Create: `jest.config.mjs`, `eslint.config.js`, `.prettierrc.json`
- Create: `src/main.ts`, `src/app.module.ts`, `src/config/environment.schema.ts`
- Create: `src/common/http/request-context.ts`, `src/common/http/request-id.middleware.ts`
- Create: `src/common/http/problem-code.ts`, `src/common/http/problem.exception.ts`, `src/common/http/problem-details.filter.ts`
- Create: `src/common/http/json-content-type.guard.ts`, `src/common/time/clock.ts`
- Create: `src/observability/health.controller.ts`
- Test: `src/config/environment.schema.spec.ts`, `test/e2e/platform.e2e-spec.ts`

**Interfaces:**
- Produces: `RequestContext`, `Clock.now(): Date`, `ProblemException`, 전역 Problem Details filter
- Consumes: 환경 변수 계약과 API Contract

- [ ] **Step 1: package와 검사 도구 기반 구성**

`package.json`에 `type: "module"`, `packageManager: "npm@11.13.0"`, `engines.node: "24.16.x"`와 Global Constraints의 script를 먼저 등록하고 lockfile을 생성한다. 이 단계에서는 production handler를 작성하지 않는다.

Run: `node --version`

Expected: `v24.16.0`.

Run: `npm --version`

Expected: `11.13.0`.

- [ ] **Step 2: 환경 변수와 liveness의 실패 테스트 작성**

```ts
it('필수 secret이 없으면 환경 검증에 실패한다', () => {
  expect(() => validateEnvironment({ NODE_ENV: 'test' })).toThrow();
});

it('서버가 생성한 request id와 liveness를 반환한다', async () => {
  const response = await request(app.getHttpServer()).get('/health/live');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
  expect(response.headers['x-request-id']).toMatch(UUID_V4);
});
```

- [ ] **Step 3: RED 확인**

Run: `npm run test:unit -- --runTestsByPath src/config/environment.schema.spec.ts`

Expected: `validateEnvironment` 또는 module을 찾지 못해 FAIL.

Run: `npm run test:e2e -- --runTestsByPath test/e2e/platform.e2e-spec.ts`

Expected: app bootstrap 또는 `/health/live` 부재로 FAIL.

- [ ] **Step 4: 최소 bootstrap·환경 검증·HTTP 공통 계층 구현**

```ts
export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().required(),
  DATABASE_URL: Joi.string().uri().required(),
  SYSTEM_ADMIN_TOKEN: Joi.string().min(43).required(),
  API_KEY_PEPPER: Joi.string().min(43).required(),
  METRICS_TOKEN: Joi.string().min(43).required(),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').required(),
  TZ: Joi.string().valid('UTC').required(),
  SWAGGER_ENABLED: Joi.boolean(),
});
```

검증 후 `SWAGGER_ENABLED`가 생략되면 `NODE_ENV !== 'production'` 값을 적용한다. environment 단위 테스트는 development·test의 기본값 `true`, production의 기본값 `false`, 명시적 boolean override를 각각 검증한다.

`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, request ID middleware와 전역 exception filter를 `src/main.ts`에서 등록한다.

- [ ] **Step 5: 공통 오류 테스트 추가 후 구현**

```ts
expect(await postUnknownField()).toMatchObject({
  status: 400,
  headers: { 'content-type': expect.stringContaining('application/problem+json') },
  body: { code: 'VALIDATION_ERROR', requestId: expect.any(String) },
});
```

잘못된 media type은 `415 UNSUPPORTED_MEDIA_TYPE`, 미등록 route는 `404 ROUTE_NOT_FOUND`로 매핑한다.

- [ ] **Step 6: 검증과 한국어 commit**

Run in order:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
```

Expected: 모든 명령 exit 0.

Commit: `build: NestJS ESM 실행 기반과 공통 HTTP 계약 추가 (#N)`

PR title: `🚨 build(platform,http): NestJS 실행 기반과 공통 HTTP 계약 추가`

---

### Task 2: PostgreSQL 18 schema, Prisma 7, readiness

**Files:**
- Create: `prisma.config.ts`, `prisma/schema.prisma`
- Create: `prisma/migrations/202608110001_initial_schema/migration.sql`
- Create: `src/database/database.constants.ts`, `src/database/postgres-pool.provider.ts`
- Create: `src/database/prisma.service.ts`, `src/database/migration-status.service.ts`, `src/database/database.module.ts`
- Modify: `src/observability/health.controller.ts`, `src/app.module.ts`, `package.json`
- Test: `test/support/postgres-test-harness.ts`, `test/support/database-cleaner.ts`
- Test: `test/integration/database-schema.int-spec.ts`, `test/e2e/readiness.e2e-spec.ts`

**Interfaces:**
- Produces: injectable `PrismaService`, `PG_POOL`, `MigrationStatusService.isReady(): Promise<boolean>`
- Consumes: DB schema 명세의 다섯 table과 모든 constraint

- [ ] **Step 1: 실제 PostgreSQL catalog·제약 실패 테스트 작성**

```ts
it('다른 Project의 API Key를 usage event가 참조하지 못한다', async () => {
  await expect(insertCrossTenantUsageEvent(sql)).rejects.toMatchObject({ code: '23503' });
});
```

- [ ] **Step 2: migration 부재 RED 확인**

Run: `npm run test:integration -- --runTestsByPath test/integration/database-schema.int-spec.ts`

Expected: relation 또는 migration 부재로 FAIL.

- [ ] **Step 3: Prisma model과 custom migration 구현**

```sql
ALTER TABLE usage_events
ADD CONSTRAINT usage_events_project_api_key_fk
FOREIGN KEY (project_id, api_key_id)
REFERENCES api_keys(project_id, id)
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE usage_events
ADD CONSTRAINT usage_events_project_idempotency_key_uq
UNIQUE (project_id, idempotency_key);
```

Prisma generator는 `provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "esm"`, `runtime = "nodejs"`를 사용한다.

- [ ] **Step 4: readiness RED/GREEN**

```ts
expect(await getReady(appWithUnavailableDb)).toMatchObject({
  status: 503,
  body: { status: 'not_ready' },
});
expect(await getReady(appWithMigratedDb)).toMatchObject({
  status: 200,
  body: { status: 'ready' },
});
```

- [ ] **Step 5: 검증과 commit**

Run in order:

```text
npm run prisma:generate
npx prisma validate
npm run test:integration
npm run test:e2e
```

Expected: 빈 PostgreSQL 18에 migration 적용 후 모든 제약·readiness 테스트 PASS.

Commit: `feat: PostgreSQL 스키마와 readiness 추가 (#N)`

PR title: `🚨 feat(database,health): PostgreSQL 스키마와 readiness 추가`

---

### Task 3: System admin Project bootstrap

**Files:**
- Create: `src/common/auth/bearer-credential.parser.ts`
- Create: `src/common/auth/timing-safe-secret.ts`
- Create: `src/system-admin/system-admin.module.ts`, `src/system-admin/system-admin.controller.ts`, `src/system-admin/system-admin.guard.ts`
- Create: `src/projects/projects.module.ts`, `src/projects/project-bootstrap.service.ts`
- Create: `src/projects/dto/create-project.dto.ts`, `src/projects/project.presenter.ts`
- Create: `src/api-keys/api-key-credential.service.ts`, `src/api-keys/api-key.presenter.ts`
- Create: `src/audit/audit-write.repository.ts`
- Test: `src/common/auth/timing-safe-secret.spec.ts`, `src/api-keys/api-key-credential.service.spec.ts`
- Test: `test/integration/project-bootstrap.int-spec.ts`, `test/e2e/admin-projects.e2e-spec.ts`

**Interfaces:**
- Produces: `ApiKeyCredentialService.issue(): IssuedApiKey`, `ProjectsService.bootstrap(command, context)`
- Produces: `AuditWriteRepository.recordProjectCreated(tx, data): Promise<void>`

- [ ] **Step 1: credential와 transaction 실패 테스트 작성**

```ts
expect(issued.plaintext).toMatch(/^mq_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
expect(issued.digest).toHaveLength(32);
expect(await findPlaintextInDatabase(issued.plaintext)).toBe(false);
expect(timingSafeSecretEqual('짧음', '서로-다른-길이의-token')).toBe(false);
```

- [ ] **Step 2: RED 확인**

Run: `npm run test:unit -- --runTestsByPath src/common/auth/timing-safe-secret.spec.ts src/api-keys/api-key-credential.service.spec.ts`

Expected: 공통 comparator 또는 credential service 부재로 FAIL.

- [ ] **Step 3: CSPRNG·HMAC과 bootstrap 최소 구현**

```ts
const secret = randomBytes(32).toString('base64url');
const plaintext = `mq_${id}.${secret}`;
const digest = createHmac('sha256', pepper).update(plaintext, 'utf8').digest();
```

`SYSTEM_ADMIN_TOKEN` 비교는 두 입력을 각각 SHA-256으로 고정 길이 digest로 만든 뒤 `timingSafeEqual`을 적용하는 공통 helper를 사용한다. 길이가 다른 입력도 예외 없이 `false`를 반환해야 한다. Project API Key digest는 HMAC-SHA-256의 고정 32-byte 값끼리 비교한다.

Project, 최초 관리자 Key와 `PROJECT_CREATED` audit를 하나의 Prisma transaction에서 생성한다. E2E 테스트는 올바른 System admin token만 허용하고, Project API Key 형식의 값과 `METRICS_TOKEN`은 관리자 endpoint에서 `401 INVALID_SYSTEM_ADMIN_TOKEN`으로 거부되는지 검증한다.

- [ ] **Step 4: HTTP·rollback 검증**

Run: `npm run test:unit -- --runTestsByPath src/common/auth/timing-safe-secret.spec.ts src/api-keys/api-key-credential.service.spec.ts`

Run: `npm run test:integration -- --runTestsByPath test/integration/project-bootstrap.int-spec.ts`

Run: `npm run test:e2e -- --runTestsByPath test/e2e/admin-projects.e2e-spec.ts`

Expected: 잘못된 token은 `401`; 성공은 `201`; 강제 audit 실패는 세 row 모두 rollback.

- [ ] **Step 5: commit**

Commit: `feat: Project와 최초 관리자 API Key 발급 추가 (#N)`

PR title: `feat(projects,api-keys): Project와 최초 관리자 API Key 발급 추가`

---

### Task 4: Project API Key 인증·scope와 하위 Key 생성

**Files:**
- Create: `src/api-keys/auth/authenticated-api-key.ts`, `src/api-keys/auth/api-key-auth.service.ts`
- Create: `src/api-keys/auth/api-key-auth.guard.ts`, `src/api-keys/auth/required-scopes.decorator.ts`
- Create: `src/api-keys/auth/scopes.guard.ts`, `src/api-keys/auth/current-api-key.decorator.ts`
- Create: `src/api-keys/api-keys.module.ts`
- Create: `src/api-keys/api-keys.controller.ts`, `src/api-keys/api-keys.service.ts`, `src/api-keys/api-keys.repository.ts`
- Create: `src/api-keys/dto/create-api-key.dto.ts`
- Modify: `src/app.module.ts`
- Test: `test/e2e/api-key-auth.e2e-spec.ts`, `test/integration/api-key-create.int-spec.ts`

**Interfaces:**
- Produces: `ApiKeyAuthService.authenticate(rawCredential): Promise<AuthenticatedApiKey>`
- Produces: `@RequiredScopes(...scopes)`와 `@CurrentApiKey()`

- [ ] **Step 1: 인증·scope·20개 상한 테스트 작성**

```ts
expect((await callWithRevokedKey()).status).toBe(401);
expect((await callWithoutScope()).status).toBe(403);
expect(await countActiveKeysAfterConcurrentCreate(25)).toBe(20);
```

- [ ] **Step 2: RED 확인**

Run: `npm run test:e2e -- --runTestsByPath test/e2e/api-key-auth.e2e-spec.ts`

Expected: guard 부재 또는 endpoint 404로 FAIL.

- [ ] **Step 3: 인증·인가·create 구현**

Digest는 `timingSafeEqual`로 비교하고 인증된 row의 `projectId`만 tenant 문맥으로 사용한다. Key 생성 transaction은 Project row를 `FOR UPDATE`로 잠근 뒤 활성 Key 수를 확인한다.

- [ ] **Step 4: 통합·동시성 검증**

Run: `npm run test:integration -- --runTestsByPath test/integration/api-key-create.int-spec.ts`

Expected: concurrent create에서도 20개 상한, Key와 audit 원자 commit, plaintext 검색 0건.

- [ ] **Step 5: commit**

Commit: `feat: API Key 인증과 scope 기반 발급 추가 (#N)`

PR title: `feat(auth,api-keys): API Key 인증과 scope 기반 발급 추가`

---

### Task 5: Key 목록·cursor·폐기와 rotation

**Files:**
- Create: `src/common/pagination/cursor-codec.ts`, `src/common/pagination/page.ts`
- Create: `src/api-keys/dto/list-api-keys.query.ts`, `src/api-keys/dto/revoke-api-key.params.ts`
- Modify: `src/api-keys/api-keys.controller.ts`, `src/api-keys/api-keys.service.ts`, `src/api-keys/api-keys.repository.ts`
- Test: `src/common/pagination/cursor-codec.spec.ts`
- Test: `test/e2e/api-key-lifecycle.e2e-spec.ts`, `test/integration/api-key-revoke.int-spec.ts`

**Interfaces:**
- Produces: `CursorCodec.encode/decode`, `PageRequest`, `CursorPage<T>`
- Consumes: `AuthenticatedApiKey`, transaction-scoped audit writer

- [ ] **Step 1: cursor와 폐기 실패 테스트 작성**

```ts
expect(() => cursorCodec.decode('broken')).toThrowProblem('INVALID_CURSOR');
expect((await revokeCurrentKey()).status).toBe(409);
expect((await revokeCrossTenantKey()).status).toBe(404);
```

- [ ] **Step 2: RED 확인**

Run: `npm run test:unit -- --runTestsByPath src/common/pagination/cursor-codec.spec.ts`

Expected: codec 부재로 FAIL.

- [ ] **Step 3: strict-after cursor와 revoke 구현**

```sql
WHERE project_id = $1
  AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT $4;
```

목록은 `limit + 1`개를 읽어 `nextCursor`를 결정하며 secret·digest를 presenter에 전달하지 않는다. 폐기 update와 audit는 한 transaction이고 이미 폐기된 Key는 추가 audit 없이 `204`다.

- [ ] **Step 4: 검증과 commit**

Run in order:

```text
npm run test:unit
npm run test:integration -- --runTestsByPath test/integration/api-key-revoke.int-spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/api-key-lifecycle.e2e-spec.ts
```

Expected: pagination 중복·누락 0, tenant 노출 0, 반복 폐기 audit 증가 0.

Commit: `feat: API Key 목록과 안전한 폐기 추가 (#N)`

PR title: `feat(api-keys,pagination): API Key 목록과 안전한 폐기 추가`

---

### Task 6: 직렬 요청에서의 멱등 usage ingest

**Files:**
- Create: `src/usage/usage.module.ts`, `src/usage/usage.controller.ts`, `src/usage/usage.service.ts`, `src/usage/usage.repository.ts`
- Create: `src/usage/dto/create-usage-event.dto.ts`
- Create: `src/usage/domain/payload-hash.ts`, `src/usage/domain/quota-time.ts`, `src/usage/domain/usage-terminal-result.ts`
- Create: `src/usage/usage.presenter.ts`, `src/usage/quota-response.ts`, `src/usage/quota-exceeded.exception.ts`
- Test: `src/usage/domain/payload-hash.spec.ts`, `src/usage/domain/quota-time.spec.ts`
- Test: `test/integration/usage-transaction.int-spec.ts`, `test/e2e/usage-events.e2e-spec.ts`

**Interfaces:**
- Produces: `UsageService.ingest(...): Promise<UsageTerminalResult>`
- Consumes: `AuthenticatedApiKey`, `RequestContext`, `PrismaService`

- [ ] **Step 1: hash·UTC·HTTP terminal result 테스트 작성**

```ts
expect(payloadHash(10)).toEqual(sha256('usage-event:v1:10'));
expect((await replaySameRequest()).body).toEqual(firstResponse.body);
expect((await reuseWithOtherUnits()).status).toBe(409);
```

- [ ] **Step 2: RED 확인**

Run: `npm run test:unit -- --runTestsByPath src/usage/domain/payload-hash.spec.ts src/usage/domain/quota-time.spec.ts`

Expected: domain functions 부재로 FAIL.

- [ ] **Step 3: 하나의 transaction으로 usage 알고리즘 구현**

```sql
UPDATE daily_usage
SET used_units = used_units + $3,
    updated_at = now()
WHERE project_id = $1
  AND usage_date = $2
  AND used_units + $3 <= limit_units
RETURNING used_units, limit_units;
```

`PENDING insert → daily row 생성 → 조건부 update 또는 FOR UPDATE snapshot → terminal finalize`를 한 transaction에서 실행한다. `429`도 terminal row로 저장한다.

- [ ] **Step 4: replay·rollback·header 검증**

Run: `npm run test:integration -- --runTestsByPath test/integration/usage-transaction.int-spec.ts`

Run: `npm run test:e2e -- --runTestsByPath test/e2e/usage-events.e2e-spec.ts`

Expected: replay 추가 차감 0, payload 충돌 `409`, body와 quota header 일치.

- [ ] **Step 5: commit**

Commit: `feat: 멱등한 사용량 수집과 quota 결정 추가 (#N)`

PR title: `feat(usage,quota): 멱등한 사용량 수집과 quota 결정 추가`

---

### Task 7: 동시성 보장·rollback·일별 조회

**Files:**
- Modify: `src/usage/usage.repository.ts`, `src/usage/usage.service.ts`
- Modify: `src/usage/usage.controller.ts`, `src/usage/usage.module.ts`
- Create: `src/usage/idempotency-retry.ts`, `src/usage/dto/list-daily-usage.query.ts`
- Create: `src/usage/daily-usage.service.ts`, `src/usage/daily-usage.presenter.ts`
- Test: `test/support/fake-clock.ts`, `test/support/database-faults.ts`
- Test: `test/concurrency/usage-quota.concurrent-spec.ts`, `test/concurrency/usage-idempotency.concurrent-spec.ts`
- Test: `test/integration/usage-rollback.int-spec.ts`, `test/e2e/daily-usage.e2e-spec.ts`

**Interfaces:**
- Produces: `UsageService.listDaily(actor, from, to)`와 최대 3회 고정 retry
- Consumes: Task 6의 terminal result와 transaction algorithm

- [ ] **Step 1: 100요청 동시성 테스트 작성**

```ts
expect(results.filter(isAccepted)).toHaveLength(20);
expect(results.filter(isQuotaExceeded)).toHaveLength(80);
expect(await readUsedUnits()).toBe(20);
```

동일 key/payload 100건은 event 1건, 차감 1회, 동일 terminal snapshot을 기대한다.

- [ ] **Step 2: RED 확인**

Run: `npm run test:concurrency -- --runTestsByPath test/concurrency/usage-quota.concurrent-spec.ts`

Expected: 경합 오류 또는 허용 건수 불일치로 FAIL.

- [ ] **Step 3: 경합 retry와 rollback 처리 구현**

선행 transaction rollback으로 conflict 후 row가 보이지 않는 경우 전체 transaction을 최대 3회 재시도한다. 소진 시 `503 CONCURRENT_REQUEST_RETRY_EXHAUSTED`를 반환하고 sleep 대신 injectable retry scheduler를 사용해 단위 테스트를 결정적으로 만든다.

- [ ] **Step 4: 일별 조회와 자정 경계 구현**

```ts
const rangeDays = utcEpochDay(to) - utcEpochDay(from) + 1;
if (rangeDays > 90) {
  throw ProblemException.validation('to', '조회 범위는 최대 90일입니다.');
}
```

`receivedAt`은 요청 진입 시 한 번 캡처하며 transaction commit 시각으로 다시 계산하지 않는다.

- [ ] **Step 5: 전체 검증과 commit**

Run in order:

```text
npm run test:concurrency
npm run test:integration -- --runTestsByPath test/integration/usage-rollback.int-spec.ts
npm run test:e2e -- --runTestsByPath test/e2e/daily-usage.e2e-spec.ts
```

Expected: 초과 허용 0, 중복 집계 0, committed PENDING 0, rollback 불일치 0.

Commit: `feat: 동시성 안전한 quota와 일별 조회 완성 (#N)`

PR title: `feat(usage,concurrency): 동시성 안전한 quota와 일별 조회 완성`

---

### Task 8: Audit 조회·관측성·OpenAPI·보안 회귀

**Files:**
- Create: `src/audit/audit.module.ts`, `src/audit/audit.controller.ts`, `src/audit/audit.service.ts`
- Create: `src/audit/audit-read.repository.ts`, `src/audit/audit.presenter.ts`, `src/audit/dto/list-audit-logs.query.ts`
- Create: `src/observability/logging.module.ts`, `src/observability/metrics.service.ts`
- Create: `src/observability/metrics.controller.ts`, `src/observability/metrics-token.guard.ts`, `src/observability/http-metrics.interceptor.ts`
- Create: `src/openapi.ts`, `src/scripts/generate-openapi.ts`, `docs/openapi/openapi.json`
- Modify: `src/app.module.ts`, `src/main.ts`
- Test: `test/e2e/audit-logs.e2e-spec.ts`, `test/e2e/observability.e2e-spec.ts`
- Test: `test/contract/openapi.contract-spec.ts`, `test/security/credential-leak.security-spec.ts`

**Interfaces:**
- Produces: `/v1/audit-logs`, `/metrics`, `/docs`, `/openapi.json`
- Consumes: Task 5 CursorCodec, 모든 service outcome과 API Contract

- [ ] **Step 1: metrics 인증·로그 redaction·OpenAPI 실패 테스트 작성**

```ts
expect((await getMetrics()).status).toBe(401);
expect((await getMetrics(systemAdminToken)).status).toBe(401);
expect((await getMetrics(metricsToken)).text).toContain('http_requests_total');
expect(serializedLogs).not.toContain(issuedPlaintextKey);
```

- [ ] **Step 2: RED 확인**

Run: `npm run test:e2e -- --runTestsByPath test/e2e/observability.e2e-spec.ts`

Expected: `/metrics` 또는 guard 부재로 FAIL.

- [ ] **Step 3: audit·logging·metrics 구현**

`METRICS_TOKEN`은 constant-time 비교하고 시스템 관리자 token 및 API Key와 교환하지 않는다. metric label은 코드에 정의한 `route`, `status`, `reason`, `decision`, `transaction` allowlist만 사용하며 Project ID와 Key ID를 넣지 않는다.

- [ ] **Step 4: Swagger·OpenAPI 환경 정책 구현**

```ts
if (config.swaggerEnabled) {
  SwaggerModule.setup('/docs', app, document, { raw: false });
  httpAdapter.get('/openapi.json', (_request, response) => response.json(document));
}
```

생성 OpenAPI의 모든 `/v1` operation은 공통 `500`·`503`을 포함하고 usage `503`은 두 code variant를 `oneOf`로 표현한다. 계약 테스트는 Nest Swagger 기본 raw route인 `/docs-json`, `/docs-yaml`이 등록되지 않고 `404 ROUTE_NOT_FOUND`인지도 검증한다.

보안 회귀 테스트는 유효한 System admin token, Project API Key, Metrics token을 준비하고 각 credential이 자기 endpoint에서만 허용되는지 전체 교차 행렬로 검증한다. 다른 종류의 credential을 바꿔 넣은 요청은 모두 해당 endpoint의 `401` Problem Details로 거부되어야 한다.

- [ ] **Step 5: 계약·보안 검증과 commit**

Run in order:

```text
npm run test:e2e
npm run test:contract
npm run test:security
npm run openapi:check
```

Expected: API Contract drift 0, credential 검출 0, health readiness `503`만 비-Problem JSON.

Commit: `feat: 감사 조회와 보호된 관측성 계약 완성 (#N)`

PR title: `🚨 feat(audit,observability): 감사 조회와 보호된 관측성 계약 완성`

---

### Task 9: Docker Compose·CI·문서·측정

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`
- Create: `.github/workflows/ci.yml`, `.github/workflows/benchmark.yml`
- Create: `scripts/demo.mjs`, `scripts/benchmark-usage.mjs`, `scripts/explain-audit.mjs`
- Create: `test/smoke/docker-compose.smoke-spec.mjs`
- Create: `README.md`, `docs/architecture/erd.md`
- Create: `docs/adr/0001-postgresql-conditional-quota.md`
- Create: `docs/adr/0002-api-key-hmac-storage.md`
- Create: `docs/adr/0003-project-idempotency-scope.md`
- Create: `docs/reports/test-report.md`, `docs/reports/benchmark-report.md`, `docs/known-limitations.md`

**Interfaces:**
- Produces: `postgres → migrate → app` Compose 실행, CI required checks, 재현 가능한 demo·benchmark
- Consumes: Tasks 1~8의 전체 application과 test script 계약

- [ ] **Step 1: Docker smoke 실패 테스트 작성**

```js
assert.deepStrictEqual(await getJson('http://localhost:3000/health/live'), { status: 'ok' });
assert.equal((await getReady()).status, 200);
```

- [ ] **Step 2: RED 확인**

Run: `npm run test:smoke`

Expected: Docker image 또는 Compose service 부재로 FAIL.

- [ ] **Step 3: multi-stage Docker와 Compose 구현**

Docker target은 `build`, `migrate`, `runtime`으로 나눈다. runtime은 non-root로 실행한다. Compose dependency는 `postgres healthy → migrate service_completed_successfully → app service_healthy`다.

- [ ] **Step 4: CI를 세 job으로 구현**

```text
static: npm ci → prisma generate → format → lint → typecheck → unit → build
postgres-tests: npm ci → prisma generate → PostgreSQL 18 시작 → migrate deploy → integration → e2e → concurrency → contract → security
docker: npm ci → prisma generate → image build → compose config → compose up --build --wait → smoke → compose down
```

Docker job은 성공·실패와 관계없이 `if: always()` cleanup 단계에서 `docker compose down --volumes`를 실행한다.

- [ ] **Step 5: 실제 결과 문서화**

Run: `npm run benchmark`

동시성 1·10·50·100의 처리량과 p50/p95/p99, 사용 환경을 `docs/reports/benchmark-report.md`에 기록한다. audit row 10,000건의 첫 page와 중간 cursor page `EXPLAIN (ANALYZE, BUFFERS)` 결과를 함께 기록한다. 측정하지 않은 수치는 적지 않는다.

- [ ] **Step 6: 최종 검증과 commit**

Run in order:

```text
npm ci
npm run prisma:generate
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:concurrency
npm run test:contract
npm run test:security
npm run openapi:check
npm run build
docker compose config
docker compose up --build --wait
npm run test:smoke
```

Expected: 모든 명령 exit 0, container healthy, 문서 링크와 secret scan 통과.

Commit: `ci: Docker 재현 환경과 전체 검증 파이프라인 완성 (#N)`

PR title: `🚨 ci(docker,docs): 재현 실행과 전체 검증 파이프라인 완성`

---

## 각 Task의 PR 종료 절차

1. `git diff --check`와 Task에 적힌 전체 검증을 새로 실행한다.
2. 변경 파일만 명시적으로 stage한다.
3. 한국어 commit과 실제 Issue 번호를 확인한다.
4. 작업 branch를 origin에 push한다.
5. `Closes #N`과 명령별 결과를 포함한 ready PR을 `dev` 대상으로 만든다.
6. self-review와 CI를 확인한 뒤 Merge commit 또는 Rebase로 병합하고 Squash는 사용하지 않는다.
7. Task 9 완료 후 전체 CI와 Docker smoke를 다시 실행해 `dev → main` release PR을 만든다.
