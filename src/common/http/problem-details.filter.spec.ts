import type { ArgumentsHost } from '@nestjs/common';
import { jest } from '@jest/globals';
import { ProblemCode } from './problem-code.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { ProblemException } from './problem.exception.js';

describe('ProblemDetailsFilter safe extensions', () => {
  it('includes allowlisted terminal extensions without allowing base-field overrides', () => {
    const send = jest.fn();
    const type = jest.fn().mockReturnThis();
    const status = jest.fn().mockReturnThis();
    const setHeader = jest.fn();
    const response = {
      hasHeader: jest.fn().mockReturnValue(true),
      send,
      setHeader,
      status,
      type,
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          requestContext: {
            receivedAt: new Date('2026-08-11T12:00:00.000Z'),
            requestId: '1d321f66-3d62-48e9-b82b-f1ed290ec138',
          },
        }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new ProblemDetailsFilter().catch(
      new ProblemException({
        code: ProblemCode.QUOTA_EXCEEDED,
        detail: 'Use a new idempotency key after the quota resets.',
        extensions: {
          code: 'OVERRIDE',
          decision: 'QUOTA_EXCEEDED',
          eventId: '4919714e-564c-48e1-bc0a-c92f3c9a96f6',
          quota: {
            limit: 1000,
            remaining: 1,
            resetAt: '2026-08-12T00:00:00.000Z',
          },
          requestId: 'override',
          secret: 'must-not-leak',
          status: 200,
          units: 3,
          usageDate: '2026-08-11',
        },
        headers: {
          'X-Quota-Limit': '1000',
          'X-Quota-Remaining': '1',
          'X-Quota-Reset': '1786492800',
        },
        status: 429,
        title: 'Daily quota exceeded',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(429);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(send).toHaveBeenCalledWith({
      code: 'QUOTA_EXCEEDED',
      decision: 'QUOTA_EXCEEDED',
      detail: 'Use a new idempotency key after the quota resets.',
      errors: undefined,
      eventId: '4919714e-564c-48e1-bc0a-c92f3c9a96f6',
      quota: {
        limit: 1000,
        remaining: 1,
        resetAt: '2026-08-12T00:00:00.000Z',
      },
      requestId: '1d321f66-3d62-48e9-b82b-f1ed290ec138',
      status: 429,
      title: 'Daily quota exceeded',
      type: 'urn:api-usage-quota-service:problem:quota-exceeded',
      units: 3,
      usageDate: '2026-08-11',
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain('must-not-leak');
    expect(setHeader).toHaveBeenCalledTimes(3);
    expect(setHeader).not.toHaveBeenCalledWith(
      'Retry-After',
      expect.anything(),
    );
  });
});
