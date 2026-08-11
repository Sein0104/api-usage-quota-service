# API Usage Metering and Quota Service — Database Schema

## 1. 문서 지위

이 문서는 PostgreSQL schema, Prisma mapping, migration, transaction 구현의 기준이다. HTTP 표현은 [`api-contract.md`](./api-contract.md), 상위 설계와 범위는 [`service-design.md`](../architecture/service-design.md)를 따른다.

실제 `prisma/schema.prisma`와 migration SQL은 이 문서의 제약을 모두 구현해야 한다. Prisma schema로 표현할 수 없는 `CHECK`, partial index, 일부 복합 FK는 생성된 migration SQL을 명시적으로 편집해 추가한다.

## 2. Database baseline

- PostgreSQL: `18.x`
- schema: `public`
- application과 DB session timezone: `UTC`
- isolation: 기본 `READ COMMITTED`
- UUID: PostgreSQL `uuid`, 신규 PK는 원칙적으로 `gen_random_uuid()`. `api_keys.id`만 prefix 생성 때문에 애플리케이션이 먼저 만든다.
- timestamp: `timestamptz(3)`
- calendar day: `date`
- quota와 units: `bigint`
- digest와 hash: raw 32-byte `bytea`
- naming: table·column·constraint·index는 `snake_case`
- 모든 FK: `ON DELETE RESTRICT ON UPDATE CASCADE`

Project 삭제는 MVP 범위 밖이므로 cascade delete를 사용하지 않는다. 테스트 fixture 정리는 FK 역순의 명시적 delete 또는 database/schema 재생성으로 수행한다.

## 3. Enum과 상수

### 3.1 Native PostgreSQL enum

```sql
CREATE TYPE api_key_status AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE usage_decision AS ENUM ('PENDING', 'ACCEPTED', 'QUOTA_EXCEEDED');
CREATE TYPE audit_action AS ENUM ('PROJECT_CREATED', 'API_KEY_CREATED', 'API_KEY_REVOKED');
```

### 3.2 Scope allowlist

`api_keys.scopes`는 `text[]`로 저장하고 다음 값만 허용한다.

```text
usage:write
usage:read
keys:manage
audit:read
```

DB는 1차원 배열, `cardinality(scopes) BETWEEN 1 AND 4`, allowlist subset을 `CHECK`한다. 애플리케이션은 중복을 거부하고 위 목록 순서로 정렬한 뒤 저장한다. MVP에서는 scope join table이나 custom array uniqueness function을 추가하지 않으므로 중복 없음은 application invariant와 통합 테스트로 보장한다.

## 4. Table specification

### 4.1 `projects`

| Column | Type | Null | Default | 규칙 |
|---|---|---:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `name` | `varchar(100)` | no | 없음 | 길이 `1..100`, 앞뒤 공백 없음 |
| `daily_quota_units` | `bigint` | no | 없음 | `1..1,000,000,000` |
| `created_at` | `timestamptz(3)` | no | `now()` | MVP API에서 update하지 않음 |

Constraints:

```sql
PRIMARY KEY (id)
CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name))
CHECK (daily_quota_units BETWEEN 1 AND 1000000000)
```

Project 이름은 전역 unique가 아니다. `daily_quota_units`는 MVP에서 수정 endpoint가 없어 application write contract상 불변이지만, 별도 trigger로 raw SQL update까지 차단하지는 않는다.

### 4.2 `api_keys`

| Column | Type | Null | Default | 규칙 |
|---|---|---:|---|---|
| `id` | `uuid` | no | 없음 | 애플리케이션이 생성하는 PK, 공개 Key ID |
| `project_id` | `uuid` | no | 없음 | Project FK |
| `name` | `varchar(100)` | no | 없음 | 길이 `1..100`, 앞뒤 공백 없음 |
| `prefix` | `varchar(39)` | no | 없음 | `mq_` + 전체 UUID |
| `secret_digest` | `bytea` | no | 없음 | HMAC-SHA-256 raw 32 bytes |
| `scopes` | `text[]` | no | 없음 | 허용 scope `1..4`개 |
| `status` | `api_key_status` | no | `'ACTIVE'` | 상태 |
| `created_at` | `timestamptz(3)` | no | `now()` | 생성 시각 |
| `revoked_at` | `timestamptz(3)` | yes | `NULL` | 폐기 시각 |

Constraints:

```sql
PRIMARY KEY (id)
FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE RESTRICT ON UPDATE CASCADE
UNIQUE (project_id, id)
UNIQUE (prefix)
CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name))
CHECK (prefix = 'mq_' || id::text)
CHECK (octet_length(secret_digest) = 32)
CHECK (array_ndims(scopes) = 1)
CHECK (cardinality(scopes) BETWEEN 1 AND 4)
CHECK (scopes <@ ARRAY['usage:write','usage:read','keys:manage','audit:read']::text[])
CHECK (
  (status = 'ACTIVE' AND revoked_at IS NULL) OR
  (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
)
```

Indexes:

```sql
CREATE INDEX api_keys_project_cursor_idx
  ON api_keys (project_id, created_at DESC, id DESC);

CREATE INDEX api_keys_active_project_idx
  ON api_keys (project_id)
  WHERE status = 'ACTIVE';
```

애플리케이션은 UUID를 먼저 생성하고 같은 insert에 `id`와 `prefix = 'mq_' || id`를 함께 전달한다.

원문 secret은 이 table을 포함한 어떤 영속 저장소에도 기록하지 않는다. 인증은 `id`로 row를 찾고 애플리케이션에서 계산한 digest를 constant-time 비교한다.

### 4.3 `usage_events`

| Column | Type | Null | Default | 규칙 |
|---|---|---:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `project_id` | `uuid` | no | 없음 | tenant |
| `api_key_id` | `uuid` | no | 없음 | 요청 인증 Key |
| `idempotency_key` | `uuid` | no | 없음 | Project 범위 UUID v4 |
| `payload_hash` | `bytea` | no | 없음 | SHA-256 raw 32 bytes |
| `usage_date` | `date` | no | 없음 | `received_at`의 UTC date |
| `units` | `bigint` | no | 없음 | `1..10,000` |
| `decision` | `usage_decision` | no | `'PENDING'` | 내부·최종 상태 |
| `response_status` | `smallint` | yes | `NULL` | 최종 `200` 또는 `429` |
| `quota_limit_units` | `bigint` | yes | `NULL` | 최종 snapshot |
| `quota_remaining_units` | `bigint` | yes | `NULL` | 최종 snapshot |
| `quota_reset_at` | `timestamptz(3)` | yes | `NULL` | 다음 UTC 자정 |
| `received_at` | `timestamptz(3)` | no | 없음 | 애플리케이션 진입 시각 |
| `finalized_at` | `timestamptz(3)` | yes | `NULL` | 최종 결정 시각 |

Keys and foreign keys:

```sql
PRIMARY KEY (id)
UNIQUE (project_id, idempotency_key)
FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE RESTRICT ON UPDATE CASCADE
FOREIGN KEY (project_id, api_key_id) REFERENCES api_keys(project_id, id)
  ON DELETE RESTRICT ON UPDATE CASCADE
```

Checks:

```sql
CHECK (uuid_extract_version(idempotency_key) IS NOT DISTINCT FROM 4)
CHECK (octet_length(payload_hash) = 32)
CHECK (units BETWEEN 1 AND 10000)
CHECK (usage_date = (received_at AT TIME ZONE 'UTC')::date)
CHECK (
  (decision = 'PENDING'
    AND response_status IS NULL
    AND quota_limit_units IS NULL
    AND quota_remaining_units IS NULL
    AND quota_reset_at IS NULL
    AND finalized_at IS NULL)
  OR
  (decision = 'ACCEPTED'
    AND response_status = 200
    AND quota_limit_units IS NOT NULL
    AND quota_remaining_units IS NOT NULL
    AND quota_reset_at IS NOT NULL
    AND finalized_at IS NOT NULL)
  OR
  (decision = 'QUOTA_EXCEEDED'
    AND response_status = 429
    AND quota_limit_units IS NOT NULL
    AND quota_remaining_units IS NOT NULL
    AND quota_reset_at IS NOT NULL
    AND finalized_at IS NOT NULL)
)
CHECK (
  quota_limit_units IS NULL OR
  (quota_limit_units BETWEEN 1 AND 1000000000
   AND quota_remaining_units BETWEEN 0 AND quota_limit_units)
)
CHECK (finalized_at IS NULL OR finalized_at >= received_at)
CHECK (
  quota_reset_at IS NULL OR
  quota_reset_at = ((usage_date + 1)::timestamp AT TIME ZONE 'UTC')
)
```

Index:

```sql
CREATE INDEX usage_events_project_api_key_idx
  ON usage_events (project_id, api_key_id);
```

`UNIQUE (project_id, idempotency_key)`가 idempotency lookup index 역할을 하므로 같은 column의 추가 index를 만들지 않는다.

DB `CHECK`는 commit 시 `PENDING` row가 남는 것 자체를 막지 못한다. “성공적으로 commit된 요청 뒤 `PENDING` 0건”은 application transaction invariant이며 통합 테스트로 검증한다.

### 4.4 `daily_usage`

| Column | Type | Null | Default | 규칙 |
|---|---|---:|---|---|
| `project_id` | `uuid` | no | 없음 | Project FK |
| `usage_date` | `date` | no | 없음 | UTC date |
| `used_units` | `bigint` | no | `0` | 허용된 누적량 |
| `limit_units` | `bigint` | no | 없음 | 해당 date 한도 snapshot |
| `updated_at` | `timestamptz(3)` | no | `now()` | 생성·갱신 시각 |

Constraints:

```sql
PRIMARY KEY (project_id, usage_date)
FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE RESTRICT ON UPDATE CASCADE
CHECK (limit_units BETWEEN 1 AND 1000000000)
CHECK (used_units BETWEEN 0 AND limit_units)
```

PK가 Project의 날짜 범위 조회를 지원하므로 별도 일별 조회 index를 만들지 않는다.

### 4.5 `audit_logs`

| Column | Type | Null | Default | 규칙 |
|---|---|---:|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `project_id` | `uuid` | no | 없음 | tenant |
| `actor_key_id` | `uuid` | yes | `NULL` | System action이면 null |
| `action` | `audit_action` | no | 없음 | allowlist |
| `resource_api_key_id` | `uuid` | yes | `NULL` | API Key action의 대상 |
| `request_id` | `uuid` | no | 없음 | HTTP request ID |
| `metadata` | `jsonb` | no | `'{}'::jsonb` | 민감정보 없는 객체 |
| `created_at` | `timestamptz(3)` | no | `now()` | 기록 시각 |

Keys and checks:

```sql
PRIMARY KEY (id)
FOREIGN KEY (project_id) REFERENCES projects(id)
  ON DELETE RESTRICT ON UPDATE CASCADE
FOREIGN KEY (project_id, actor_key_id) REFERENCES api_keys(project_id, id)
  ON DELETE RESTRICT ON UPDATE CASCADE
FOREIGN KEY (project_id, resource_api_key_id) REFERENCES api_keys(project_id, id)
  ON DELETE RESTRICT ON UPDATE CASCADE
CHECK (jsonb_typeof(metadata) = 'object')
CHECK (
  (action = 'PROJECT_CREATED'
    AND actor_key_id IS NULL
    AND resource_api_key_id IS NULL)
  OR
  (action IN ('API_KEY_CREATED', 'API_KEY_REVOKED')
    AND actor_key_id IS NOT NULL
    AND resource_api_key_id IS NOT NULL)
)
```

Indexes:

```sql
CREATE INDEX audit_logs_project_cursor_idx
  ON audit_logs (project_id, created_at DESC, id DESC);

CREATE INDEX audit_logs_actor_fk_idx
  ON audit_logs (project_id, actor_key_id)
  WHERE actor_key_id IS NOT NULL;

CREATE INDEX audit_logs_resource_api_key_fk_idx
  ON audit_logs (project_id, resource_api_key_id)
  WHERE resource_api_key_id IS NOT NULL;
```

`metadata`에 대한 GIN index는 MVP query가 없으므로 만들지 않는다.

Metadata application schemas:

| Action | Metadata fields |
|---|---|
| `PROJECT_CREATED` | `projectName`, `dailyQuotaUnits`, `initialApiKeyId` |
| `API_KEY_CREATED` | `name`, `prefix`, `scopes` |
| `API_KEY_REVOKED` | `name`, `prefix` |

원문 secret, digest, Authorization header는 metadata에 금지한다.

HTTP mapper는 `PROJECT_CREATED`를 `resourceType=PROJECT`, `resourceId=project_id`로 반환한다. 나머지는 `resourceType=API_KEY`, `resourceId=resource_api_key_id`로 반환한다. polymorphic `resource_id`를 저장하지 않아 API Key 대상의 tenant 일치를 복합 FK로 강제한다.

## 5. Cursor query contract

API Key와 audit 목록은 다음 keyset pagination 형태를 사용한다.

First page:

```sql
WHERE project_id = :projectId
ORDER BY created_at DESC, id DESC
LIMIT :limitPlusOne;
```

Next page:

```sql
WHERE project_id = :projectId
  AND (created_at, id) < (:cursorCreatedAt, :cursorId)
ORDER BY created_at DESC, id DESC
LIMIT :limitPlusOne;
```

offset pagination은 사용하지 않는다. Cursor 입력은 query parameter binding을 사용하며 SQL 문자열에 연결하지 않는다.

## 6. Transaction and lock contract

### 6.1 Project bootstrap

한 transaction에서 다음을 수행한다.

1. Project insert
2. 네 scope를 가진 `initial-admin` API Key insert
3. `PROJECT_CREATED` audit insert

어느 단계든 실패하면 모두 rollback한다.

### 6.2 API Key create

Lock order는 항상 Project row 후 API Key row다.

1. `SELECT id FROM projects WHERE id = :projectId FOR UPDATE`
2. partial index를 이용해 활성 Key count
3. 20개면 `ACTIVE_KEY_LIMIT_REACHED`
4. Key insert
5. `API_KEY_CREATED` audit insert
6. commit

동일 Project의 Key create를 직렬화해 활성 20개 상한을 지킨다.

### 6.3 API Key revoke

1. Project row `FOR UPDATE`
2. `(project_id, id)`로 target Key 조회·lock
3. 현재 인증 Key면 rollback 후 `CANNOT_REVOKE_CURRENT_KEY`
4. 이미 `REVOKED`면 변경·audit 없이 commit하고 `204`
5. `status`, `revoked_at` update
6. `API_KEY_REVOKED` audit insert
7. commit

### 6.4 Usage event ingest

상위 설계의 조건부 UPDATE 알고리즘을 사용한다. Prisma interactive transaction 안에서 parameterized `$queryRaw`/`$executeRaw`만 사용한다.

필수 invariant:

- idempotency insert와 payload 비교가 quota 변경보다 먼저다.
- `daily_usage` 생성, 조건부 차감, usage event 최종화가 한 transaction이다.
- `QUOTA_EXCEEDED`도 terminal row로 commit한다.
- transient `5xx`에서는 새 terminal idempotency row를 commit하지 않는다.
- transaction retry는 idempotency 경합에서만 최대 3회이며 고정된 짧은 backoff를 사용한다.

## 7. Prisma and raw SQL boundary

Prisma Client를 사용하는 영역:

- Project insert와 단순 조회
- API Key metadata CRUD
- 일별 사용량 조회
- audit cursor 조회
- 기본 transaction orchestration

Raw SQL을 사용하는 영역:

- `FOR UPDATE` lock
- `INSERT ... ON CONFLICT DO NOTHING RETURNING`
- quota 조건부 `UPDATE ... RETURNING`
- keyset tuple comparison
- Prisma schema로 표현할 수 없는 migration constraint와 partial index

규칙:

- dynamic value는 반드시 parameter binding한다.
- table·column·order 문자열을 request 값으로 조립하지 않는다.
- `prisma`와 `@prisma/client` major/minor를 항상 일치시킨다.
- Prisma `BigInt`는 API mapper에서 `0..1,000,000,000` 범위를 다시 검사한 뒤 JSON number로 변환한다.

## 8. Migration policy

- migration 파일은 Git에 commit한다.
- 개발은 `prisma migrate dev`, CI·배포는 `prisma migrate deploy`를 사용한다.
- 애플리케이션 프로세스가 자동으로 migration을 실행하지 않는다.
- Compose는 일회성 `migrate` service가 성공한 뒤 app을 시작한다.
- CI는 빈 PostgreSQL 18 database에 migration 전체를 적용한다.
- Prisma가 생성한 migration을 편집했다면 파일 상단 comment에 custom constraint/index 이유를 기록한다.
- 이미 공유된 migration 파일은 수정하지 않고 새 migration으로 변경한다.
- schema drift check와 실제 PostgreSQL 통합 테스트를 모두 통과해야 한다.

## 9. Database verification minimum

1. 모든 migration이 빈 PostgreSQL 18 instance에 적용된다.
2. `prisma/schema.prisma`와 migration 결과가 drift 없이 일치한다.
3. 각 `CHECK`, unique, FK에 대해 실패하는 raw SQL integration test가 하나 이상 있다.
4. cross-tenant `(project_id, api_key_id)`, `(project_id, actor_key_id)`, `(project_id, resource_api_key_id)` insert가 DB에서 실패한다.
5. Key create 동시 실행에서 활성 Key가 20개를 넘지 않는다.
6. quota 20에 100개 동시 요청을 보내 정확히 20개만 `ACCEPTED`다.
7. 같은 idempotency key 100개 경합 후 event가 한 건이고 quota가 한 번만 증가한다.
8. 강제 exception 뒤 usage event와 `daily_usage`가 함께 rollback된다.
9. 성공적으로 처리된 요청 뒤 committed `PENDING` row가 0개다.
10. cursor query가 지정 index를 사용하는지 `EXPLAIN (ANALYZE, BUFFERS)`로 확인한다.
