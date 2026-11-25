import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const baseUrl = (
  process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`
).replace(/\/$/, '');

async function request(path, options = {}, expectedStatuses = [200]) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `Unexpected ${response.status} from ${path}: ${body?.code ?? 'unknown'}`,
    );
  }
  return { body, headers: response.headers, status: response.status };
}

export function assertExpectedDailyUsage(body, usageDate) {
  const item = Array.isArray(body?.items)
    ? body.items.find((candidate) => candidate?.usageDate === usageDate)
    : undefined;
  if (
    item?.usedUnits !== 1 ||
    item?.limitUnits !== 5 ||
    item?.remainingUnits !== 4
  ) {
    throw new Error('Daily usage did not persist the expected quota values.');
  }
}

export async function runDemo({
  systemAdminToken = process.env.SYSTEM_ADMIN_TOKEN,
} = {}) {
  if (!systemAdminToken || systemAdminToken.startsWith('<')) {
    throw new Error(
      'SYSTEM_ADMIN_TOKEN must be supplied through the environment.',
    );
  }
  const project = await request(
    '/v1/admin/projects',
    {
      body: JSON.stringify({ dailyQuotaUnits: 5, name: 'demo-project' }),
      headers: {
        authorization: `Bearer ${systemAdminToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    },
    [201],
  );
  const apiKey = project.body?.secret;
  if (typeof apiKey !== 'string' || !apiKey.startsWith('mq_')) {
    throw new Error('Project bootstrap did not return an API credential.');
  }
  const secondary = await request(
    '/v1/api-keys',
    {
      body: JSON.stringify({
        name: 'demo-writer',
        scopes: ['usage:write', 'usage:read'],
      }),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    },
    [201],
  );
  const secondaryKey = secondary.body?.secret;
  const secondaryId = secondary.body?.apiKey?.id;
  if (typeof secondaryKey !== 'string' || typeof secondaryId !== 'string') {
    throw new Error(
      'Secondary key creation did not return its one-time secret.',
    );
  }
  const listed = await request('/v1/api-keys?limit=50', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!listed.body.items.some((item) => item.id === secondaryId)) {
    throw new Error('Secondary key is absent from its project key list.');
  }
  const idempotencyKey = randomUUID();
  const usageOptions = {
    body: JSON.stringify({ units: 1 }),
    headers: {
      authorization: `Bearer ${secondaryKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    method: 'POST',
  };
  const usage = await request('/v1/usage-events', usageOptions, [200]);
  if (usage.body?.decision !== 'ACCEPTED') {
    throw new Error(`Unexpected usage decision ${usage.body?.decision}.`);
  }
  const replay = await request('/v1/usage-events', usageOptions, [200]);
  if (
    replay.body.eventId !== usage.body.eventId ||
    JSON.stringify(replay.body.quota) !== JSON.stringify(usage.body.quota)
  ) {
    throw new Error('Idempotency replay changed the stored terminal result.');
  }
  const usageDate = usage.body?.usageDate;
  if (typeof usageDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) {
    throw new Error('Accepted usage did not return its UTC usage date.');
  }
  const daily = await request(
    `/v1/usage/daily?from=${usageDate}&to=${usageDate}`,
    { headers: { authorization: `Bearer ${secondaryKey}` } },
  );
  assertExpectedDailyUsage(daily.body, usageDate);
  const audit = await request('/v1/audit-logs?limit=10', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!audit.body.items.some((item) => item.action === 'API_KEY_CREATED')) {
    throw new Error('API key creation audit row is missing.');
  }
  await request(
    `/v1/api-keys/${secondaryId}`,
    { headers: { authorization: `Bearer ${apiKey}` }, method: 'DELETE' },
    [204],
  );
  const revoked = await request(
    `/v1/usage/daily?from=${usageDate}&to=${usageDate}`,
    { headers: { authorization: `Bearer ${secondaryKey}` } },
    [401],
  );
  if (revoked.body.code !== 'INVALID_API_KEY') {
    throw new Error('Revoked credential did not fail closed.');
  }
  const finalAudit = await request('/v1/audit-logs?limit=10', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (
    !finalAudit.body.items.some((item) => item.action === 'API_KEY_REVOKED')
  ) {
    throw new Error('API key revocation audit row is missing.');
  }
  return {
    auditCount: finalAudit.body.items.length,
    daily: daily.body,
    projectId: project.body.project.id,
    secondaryKeyId: secondaryId,
    usage: usage.body,
  };
}

async function main() {
  const result = await runDemo();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
