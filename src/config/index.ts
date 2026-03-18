import dotenv from 'dotenv';
import path from 'path';
import Joi from 'joi';

// Load .env files (local overrides the main .env)
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test', 'staging').required(),
    PORT: Joi.number().default(5000),
    BACKEND_URL: Joi.string().required().description('Backend URL'),
    MONGODB_URI: Joi.string().required().description('Mongo DB url'),
    MONGODB_URI_TEST: Joi.string().allow('').description('Mongo DB test url'),
    BCRYPT_SALT_ROUNDS: Joi.number().required().description('Bcrypt salt rounds'),
    // JWT
    JWT_ACCESS_SECRET: Joi.string().allow('').description('JWT access secret key'),
    JWT_ACCESS_EXPIRATION: Joi.string().allow('').description("JWT access token expiration time"),
    JWT_REFRESH_SECRET: Joi.string().allow('').description('JWT refresh secret key'),
    JWT_REFRESH_EXPIRATION: Joi.string().allow('').description('expiration time for refresh token'),

    CORS_ORIGIN: Joi.string().default('http://localhost:3000').description('CORS allowed origin'),
    DEALERSCLOUD_FTP_HOST: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_USER: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_PASSWORD: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_FILE: Joi.string().allow('').default('DealerCloud.txt'),
    SYNC_SCHEDULE: Joi.string().default('0 0 * * *'),
    // Email Config
    SMTP_HOST: Joi.string().allow('').description('Email server host'),
    SMTP_PORT: Joi.number().allow('').description('Email server port'),
    SMTP_SECURE: Joi.boolean().allow('').description('Email server secure'),
    SMTP_USER: Joi.string().allow('').description('Email server username'),
    SMTP_PASS: Joi.string().allow('').description('Email server password'),
    // Google
    GOOGLE_CLIENT_ID: Joi.string().allow('').description('Google Client ID'),
    GOOGLE_CLIENT_SECRET: Joi.string().allow('').description('Google Client Secret'),
    GOOGLE_REDIRECT_URI: Joi.string().allow('').description('Google Redirect URI'),
    // Stripe
    STRIPE_SECRET_KEY: Joi.string().required().description('Stripe Secret Key'),
    STRIPE_PUBLISHABLE_KEY: Joi.string().required().description('Stripe Publishable Key'),
    STRIPE_WEBHOOK_SECRET: Joi.string().allow('').description('Stripe Webhook Secret'),
    // Redis
    REDIS_ENABLED: Joi.boolean().default(true).description('Redis enabled toggle'),
    REDIS_HOST: Joi.string().default('127.0.0.1').description('Redis host'),
    REDIS_PORT: Joi.number().default(6379).description('Redis port'),
    REDIS_PASSWORD: Joi.string().allow('').default('').description('Redis password'),

    // Cloudflare R2
    R2_ACCESS_KEY_ID: Joi.string().allow('').description('R2 Access Key'),
    R2_SECRET_ACCESS_KEY: Joi.string().allow('').description('R2 Secret Access Key'),
    R2_ENDPOINT: Joi.string().allow('').description('R2 Endpoint'),
    R2_BUCKET_NAME: Joi.string().allow('').description('R2 Bucket Name'),
    R2_PUBLIC_URL: Joi.string().allow('').description('R2 Public URL'),
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
  frontendUrl: envVars.FRONTEND_URL,
  backendUrl: envVars.BACKEND_URL,
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
    host: envVars.SMTP_HOST,
    port: envVars.SMTP_PORT,
    secure: envVars.SMTP_SECURE,
    user: envVars.SMTP_USER,
    pass: envVars.SMTP_PASS,
  },

  google: {
    clientId: envVars.GOOGLE_CLIENT_ID,
    clientSecret: envVars.GOOGLE_CLIENT_SECRET,
    redirectUri: envVars.GOOGLE_REDIRECT_URI,
  },
  stripe: {
    secretKey: envVars.STRIPE_SECRET_KEY,
    publishableKey: envVars.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: envVars.STRIPE_WEBHOOK_SECRET || '',
  },
  redis: {
    enabled: envVars.REDIS_ENABLED,
    host: envVars.REDIS_HOST,
    port: envVars.REDIS_PORT,
    password: envVars.REDIS_PASSWORD || undefined,
  },
  r2: {
    accessKeyId: envVars.R2_ACCESS_KEY_ID,
    secretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
    endpoint: envVars.R2_ENDPOINT,
    bucketName: envVars.R2_BUCKET_NAME,
    publicUrl: envVars.R2_PUBLIC_URL,
  },
};

export default config;