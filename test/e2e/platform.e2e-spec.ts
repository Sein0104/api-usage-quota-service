import {
  Body,
  Controller,
  type INestApplication,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { JsonContentTypeGuard } from '../../src/common/http/json-content-type.guard.js';
import { configureApplication } from '../../src/main.js';
import { testEnvironment } from '../support/test-environment.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class TestRequestDto {
  @IsString()
  name!: string;
}

@Controller('test-validation')
@UseGuards(JsonContentTypeGuard)
class TestValidationController {
  @Post()
  create(@Body() body: TestRequestDto): TestRequestDto {
    return body;
  }
}

describe('platform HTTP contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(testEnvironment())],
      controllers: [TestValidationController],
    }).compile();

    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns server-generated request id and liveness', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/live')
      .set('X-Request-Id', 'client-supplied-id');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).not.toBe('client-supplied-id');
  });

  it('returns validation Problem Details for an unknown JSON field', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/test-validation')
      .send({ name: 'valid', unknown: 'rejected' });

    expect(response).toMatchObject({
      status: 400,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
      },
      body: {
        type: 'urn:api-usage-quota-service:problem:validation-error',
        title: 'Validation failed',
        status: 400,
        detail: 'Request validation failed.',
        code: 'VALIDATION_ERROR',
        requestId: expect.any(String),
      },
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('returns validation Problem Details for malformed JSON', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/test-validation')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'client-supplied-id')
      .send('{"name":');

    expect(response).toMatchObject({
      status: 400,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
      },
      body: {
        type: 'urn:api-usage-quota-service:problem:validation-error',
        title: 'Validation failed',
        status: 400,
        detail: 'Request validation failed.',
        code: 'VALIDATION_ERROR',
        requestId: expect.any(String),
      },
    });
    expect(response.headers['x-request-id']).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).not.toBe('client-supplied-id');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('returns unsupported media type Problem Details for a JSON body endpoint', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/test-validation')
      .set('Content-Type', 'text/plain')
      .send('not-json');

    expect(response).toMatchObject({
      status: 415,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
      },
      body: { code: 'UNSUPPORTED_MEDIA_TYPE', requestId: expect.any(String) },
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('returns route-not-found Problem Details for an unregistered route', async () => {
    const response = await request(app.getHttpServer()).get(
      '/v1/not-registered',
    );

    expect(response).toMatchObject({
      status: 404,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
      },
      body: { code: 'ROUTE_NOT_FOUND', requestId: expect.any(String) },
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });
});
