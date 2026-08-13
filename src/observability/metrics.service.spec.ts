import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('publishes only allowlisted low-cardinality labels', async () => {
    const metrics = new MetricsService();

    metrics.observeHttp('GET', '/v1/api-keys?cursor=secret', 200, 0.25);
    metrics.observeHttp('TRACE', '/unknown/123', 418, 0.5);
    metrics.recordApiKeyAuthFailure('MISSING_OR_MALFORMED');
    metrics.recordQuotaDecision('ACCEPTED', 3);

    const exposition = await metrics.exposition();
    expect(exposition).toContain(
      'http_requests_total{route="GET /v1/api-keys",status="200"} 1',
    );
    expect(exposition).toContain(
      'http_requests_total{route="UNMATCHED",status="OTHER"} 1',
    );
    expect(exposition).toContain(
      'api_key_auth_failures_total{reason="MISSING_OR_MALFORMED"} 1',
    );
    expect(exposition).toContain(
      'quota_decisions_total{decision="ACCEPTED"} 1',
    );
    expect(exposition).toContain('usage_units_accepted_total 3');
    expect(exposition).not.toContain('secret');
    expect(exposition).not.toContain('/unknown/123');
  });

  it('rejects non-allowlisted domain labels instead of exporting them', () => {
    const metrics = new MetricsService();
    expect(() =>
      metrics.recordApiKeyAuthFailure('PROJECT_ID' as never),
    ).toThrow();
    expect(() => metrics.recordQuotaDecision('REPLAY' as never, 0)).toThrow();
    expect(() => metrics.observeTransaction('OTHER' as never, 1)).toThrow();
  });
});
