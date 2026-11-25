import { parseBearerCredential } from './bearer-credential.parser.js';

describe('parseBearerCredential', () => {
  it.each([
    [[], undefined],
    [['Authorization', 'Bearer secret'], 'secret'],
    [['Authorization', 'bearer secret'], 'secret'],
    [['Authorization', 'Basic secret'], undefined],
    [['Authorization', 'Bearer one', 'authorization', 'Bearer two'], undefined],
  ])('parses raw authorization fields exactly: %o', (rawHeaders, expected) => {
    expect(parseBearerCredential(rawHeaders)).toBe(expected);
  });
});
