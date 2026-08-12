import type { CursorCodec } from '../../common/pagination/cursor-codec.js';
import { invalidCursor } from '../../common/pagination/cursor-codec.js';
import type { PageRequest } from '../../common/pagination/page.js';
import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';

const canonicalLimitPattern = /^(?:[1-9]|[1-9][0-9]|100)$/;

export class ListApiKeysQuery {
  cursor?: string;
  limit?: string;
}

export function parseListApiKeysQuery(
  query: unknown,
  codec: CursorCodec,
): PageRequest {
  if (!isQueryObject(query)) throw validationError();
  const keys = Object.keys(query);
  if (keys.some((key) => key !== 'cursor' && key !== 'limit')) {
    throw validationError();
  }

  const rawCursor = query.cursor;
  if (Array.isArray(rawCursor)) throw invalidCursor();
  if (rawCursor !== undefined && typeof rawCursor !== 'string') {
    throw invalidCursor();
  }

  const rawLimit = query.limit;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'string' || !canonicalLimitPattern.test(rawLimit))
  ) {
    throw validationError();
  }

  return {
    cursor: rawCursor === undefined ? null : codec.decode(rawCursor),
    limit: rawLimit === undefined ? 50 : Number(rawLimit),
  };
}

function isQueryObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validationError(): ProblemException {
  return new ProblemException({
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    status: 400,
    title: 'Validation failed',
  });
}
