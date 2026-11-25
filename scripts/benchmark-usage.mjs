import { randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function nearestRankPercentile(samples, percentile) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new TypeError('At least one measured sample is required.');
  }
  if (!(percentile > 0 && percentile <= 1)) {
    throw new RangeError('Percentile must be in the interval (0, 1].');
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export async function runBoundedWorkers(concurrency, itemCount, visit) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer.');
  }
  if (!Number.isInteger(itemCount) || itemCount < 0) {
    throw new RangeError('Item count must be a non-negative integer.');
  }
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= itemCount) return;
      await visit(index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, itemCount) }, () => worker()),
  );
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function postUsage(baseUrl, credential, timeoutMs) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/v1/usage-events`, {
    body: '{"units":1}',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (response.status !== 200 || body.decision !== 'ACCEPTED') {
    throw new Error(
      `Benchmark request failed: status=${response.status} decision=${body.decision ?? body.code ?? 'unknown'}`,
    );
  }
  return performance.now() - startedAt;
}

export async function runBenchmark(options = {}) {
  const baseUrl = (
    options.baseUrl ??
    process.env.BASE_URL ??
    `http://127.0.0.1:${process.env.PORT ?? '3000'}`
  ).replace(/\/$/, '');
  const credential = options.credential ?? process.env.BENCHMARK_API_KEY;
  if (!credential || !credential.startsWith('mq_')) {
    throw new Error(
      'BENCHMARK_API_KEY must be supplied through the environment.',
    );
  }
  const appImageDigest = options.appImageDigest ?? process.env.APP_IMAGE_DIGEST;
  const postgresVersion =
    options.postgresVersion ?? process.env.POSTGRES_VERSION;
  const npmVersion =
    options.npmVersion ??
    process.env.npm_config_user_agent?.match(/npm\/([^ ]+)/)?.[1];
  if (!appImageDigest) {
    throw new Error('APP_IMAGE_DIGEST is required for benchmark provenance.');
  }
  if (!postgresVersion) {
    throw new Error('POSTGRES_VERSION is required for benchmark provenance.');
  }
  if (!npmVersion) {
    throw new Error('npm version provenance is required. Run through npm.');
  }
  const warmup = positiveInteger(
    options.warmup ?? process.env.BENCHMARK_WARMUP ?? 20,
    'warmup',
  );
  const requestsPerWorker = positiveInteger(
    options.requestsPerWorker ??
      process.env.BENCHMARK_REQUESTS_PER_WORKER ??
      50,
    'requestsPerWorker',
  );
  const repetitions = positiveInteger(
    options.repetitions ?? process.env.BENCHMARK_REPETITIONS ?? 3,
    'repetitions',
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? process.env.BENCHMARK_TIMEOUT_MS ?? 30_000,
    'timeoutMs',
  );
  const concurrencyLevels = options.concurrencyLevels ?? [1, 10, 50, 100];
  if (
    !Array.isArray(concurrencyLevels) ||
    concurrencyLevels.length === 0 ||
    concurrencyLevels.some(
      (level) => !Number.isInteger(level) || level < 1 || level > 1_000,
    )
  ) {
    throw new Error(
      'concurrencyLevels must contain positive integers up to 1000.',
    );
  }

  const results = [];
  for (const concurrency of concurrencyLevels) {
    const itemCount = concurrency * requestsPerWorker;
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      await runBoundedWorkers(concurrency, concurrency * warmup, () =>
        postUsage(baseUrl, credential, timeoutMs),
      );
      const samples = new Array(itemCount);
      const startedAt = performance.now();
      await runBoundedWorkers(concurrency, itemCount, async (index) => {
        samples[index] = await postUsage(baseUrl, credential, timeoutMs);
      });
      const durationSeconds = (performance.now() - startedAt) / 1_000;
      results.push({
        concurrency,
        durationSeconds,
        p50Milliseconds: nearestRankPercentile(samples, 0.5),
        p95Milliseconds: nearestRankPercentile(samples, 0.95),
        p99Milliseconds: nearestRankPercentile(samples, 0.99),
        repetition,
        requestCount: itemCount,
        throughputPerSecond: itemCount / durationSeconds,
      });
    }
  }

  const cpu = cpus()[0];
  return {
    configuration: {
      concurrencyLevels,
      percentileMethod:
        'nearest-rank: sorted[Math.ceil(percentile * sampleCount) - 1]',
      warmupPolicy:
        'warmup requests per worker before every concurrency repetition',
      repetitions,
      requestsPerWorker,
      timeoutMs,
      warmup,
    },
    environment: {
      appImageDigest,
      commit:
        process.env.GITHUB_SHA ??
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      cpuLogicalCount: cpus().length,
      cpuModel: cpu?.model ?? 'unknown',
      node: process.version,
      npm: npmVersion,
      os: `${platform()} ${release()}`,
      postgres: postgresVersion,
      recordedAt: new Date().toISOString(),
    },
    results,
  };
}

async function main() {
  const report = await runBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
