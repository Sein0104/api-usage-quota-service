import Joi from 'joi';

export interface Environment {
  API_KEY_PEPPER: string;
  DATABASE_URL: string;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  METRICS_TOKEN: string;
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  SWAGGER_ENABLED: boolean;
  SYSTEM_ADMIN_TOKEN: string;
  TZ: 'UTC';
}

export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().required(),
  DATABASE_URL: Joi.string().uri().required(),
  SYSTEM_ADMIN_TOKEN: Joi.string().min(43).required(),
  API_KEY_PEPPER: Joi.string().min(43).required(),
  METRICS_TOKEN: Joi.string().min(43).required(),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .required(),
  TZ: Joi.string().valid('UTC').required(),
  SWAGGER_ENABLED: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),
});

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const { error, value } = environmentSchema.validate(config, {
    abortEarly: false,
    allowUnknown: true,
    convert: true,
  });

  if (error !== undefined) {
    throw new Error(`Environment validation failed: ${error.message}`);
  }

  return value as Environment;
}
