-- This reviewed migration is intentionally hand-authored: Prisma schema cannot
-- express PostgreSQL CHECK constraints, partial indexes, or the tenant-scoped
-- composite foreign keys required by the database contract.
CREATE TYPE api_key_status AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE usage_decision AS ENUM ('PENDING', 'ACCEPTED', 'QUOTA_EXCEEDED');
CREATE TYPE audit_action AS ENUM ('PROJECT_CREATED', 'API_KEY_CREATED', 'API_KEY_REVOKED');

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  daily_quota_units bigint NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_ck CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT projects_daily_quota_units_ck CHECK (daily_quota_units BETWEEN 1 AND 1000000000)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  prefix varchar(39) NOT NULL,
  secret_digest bytea NOT NULL,
  scopes text[] NOT NULL,
  status api_key_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  revoked_at timestamptz(3),
  CONSTRAINT api_keys_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT api_keys_project_id_id_uq UNIQUE (project_id, id),
  CONSTRAINT api_keys_prefix_uq UNIQUE (prefix),
  CONSTRAINT api_keys_name_ck CHECK (char_length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  CONSTRAINT api_keys_prefix_ck CHECK (prefix = 'mq_' || id::text),
  CONSTRAINT api_keys_secret_digest_ck CHECK (octet_length(secret_digest) = 32),
  CONSTRAINT api_keys_scopes_dimension_ck CHECK (array_ndims(scopes) = 1),
  CONSTRAINT api_keys_scopes_cardinality_ck CHECK (cardinality(scopes) BETWEEN 1 AND 4),
  CONSTRAINT api_keys_scopes_allowlist_ck CHECK (scopes <@ ARRAY['usage:write','usage:read','keys:manage','audit:read']::text[]),
  CONSTRAINT api_keys_status_revoked_at_ck CHECK ((status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_at >= created_at))
);
CREATE INDEX api_keys_project_cursor_idx ON api_keys (project_id, created_at DESC, id DESC);
CREATE INDEX api_keys_active_project_idx ON api_keys (project_id) WHERE status = 'ACTIVE';

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  payload_hash bytea NOT NULL,
  usage_date date NOT NULL,
  units bigint NOT NULL,
  decision usage_decision NOT NULL DEFAULT 'PENDING',
  response_status smallint,
  quota_limit_units bigint,
  quota_remaining_units bigint,
  quota_reset_at timestamptz(3),
  received_at timestamptz(3) NOT NULL,
  finalized_at timestamptz(3),
  CONSTRAINT usage_events_project_idempotency_key_uq UNIQUE (project_id, idempotency_key),
  CONSTRAINT usage_events_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT usage_events_project_api_key_fk FOREIGN KEY (project_id, api_key_id) REFERENCES api_keys(project_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT usage_events_idempotency_key_version_ck CHECK (uuid_extract_version(idempotency_key) IS NOT DISTINCT FROM 4),
  CONSTRAINT usage_events_payload_hash_ck CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT usage_events_units_ck CHECK (units BETWEEN 1 AND 10000),
  CONSTRAINT usage_events_usage_date_ck CHECK (usage_date = (received_at AT TIME ZONE 'UTC')::date),
  CONSTRAINT usage_events_decision_snapshot_ck CHECK ((decision = 'PENDING' AND response_status IS NULL AND quota_limit_units IS NULL AND quota_remaining_units IS NULL AND quota_reset_at IS NULL AND finalized_at IS NULL) OR (decision = 'ACCEPTED' AND response_status = 200 AND quota_limit_units IS NOT NULL AND quota_remaining_units IS NOT NULL AND quota_reset_at IS NOT NULL AND finalized_at IS NOT NULL) OR (decision = 'QUOTA_EXCEEDED' AND response_status = 429 AND quota_limit_units IS NOT NULL AND quota_remaining_units IS NOT NULL AND quota_reset_at IS NOT NULL AND finalized_at IS NOT NULL)),
  CONSTRAINT usage_events_quota_snapshot_ck CHECK (quota_limit_units IS NULL OR (quota_limit_units BETWEEN 1 AND 1000000000 AND quota_remaining_units BETWEEN 0 AND quota_limit_units)),
  CONSTRAINT usage_events_finalized_at_ck CHECK (finalized_at IS NULL OR finalized_at >= received_at),
  CONSTRAINT usage_events_quota_reset_at_ck CHECK (quota_reset_at IS NULL OR quota_reset_at = ((usage_date + 1)::timestamp AT TIME ZONE 'UTC'))
);
CREATE INDEX usage_events_project_api_key_idx ON usage_events (project_id, api_key_id);

CREATE TABLE daily_usage (
  project_id uuid NOT NULL,
  usage_date date NOT NULL,
  used_units bigint NOT NULL DEFAULT 0,
  limit_units bigint NOT NULL,
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, usage_date),
  CONSTRAINT daily_usage_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT daily_usage_limit_units_ck CHECK (limit_units BETWEEN 1 AND 1000000000),
  CONSTRAINT daily_usage_used_units_ck CHECK (used_units BETWEEN 0 AND limit_units)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  actor_key_id uuid,
  action audit_action NOT NULL,
  resource_api_key_id uuid,
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT audit_logs_project_actor_key_fk FOREIGN KEY (project_id, actor_key_id) REFERENCES api_keys(project_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT audit_logs_project_resource_api_key_fk FOREIGN KEY (project_id, resource_api_key_id) REFERENCES api_keys(project_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT audit_logs_metadata_ck CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_logs_action_keys_ck CHECK ((action = 'PROJECT_CREATED' AND actor_key_id IS NULL AND resource_api_key_id IS NULL) OR (action IN ('API_KEY_CREATED', 'API_KEY_REVOKED') AND actor_key_id IS NOT NULL AND resource_api_key_id IS NOT NULL))
);
CREATE INDEX audit_logs_project_cursor_idx ON audit_logs (project_id, created_at DESC, id DESC);
CREATE INDEX audit_logs_actor_fk_idx ON audit_logs (project_id, actor_key_id) WHERE actor_key_id IS NOT NULL;
CREATE INDEX audit_logs_resource_api_key_fk_idx ON audit_logs (project_id, resource_api_key_id) WHERE resource_api_key_id IS NOT NULL;
