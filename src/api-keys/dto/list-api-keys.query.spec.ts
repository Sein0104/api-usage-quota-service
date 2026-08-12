import { CursorCodec } from '../../common/pagination/cursor-codec.js';
import { parseListApiKeysQuery } from './list-api-keys.query.js';

describe('parseListApiKeysQuery', () => {
  const codec = new CursorCodec();
  const cursor = codec.encode({
    createdAt: new Date('2026-08-12T12:34:56.789Z'),
    id: '11111111-2222-4333-8444-555555555555',
  });

  it('defaults an omitted cursor to null and limit to 50', () => {
    expect(parseListApiKeysQuery({}, codec)).toEqual({
      cursor: null,
      limit: 50,
    });
  });

  it('accepts one canonical cursor and one canonical decimal limit', () => {
    expect(parseListApiKeysQuery({ cursor, limit: '100' }, codec)).toEqual({
      cursor: {
        createdAt: new Date('2026-08-12T12:34:56.789Z'),
        id: '11111111-2222-4333-8444-555555555555',
      },
      limit: 100,
    });
  });

  it.each([{ cursor: '' }, { cursor: [cursor, cursor] }, { cursor: 'broken' }])(
    'maps malformed cursor query to INVALID_CURSOR: %o',
    (query) => {
      expect(() => parseListApiKeysQuery(query, codec)).toThrow(
        expect.objectContaining({
          problem: expect.objectContaining({
            code: 'INVALID_CURSOR',
            status: 400,
          }),
        }),
      );
    },
  );

  it.each([
    { limit: '' },
    { limit: '01' },
    { limit: '+1' },
    { limit: '1.0' },
    { limit: ' 1' },
    { limit: '1e0' },
    { limit: ['1', '2'] },
    { limit: { value: '1' } },
    { limit: '0' },
    { limit: '101' },
    { unknown: 'field' },
    null,
    [],
  ])('rejects non-canonical limit and unknown query input: %o', (query) => {
    expect(() => parseListApiKeysQuery(query, codec)).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          status: 400,
        }),
      }),
    );
  });
});
