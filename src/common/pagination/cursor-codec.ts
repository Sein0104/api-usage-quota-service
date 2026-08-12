import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { ProblemCode } from '../http/problem-code.js';
import { ProblemException } from '../http/problem.exception.js';

export interface CursorValue {
  createdAt: Date;
  id: string;
}

const encodedCursorPattern = /^[A-Za-z0-9_-]+$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CursorCodec {
  encode(cursor: CursorValue): string {
    const payload = JSON.stringify({
      v: 1,
      createdAt: cursor.createdAt.toISOString(),
      id: cursor.id,
    });
    return Buffer.from(payload, 'utf8').toString('base64url');
  }

  decode(encoded: string): CursorValue {
    try {
      if (!encodedCursorPattern.test(encoded)) throw new Error('alphabet');
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw new Error('encoding');
      const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(json);
      if (!isPlainObject(value)) throw new Error('object');
      if (
        Object.keys(value).length !== 3 ||
        !Object.hasOwn(value, 'v') ||
        !Object.hasOwn(value, 'createdAt') ||
        !Object.hasOwn(value, 'id') ||
        value.v !== 1 ||
        typeof value.createdAt !== 'string' ||
        typeof value.id !== 'string' ||
        !timestampPattern.test(value.createdAt) ||
        !uuidPattern.test(value.id)
      ) {
        throw new Error('schema');
      }
      const createdAt = new Date(value.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString() !== value.createdAt
      ) {
        throw new Error('timestamp');
      }
      const decoded = { createdAt, id: value.id };
      if (this.encode(decoded) !== encoded) throw new Error('canonical');
      return decoded;
    } catch {
      throw invalidCursor();
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function invalidCursor(): ProblemException {
  return new ProblemException({
    code: ProblemCode.INVALID_CURSOR,
    detail: 'The pagination cursor is invalid.',
    status: 400,
    title: 'Invalid cursor',
  });
}
