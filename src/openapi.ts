import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import type { Environment } from './config/environment.schema.js';
import type { Response } from 'express';
import {
  NotReadyHealth,
  ProblemModel,
  QuotaSnapshotModel,
} from './openapi.models.js';

type Schema = Record<string, unknown>;
type Operation = NonNullable<OpenAPIObject['paths'][string]['get']>;

const problemContent = (schema: Schema) => ({
  'application/problem+json': { schema },
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const requestIdHeader = {
  description: 'Server-generated request identifier.',
  required: true,
  schema: { format: 'uuid', type: 'string' },
};
const bearerChallengeHeader = {
  description: 'Bearer authentication challenge.',
  required: true,
  schema: { enum: ['Bearer'], type: 'string' },
};
const quotaHeaders = {
  'X-Quota-Limit': {
    description: 'Daily quota limit.',
    required: true,
    schema: { maximum: 1_000_000_000, minimum: 1, type: 'integer' },
  },
  'X-Quota-Remaining': {
    description: 'Remaining daily quota.',
    required: true,
    schema: { maximum: 1_000_000_000, minimum: 0, type: 'integer' },
  },
  'X-Quota-Reset': {
    description: 'UTC quota reset time as Unix epoch seconds.',
    required: true,
    schema: { minimum: 0, type: 'integer' },
  },
};

function problemSchema(code: string, status: number, title: string): Schema {
  return {
    additionalProperties: false,
    properties: {
      code: { enum: [code], type: 'string' },
      detail: { type: 'string' },
      requestId: { format: 'uuid', type: 'string' },
      status: { enum: [status], type: 'integer' },
      title: { enum: [title], type: 'string' },
      type: {
        enum: [
          `urn:api-usage-quota-service:problem:${code
            .toLowerCase()
            .replaceAll('_', '-')}`,
        ],
        format: 'uri',
        type: 'string',
      },
    },
    required: ['type', 'title', 'status', 'detail', 'code', 'requestId'],
    type: 'object',
  };
}

function validationProblemSchema(code: string, title: string): Schema {
  const base = problemSchema(code, 400, title);
  return {
    ...base,
    properties: {
      ...(base.properties as Schema),
      errors: {
        items: ref('ValidationErrorItem'),
        type: 'array',
      },
    },
  };
}

function ensureCommonSchemas(document: OpenAPIObject): void {
  document.components ??= {};
  document.components.schemas ??= {};
  const quotaExceededProblem = problemSchema(
    'QUOTA_EXCEEDED',
    429,
    'Daily quota exceeded',
  );
  Object.assign(document.components.schemas, {
    InternalErrorProblem: problemSchema(
      'INTERNAL_ERROR',
      500,
      'Internal server error',
    ),
    DependencyUnavailableProblem: problemSchema(
      'DEPENDENCY_UNAVAILABLE',
      503,
      'Dependency unavailable',
    ),
    ConcurrentRequestRetryExhaustedProblem: problemSchema(
      'CONCURRENT_REQUEST_RETRY_EXHAUSTED',
      503,
      'Concurrent request retry exhausted',
    ),
    ValidationErrorItem: {
      additionalProperties: false,
      properties: {
        field: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['field', 'reason'],
      type: 'object',
    },
    ValidationErrorProblem: validationProblemSchema(
      'VALIDATION_ERROR',
      'Validation failed',
    ),
    InvalidCursorProblem: validationProblemSchema(
      'INVALID_CURSOR',
      'Invalid cursor',
    ),
    InvalidSystemAdminTokenProblem: problemSchema(
      'INVALID_SYSTEM_ADMIN_TOKEN',
      401,
      'Invalid system administrator token',
    ),
    InvalidApiKeyProblem: problemSchema(
      'INVALID_API_KEY',
      401,
      'Invalid API key',
    ),
    InvalidMetricsTokenProblem: problemSchema(
      'INVALID_METRICS_TOKEN',
      401,
      'Invalid metrics token',
    ),
    InsufficientScopeProblem: problemSchema(
      'INSUFFICIENT_SCOPE',
      403,
      'Insufficient scope',
    ),
    ResourceNotFoundProblem: problemSchema(
      'RESOURCE_NOT_FOUND',
      404,
      'Resource not found',
    ),
    IdempotencyKeyReusedProblem: problemSchema(
      'IDEMPOTENCY_KEY_REUSED',
      409,
      'Idempotency key reused',
    ),
    CannotRevokeCurrentKeyProblem: problemSchema(
      'CANNOT_REVOKE_CURRENT_KEY',
      409,
      'Cannot revoke current API key',
    ),
    ActiveKeyLimitReachedProblem: problemSchema(
      'ACTIVE_KEY_LIMIT_REACHED',
      409,
      'Active API key limit reached',
    ),
    UnsupportedMediaTypeProblem: problemSchema(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      'Unsupported media type',
    ),
    QuotaExceededProblem: {
      ...quotaExceededProblem,
      properties: {
        ...(quotaExceededProblem.properties as Schema),
        decision: { enum: ['QUOTA_EXCEEDED'], type: 'string' },
        eventId: { format: 'uuid', type: 'string' },
        quota: ref('QuotaSnapshotModel'),
        units: { maximum: 10_000, minimum: 1, type: 'integer' },
        usageDate: { format: 'date', type: 'string' },
      },
      required: [
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
      ],
    },
  });

  for (const schema of Object.values(document.components.schemas)) {
    if (
      typeof schema === 'object' &&
      schema !== null &&
      'properties' in schema
    ) {
      schema.additionalProperties = false;
    }
  }

  const auditProperties = {
    createdAt: { format: 'date-time', type: 'string' },
    id: { format: 'uuid', type: 'string' },
    requestId: { format: 'uuid', type: 'string' },
    resourceId: { format: 'uuid', type: 'string' },
  };
  const requiredAuditProperties = [
    'id',
    'action',
    'resourceType',
    'resourceId',
    'actorKeyId',
    'requestId',
    'metadata',
    'createdAt',
  ];
  Object.assign(document.components.schemas, {
    ProjectCreatedAuditLog: {
      additionalProperties: false,
      properties: {
        ...auditProperties,
        action: { enum: ['PROJECT_CREATED'], type: 'string' },
        actorKeyId: { enum: [null], nullable: true, type: 'string' },
        metadata: ref('ProjectCreatedMetadataModel'),
        resourceType: { enum: ['PROJECT'], type: 'string' },
      },
      required: requiredAuditProperties,
      type: 'object',
    },
    ApiKeyCreatedAuditLog: {
      additionalProperties: false,
      properties: {
        ...auditProperties,
        action: { enum: ['API_KEY_CREATED'], type: 'string' },
        actorKeyId: { format: 'uuid', type: 'string' },
        metadata: ref('ApiKeyCreatedMetadataModel'),
        resourceType: { enum: ['API_KEY'], type: 'string' },
      },
      required: requiredAuditProperties,
      type: 'object',
    },
    ApiKeyRevokedAuditLog: {
      additionalProperties: false,
      properties: {
        ...auditProperties,
        action: { enum: ['API_KEY_REVOKED'], type: 'string' },
        actorKeyId: { format: 'uuid', type: 'string' },
        metadata: ref('ApiKeyRevokedMetadataModel'),
        resourceType: { enum: ['API_KEY'], type: 'string' },
      },
      required: requiredAuditProperties,
      type: 'object',
    },
    AuditLogModel: {
      discriminator: {
        mapping: {
          API_KEY_CREATED: '#/components/schemas/ApiKeyCreatedAuditLog',
          API_KEY_REVOKED: '#/components/schemas/ApiKeyRevokedAuditLog',
          PROJECT_CREATED: '#/components/schemas/ProjectCreatedAuditLog',
        },
        propertyName: 'action',
      },
      oneOf: [
        ref('ProjectCreatedAuditLog'),
        ref('ApiKeyCreatedAuditLog'),
        ref('ApiKeyRevokedAuditLog'),
      ],
    },
  });
}

function operations(document: OpenAPIObject): [string, string, Operation][] {
  const methods = [
    'get',
    'post',
    'put',
    'patch',
    'delete',
    'options',
    'head',
    'trace',
  ] as const;
  return Object.entries(document.paths).flatMap(([path, item]) =>
    methods.flatMap((method) => {
      const operation = item[method];
      return operation === undefined
        ? []
        : [[path, method, operation] as [string, string, Operation]];
    }),
  );
}

function responseForProblem(
  schema: Schema,
  status: number,
): NonNullable<Operation['responses'][string]> {
  return {
    content: problemContent(schema),
    description: `Problem Details (${status}).`,
  };
}

function replaceProblemResponses(
  path: string,
  method: string,
  operation: Operation,
): void {
  const map: Record<string, Record<string, string | string[]>> = {
    'POST /v1/admin/projects': {
      '400': 'ValidationErrorProblem',
      '401': 'InvalidSystemAdminTokenProblem',
      '415': 'UnsupportedMediaTypeProblem',
    },
    'POST /v1/api-keys': {
      '400': 'ValidationErrorProblem',
      '401': 'InvalidApiKeyProblem',
      '403': 'InsufficientScopeProblem',
      '409': 'ActiveKeyLimitReachedProblem',
      '415': 'UnsupportedMediaTypeProblem',
    },
    'GET /v1/api-keys': {
      '400': ['InvalidCursorProblem', 'ValidationErrorProblem'],
      '401': 'InvalidApiKeyProblem',
      '403': 'InsufficientScopeProblem',
    },
    'DELETE /v1/api-keys/{id}': {
      '400': 'ValidationErrorProblem',
      '401': 'InvalidApiKeyProblem',
      '403': 'InsufficientScopeProblem',
      '404': 'ResourceNotFoundProblem',
      '409': 'CannotRevokeCurrentKeyProblem',
    },
    'POST /v1/usage-events': {
      '400': 'ValidationErrorProblem',
      '401': 'InvalidApiKeyProblem',
      '403': 'InsufficientScopeProblem',
      '409': 'IdempotencyKeyReusedProblem',
      '415': 'UnsupportedMediaTypeProblem',
      '429': 'QuotaExceededProblem',
    },
    'GET /v1/usage/daily': {
      '400': 'ValidationErrorProblem',
      '401': 'InvalidApiKeyProblem',
      '403': 'InsufficientScopeProblem',
    },
    'GET /v1/audit-logs': {
      '400': ['InvalidCursorProblem', 'ValidationErrorProblem'],
      '401': 'InvalidApiKeyProblem',
      '403': 'InsufficientScopeProblem',
    },
    'GET /metrics': {
      '401': 'InvalidMetricsTokenProblem',
      '500': 'InternalErrorProblem',
    },
    'GET /health/ready': { '500': 'InternalErrorProblem' },
  };
  for (const [status, schemaNames] of Object.entries(
    map[`${method.toUpperCase()} ${path}`] ?? {},
  )) {
    const names = Array.isArray(schemaNames) ? schemaNames : [schemaNames];
    operation.responses[status] = responseForProblem(
      names.length === 1
        ? ref(names[0]!)
        : { oneOf: names.map((name) => ref(name)) },
      Number(status),
    );
  }
}

function attachResponseHeaders(operation: Operation): void {
  for (const [status, response] of Object.entries(operation.responses)) {
    if (response === undefined || '$ref' in response) continue;
    response.headers = {
      ...(response.headers ?? {}),
      'X-Request-Id': requestIdHeader,
      ...(status === '401'
        ? { 'WWW-Authenticate': bearerChallengeHeader }
        : {}),
    };
  }
}

export function finalizeOpenApiDocument(
  document: OpenAPIObject,
): OpenAPIObject {
  ensureCommonSchemas(document);
  for (const [path, method, operation] of operations(document)) {
    replaceProblemResponses(path, method, operation);
    if (path.startsWith('/v1/')) {
      operation.responses['500'] = {
        content: problemContent(ref('InternalErrorProblem')),
        description: 'Unexpected internal server error.',
      };
      operation.responses['503'] = {
        content: problemContent(ref('DependencyUnavailableProblem')),
        description: 'Required dependency unavailable.',
      };
      if (path === '/v1/usage-events' && method === 'post') {
        operation.responses['503'] = {
          content: problemContent({
            oneOf: [
              ref('DependencyUnavailableProblem'),
              ref('ConcurrentRequestRetryExhaustedProblem'),
            ],
          }),
          description: 'Dependency unavailable or concurrency retry exhausted.',
        };
        for (const status of ['200', '429']) {
          const response = operation.responses[status];
          if (response !== undefined && !('$ref' in response)) {
            response.headers = { ...(response.headers ?? {}), ...quotaHeaders };
          }
        }
      }
    }
    attachResponseHeaders(operation);
  }
  return document;
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('API Usage Metering and Quota Service')
    .setDescription(
      'Tenant-isolated API usage metering and daily quota service.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { bearerFormat: 'opaque', scheme: 'bearer', type: 'http' },
      'systemAdminBearer',
    )
    .addBearerAuth(
      { bearerFormat: 'opaque', scheme: 'bearer', type: 'http' },
      'projectApiKeyBearer',
    )
    .addBearerAuth(
      { bearerFormat: 'opaque', scheme: 'bearer', type: 'http' },
      'metricsBearer',
    )
    .build();
  return finalizeOpenApiDocument(
    SwaggerModule.createDocument(app, config, {
      extraModels: [ProblemModel, QuotaSnapshotModel, NotReadyHealth],
      operationIdFactory: (controller, method) => `${controller}.${method}`,
    }),
  );
}

export function stableOpenApiJson(document: OpenAPIObject): string {
  function sort(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sort(nested)]),
    );
  }
  return `${JSON.stringify(sort(document), null, 2)}\n`;
}

export function configureOpenApi(
  app: INestApplication,
  environment: Pick<Environment, 'SWAGGER_ENABLED'>,
): OpenAPIObject | undefined {
  if (!environment.SWAGGER_ENABLED) return undefined;
  const document = createOpenApiDocument(app);
  SwaggerModule.setup('/docs', app, document, {
    raw: false,
    swaggerOptions: { url: '/openapi.json' },
  });
  app
    .getHttpAdapter()
    .get('/openapi.json', (_request: unknown, response: Response) => {
      response.type('application/json').send(document);
    });
  return document;
}
