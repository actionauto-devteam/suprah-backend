import pino from 'pino';
import pinoHttp from 'pino-http';
import path from 'path';

// Define log level based on environment
const level = process.env.NODE_ENV === 'development' ? 'debug' : 'info';

// Configure transports
const transport = pino.transport({
  targets: [
    // 1. Pretty print to console for development
    ...(process.env.NODE_ENV === 'development'
      ? [
          {
            target: 'pino-pretty',
            options: {
              colorize: true,
              ignore: 'pid,hostname',
              translateTime: 'SYS:standard',
            },
            level: 'debug',
          },
        ]
      : [
          {
            target: 'pino/file',
            options: { destination: 1 }, // stdout for production (Docker/PM2 logs)
            level: 'info',
          },
        ]),
    // 2. Rolling file transport for persistent logs (Self-Hosted logic)
    {
      target: 'pino-roll',
      options: {
        file: path.join(process.cwd(), 'logs', 'app.log'),
        frequency: 'daily',
        size: '20m', // Roll when file hits 20MB
        mkdir: true,
        limit: {
          count: 7, // Keep 7 days of logs
        },
      },
      level: 'info',
    },
  ],
});

// Create the logger instance
const logger = pino(
  {
    level,
    base: {
      env: process.env.NODE_ENV,
    },
    // PII Masking: Redact sensitive fields from the logs
    redact: {
      paths: [
        'req.headers.authorization',
        'req.body.password',
        'req.body.token',
        'req.body.creditCard',
        'req.body.ssn',
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
