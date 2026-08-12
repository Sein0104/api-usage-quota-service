import { DynamicModule, Global, Module } from '@nestjs/common';
import type { Environment } from './environment.schema.js';

export const ENVIRONMENT = Symbol('ENVIRONMENT');

@Global()
@Module({})
export class EnvironmentModule {
  static forRoot(environment: Environment): DynamicModule {
    return {
      exports: [ENVIRONMENT],
      global: true,
      module: EnvironmentModule,
      providers: [{ provide: ENVIRONMENT, useValue: environment }],
    };
  }
}
