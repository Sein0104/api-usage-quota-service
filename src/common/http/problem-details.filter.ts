import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { ProblemCode } from './problem-code.js';
import {
  ProblemException,
  type ProblemExceptionOptions,
} from './problem.exception.js';

interface ProblemDetails extends ProblemExceptionOptions {
  requestId: string;
  type: string;
}

const problemByStatus: Partial<Record<number, ProblemExceptionOptions>> = {
  [HttpStatus.BAD_REQUEST]: {
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    status: HttpStatus.BAD_REQUEST,
    title: 'Validation failed',
  },
  [HttpStatus.NOT_FOUND]: {
    code: ProblemCode.ROUTE_NOT_FOUND,
    detail: 'The requested route was not found.',
    status: HttpStatus.NOT_FOUND,
    title: 'Route not found',
  },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: {
    code: ProblemCode.UNSUPPORTED_MEDIA_TYPE,
    detail: 'The request media type must be application/json.',
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    title: 'Unsupported media type',
  },
};

function toProblemType(code: ProblemCode): string {
  return `urn:api-usage-quota-service:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const requestId = request.requestContext?.requestId ?? randomUUID();

    if (!response.hasHeader('X-Request-Id')) {
      response.setHeader('X-Request-Id', requestId);
    }

    const problem = this.toProblem(exception);
    const body: ProblemDetails = {
      ...problem,
      requestId,
      type: toProblemType(problem.code),
    };

    response.status(problem.status).type('application/problem+json').send(body);
  }

  private toProblem(exception: unknown): ProblemExceptionOptions {
    if (exception instanceof ProblemException) {
      return exception.problem;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return (
        problemByStatus[status] ?? {
          code: ProblemCode.INTERNAL_ERROR,
          detail: 'An unexpected server error occurred.',
          status,
          title: 'Internal server error',
        }
      );
    }

    return {
      code: ProblemCode.INTERNAL_ERROR,
      detail: 'An unexpected server error occurred.',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      title: 'Internal server error',
    };
  }
}
