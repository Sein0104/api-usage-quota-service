import { HttpException } from '@nestjs/common';
import { ProblemCode } from './problem-code.js';

export interface ProblemError {
  field: string;
  reason: string;
}

export interface ProblemExceptionOptions {
  code: ProblemCode;
  detail: string;
  errors?: ProblemError[];
  headers?: Record<string, string>;
  status: number;
  title: string;
}

export class ProblemException extends HttpException {
  constructor(public readonly problem: ProblemExceptionOptions) {
    super(problem, problem.status);
  }
}
