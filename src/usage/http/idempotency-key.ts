import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';

const canonicalUuidV4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validationError(): ProblemException {
  return new ProblemException({
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    errors: [
      {
        field: 'Idempotency-Key',
        reason: 'must be exactly one canonical lowercase UUID v4 header',
      },
    ],
    status: 400,
    title: 'Validation failed',
  });
}

export function parseIdempotencyKey(rawHeaders: readonly string[]): string {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'idempotency-key') {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length !== 1 || !canonicalUuidV4.test(values[0])) {
    throw validationError();
  }
  return values[0];
}

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

export {};
