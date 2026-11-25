# ERD

```mermaid
erDiagram
  PROJECTS ||--o{ API_KEYS : owns
  PROJECTS ||--o{ USAGE_EVENTS : records
  PROJECTS ||--o{ DAILY_USAGE : aggregates
  PROJECTS ||--o{ AUDIT_LOGS : owns
  API_KEYS ||--o{ USAGE_EVENTS : authenticates
  API_KEYS o|--o{ AUDIT_LOGS : actor
  API_KEYS o|--o{ AUDIT_LOGS : resource

  PROJECTS {
    uuid id PK
    varchar name
    bigint daily_quota_units
    timestamptz created_at
  }
  API_KEYS {
    uuid id PK
    uuid project_id FK
    varchar name
    varchar prefix UK
    bytea secret_digest
    text_array scopes
    api_key_status status
    timestamptz created_at
    timestamptz revoked_at
  }
  USAGE_EVENTS {
    uuid id PK
    uuid project_id FK
    uuid api_key_id FK
    uuid idempotency_key
    bytea payload_hash
    date usage_date
    bigint units
    usage_decision decision
    smallint response_status
    bigint quota_limit_units
    bigint quota_remaining_units
    timestamptz quota_reset_at
    timestamptz received_at
    timestamptz finalized_at
  }
  DAILY_USAGE {
    uuid project_id PK,FK
    date usage_date PK
    bigint used_units
    bigint limit_units
    timestamptz updated_at
  }
  AUDIT_LOGS {
    uuid id PK
    uuid project_id FK
    uuid actor_key_id FK
    audit_action action
    uuid resource_api_key_id FK
    uuid request_id
    jsonb metadata
    timestamptz created_at
  }
```

모든 자식 관계는 `project_id`를 tenant 경계로 사용합니다. `usage_events`의 idempotency uniqueness는 단일 열이 아니라 `(project_id, idempotency_key)` 복합 제약입니다. Key를 참조하는 usage/audit FK도 `(project_id, api_key_id)` 복합 관계이므로 다른 Project의 Key 결합을 DB가 거부합니다. 전체 constraint·index는 [DB 명세](../specs/database-schema.md)에 있습니다.
