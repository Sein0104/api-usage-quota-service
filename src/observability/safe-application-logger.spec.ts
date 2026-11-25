import pino, { type DestinationStream } from 'pino';
import { SafeApplicationLogger } from './safe-application-logger.js';

describe('SafeApplicationLogger', () => {
  it('serializes one request_id and drops arbitrary nested credential fields', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk: string) {
        lines.push(chunk);
      },
    };
    const logger = pino({ base: null, timestamp: false }, destination);
    const safeLogger = new SafeApplicationLogger(() => logger);

    safeLogger.requestCompleted({
      duration: 0.125,
      outcome: 'CLIENT_ERROR',
      requestId: 'request-id-canary',
      route: 'GET /metrics',
      status: 401,
      nested: {
        secret: 'nested-secret-canary',
        token: 'nested-token-canary',
      },
    } as never);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.match(/"request_id"/g)).toHaveLength(1);
    expect(lines[0]).not.toContain('nested-secret-canary');
    expect(lines[0]).not.toContain('nested-token-canary');
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({
      duration: 0.125,
      level: 30,
      msg: 'request completed',
      outcome: 'CLIENT_ERROR',
      request_id: 'request-id-canary',
      route: 'GET /metrics',
      status: 401,
    });
  });
});
