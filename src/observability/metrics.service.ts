import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

export const HTTP_ROUTES = [
  'POST /v1/admin/projects',
  'POST /v1/api-keys',
  'GET /v1/api-keys',
  'DELETE /v1/api-keys/{id}',
  'POST /v1/usage-events',
  'GET /v1/usage/daily',
  'GET /v1/audit-logs',
  'GET /health/live',
  'GET /health/ready',
  'GET /metrics',
  'GET /docs',
  'GET /openapi.json',
  'UNMATCHED',
] as const;
export type HttpRoute = (typeof HTTP_ROUTES)[number];
export type ApiKeyAuthFailureReason =
  'MISSING_OR_MALFORMED' | 'INVALID_OR_REVOKED';
export type QuotaDecision = 'ACCEPTED' | 'QUOTA_EXCEEDED';
export type TransactionKind =
  'PROJECT_BOOTSTRAP' | 'API_KEY_CREATE' | 'API_KEY_REVOKE' | 'USAGE_INGEST';

const statusAllowlist = new Set([
  200, 201, 204, 400, 401, 403, 404, 409, 415, 429, 500, 503,
]);
const transactionAllowlist = new Set<TransactionKind>([
  'PROJECT_BOOTSTRAP',
  'API_KEY_CREATE',
  'API_KEY_REVOKE',
  'USAGE_INGEST',
]);

export function canonicalHttpRoute(
  method: string,
  originalUrl: string,
): HttpRoute {
  const path =
    originalUrl.split('?', 1)[0].toLowerCase().replace(/\/$/, '') || '/';
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'DELETE' && /^\/v1\/api-keys\/[^/]+$/.test(path)) {
    return 'DELETE /v1/api-keys/{id}';
  }
  const candidate = `${normalizedMethod} ${path}`;
  return (HTTP_ROUTES as readonly string[]).includes(candidate)
    ? (candidate as HttpRoute)
    : 'UNMATCHED';
}

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly httpRequests = new Counter({
    help: 'Completed HTTP requests.',
    labelNames: ['route', 'status'] as const,
    name: 'http_requests_total',
    registers: [this.registry],
  });
  private readonly httpDuration = new Histogram({
    help: 'Completed HTTP request duration in seconds.',
    labelNames: ['route'] as const,
    name: 'http_request_duration_seconds',
    registers: [this.registry],
  });
  private readonly apiKeyFailures = new Counter({
    help: 'Project API key authentication failures.',
    labelNames: ['reason'] as const,
    name: 'api_key_auth_failures_total',
    registers: [this.registry],
  });
  private readonly quotaDecisions = new Counter({
    help: 'Newly committed quota decisions.',
    labelNames: ['decision'] as const,
    name: 'quota_decisions_total',
    registers: [this.registry],
  });
  private readonly acceptedUnits = new Counter({
    help: 'Newly committed accepted usage units.',
    name: 'usage_units_accepted_total',
    registers: [this.registry],
  });
  private readonly transactionDuration = new Histogram({
    help: 'Database transaction attempt duration in seconds.',
    labelNames: ['transaction'] as const,
    name: 'db_transaction_duration_seconds',
    registers: [this.registry],
  });

  readonly contentType = this.registry.contentType;

  observeHttp(
    method: string,
    originalUrl: string,
    statusCode: number,
    seconds: number,
  ): void {
    const route = canonicalHttpRoute(method, originalUrl);
    const status = statusAllowlist.has(statusCode)
      ? String(statusCode)
      : 'OTHER';
    this.httpRequests.inc({ route, status });
    this.httpDuration.observe({ route }, Math.max(0, seconds));
  }

  recordApiKeyAuthFailure(reason: ApiKeyAuthFailureReason): void {
    if (reason !== 'MISSING_OR_MALFORMED' && reason !== 'INVALID_OR_REVOKED') {
      throw new RangeError('Unsupported API key authentication metric label.');
    }
    this.apiKeyFailures.inc({ reason });
  }

  recordQuotaDecision(decision: QuotaDecision, units: number): void {
    if (decision !== 'ACCEPTED' && decision !== 'QUOTA_EXCEEDED') {
      throw new RangeError('Unsupported quota decision metric label.');
    }
    this.quotaDecisions.inc({ decision });
    if (decision === 'ACCEPTED') {
      if (!Number.isSafeInteger(units) || units < 1)
        throw new RangeError('Invalid accepted units.');
      this.acceptedUnits.inc(units);
    }
  }

  observeTransaction(transaction: TransactionKind, seconds: number): void {
    if (!transactionAllowlist.has(transaction)) {
      throw new RangeError('Unsupported transaction metric label.');
    }
    this.transactionDuration.observe({ transaction }, Math.max(0, seconds));
  }

  exposition(): Promise<string> {
    return this.registry.metrics();
  }
}
