import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRevokeApiKeyId(id: string): string {
  if (!canonicalUuidPattern.test(id)) {
    throw new ProblemException({
      code: ProblemCode.VALIDATION_ERROR,
      detail: 'Request validation failed.',
      status: 400,
      title: 'Validation failed',
    });
  }
  return id;
}
