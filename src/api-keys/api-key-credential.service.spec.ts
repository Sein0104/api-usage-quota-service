import { ApiKeyCredentialService } from './api-key-credential.service.js';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

describe('ApiKeyCredentialService', () => {
  it('issues an opaque credential with a UUID-derived prefix and a 32-byte HMAC digest', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const service = new ApiKeyCredentialService('test-pepper', {
      randomBytes: (size) => Buffer.alloc(size, 0xab),
      randomUUID: () => id,
    });

    const issued = service.issue();

    expect(issued).toMatchObject({ id, prefix: `mq_${id}` });
    expect(issued.plaintext).toMatch(/^mq_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(issued.digest).toHaveLength(32);
    expect(issued.digest).toEqual(
      createHmac('sha256', 'test-pepper')
        .update(issued.plaintext, 'utf8')
        .digest(),
    );
  });

  it('derives the stored digest from a raw credential with the same HMAC format used for issuing', () => {
    const service = new ApiKeyCredentialService('test-pepper', {
      randomBytes: (size) => Buffer.alloc(size, 0xab),
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    });
    const credential =
      'mq_11111111-2222-4333-8444-555555555555.q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';

    expect(
      (service as unknown as { digest(rawCredential: string): Buffer }).digest(
        credential,
      ),
    ).toEqual(
      createHmac('sha256', 'test-pepper').update(credential, 'utf8').digest(),
    );
  });
});
