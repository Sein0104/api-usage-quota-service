import { timingSafeSecretEqual } from './timing-safe-secret.js';

describe('timingSafeSecretEqual', () => {
  it('compares arbitrary Unicode secrets without leaking length through an exception', () => {
    expect(timingSafeSecretEqual('짧음', '서로-다른-길이의-token')).toBe(false);
    expect(timingSafeSecretEqual('', 'configured-admin-token')).toBe(false);
    expect(timingSafeSecretEqual('same', 'same')).toBe(true);
  });
});
