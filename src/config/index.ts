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
    BCRYPT_SALT_ROUNDS: Joi.number().required().description('Bcrypt salt rounds'),
    JWT_ACCESS_SECRET: Joi.string().required().description('JWT access secret key'),
    JWT_ACCESS_EXPIRATION: Joi.string().required().description("JWT access token expiration time (e.g., '15m', '1h')"),
    JWT_REFRESH_SECRET: Joi.string().required().description('JWT refresh secret key'),
    JWT_REFRESH_EXPIRATION: Joi.string()
      .required()
      .description('expiration time for refresh token (e.g., "7d", "30d")'),
    CORS_ORIGIN: Joi.string().default('http://localhost:3000').description('CORS allowed origin'),
    DEALERSCLOUD_FTP_HOST: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_USER: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_PASSWORD: Joi.string().allow('').default(''),
    DEALERSCLOUD_FTP_FILE: Joi.string().allow('').default('DealerCloud.txt'),
    SYNC_SCHEDULE: Joi.string().default('0 0 * * *'),
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
  mongoose: {
    url: envVars.MONGODB_URI,
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
};

export default config;
