import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import type { PresentedUsageTerminal } from './quota-response.js';

export class QuotaExceededException extends ProblemException {
  constructor(presented: PresentedUsageTerminal) {
    super({
      code: ProblemCode.QUOTA_EXCEEDED,
      detail: 'Use a new idempotency key after the quota resets.',
      extensions: {
        decision: presented.body.decision,
        eventId: presented.body.eventId,
        quota: presented.body.quota,
        units: presented.body.units,
        usageDate: presented.body.usageDate,
      },
      headers: presented.headers,
      status: 429,
      title: 'Daily quota exceeded',
    });
  }
}
