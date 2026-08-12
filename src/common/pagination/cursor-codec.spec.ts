import { Buffer } from 'node:buffer';
import { CursorCodec } from './cursor-codec.js';

const cursorValue = {
  createdAt: new Date('2026-08-12T12:34:56.789Z'),
  id: '11111111-2222-4333-8444-555555555555',
};

describe('CursorCodec', () => {
  const codec = new CursorCodec();

  it('encodes the canonical minified UTF-8 payload in fixed key order', () => {
    expect(codec.encode(cursorValue)).toBe(
      'eyJ2IjoxLCJjcmVhdGVkQXQiOiIyMDI2LTA4LTEyVDEyOjM0OjU2Ljc4OVoiLCJpZCI6IjExMTExMTExLTIyMjItNDMzMy04NDQ0LTU1NTU1NTU1NTU1NSJ9',
    );
  });

  it('round-trips a canonical cursor', () => {
    expect(codec.decode(codec.encode(cursorValue))).toEqual(cursorValue);
  });

  it.each([
    { createdAt: new Date(Number.NaN), id: cursorValue.id },
    {
      createdAt: cursorValue.createdAt,
      id: '11111111-2222-4333-8444-55555555555A',
    },
    { createdAt: cursorValue.createdAt, id: 'not-a-uuid' },
  ])('rejects a non-canonical value before encoding: %o', (value) => {
    expect(() => codec.encode(value)).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          code: 'INVALID_CURSOR',
          status: 400,
        }),
      }),
    );
  });

  it.each([
    '',
    'broken=',
    'broken+',
    Buffer.from([0xff]).toString('base64url'),
    Buffer.from('not-json').toString('base64url'),
    Buffer.from('{}').toString('base64url'),
    Buffer.from(
      '{"v":2,"createdAt":"2026-08-12T12:34:56.789Z","id":"11111111-2222-4333-8444-555555555555"}',
    ).toString('base64url'),
    Buffer.from(
      '{"v":1,"createdAt":"2026-08-12T12:34:56.789Z","id":"11111111-2222-4333-8444-555555555555","extra":true}',
    ).toString('base64url'),
    Buffer.from(
      '{"v":1,"createdAt":"2026-08-12T12:34:56Z","id":"11111111-2222-4333-8444-555555555555"}',
    ).toString('base64url'),
    Buffer.from(
      '{"v":1,"createdAt":"2026-02-30T12:34:56.789Z","id":"11111111-2222-4333-8444-555555555555"}',
    ).toString('base64url'),
    Buffer.from(
      '{"v":1,"createdAt":"2026-08-12T12:34:56.789Z","id":"11111111-2222-4333-8444-55555555555A"}',
    ).toString('base64url'),
    Buffer.from(
      '{"v":1,"createdAt":"2026-08-12T12:34:56.789Z","id":"not-a-uuid"}',
    ).toString('base64url'),
    Buffer.from(
      '{"createdAt":"2026-08-12T12:34:56.789Z","v":1,"id":"11111111-2222-4333-8444-555555555555"}',
    ).toString('base64url'),
  ])('rejects non-canonical cursor %s', (encoded) => {
    expect(() => codec.decode(encoded)).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          code: 'INVALID_CURSOR',
          status: 400,
        }),
      }),
    );
  });
});
