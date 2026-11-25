import { NestFactory } from '@nestjs/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppModule } from '../app.module.js';
import { configureApplication } from '../main.js';
import { createOpenApiDocument, stableOpenApiJson } from '../openapi.js';
import type { Environment } from '../config/environment.schema.js';

export const OPENAPI_PATH = resolve('docs/openapi/openapi.json');

function generationEnvironment(): Environment {
  return {
    API_KEY_PEPPER: 'p'.repeat(43),
    DATABASE_URL:
      'postgresql://postgres:postgres@127.0.0.1:5432/openapi_generation',
    LOG_LEVEL: 'fatal',
    METRICS_TOKEN: 'm'.repeat(43),
    NODE_ENV: 'test',
    PORT: 3000,
    SWAGGER_ENABLED: true,
    SYSTEM_ADMIN_TOKEN: 's'.repeat(43),
    TZ: 'UTC',
  };
}

export async function generateOpenApiJson(): Promise<string> {
  const app = await NestFactory.create(
    AppModule.forRoot(generationEnvironment()),
    { logger: false },
  );
  try {
    configureApplication(app);
    await app.init();
    return stableOpenApiJson(createOpenApiDocument(app));
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const generated = await generateOpenApiJson();
  if (process.argv.includes('--check')) {
    const committed = await readFile(OPENAPI_PATH, 'utf8').catch(() => '');
    if (generated !== committed) {
      throw new Error(
        'Generated OpenAPI differs from docs/openapi/openapi.json.',
      );
    }
    return;
  }
  await mkdir(dirname(OPENAPI_PATH), { recursive: true });
  await writeFile(OPENAPI_PATH, generated, 'utf8');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
