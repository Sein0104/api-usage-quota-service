import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  nearestRankPercentile,
  runBoundedWorkers,
  runBenchmark,
} from '../../scripts/benchmark-usage.mjs';
import { assertExpectedDailyUsage } from '../../scripts/demo.mjs';
import {
  assertSafeText,
  verifyDocumentation,
} from '../../scripts/verify-docs.mjs';

const execFileAsync = promisify(execFile);

test('demo verifies the persisted daily usage values', () => {
  assert.doesNotThrow(() =>
    assertExpectedDailyUsage(
      {
        items: [
          {
            limitUnits: 5,
            remainingUnits: 4,
            updatedAt: '2026-09-21T00:00:00.000Z',
            usageDate: '2026-09-21',
            usedUnits: 1,
          },
        ],
      },
      '2026-09-21',
    ),
  );
  assert.throws(
    () =>
      assertExpectedDailyUsage(
        {
          items: [
            {
              limitUnits: 5,
              remainingUnits: 5,
              updatedAt: '2026-09-21T00:00:00.000Z',
              usageDate: '2026-09-21',
              usedUnits: 0,
            },
          ],
        },
        '2026-09-21',
      ),
    /daily usage/i,
  );
});

test('nearest-rank percentiles are derived from sorted measured samples', () => {
  const samples = [8, 1, 4, 2, 16];
  assert.equal(nearestRankPercentile(samples, 0.5), 4);
  assert.equal(nearestRankPercentile(samples, 0.95), 16);
  assert.equal(nearestRankPercentile(samples, 0.99), 16);
  assert.deepStrictEqual(samples, [8, 1, 4, 2, 16]);
  assert.throws(() => nearestRankPercentile([], 0.5), /sample/i);
});

test('bounded workers never exceed the requested concurrency and visit each item once', async () => {
  let active = 0;
  let maximumActive = 0;
  const visited = [];

  await runBoundedWorkers(3, 11, async (index) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    visited.push(index);
    active -= 1;
  });

  assert.equal(maximumActive, 3);
  assert.deepStrictEqual(
    visited.toSorted((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test('benchmark rejects missing provenance before issuing an HTTP request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('must not be called');
  };
  try {
    await assert.rejects(
      () =>
        runBenchmark({
          concurrencyLevels: [1],
          credential: `mq_123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(43)}`,
          repetitions: 1,
          requestsPerWorker: 1,
          warmup: 1,
        }),
      /APP_IMAGE_DIGEST/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('benchmark validates every response and performs exact per-worker warmup', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ decision: 'ACCEPTED' }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  };
  try {
    const report = await runBenchmark({
      appImageDigest: 'sha256:test-image',
      concurrencyLevels: [2],
      credential: `mq_123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(43)}`,
      npmVersion: '11.13.0',
      postgresVersion: '18.3',
      repetitions: 1,
      requestsPerWorker: 3,
      warmup: 2,
    });
    assert.equal(calls, 10); // 2 workers × 2 warmup + 2 workers × 3 measured
    assert.equal(report.results[0].requestCount, 6);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ decision: 'QUOTA_EXCEEDED' }), {
        headers: { 'content-type': 'application/json' },
        status: 429,
      });
    await assert.rejects(
      () =>
        runBenchmark({
          appImageDigest: 'sha256:test-image',
          concurrencyLevels: [1],
          credential: `mq_123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(43)}`,
          npmVersion: '11.13.0',
          postgresVersion: '18.3',
          repetitions: 1,
          requestsPerWorker: 1,
          warmup: 1,
        }),
      /status=429 decision=QUOTA_EXCEEDED/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('secret scanner rejects real credentials but accepts documented placeholders', () => {
  assert.doesNotThrow(() =>
    assertSafeText(
      'Authorization: Bearer <SYSTEM_ADMIN_TOKEN>\nDATABASE_URL=postgresql://postgres:<PASSWORD>@postgres:5432/api_usage',
      'fixture.md',
    ),
  );
  assert.throws(
    () =>
      assertSafeText(
        `credential=mq_123e4567-e89b-42d3-a456-426614174000.${'a'.repeat(43)}`,
        'fixture.md',
      ),
    /credential/i,
  );
  assert.throws(
    () =>
      assertSafeText(`Authorization: Bearer ${'z'.repeat(43)}`, 'fixture.md'),
    /bearer/i,
  );
  assert.throws(
    () => assertSafeText(`API_KEY_PEPPER=${'q'.repeat(43)}`, 'Dockerfile'),
    /secret assignment/i,
  );
  assert.throws(
    () => assertSafeText(`POSTGRES_PASSWORD=${'d'.repeat(43)}`, 'compose.yaml'),
    /secret assignment/i,
  );
});

test('documentation verifier follows relative links and reports missing targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-docs-'));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '[Design](docs/design.md)\n');
  await writeFile(join(root, 'docs', 'design.md'), '# Design\n');
  await assert.doesNotReject(() => verifyDocumentation(root));

  await writeFile(join(root, 'README.md'), '[Missing](docs/missing.md)\n');
  await assert.rejects(() => verifyDocumentation(root), /missing/i);
});

test('documentation walker scans operational files while ignoring a private local env file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quota-scan-'));
  const localSecret = `local-${'s'.repeat(43)}`;
  const localDatabasePassword = `database-${'d'.repeat(35)}`;
  await execFileAsync('git', ['init'], { cwd: root });
  await writeFile(join(root, '.gitignore'), '.env\n');
  await writeFile(
    join(root, '.env'),
    `SYSTEM_ADMIN_TOKEN='${localSecret}'\nPOSTGRES_PASSWORD="${localDatabasePassword}"\n`,
  );
  await writeFile(join(root, 'README.md'), '# Safe\n');
  await writeFile(
    join(root, 'Dockerfile'),
    `ENV API_KEY_PEPPER=${'q'.repeat(43)}\n`,
  );
  await execFileAsync('git', ['add', '.gitignore', 'README.md'], { cwd: root });
  await assert.doesNotReject(() => verifyDocumentation(root));

  await execFileAsync('git', ['add', '-f', 'Dockerfile'], { cwd: root });
  await assert.rejects(() => verifyDocumentation(root), /secret assignment/i);

  await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n');
  await assert.doesNotReject(() => verifyDocumentation(root));
  await writeFile(join(root, 'README.md'), `# Leaked\n${localSecret}\n`);
  await assert.rejects(() => verifyDocumentation(root), /local secret/i);
  await writeFile(
    join(root, 'README.md'),
    `# Leaked database password\n${localDatabasePassword}\n`,
  );
  await assert.rejects(() => verifyDocumentation(root), /local secret/i);
});

test('GitHub Actions dependencies use immutable full commit SHAs', async () => {
  const allowed = new Set([
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ]);
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/benchmark.yml',
  ]) {
    const workflow = await readFile(path, 'utf8');
    const uses = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map(
      (match) => match[1],
    );
    assert.ok(uses.length > 0);
    for (const dependency of uses) {
      assert.match(dependency, /^[^@]+@[0-9a-f]{40}$/);
      assert.ok(
        allowed.has(dependency),
        `Unexpected action pin: ${dependency}`,
      );
    }
  }
});
