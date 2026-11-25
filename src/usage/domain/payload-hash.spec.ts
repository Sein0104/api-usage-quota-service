import { createHash } from 'node:crypto';
import { payloadHash } from './payload-hash.js';

describe('payloadHash', () => {
  it.each([1, 10, 10_000])(
    'hashes the versioned decimal units payload for %s',
    (units) => {
      const expected = createHash('sha256')
        .update(`usage-event:v1:${units}`, 'utf8')
        .digest();

      expect(payloadHash(units)).toEqual(expected);
    },
  );
});
