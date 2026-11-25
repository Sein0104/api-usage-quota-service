import { applyDecorators } from '@nestjs/common';
import { ApiResponse, ApiSecurity } from '@nestjs/swagger';

export const ApiProjectSecurity = () => ApiSecurity('projectApiKeyBearer');
export const ApiSystemAdminSecurity = () => ApiSecurity('systemAdminBearer');
export const ApiMetricsSecurity = () => ApiSecurity('metricsBearer');

export function ApiProblemResponses(...statuses: number[]): MethodDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        content: {
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/ProblemModel' },
          },
        },
        description: `Problem Details (${status}).`,
        status,
      }),
    ),
  );
}
