import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';

export interface ListDailyUsageQuery {
  from: string;
  to: string;
}

interface ParsedDate {
  epochDay: number;
  value: string;
}

function validation(field: string, reason: string): never {
  throw new ProblemException({
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    errors: [{ field, reason }],
    status: 400,
    title: 'Validation failed',
  });
}

function parseDate(field: 'from' | 'to', value: unknown): ParsedDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return validation(field, 'must be a single UTC date in YYYY-MM-DD format');
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return validation(field, 'must be a real Gregorian date');
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return validation(field, 'must be a real Gregorian date');
  }
  return { epochDay: date.getTime() / 86_400_000, value };
}

export function parseListDailyUsageQuery(
  query: Record<string, unknown>,
): ListDailyUsageQuery {
  const keys = Object.keys(query);
  const unknown = keys.find((key) => key !== 'from' && key !== 'to');
  if (unknown !== undefined) validation(unknown, 'is not allowed');
  const from = parseDate('from', query.from);
  const to = parseDate('to', query.to);
  const inclusiveDays = to.epochDay - from.epochDay + 1;
  if (inclusiveDays < 1) validation('to', 'must be on or after from');
  if (inclusiveDays > 90)
    validation('to', 'date range must not exceed 90 days');
  return { from: from.value, to: to.value };
}
