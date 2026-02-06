import dotenv from 'dotenv';
import path from 'path';
import Joi from 'joi';

// Load .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test', 'staging').required(),
    PORT: Joi.number().default(5000),
    MONGODB_URI: Joi.string().required().description('Mongo DB url'),
    MONGODB_URI_TEST: Joi.string().allow('').description('Mongo DB test url'),
    BCRYPT_SALT_ROUNDS: Joi.number().required().description('Bcrypt salt rounds'),
    // JWT - Making these optional during migration, or keep required if we want to ensure envs are still there until fully clear
    JWT_ACCESS_SECRET: Joi.string().allow('').description('JWT access secret key'),
    JWT_ACCESS_EXPIRATION: Joi.string().allow('').description("JWT access token expiration time (e.g., '15m', '1h')"),
    JWT_REFRESH_SECRET: Joi.string().allow('').description('JWT refresh secret key'),
    JWT_REFRESH_EXPIRATION: Joi.string().allow('').description('expiration time for refresh token (e.g., "7d", "30d")'),
    // Clerk
    CLERK_PUBLISHABLE_KEY: Joi.string().required().description('Clerk Publishable Key'),
    CLERK_SECRET_KEY: Joi.string().required().description('Clerk Secret Key'),
    CLERK_WEBHOOK_SECRET: Joi.string().required().description('Clerk Webhook Secret'),
    CORS_ORIGIN: Joi.string().default('http://localhost:3000').description('CORS allowed origin'),
    DEALERSCLOUD_FTP_HOST: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_USER: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_PASSWORD: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_FILE: Joi.string().allow('').default('DealerCloud.txt'),
    SYNC_SCHEDULE: Joi.string().default('0 0 * * *'),
    // Email Config (Restored for Appointments)
    EMAIL_HOST: Joi.string().allow('').description('Email server host'),
    EMAIL_PORT: Joi.number().allow('').description('Email server port'),
    EMAIL_USER: Joi.string().allow('').description('Email server username'),
    EMAIL_PASS: Joi.string().allow('').description('Email server password'),
    EMAIL_FROM: Joi.string().allow('').description('Email from address'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  corsOrigin: envVars.CORS_ORIGIN,
  frontendUrl: envVars.CORS_ORIGIN,
  mongoose: {
    url: envVars.NODE_ENV === 'test' && envVars.MONGODB_URI_TEST ? envVars.MONGODB_URI_TEST : envVars.MONGODB_URI,
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  bcryptSaltRounds: envVars.BCRYPT_SALT_ROUNDS,
  jwt: {
    accessSecret: envVars.JWT_ACCESS_SECRET,
    accessExpiration: envVars.JWT_ACCESS_EXPIRATION,
    refreshSecret: envVars.JWT_REFRESH_SECRET,
    refreshExpiration: envVars.JWT_REFRESH_EXPIRATION,
  },
  ftp: {
    host: envVars.DEALERSCLOUD_FTP_HOST,
    user: envVars.DEALERSCLOUD_FTP_USER,
    password: envVars.DEALERSCLOUD_FTP_PASSWORD,
    file: envVars.DEALERSCLOUD_FTP_FILE,
  },
  sync: {
    schedule: envVars.SYNC_SCHEDULE,
  },
  email: {
    host: envVars.EMAIL_HOST,
    port: envVars.EMAIL_PORT,
    user: envVars.EMAIL_USER,
    pass: envVars.EMAIL_PASS,
    from: envVars.EMAIL_FROM,
  },
  clerk: {
    publishableKey: envVars.CLERK_PUBLISHABLE_KEY,
    secretKey: envVars.CLERK_SECRET_KEY,
    webhookSecret: envVars.CLERK_WEBHOOK_SECRET,
  },
};

export default config;
