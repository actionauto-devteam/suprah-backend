import pino from 'pino';
import pinoHttp from 'pino-http';
import path from 'path';
import dotenv from 'dotenv';

// Ensure .env is loaded before configuring the logger
dotenv.config();

const env = process.env.NODE_ENV || 'development';
const isDev = env === 'development';
const logLevel = isDev ? 'debug' : 'info';

const logDir = path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'app.log');

// Configure transport targets
const transport = isDev
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'SYS:standard',
      },
    })
  : pino.transport({
      targets: [
        {
          target: 'pino/file',
          options: { destination: 1 },
          level: 'info',
        },
        {
          target: 'pino-roll',
          options: {
            file: logFile,
            frequency: 'daily',
            size: '20m',
            mkdir: true,
          },
          level: 'info',
        },
      ],
    });

// Create the logger instance
let logger: pino.Logger;

if (isDev) {
  // In development, we combine formatted terminal output with file logging
  // multistream allows us to bypass worker thread capture issues in ts-node-dev
  const prettyStream = require('pino-pretty')({
    colorize: true,
    ignore: 'pid,hostname',
    translateTime: 'SYS:standard',
  });
  
  // Create a file stream for development as well
  const fs = require('fs');
  const fileStream = fs.createWriteStream(logFile, { flags: 'a' });

  logger = pino(
    {
      level: logLevel,
      base: { env },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.password_confirmation',
          'req.body.token',
          'req.body.creditCard',
          'req.body.ssn',
          'req.body.dob',
          'req.body.routingNumber',
          'req.body.accountNumber',
          'req.body.cvv',
          'req.body.pin',
          'res.headers["set-cookie"]'
        ],
        censor: '[REDACTED]',
        remove: false
      },
      formatters: {
        level: (label) => {
          return { level: label.toUpperCase() };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: prettyStream, level: logLevel },
      { stream: fileStream, level: 'info' }
    ])
  );
} else {
  // In production, use high-performance transports (JSON stdout + Rolling File)
  logger = pino(
    {
      level: logLevel,
      base: { env },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.password_confirmation',
          'req.body.token',
          'req.body.creditCard',
          'req.body.ssn',
          'req.body.dob',
          'req.body.routingNumber',
          'req.body.accountNumber',
          'req.body.cvv',
          'req.body.pin',
          'res.headers["set-cookie"]'
        ],
        censor: '[REDACTED]',
        remove: false
      },
      formatters: {
        level: (label) => {
          return { level: label.toUpperCase() };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport
  );
}

// Initial startup log to verify log visibility
logger.info({ env, logLevel }, 'Logger initialized');

// Create HTTP logger middleware
export const httpLogger = pinoHttp({
  logger,
  // Use X-Request-Id from the request if available
  genReqId: (req) => req.headers['x-request-id'] || req.id || require('crypto').randomUUID(),
  // Custom request serialization
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query,
      remoteAddress: req.remoteAddress,
      // Only include organizationId if it exists on the req (populated by middleware)
      organizationId: req.raw?.organizationId || req.organizationId,
      userId: req.raw?.user?.id || req.user?.id || req.user?._id,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err
  },
  // Custom success/error messages
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} completed with ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} failed with ${res.statusCode}: ${err.message}`;
  },
});

export default logger;
