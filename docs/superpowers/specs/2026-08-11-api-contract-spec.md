# API Usage Metering and Quota Service — API Contract

## 1. 문서 지위

이 문서는 HTTP API의 구현·OpenAPI 생성·계약 테스트 기준이다. 상위 범위와 설계 이유는 [`2026-08-11-api-usage-quota-service-design.md`](./2026-08-11-api-usage-quota-service-design.md), 저장 구조와 제약은 [`2026-08-11-database-schema-spec.md`](./2026-08-11-database-schema-spec.md)를 따른다.

문서의 `MUST`, `MUST NOT`, `SHOULD`는 구현 요구사항이다. 이 문서와 생성된 OpenAPI가 다르면 구현 전 둘 중 하나를 수정해 일치시켜야 한다.

## 2. 공통 규약

### 2.1 Base URL과 media type

- API prefix: `/v1`
- JSON 요청: `Content-Type: application/json`
- body가 있는 성공 응답: `application/json`; `204`는 body와 Content-Type 없음
- 오류 응답: `application/problem+json`
- 메트릭: Prometheus text exposition format
- JSON field: `camelCase`
- DB·로그 field: `snake_case`
- JSON body에 명세되지 않은 field가 있으면 `400 VALIDATION_ERROR`
- body가 있는 endpoint에 다른 media type을 보내면 `415 UNSUPPORTED_MEDIA_TYPE`

### 2.2 값 표현

| 종류 | 표현 |
|---|---|
| UUID | canonical lowercase UUID 문자열 |
| 시각 | UTC RFC 3339, millisecond 정밀도. 예: `2026-08-11T15:10:30.123Z` |
| 날짜 | UTC `YYYY-MM-DD` |
| 수량 | JSON number. 모든 공개 범위가 JavaScript safe integer 안에 있음 |
| enum | 문서에 적힌 대문자 또는 scope 문자열만 허용 |
| nullable | schema가 명시한 field만 `null` 허용 |

이름은 앞뒤 공백을 제거해서 저장하지 않는다. 입력값이 이미 trim된 상태가 아니거나 trim 후 비어 있으면 validation error다.

### 2.3 Request ID

- 서버는 모든 요청 진입 시 UUID v4 `requestId`를 생성한다.
- 모든 응답에 `X-Request-Id: <requestId>`를 반환한다.
- 오류 body의 `requestId`는 response header와 같아야 한다.
- 클라이언트가 보낸 `X-Request-Id`는 신뢰하거나 그대로 전파하지 않는다.
- 로그와 audit row는 같은 request ID를 사용한다.

### 2.4 인증 형식

시스템 관리자와 Project API Key 모두 다음 header를 사용한다.

```http
Authorization: Bearer <credential>
```

- 시스템 관리자 credential은 `SYSTEM_ADMIN_TOKEN`과 constant-time 비교한다.
- Project credential 형식은 `mq_<key-id>.<secret>`이다.
- `<key-id>`는 canonical lowercase UUID다.
- `<secret>`은 256-bit 난수의 unpadded base64url 문자열이다.
- 누락·복수 Authorization header, 다른 scheme, malformed credential은 `401`이다.
- `401` 응답에는 `WWW-Authenticate: Bearer`를 포함한다.

### 2.5 Scope matrix

| Endpoint | 인증 | 필요 scope |
|---|---|---|
| `POST /v1/admin/projects` | System admin | 없음 |
| `POST /v1/api-keys` | Project API Key | `keys:manage` |
| `GET /v1/api-keys` | Project API Key | `keys:manage` |
| `DELETE /v1/api-keys/{id}` | Project API Key | `keys:manage` |
| `POST /v1/usage-events` | Project API Key | `usage:write` |
| `GET /v1/usage/daily` | Project API Key | `usage:read` |
| `GET /v1/audit-logs` | Project API Key | `audit:read` |
| `GET /health/live` | 없음 | 없음 |
| `GET /health/ready` | 없음 | 없음 |
| `GET /metrics` | 없음, MVP에서는 private network 전제 | 없음 |

유효한 Key가 필요 scope를 갖지 않으면 `403 INSUFFICIENT_SCOPE`다. Key가 가진 scope만 다른 Key에 발급할 수 있는 위임 모델은 사용하지 않는다. `keys:manage` 보유자는 허용된 네 scope의 임의 조합을 발급할 수 있다.

### 2.6 Validation과 오류 우선순위

보호 endpoint는 다음 순서로 검사한다.

1. Request ID 생성
2. Authorization 형식과 credential 검증
3. 필요 scope 검증
4. path, query, header, body validation
5. tenant 범위 resource 조회
6. domain invariant와 transaction 실행

따라서 인증되지 않은 요청은 path UUID나 resource 존재 여부가 잘못되어도 먼저 `401`을 받는다. 다른 Project의 resource는 존재 여부를 숨기기 위해 `404`로 응답한다.

## 3. 공통 schema

### 3.1 Scope

허용값은 다음 네 개뿐이다.

```json
["usage:write", "usage:read", "keys:manage", "audit:read"]
```

입력 배열은 1~4개이며 중복을 허용하지 않는다. 저장·응답 시 위 목록의 순서로 정렬한다.

### 3.2 Project

```json
{
  "id": "6a20c907-a5c9-4d5f-9598-41e37069af46",
  "name": "portfolio-demo",
  "dailyQuotaUnits": 1000,
  "createdAt": "2026-08-11T15:10:30.123Z"
}
```

### 3.3 ApiKeyMetadata

```json
{
  "id": "54de65a8-4102-41ef-b70f-d29606b1de67",
  "name": "ingest-worker",
  "prefix": "mq_54de65a8-4102-41ef-b70f-d29606b1de67",
  "scopes": ["usage:write"],
  "status": "ACTIVE",
  "createdAt": "2026-08-11T15:10:30.123Z",
  "revokedAt": null
}
```

`status`는 `ACTIVE` 또는 `REVOKED`다. 원문 secret이나 digest는 metadata에 포함하지 않는다.

### 3.4 QuotaSnapshot

```json
{
  "limit": 1000,
  "remaining": 997,
  "resetAt": "2026-08-12T00:00:00.000Z"
}
```

`0 <= remaining <= limit`이며 `resetAt`은 `usageDate` 다음 UTC 자정이다.

### 3.5 Problem Details

기본 오류 body는 다음과 같다.

```json
{
  "type": "urn:api-usage-quota-service:problem:validation-error",
  "title": "Validation failed",
  "status": 400,
  "detail": "Request validation failed.",
  "code": "VALIDATION_ERROR",
  "requestId": "1d321f66-3d62-48e9-b82b-f1ed290ec138",
  "errors": [
    {
      "field": "dailyQuotaUnits",
      "reason": "must be an integer between 1 and 1000000000"
    }
  ]
}
```

- `type`은 `urn:api-usage-quota-service:problem:<kebab-case-code>`다.
- `errors`는 `VALIDATION_ERROR`와 `INVALID_CURSOR`에서만 선택적으로 사용한다.
- 내부 exception, SQL, stack trace, secret은 포함하지 않는다.
- 같은 오류에 대해 `title`은 안정적으로 유지하고 `detail`은 민감정보 없이 구체화할 수 있다.

### 3.6 Cursor page

목록 응답은 다음 envelope를 사용한다.

```json
{
  "items": [],
  "nextCursor": null
}
```

- query: `cursor` optional, `limit` optional
- `limit`: integer `1..100`, default `50`
- 정렬: `(created_at DESC, id DESC)`
- cursor payload: `{"v":1,"createdAt":"<RFC3339>","id":"<UUID>"}`를 UTF-8 JSON으로 만든 뒤 unpadded base64url encoding
- cursor 이후 page는 strict-after 조건 `(created_at, id) < (:createdAt, :id)`를 사용한다.
- 서버는 `limit + 1`개를 읽고 다음 항목이 있을 때만 `nextCursor`를 반환한다.
- malformed, 지원하지 않는 version, 잘못된 field/type은 `400 INVALID_CURSOR`다.
- cursor는 opaque이며 인증 수단이 아니다. 모든 query는 별도로 인증된 `projectId`를 조건에 포함한다.

## 4. Endpoint 계약

### 4.1 `POST /v1/admin/projects`

Project와 최초 관리자 Key를 하나의 transaction에서 만든다.

Request:

```json
{
  "name": "portfolio-demo",
  "dailyQuotaUnits": 1000
}
```

Validation:

- `name`: string, `1..100`자, 앞뒤 공백 없음
- `dailyQuotaUnits`: integer, `1..1,000,000,000`
- Project 이름은 전역 unique가 아니며 같은 이름을 허용한다.

Success `201`:

```json
{
  "project": {
    "id": "6a20c907-a5c9-4d5f-9598-41e37069af46",
    "name": "portfolio-demo",
    "dailyQuotaUnits": 1000,
    "createdAt": "2026-08-11T15:10:30.123Z"
  },
  "apiKey": {
    "id": "54de65a8-4102-41ef-b70f-d29606b1de67",
    "name": "initial-admin",
    "prefix": "mq_54de65a8-4102-41ef-b70f-d29606b1de67",
    "scopes": ["usage:write", "usage:read", "keys:manage", "audit:read"],
    "status": "ACTIVE",
    "createdAt": "2026-08-11T15:10:30.123Z",
    "revokedAt": null
  },
  "secret": "mq_54de65a8-4102-41ef-b70f-d29606b1de67.<base64url-secret>"
}
```

원문 `secret`은 이 응답에서만 반환한다. `PROJECT_CREATED` audit metadata에 최초 Key ID를 포함하며 별도 `API_KEY_CREATED` row를 중복 생성하지 않는다. 이 endpoint는 MVP에서 idempotent하지 않다.

Errors: `400 VALIDATION_ERROR`, `401 INVALID_SYSTEM_ADMIN_TOKEN`, `415 UNSUPPORTED_MEDIA_TYPE`, `500 INTERNAL_ERROR`, `503 DEPENDENCY_UNAVAILABLE`.

### 4.2 `POST /v1/api-keys`

Request:

```json
{
  "name": "ingest-worker",
  "scopes": ["usage:write"]
}
```

Validation:

- `name`: string, `1..100`자, 앞뒤 공백 없음
- `scopes`: 허용값으로만 이루어진 중복 없는 배열, 길이 `1..4`

Success `201`:

```json
{
  "apiKey": {
    "id": "54de65a8-4102-41ef-b70f-d29606b1de67",
    "name": "ingest-worker",
    "prefix": "mq_54de65a8-4102-41ef-b70f-d29606b1de67",
    "scopes": ["usage:write"],
    "status": "ACTIVE",
    "createdAt": "2026-08-11T15:10:30.123Z",
    "revokedAt": null
  },
  "secret": "mq_54de65a8-4102-41ef-b70f-d29606b1de67.<base64url-secret>"
}
```

성공 시 Key와 `API_KEY_CREATED` audit row를 함께 commit한다.

Errors: `400 VALIDATION_ERROR`, `401 INVALID_API_KEY`, `403 INSUFFICIENT_SCOPE`, `409 ACTIVE_KEY_LIMIT_REACHED`, `415 UNSUPPORTED_MEDIA_TYPE`, `500 INTERNAL_ERROR`, `503 DEPENDENCY_UNAVAILABLE`.

### 4.3 `GET /v1/api-keys`

Query: `cursor`, `limit`. 활성·폐기 Key를 모두 반환한다.

Success `200`:

```json
{
  "items": [
    {
      "id": "54de65a8-4102-41ef-b70f-d29606b1de67",
      "name": "ingest-worker",
      "prefix": "mq_54de65a8-4102-41ef-b70f-d29606b1de67",
      "scopes": ["usage:write"],
      "status": "ACTIVE",
      "createdAt": "2026-08-11T15:10:30.123Z",
      "revokedAt": null
    }
  ],
  "nextCursor": null
}
```

Errors: `400 INVALID_CURSOR`, `401 INVALID_API_KEY`, `403 INSUFFICIENT_SCOPE`, `503 DEPENDENCY_UNAVAILABLE`.

### 4.4 `DELETE /v1/api-keys/{id}`

Path `id`는 canonical lowercase UUID다.

- 최초 폐기: `204`, body 없음, `API_KEY_REVOKED` audit row 한 건 생성
- 이미 폐기된 Key: `204`, body 없음, audit row 추가 생성 안 함
- 현재 요청 인증에 사용한 Key: `409 CANNOT_REVOKE_CURRENT_KEY`
- 다른 Project의 Key 또는 없는 Key: `404 RESOURCE_NOT_FOUND`

Errors: `400 VALIDATION_ERROR`, `401 INVALID_API_KEY`, `403 INSUFFICIENT_SCOPE`, `404 RESOURCE_NOT_FOUND`, `409 CANNOT_REVOKE_CURRENT_KEY`, `503 DEPENDENCY_UNAVAILABLE`.

### 4.5 `POST /v1/usage-events`

Required header:

```http
Idempotency-Key: 64f4ce08-03df-40fa-ae44-ebd9d584781f
```

canonical lowercase UUID v4만 허용한다.

Request:

```json
{
  "units": 3
}
```

`units`는 integer `1..10,000`이다.

Accepted `200`:

```json
{
  "eventId": "4919714e-564c-48e1-bc0a-c92f3c9a96f6",
  "decision": "ACCEPTED",
  "usageDate": "2026-08-11",
  "units": 3,
  "quota": {
    "limit": 1000,
    "remaining": 997,
    "resetAt": "2026-08-12T00:00:00.000Z"
  }
}
```

Quota exceeded `429`:

```json
{
  "type": "urn:api-usage-quota-service:problem:quota-exceeded",
  "title": "Daily quota exceeded",
  "status": 429,
  "detail": "Use a new idempotency key after the quota resets.",
  "code": "QUOTA_EXCEEDED",
  "requestId": "1d321f66-3d62-48e9-b82b-f1ed290ec138",
  "eventId": "4919714e-564c-48e1-bc0a-c92f3c9a96f6",
  "decision": "QUOTA_EXCEEDED",
  "usageDate": "2026-08-11",
  "units": 3,
  "quota": {
    "limit": 1000,
    "remaining": 1,
    "resetAt": "2026-08-12T00:00:00.000Z"
  }
}
```

`200`과 `429` 모두 다음 header를 반환한다.

```http
X-Quota-Limit: 1000
X-Quota-Remaining: <quota.remaining>
X-Quota-Reset: 1786492800
```

`X-Quota-Reset`은 `resetAt`의 Unix epoch seconds다. `Retry-After`는 반환하지 않는다.

#### Idempotency replay

- scope는 Project 전체 `(projectId, idempotencyKey)`다.
- payload identity는 `units`의 versioned hash로 판단한다.
- 같은 key·같은 payload는 최초 `eventId`, status, decision, usage date, units, quota snapshot과 quota header를 재사용한다.
- replay의 `X-Request-Id`, 오류 body `requestId`, HTTP `Date` header는 새 요청 값이다.
- 저장하는 terminal result는 `200 ACCEPTED`와 `429 QUOTA_EXCEEDED`뿐이다.
- 인증·인가·validation·`409`·`5xx` 결과는 idempotency record로 확정하지 않는다.
- 같은 key·다른 payload는 `409 IDEMPOTENCY_KEY_REUSED`다.
- `429`가 저장된 key는 다음 날에도 같은 `429`를 재생하므로 reset 후 새 논리 요청에는 새 key를 사용한다.

Errors: `400 VALIDATION_ERROR`, `401 INVALID_API_KEY`, `403 INSUFFICIENT_SCOPE`, `409 IDEMPOTENCY_KEY_REUSED`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 QUOTA_EXCEEDED`, `500 INTERNAL_ERROR`, `503 DEPENDENCY_UNAVAILABLE`, `503 CONCURRENT_REQUEST_RETRY_EXHAUSTED`.

### 4.6 `GET /v1/usage/daily`

Query:

- `from`: required UTC date
- `to`: required UTC date
- `from <= to`
- 양 끝 포함 최대 90일

Success `200`은 `usageDate ASC`로 정렬한다. `daily_usage` row가 없는 날짜는 생략한다. 거절 event만 있고 허용량이 0인 날짜도 row가 생성되므로 포함될 수 있다.

```json
{
  "items": [
    {
      "usageDate": "2026-08-11",
      "usedUnits": 20,
      "limitUnits": 1000,
      "remainingUnits": 980,
      "updatedAt": "2026-08-11T15:15:10.456Z"
    }
  ]
}
```

Errors: `400 VALIDATION_ERROR`, `401 INVALID_API_KEY`, `403 INSUFFICIENT_SCOPE`, `503 DEPENDENCY_UNAVAILABLE`.

### 4.7 `GET /v1/audit-logs`

Query: `cursor`, `limit`.

`action`은 `PROJECT_CREATED`, `API_KEY_CREATED`, `API_KEY_REVOKED`다. `resourceType`은 `PROJECT`, `API_KEY`다.

Success `200`:

```json
{
  "items": [
    {
      "id": "f608f511-5114-4fb5-9d39-eb7224e2b5dc",
      "action": "API_KEY_CREATED",
      "resourceType": "API_KEY",
      "resourceId": "54de65a8-4102-41ef-b70f-d29606b1de67",
      "actorKeyId": "10fb68ba-272f-488b-8197-a93b4a4ed96a",
      "requestId": "1d321f66-3d62-48e9-b82b-f1ed290ec138",
      "metadata": {
        "name": "ingest-worker",
        "prefix": "mq_54de65a8-4102-41ef-b70f-d29606b1de67",
        "scopes": ["usage:write"]
      },
      "createdAt": "2026-08-11T15:10:30.123Z"
    }
  ],
  "nextCursor": null
}
```

`PROJECT_CREATED`의 `actorKeyId`는 `null`이다. metadata에는 원문 secret, digest, Authorization header를 넣지 않는다.

DB는 polymorphic resource column을 사용하지 않는다. API mapper는 `PROJECT_CREATED`의 `resourceType=PROJECT`, `resourceId=projectId`를 만들고, Key action은 `resourceType=API_KEY`, `resourceId=resourceApiKeyId`를 만든다.

Errors: `400 INVALID_CURSOR`, `401 INVALID_API_KEY`, `403 INSUFFICIENT_SCOPE`, `503 DEPENDENCY_UNAVAILABLE`.

### 4.8 `GET /health/live`

Success `200`:

```json
{"status":"ok"}
```

외부 dependency를 확인하지 않는다.

### 4.9 `GET /health/ready`

PostgreSQL 연결과 migration 상태가 준비되면 `200`:

```json
{"status":"ready"}
```

준비되지 않으면 `503`:

```json
{"status":"not_ready"}
```

Probe 호환성을 위해 health endpoint는 Problem Details 예외다. 내부 DB 오류나 접속 문자열은 노출하지 않는다.

### 4.10 `GET /metrics`

- Success: `200`
- Content-Type: Prometheus client가 제공하는 text exposition content type
- 원문 credential, Project ID, Key ID를 label이나 sample 값에 포함하지 않는다.
- MVP에서는 인증 없이 제공하되 local 또는 private network 노출만 허용한다.
- 공개 배포 시 reverse proxy 또는 별도 운영 인증 계층 뒤에 둬야 하며, 이는 MVP 외부 인프라 범위다.

## 5. Error catalog

| Status | Code | 의미 |
|---:|---|---|
| 400 | `VALIDATION_ERROR` | body, path, query, header validation 실패 |
| 400 | `INVALID_CURSOR` | cursor decoding 또는 schema 실패 |
| 401 | `INVALID_SYSTEM_ADMIN_TOKEN` | 관리자 token 누락·불일치 |
| 401 | `INVALID_API_KEY` | API Key 누락·형식·digest·폐기 상태 오류 |
| 403 | `INSUFFICIENT_SCOPE` | 필요 scope 없음 |
| 404 | `RESOURCE_NOT_FOUND` | 현재 tenant에서 resource 없음 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 같은 key와 다른 payload |
| 409 | `CANNOT_REVOKE_CURRENT_KEY` | 현재 인증 Key 자체 폐기 시도 |
| 409 | `ACTIVE_KEY_LIMIT_REACHED` | 활성 Key 20개 상한 |
| 429 | `QUOTA_EXCEEDED` | UTC 일일 quota 부족 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | JSON body endpoint에 다른 media type 사용 |
| 500 | `INTERNAL_ERROR` | 예상하지 못한 서버 오류 |
| 503 | `DEPENDENCY_UNAVAILABLE` | PostgreSQL 사용 불가 |
| 503 | `CONCURRENT_REQUEST_RETRY_EXHAUSTED` | idempotency 경합 재시도 소진 |

## 6. Contract test minimum

1. 생성된 OpenAPI의 모든 endpoint, status, schema가 이 문서와 일치한다.
2. 모든 JSON DTO는 unknown field를 거부한다.
3. 각 보호 endpoint가 `401`, `403`, success를 구분한다.
4. cross-tenant resource 조회·폐기가 `404`이며 존재 여부를 노출하지 않는다.
5. cursor 첫 page·중간 page·끝 page·invalid cursor를 검증한다.
6. usage `200`과 `429`의 quota body와 header가 일치한다.
7. 같은 idempotency key 100회 replay가 같은 terminal result를 반환한다.
8. 다른 payload 충돌이 `409`이며 quota를 추가 차감하지 않는다.
9. 모든 오류의 Content-Type, Problem Details 필수 field, request ID를 검증한다.
10. health와 metrics가 secret 또는 상세 dependency 오류를 노출하지 않는다.
