import { CursorCodec } from '../../common/pagination/cursor-codec.js';
import { parseListAuditLogsQuery } from './list-audit-logs.query.js';

describe('parseListAuditLogsQuery', () => {
  const codec = new CursorCodec();

  it('uses the cursor-page defaults and decodes a valid cursor', () => {
    const cursor = codec.encode({
      createdAt: new Date('2026-08-12T01:02:03.004Z'),
      id: '11111111-2222-4333-8444-555555555555',
    });

    expect(parseListAuditLogsQuery({}, codec)).toEqual({
      cursor: null,
      limit: 50,
    });
    expect(parseListAuditLogsQuery({ cursor, limit: '100' }, codec)).toEqual({
      cursor: {
        createdAt: new Date('2026-08-12T01:02:03.004Z'),
        id: '11111111-2222-4333-8444-555555555555',
      },
      limit: 100,
    });
  });

  it.each([
    { limit: '0' },
    { limit: '01' },
    { limit: '101' },
    { limit: ['10', '20'] },
    { unknown: 'value' },
  ])('rejects a non-canonical audit query: %p', (query) => {
    expect(() => parseListAuditLogsQuery(query, codec)).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      }),
    );
  });

  it.each([{ cursor: 'broken' }, { cursor: ['one', 'two'] }])(
    'uses INVALID_CURSOR only for cursor failures: %p',
    (query) => {
      expect(() => parseListAuditLogsQuery(query, codec)).toThrow(
        expect.objectContaining({
          problem: expect.objectContaining({ code: 'INVALID_CURSOR' }),
        }),
      );
    },
  );
});
