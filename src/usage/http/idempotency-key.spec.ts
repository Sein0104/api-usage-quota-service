import { ProblemException } from '../../common/http/problem.exception.js';
import { parseIdempotencyKey } from './idempotency-key.js';

const valid = '64f4ce08-03df-40fa-ae44-ebd9d584781f';

describe('parseIdempotencyKey', () => {
  it('returns exactly one canonical lowercase UUID v4 raw header value', () => {
    expect(
      parseIdempotencyKey(['Host', 'example.test', 'Idempotency-Key', valid]),
    ).toBe(valid);
  });

  it.each([
    { rawHeaders: [] },
    { rawHeaders: ['Idempotency-Key', ''] },
    { rawHeaders: ['Idempotency-Key', `${valid},${valid}`] },
    { rawHeaders: ['Idempotency-Key', valid.toUpperCase()] },
    {
      rawHeaders: ['Idempotency-Key', '64f4ce08-03df-10fa-ae44-ebd9d584781f'],
    },
    { rawHeaders: ['Idempotency-Key', `{${valid}}`] },
    { rawHeaders: ['Idempotency-Key', ` ${valid}`] },
    { rawHeaders: ['Idempotency-Key', `${valid} `] },
    {
      rawHeaders: ['Idempotency-Key', valid, 'idempotency-key', valid],
    },
  ])('rejects invalid raw header fields: $rawHeaders', ({ rawHeaders }) => {
    expect(() => parseIdempotencyKey(rawHeaders)).toThrow(
      expect.objectContaining<Partial<ProblemException>>({
        problem: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      }),
    );
  });
});
