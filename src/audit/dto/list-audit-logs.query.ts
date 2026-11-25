import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';
import type { CursorCodec } from '../../common/pagination/cursor-codec.js';
import { invalidCursor } from '../../common/pagination/cursor-codec.js';
import type { PageRequest } from '../../common/pagination/page.js';

const canonicalLimitPattern = /^(?:[1-9]|[1-9][0-9]|100)$/;

export class ListAuditLogsQuery {
  cursor?: string;
  limit?: string;
}

export function parseListAuditLogsQuery(
  query: unknown,
  codec: CursorCodec,
): PageRequest {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw validationError();
  }
  const values = query as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== 'cursor' && key !== 'limit')) {
    throw validationError();
  }

  const cursor = values.cursor;
  if (
    Array.isArray(cursor) ||
    (cursor !== undefined && typeof cursor !== 'string')
  ) {
    throw invalidCursor();
  }
  const limit = values.limit;
  if (
    limit !== undefined &&
    (typeof limit !== 'string' || !canonicalLimitPattern.test(limit))
  ) {
    throw validationError();
  }

  return {
    cursor: cursor === undefined ? null : codec.decode(cursor),
    limit: limit === undefined ? 50 : Number(limit),
  };
}

function validationError(): ProblemException {
  return new ProblemException({
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    status: 400,
    title: 'Validation failed',
  });
}
