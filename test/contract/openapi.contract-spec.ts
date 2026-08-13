import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import { readFile } from 'node:fs/promises';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import {
  createOpenApiDocument,
  finalizeOpenApiDocument,
} from '../../src/openapi.js';
import { testEnvironment } from '../support/test-environment.js';

const openApiMethods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
] as const;

function expectLocalReferencesToResolve(document: OpenAPIObject): void {
  const references: string[] = [];
  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      if (
        key === '$ref' &&
        typeof nested === 'string' &&
        nested.startsWith('#/')
      ) {
        references.push(nested);
      } else {
        collect(nested);
      }
    }
  }
  collect(document);

  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    const target = reference
      .slice(2)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce<unknown>((value, part) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !Object.hasOwn(value, part)
        ) {
          return undefined;
        }
        return (value as Record<string, unknown>)[part];
      }, document);
    expect(target).toBeDefined();
  }
}

describe('OpenAPI common contract', () => {
  it('adds common 500/503 responses to every v1 operation and a two-code usage 503', () => {
    const source = {
      components: { schemas: {} },
      info: { title: 'test', version: '1' },
      openapi: '3.0.0',
      paths: {
        '/v1/api-keys': { get: { responses: { 200: { description: 'ok' } } } },
        '/v1/usage-events': {
          post: { responses: { 200: { description: 'ok' } } },
        },
        '/health/ready': {
          get: { responses: { 503: { description: 'not ready' } } },
        },
      },
    } as unknown as OpenAPIObject;

    const document = finalizeOpenApiDocument(source);

    expect(document.paths['/v1/api-keys']?.get?.responses).toHaveProperty(
      '500',
    );
    expect(document.paths['/v1/api-keys']?.get?.responses).toHaveProperty(
      '503',
    );
    const usage503 = document.paths['/v1/usage-events']?.post?.responses?.[503];
    expect(usage503).toMatchObject({
      content: {
        'application/problem+json': {
          schema: {
            oneOf: [
              { $ref: '#/components/schemas/DependencyUnavailableProblem' },
              {
                $ref: '#/components/schemas/ConcurrentRequestRetryExhaustedProblem',
              },
            ],
          },
        },
      },
    });
    expect(
      document.paths['/health/ready']?.get?.responses?.[503],
    ).toMatchObject({
      description: 'not ready',
    });
  });
});

describe('generated OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(testEnvironment())],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
    document = createOpenApiDocument(app);
  });

  afterAll(async () => app.close());

  it('documents the exact security scheme for each route family', () => {
    expect(document.components?.securitySchemes).toEqual(
      expect.objectContaining({
        metricsBearer: expect.any(Object),
        projectApiKeyBearer: expect.any(Object),
        systemAdminBearer: expect.any(Object),
      }),
    );
    expect(document.paths['/v1/admin/projects']?.post?.security).toEqual([
      { systemAdminBearer: [] },
    ]);
    expect(document.paths['/v1/api-keys']?.get?.security).toEqual([
      { projectApiKeyBearer: [] },
    ]);
    expect(document.paths['/metrics']?.get?.security).toEqual([
      { metricsBearer: [] },
    ]);
    expect(document.paths['/health/live']?.get?.security).toBeUndefined();
    for (const scheme of Object.values(
      document.components?.securitySchemes ?? {},
    )) {
      expect(scheme).toMatchObject({
        bearerFormat: 'opaque',
        scheme: 'bearer',
        type: 'http',
      });
    }
  });

  it('documents every v1 operation with common errors and the usage oneOf', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      if (!path.startsWith('/v1/')) continue;
      for (const operation of Object.values(item)) {
        if (
          typeof operation !== 'object' ||
          operation === null ||
          !('responses' in operation)
        )
          continue;
        expect(operation.responses).toHaveProperty('500');
        expect(operation.responses).toHaveProperty('503');
      }
    }
    expect(
      document.paths['/v1/usage-events']?.post?.responses?.['503'],
    ).toMatchObject({
      content: {
        'application/problem+json': {
          schema: {
            oneOf: [
              { $ref: '#/components/schemas/DependencyUnavailableProblem' },
              {
                $ref: '#/components/schemas/ConcurrentRequestRetryExhaustedProblem',
              },
            ],
          },
        },
      },
    });
  });

  it('documents hidden request parameters and readiness media type exactly', () => {
    expect(document.paths['/v1/usage-events']?.post?.parameters).toContainEqual(
      expect.objectContaining({
        in: 'header',
        name: 'Idempotency-Key',
        required: true,
      }),
    );
    expect(document.paths['/v1/usage/daily']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ in: 'query', name: 'from', required: true }),
        expect.objectContaining({ in: 'query', name: 'to', required: true }),
      ]),
    );
    expect(
      document.paths['/health/ready']?.get?.responses?.['503'],
    ).toHaveProperty('content.application/json');
  });

  it('closes object schemas and binds audit actions to exact metadata variants', () => {
    for (const schema of Object.values(document.components?.schemas ?? {})) {
      if (
        typeof schema === 'object' &&
        schema !== null &&
        'properties' in schema
      ) {
        expect(schema).toHaveProperty('additionalProperties', false);
      }
    }
    expect(document.components?.schemas?.AuditLogModel).toEqual({
      discriminator: {
        mapping: {
          API_KEY_CREATED: '#/components/schemas/ApiKeyCreatedAuditLog',
          API_KEY_REVOKED: '#/components/schemas/ApiKeyRevokedAuditLog',
          PROJECT_CREATED: '#/components/schemas/ProjectCreatedAuditLog',
        },
        propertyName: 'action',
      },
      oneOf: [
        { $ref: '#/components/schemas/ProjectCreatedAuditLog' },
        { $ref: '#/components/schemas/ApiKeyCreatedAuditLog' },
        { $ref: '#/components/schemas/ApiKeyRevokedAuditLog' },
      ],
    });
    expect(document.components?.schemas?.ProjectCreatedAuditLog).toMatchObject({
      additionalProperties: false,
      properties: {
        action: { enum: ['PROJECT_CREATED'], type: 'string' },
        actorKeyId: { enum: [null], nullable: true, type: 'string' },
        metadata: { $ref: '#/components/schemas/ProjectCreatedMetadataModel' },
        resourceType: { enum: ['PROJECT'], type: 'string' },
      },
    });
    expect(
      (
        document.components?.schemas?.ProjectCreatedAuditLog as {
          properties?: { actorKeyId?: { type?: string } };
        }
      ).properties?.actorKeyId?.type,
    ).not.toBe('null');
  });

  it('uses Problem Details media for every error except readiness 503', () => {
    for (const [path, item] of Object.entries(document.paths)) {
      for (const operation of Object.values(item)) {
        if (
          typeof operation !== 'object' ||
          operation === null ||
          !('responses' in operation)
        ) {
          continue;
        }
        const responses = operation.responses as Record<
          string,
          { $ref?: string; content?: Record<string, unknown> }
        >;
        for (const [status, response] of Object.entries(responses)) {
          if (Number(status) < 400 || '$ref' in response) continue;
          const mediaTypes = Object.keys(response.content ?? {});
          if (path === '/health/ready' && status === '503') {
            expect(mediaTypes).toEqual(['application/json']);
          } else {
            expect(mediaTypes).toEqual(['application/problem+json']);
          }
        }
      }
    }
  });

  it('documents issued secrets as required response-only fields without values', () => {
    for (const name of [
      'ApiKeyCreateResponseModel',
      'ProjectBootstrapResponseModel',
    ]) {
      const schema = document.components?.schemas?.[name] as {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      expect(schema.required).toContain('secret');
      expect(schema.properties?.secret).toEqual({
        format: 'password',
        pattern:
          '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[A-Za-z0-9_-]{43}$',
        readOnly: true,
        type: 'string',
      });
    }
  });

  it('resolves every local OpenAPI reference', () => {
    expectLocalReferencesToResolve(document);
  });

  it('documents the exact quota problem and terminal response headers', () => {
    const responses = document.paths['/v1/usage-events']?.post?.responses;
    expect(responses?.['429']).toMatchObject({
      content: {
        'application/problem+json': {
          schema: { $ref: '#/components/schemas/QuotaExceededProblem' },
        },
      },
    });
    const quotaProblem = document.components?.schemas?.QuotaExceededProblem as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
      required?: string[];
      type?: string;
    };
    expect(quotaProblem).toMatchObject({
      additionalProperties: false,
      properties: {
        code: { enum: ['QUOTA_EXCEEDED'], type: 'string' },
        decision: { enum: ['QUOTA_EXCEEDED'], type: 'string' },
        eventId: { format: 'uuid', type: 'string' },
        quota: { $ref: '#/components/schemas/QuotaSnapshotModel' },
        status: { enum: [429], type: 'integer' },
        units: { maximum: 10_000, minimum: 1, type: 'integer' },
        usageDate: { format: 'date', type: 'string' },
      },
      type: 'object',
    });
    expect(new Set(quotaProblem.required)).toEqual(
      new Set([
        'type',
        'title',
        'status',
        'detail',
        'code',
        'requestId',
        'eventId',
        'decision',
        'usageDate',
        'units',
        'quota',
      ]),
    );
    for (const status of ['200', '429']) {
      const response = responses?.[status] as
        { headers?: Record<string, unknown> } | undefined;
      expect(Object.keys(response?.headers ?? {}).sort()).toEqual([
        'X-Quota-Limit',
        'X-Quota-Remaining',
        'X-Quota-Reset',
        'X-Request-Id',
      ]);
    }
  });

  it('documents request ids on every response and Bearer challenges on every 401', () => {
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        if (
          typeof operation !== 'object' ||
          operation === null ||
          !('responses' in operation)
        ) {
          continue;
        }
        const responses = operation.responses as Record<
          string,
          { headers?: Record<string, unknown> }
        >;
        for (const [status, response] of Object.entries(responses)) {
          expect(response.headers?.['X-Request-Id']).toMatchObject({
            required: true,
            schema: { format: 'uuid', type: 'string' },
          });
          if (status === '401') {
            expect(response.headers?.['WWW-Authenticate']).toMatchObject({
              required: true,
              schema: { enum: ['Bearer'], type: 'string' },
            });
          }
        }
      }
    }
  });

  it('uses exact health states and integer schemas for integer-only values', () => {
    expect(
      document.paths['/health/live']?.get?.responses?.['200'],
    ).toHaveProperty(
      'content.application/json.schema.$ref',
      '#/components/schemas/LiveHealth',
    );
    expect(
      document.paths['/health/ready']?.get?.responses?.['200'],
    ).toHaveProperty(
      'content.application/json.schema.$ref',
      '#/components/schemas/ReadyHealth',
    );
    expect(
      document.paths['/health/ready']?.get?.responses?.['503'],
    ).toHaveProperty(
      'content.application/json.schema.$ref',
      '#/components/schemas/NotReadyHealth',
    );
    expect(document.components?.schemas?.LiveHealth).toMatchObject({
      additionalProperties: false,
      properties: { status: { enum: ['ok'], type: 'string' } },
    });
    expect(document.components?.schemas?.ReadyHealth).toMatchObject({
      additionalProperties: false,
      properties: { status: { enum: ['ready'], type: 'string' } },
    });
    expect(document.components?.schemas?.NotReadyHealth).toMatchObject({
      additionalProperties: false,
      properties: { status: { enum: ['not_ready'], type: 'string' } },
    });

    const numberSchemas: string[] = [];
    function findNumberSchemas(value: unknown, path: string): void {
      if (Array.isArray(value)) {
        value.forEach((nested, index) =>
          findNumberSchemas(nested, `${path}/${index}`),
        );
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      if ((value as { type?: unknown }).type === 'number') {
        numberSchemas.push(path);
      }
      for (const [key, nested] of Object.entries(value)) {
        findNumberSchemas(nested, `${path}/${key}`);
      }
    }
    findNumberSchemas(document, '#');
    expect(numberSchemas).toEqual([]);
  });

  it('binds every operation-specific error to its exact code and status', () => {
    const titleByCode: Record<string, string> = {
      ACTIVE_KEY_LIMIT_REACHED: 'Active API key limit reached',
      CANNOT_REVOKE_CURRENT_KEY: 'Cannot revoke current API key',
      CONCURRENT_REQUEST_RETRY_EXHAUSTED: 'Concurrent request retry exhausted',
      DEPENDENCY_UNAVAILABLE: 'Dependency unavailable',
      IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused',
      INSUFFICIENT_SCOPE: 'Insufficient scope',
      INVALID_API_KEY: 'Invalid API key',
      INVALID_CURSOR: 'Invalid cursor',
      INVALID_METRICS_TOKEN: 'Invalid metrics token',
      INVALID_SYSTEM_ADMIN_TOKEN: 'Invalid system administrator token',
      INTERNAL_ERROR: 'Internal server error',
      QUOTA_EXCEEDED: 'Daily quota exceeded',
      RESOURCE_NOT_FOUND: 'Resource not found',
      UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
      VALIDATION_ERROR: 'Validation failed',
    };
    const schemaByCode: Record<string, string> = {
      ACTIVE_KEY_LIMIT_REACHED: 'ActiveKeyLimitReachedProblem',
      CANNOT_REVOKE_CURRENT_KEY: 'CannotRevokeCurrentKeyProblem',
      IDEMPOTENCY_KEY_REUSED: 'IdempotencyKeyReusedProblem',
      INSUFFICIENT_SCOPE: 'InsufficientScopeProblem',
      INVALID_API_KEY: 'InvalidApiKeyProblem',
      INVALID_CURSOR: 'InvalidCursorProblem',
      INVALID_METRICS_TOKEN: 'InvalidMetricsTokenProblem',
      INVALID_SYSTEM_ADMIN_TOKEN: 'InvalidSystemAdminTokenProblem',
      INTERNAL_ERROR: 'InternalErrorProblem',
      QUOTA_EXCEEDED: 'QuotaExceededProblem',
      RESOURCE_NOT_FOUND: 'ResourceNotFoundProblem',
      UNSUPPORTED_MEDIA_TYPE: 'UnsupportedMediaTypeProblem',
      VALIDATION_ERROR: 'ValidationErrorProblem',
    };
    const expected: Record<string, Record<string, string[]>> = {
      'POST /v1/admin/projects': {
        '400': ['VALIDATION_ERROR'],
        '401': ['INVALID_SYSTEM_ADMIN_TOKEN'],
        '415': ['UNSUPPORTED_MEDIA_TYPE'],
      },
      'POST /v1/api-keys': {
        '400': ['VALIDATION_ERROR'],
        '401': ['INVALID_API_KEY'],
        '403': ['INSUFFICIENT_SCOPE'],
        '409': ['ACTIVE_KEY_LIMIT_REACHED'],
        '415': ['UNSUPPORTED_MEDIA_TYPE'],
      },
      'GET /v1/api-keys': {
        '400': ['INVALID_CURSOR', 'VALIDATION_ERROR'],
        '401': ['INVALID_API_KEY'],
        '403': ['INSUFFICIENT_SCOPE'],
      },
      'DELETE /v1/api-keys/{id}': {
        '400': ['VALIDATION_ERROR'],
        '401': ['INVALID_API_KEY'],
        '403': ['INSUFFICIENT_SCOPE'],
        '404': ['RESOURCE_NOT_FOUND'],
        '409': ['CANNOT_REVOKE_CURRENT_KEY'],
      },
      'POST /v1/usage-events': {
        '400': ['VALIDATION_ERROR'],
        '401': ['INVALID_API_KEY'],
        '403': ['INSUFFICIENT_SCOPE'],
        '409': ['IDEMPOTENCY_KEY_REUSED'],
        '415': ['UNSUPPORTED_MEDIA_TYPE'],
        '429': ['QUOTA_EXCEEDED'],
      },
      'GET /v1/usage/daily': {
        '400': ['VALIDATION_ERROR'],
        '401': ['INVALID_API_KEY'],
        '403': ['INSUFFICIENT_SCOPE'],
      },
      'GET /v1/audit-logs': {
        '400': ['INVALID_CURSOR', 'VALIDATION_ERROR'],
        '401': ['INVALID_API_KEY'],
        '403': ['INSUFFICIENT_SCOPE'],
      },
      'GET /metrics': {
        '401': ['INVALID_METRICS_TOKEN'],
        '500': ['INTERNAL_ERROR'],
      },
      'GET /health/ready': { '500': ['INTERNAL_ERROR'] },
    };
    const methods = ['get', 'post', 'delete'] as const;
    for (const [route, responses] of Object.entries(expected)) {
      const [method, path] = route.split(' ') as [string, string];
      const operation =
        document.paths[path]?.[
          methods.find((candidate) => candidate === method.toLowerCase())!
        ];
      for (const [status, codes] of Object.entries(responses)) {
        const schema = (
          operation?.responses?.[status] as {
            content?: {
              'application/problem+json'?: { schema?: Record<string, unknown> };
            };
          }
        ).content?.['application/problem+json']?.schema;
        const refs =
          codes.length === 1
            ? [(schema as { $ref?: string }).$ref]
            : (schema as { oneOf?: { $ref: string }[] }).oneOf?.map(
                (item) => item.$ref,
              );
        expect(refs).toEqual(
          codes.map((code) => `#/components/schemas/${schemaByCode[code]}`),
        );
        const actual = refs?.map((reference, index) => {
          const name = reference?.split('/').at(-1) ?? '';
          const problem = document.components?.schemas?.[name] as {
            properties?: {
              code?: { enum?: string[] };
              status?: { enum?: number[] };
              title?: { enum?: string[]; type?: string };
              type?: { enum?: string[]; format?: string; type?: string };
            };
          };
          expect(problem.properties?.status?.enum).toEqual([Number(status)]);
          expect(problem.properties?.title).toEqual({
            enum: [titleByCode[codes[index]!]],
            type: 'string',
          });
          const code = problem.properties?.code?.enum?.[0];
          expect(problem.properties?.type).toEqual({
            enum: [
              `urn:api-usage-quota-service:problem:${code
                ?.toLowerCase()
                .replaceAll('_', '-')}`,
            ],
            format: 'uri',
            type: 'string',
          });
          return code;
        });
        expect(actual).toEqual(codes);
      }
    }
  });

  it('defines every code-specific problem with exact identity fields', () => {
    const expected: Record<
      string,
      { code: string; status: number; title: string }
    > = {
      ActiveKeyLimitReachedProblem: {
        code: 'ACTIVE_KEY_LIMIT_REACHED',
        status: 409,
        title: 'Active API key limit reached',
      },
      CannotRevokeCurrentKeyProblem: {
        code: 'CANNOT_REVOKE_CURRENT_KEY',
        status: 409,
        title: 'Cannot revoke current API key',
      },
      ConcurrentRequestRetryExhaustedProblem: {
        code: 'CONCURRENT_REQUEST_RETRY_EXHAUSTED',
        status: 503,
        title: 'Concurrent request retry exhausted',
      },
      DependencyUnavailableProblem: {
        code: 'DEPENDENCY_UNAVAILABLE',
        status: 503,
        title: 'Dependency unavailable',
      },
      IdempotencyKeyReusedProblem: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        status: 409,
        title: 'Idempotency key reused',
      },
      InsufficientScopeProblem: {
        code: 'INSUFFICIENT_SCOPE',
        status: 403,
        title: 'Insufficient scope',
      },
      InternalErrorProblem: {
        code: 'INTERNAL_ERROR',
        status: 500,
        title: 'Internal server error',
      },
      InvalidApiKeyProblem: {
        code: 'INVALID_API_KEY',
        status: 401,
        title: 'Invalid API key',
      },
      InvalidCursorProblem: {
        code: 'INVALID_CURSOR',
        status: 400,
        title: 'Invalid cursor',
      },
      InvalidMetricsTokenProblem: {
        code: 'INVALID_METRICS_TOKEN',
        status: 401,
        title: 'Invalid metrics token',
      },
      InvalidSystemAdminTokenProblem: {
        code: 'INVALID_SYSTEM_ADMIN_TOKEN',
        status: 401,
        title: 'Invalid system administrator token',
      },
      QuotaExceededProblem: {
        code: 'QUOTA_EXCEEDED',
        status: 429,
        title: 'Daily quota exceeded',
      },
      ResourceNotFoundProblem: {
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
        title: 'Resource not found',
      },
      UnsupportedMediaTypeProblem: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        status: 415,
        title: 'Unsupported media type',
      },
      ValidationErrorProblem: {
        code: 'VALIDATION_ERROR',
        status: 400,
        title: 'Validation failed',
      },
    };
    const schemas = document.components?.schemas ?? {};
    expect(
      Object.keys(schemas)
        .filter((name) => name.endsWith('Problem') && name !== 'ProblemModel')
        .sort(),
    ).toEqual(Object.keys(expected).sort());

    for (const [name, contract] of Object.entries(expected)) {
      const schema = schemas[name] as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).toMatchObject({
        code: { enum: [contract.code], type: 'string' },
        status: { enum: [contract.status], type: 'integer' },
        title: { enum: [contract.title], type: 'string' },
        type: {
          enum: [
            `urn:api-usage-quota-service:problem:${contract.code
              .toLowerCase()
              .replaceAll('_', '-')}`,
          ],
          format: 'uri',
          type: 'string',
        },
      });
    }
  });

  it('publishes only the exact response statuses and common v1 problems', () => {
    const expectedStatuses: Record<string, string[]> = {
      'DELETE /v1/api-keys/{id}': [
        '204',
        '400',
        '401',
        '403',
        '404',
        '409',
        '500',
        '503',
      ],
      'GET /health/live': ['200'],
      'GET /health/ready': ['200', '500', '503'],
      'GET /metrics': ['200', '401', '500'],
      'GET /v1/api-keys': ['200', '400', '401', '403', '500', '503'],
      'GET /v1/audit-logs': ['200', '400', '401', '403', '500', '503'],
      'GET /v1/usage/daily': ['200', '400', '401', '403', '500', '503'],
      'POST /v1/admin/projects': ['201', '400', '401', '415', '500', '503'],
      'POST /v1/api-keys': [
        '201',
        '400',
        '401',
        '403',
        '409',
        '415',
        '500',
        '503',
      ],
      'POST /v1/usage-events': [
        '200',
        '400',
        '401',
        '403',
        '409',
        '415',
        '429',
        '500',
        '503',
      ],
    };

    for (const [route, statuses] of Object.entries(expectedStatuses)) {
      const [method, path] = route.split(' ') as [string, string];
      const operation = (
        document.paths[path] as unknown as Record<
          string,
          { responses: Record<string, unknown> }
        >
      )[method.toLowerCase()];
      expect(Object.keys(operation.responses).sort()).toEqual(
        [...statuses].sort(),
      );
      expect(JSON.stringify(operation.responses)).not.toContain(
        '#/components/schemas/ProblemModel',
      );

      if (!path.startsWith('/v1/')) continue;
      expect(operation.responses['500']).toHaveProperty(
        'content.application/problem+json.schema',
        { $ref: '#/components/schemas/InternalErrorProblem' },
      );
      if (route === 'POST /v1/usage-events') {
        expect(operation.responses['503']).toHaveProperty(
          'content.application/problem+json.schema',
          {
            oneOf: [
              { $ref: '#/components/schemas/DependencyUnavailableProblem' },
              {
                $ref: '#/components/schemas/ConcurrentRequestRetryExhaustedProblem',
              },
            ],
          },
        );
      } else {
        expect(operation.responses['503']).toHaveProperty(
          'content.application/problem+json.schema',
          { $ref: '#/components/schemas/DependencyUnavailableProblem' },
        );
      }
    }
  });

  it('documents each success response media and the empty revoke response exactly', () => {
    const jsonSuccessSchemas: Record<string, string> = {
      'GET /health/live': 'LiveHealth',
      'GET /health/ready': 'ReadyHealth',
      'GET /v1/api-keys': 'ApiKeyPageModel',
      'GET /v1/audit-logs': 'AuditLogPageModel',
      'GET /v1/usage/daily': 'DailyUsageResponseModel',
      'POST /v1/admin/projects': 'ProjectBootstrapResponseModel',
      'POST /v1/api-keys': 'ApiKeyCreateResponseModel',
      'POST /v1/usage-events': 'AcceptedUsageResponseModel',
    };
    const successStatus: Record<string, string> = {
      'GET /health/live': '200',
      'GET /health/ready': '200',
      'GET /v1/api-keys': '200',
      'GET /v1/audit-logs': '200',
      'GET /v1/usage/daily': '200',
      'POST /v1/admin/projects': '201',
      'POST /v1/api-keys': '201',
      'POST /v1/usage-events': '200',
    };
    for (const [route, schemaName] of Object.entries(jsonSuccessSchemas)) {
      const [method, path] = route.split(' ') as [string, string];
      const operation = (
        document.paths[path] as unknown as Record<
          string,
          { responses: Record<string, unknown> }
        >
      )[method.toLowerCase()];
      const response = operation.responses[successStatus[route]!] as {
        content?: Record<string, unknown>;
      };
      expect(Object.keys(response.content ?? {})).toEqual(['application/json']);
      expect(response).toHaveProperty('content.application/json.schema', {
        $ref: `#/components/schemas/${schemaName}`,
      });
    }

    const metrics = document.paths['/metrics']?.get?.responses?.['200'] as {
      content?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    };
    expect(metrics.content).toEqual({
      'text/plain': { schema: { type: 'string' } },
    });
    expect(Object.keys(metrics.headers ?? {})).toEqual(['X-Request-Id']);

    const revoked = document.paths['/v1/api-keys/{id}']?.delete?.responses?.[
      '204'
    ] as {
      content?: Record<string, unknown>;
      headers?: Record<string, unknown>;
    };
    expect(revoked.content).toBeUndefined();
    expect(Object.keys(revoked.headers ?? {})).toEqual(['X-Request-Id']);
  });

  it('uses exact accepted and active issuance success schemas', () => {
    expect(
      document.paths['/v1/usage-events']?.post?.responses?.['200'],
    ).toHaveProperty(
      'content.application/json.schema.$ref',
      '#/components/schemas/AcceptedUsageResponseModel',
    );
    expect(
      document.components?.schemas?.AcceptedUsageResponseModel,
    ).toMatchObject({
      properties: { decision: { enum: ['ACCEPTED'], type: 'string' } },
    });
    const active = document.components?.schemas?.ActiveApiKeyMetadataModel;
    expect(active).toMatchObject({
      additionalProperties: false,
      properties: {
        prefix: {
          pattern:
            '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        },
        revokedAt: { enum: [null], nullable: true, type: 'string' },
        status: { enum: ['ACTIVE'], type: 'string' },
      },
    });
    for (const responseName of [
      'ProjectBootstrapResponseModel',
      'ApiKeyCreateResponseModel',
    ]) {
      expect(document.components?.schemas?.[responseName]).toHaveProperty(
        'properties.apiKey.$ref',
        '#/components/schemas/ActiveApiKeyMetadataModel',
      );
    }
    for (const metadataName of [
      'ApiKeyMetadataModel',
      'ApiKeyCreatedMetadataModel',
      'ApiKeyRevokedMetadataModel',
    ]) {
      expect(document.components?.schemas?.[metadataName]).toHaveProperty(
        'properties.prefix.pattern',
        '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      );
    }
  });

  it('contains only the published operation set with exact security', () => {
    const expected = {
      'DELETE /v1/api-keys/{id}': [{ projectApiKeyBearer: [] }],
      'GET /health/live': undefined,
      'GET /health/ready': undefined,
      'GET /metrics': [{ metricsBearer: [] }],
      'GET /v1/api-keys': [{ projectApiKeyBearer: [] }],
      'GET /v1/audit-logs': [{ projectApiKeyBearer: [] }],
      'GET /v1/usage/daily': [{ projectApiKeyBearer: [] }],
      'POST /v1/admin/projects': [{ systemAdminBearer: [] }],
      'POST /v1/api-keys': [{ projectApiKeyBearer: [] }],
      'POST /v1/usage-events': [{ projectApiKeyBearer: [] }],
    } as const;
    const actual: Record<string, unknown> = {};
    for (const [path, item] of Object.entries(document.paths)) {
      for (const method of openApiMethods) {
        const operation = item[method];
        if (operation !== undefined) {
          actual[`${method.toUpperCase()} ${path}`] = operation.security;
        }
      }
    }
    expect(actual).toEqual(expected);
    expect(
      Object.keys(document.components?.securitySchemes ?? {}).sort(),
    ).toEqual(['metricsBearer', 'projectApiKeyBearer', 'systemAdminBearer']);
  });

  it('documents epoch quota reset and integer request fields', () => {
    for (const status of ['200', '429']) {
      expect(
        document.paths['/v1/usage-events']?.post?.responses?.[status],
      ).toHaveProperty('headers.X-Quota-Reset', {
        description: 'UTC quota reset time as Unix epoch seconds.',
        required: true,
        schema: { minimum: 0, type: 'integer' },
      });
    }
    expect(document.components?.schemas?.CreateProjectDto).toHaveProperty(
      'properties.dailyQuotaUnits.type',
      'integer',
    );
    expect(document.components?.schemas?.CreateUsageEventDto).toHaveProperty(
      'properties.units.type',
      'integer',
    );
  });

  it('documents canonical credential ids and strict pagination inputs', () => {
    const idempotencyParameter = document.paths['/v1/usage-events']?.post
      ?.parameters?.[0] as {
      in?: string;
      name?: string;
      required?: boolean;
      schema?: { format?: string; pattern?: string; type?: string };
    };
    const idempotencyPattern =
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
    expect(idempotencyParameter).toMatchObject({
      in: 'header',
      name: 'Idempotency-Key',
      required: true,
      schema: {
        format: 'uuid',
        pattern: idempotencyPattern,
        type: 'string',
      },
    });
    const idempotencyRegex = new RegExp(idempotencyPattern);
    expect(idempotencyRegex.test('64f4ce08-03df-40fa-ae44-ebd9d584781f')).toBe(
      true,
    );
    expect(idempotencyRegex.test('64f4ce08-03df-10fa-ae44-ebd9d584781f')).toBe(
      false,
    );
    expect(idempotencyRegex.test('64F4CE08-03DF-40FA-AE44-EBD9D584781F')).toBe(
      false,
    );

    const revokeParameter = document.paths['/v1/api-keys/{id}']?.delete
      ?.parameters?.[0] as {
      in?: string;
      name?: string;
      required?: boolean;
      schema?: { format?: string; pattern?: string; type?: string };
    };
    const canonicalUuidPattern =
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    expect(revokeParameter).toMatchObject({
      in: 'path',
      name: 'id',
      required: true,
      schema: {
        format: 'uuid',
        pattern: canonicalUuidPattern,
        type: 'string',
      },
    });
    const revokeRegex = new RegExp(canonicalUuidPattern);
    expect(revokeRegex.test('64f4ce08-03df-10fa-ae44-ebd9d584781f')).toBe(true);
    expect(revokeRegex.test('64F4CE08-03DF-10FA-AE44-EBD9D584781F')).toBe(
      false,
    );

    for (const path of ['/v1/api-keys', '/v1/audit-logs']) {
      const parameters = document.paths[path]?.get?.parameters as
        | {
            description?: string;
            in?: string;
            name?: string;
            required?: boolean;
            schema?: Record<string, unknown>;
          }[]
        | undefined;
      const cursor = parameters?.find((item) => item.name === 'cursor');
      const limit = parameters?.find((item) => item.name === 'limit');
      expect(cursor).toMatchObject({
        description: 'Opaque unpadded base64url pagination cursor.',
        in: 'query',
        name: 'cursor',
        required: false,
        schema: {
          minLength: 1,
          pattern: '^[A-Za-z0-9_-]+$',
          type: 'string',
        },
      });
      expect(limit).toMatchObject({
        in: 'query',
        name: 'limit',
        required: false,
        schema: {
          default: 50,
          maximum: 100,
          minimum: 1,
          type: 'integer',
        },
      });
    }
  });

  it('documents strict inclusive UTC daily usage query semantics', () => {
    const parameters = document.paths['/v1/usage/daily']?.get?.parameters as
      | {
          description?: string;
          format?: string;
          in?: string;
          name?: string;
          required?: boolean;
        }[]
      | undefined;
    expect(parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description:
            'Inclusive range start as one canonical UTC YYYY-MM-DD date. Duplicate and unknown query fields are rejected; the inclusive range may span at most 90 days.',
          in: 'query',
          name: 'from',
          required: true,
          schema: expect.objectContaining({ format: 'date', type: 'string' }),
        }),
        expect.objectContaining({
          description:
            'Inclusive range end as one canonical UTC YYYY-MM-DD date. It must be on or after from; duplicate and unknown query fields are rejected; the inclusive range may span at most 90 days.',
          in: 'query',
          name: 'to',
          required: true,
          schema: expect.objectContaining({ format: 'date', type: 'string' }),
        }),
      ]),
    );
  });

  it('allows only closed field/reason validation errors on validation problems', () => {
    expect(document.components?.schemas?.ValidationErrorItem).toEqual({
      additionalProperties: false,
      properties: {
        field: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['field', 'reason'],
      type: 'object',
    });
    for (const name of ['ValidationErrorProblem', 'InvalidCursorProblem']) {
      const schema = document.components?.schemas?.[name] as {
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties?.errors).toEqual({
        items: { $ref: '#/components/schemas/ValidationErrorItem' },
        type: 'array',
      });
      expect(schema.required).not.toContain('errors');
    }
  });

  it('keeps critical artifact semantics aligned with the source document', async () => {
    const artifact = JSON.parse(
      await readFile('docs/openapi/openapi.json', 'utf8'),
    ) as OpenAPIObject;
    expect(artifact).toEqual(document);
    expectLocalReferencesToResolve(artifact);
  });
});
