import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseUrl = (
  process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`
).replace(/\/$/, '');

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  return { body, response };
}

test('Compose app exposes exact live and ready health contracts', async () => {
  const live = await getJson('/health/live');
  assert.equal(live.response.status, 200);
  assert.deepStrictEqual(live.body, { status: 'ok' });

  const ready = await getJson('/health/ready');
  assert.equal(ready.response.status, 200);
  assert.deepStrictEqual(ready.body, { status: 'ready' });
});

test('Compose app serves the generated API contract without credentials', async () => {
  const openApi = await getJson('/openapi.json');
  assert.equal(openApi.response.status, 200);
  assert.equal(openApi.body.openapi, '3.0.0');
  assert.ok(openApi.body.paths['/v1/usage-events']?.post);
  assert.ok(openApi.body.paths['/v1/audit-logs']?.get);
});

test('Compose app serves the explicitly enabled Swagger UI', async () => {
  const response = await fetch(`${baseUrl}/docs`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /swagger-ui/);
});

test('Compose metrics reject anonymous requests and accept the metrics token', async () => {
  const anonymous = await getJson('/metrics');
  assert.equal(anonymous.response.status, 401);
  assert.equal(anonymous.body.code, 'INVALID_METRICS_TOKEN');
  assert.ok(process.env.METRICS_TOKEN, 'METRICS_TOKEN is required for smoke');
  const authorized = await fetch(`${baseUrl}/metrics`, {
    headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(authorized.status, 200);
  assert.match(authorized.headers.get('content-type'), /text\/plain/);
  assert.match(await authorized.text(), /# HELP/);
});
