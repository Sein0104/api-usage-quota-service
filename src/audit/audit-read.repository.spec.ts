import { AuditReadRepository } from './audit-read.repository.js';

describe('AuditReadRepository', () => {
  it('binds tenant, descending order, and limit without a tuple for the first page', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const database = {
      $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve([]);
      },
    };

    await new AuditReadRepository().list(
      database as never,
      '22222222-2222-4333-8444-555555555555',
      null,
      51,
    );

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql.replace(/\s+/g, ' ');
    expect(sql).toContain(
      'WHERE project_id = ?::uuid ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    expect(sql).not.toContain('(created_at, id) <');
    expect(calls[0]?.values).toEqual([
      '22222222-2222-4333-8444-555555555555',
      51,
    ]);
  });

  it('binds tenant and strict tuple cursor in one parameterized descending query', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const database = {
      $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        calls.push({ sql: strings.join('?'), values });
        return Promise.resolve([]);
      },
    };
    const cursor = {
      createdAt: new Date('2026-08-12T01:02:03.004Z'),
      id: '11111111-2222-4333-8444-555555555555',
    };

    await new AuditReadRepository().list(
      database as never,
      '22222222-2222-4333-8444-555555555555',
      cursor,
      51,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql.replace(/\s+/g, ' ')).toContain(
      '(created_at, id) < (?, ?::uuid) ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    expect(calls[0]?.values).toEqual([
      '22222222-2222-4333-8444-555555555555',
      cursor.createdAt,
      cursor.id,
      51,
    ]);
  });
});
