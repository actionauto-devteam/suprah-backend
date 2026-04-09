import pino from 'pino';
import pinoHttp from 'pino-http';
import path from 'path';
import dotenv from 'dotenv';

// Ensure .env is loaded before configuring the logger
dotenv.config();

const env = process.env.NODE_ENV || 'development';
const isDev = env === 'development';
const isTest = env === 'test';
const logLevel = (isDev || isTest) ? 'debug' : 'info';

const logDir = path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'app.log');

// Define logger variable
let logger: pino.Logger;

// Custom dev-stream for MongoDB ingestion (uses model directly to avoid worker overhead in dev)
const mongoDevStream = {
  write: (chunk: string) => {
    try {
      const { SystemLog } = require('../models/SystemLog.model');
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState === 1) {
        const logData = JSON.parse(chunk);
        SystemLog.create({
          timestamp: new Date(logData.time || Date.now()),
          level: logData.level || 'INFO',
          message: logData.msg || '',
          req: logData.req,
          res: logData.res,
          err: logData.err,
          context: logData.context,
          env: logData.env || process.env.NODE_ENV,
        }).catch((e: any) => console.error('[Mongo-Log-Dev] Error:', e));
      }
    } catch (e) { /* Ignore parsing errors for non-JSON chunks */ }
  }
};

if (isDev) {
  // In development, combine formatted terminal output with file logging + MongoDB
  const prettyStream = require('pino-pretty')({
    colorize: true,
    ignore: 'pid,hostname',
    translateTime: 'SYS:standard',
  });
  
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
        ],
        censor: '[REDACTED]',
        remove: false
      },
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([
      { stream: prettyStream, level: logLevel },
      { stream: fileStream, level: 'info' },
      { stream: mongoDevStream as any, level: 'info' }
    ])
  );
} else if (isTest) {
  // In test environment, use a silent logger to keep output clean and avoid worker conflicts
  logger = pino({ level: 'silent' });
} else {
  // In production, use high-performance transports (JSON stdout + Rolling File + MongoDB Worker)
  const transport = pino.transport({
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
      {
        target: path.join(__dirname, `pino-mongodb-transport${__filename.endsWith('.ts') ? '.ts' : '.js'}`),
        options: {},
        level: 'info',
      },
    ],
  });

  logger = pino(
    {
      level: logLevel,
      base: { env },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
        ],
        censor: '[REDACTED]',
        remove: false
      },
      formatters: {
        level: (label) => ({ level: label.toUpperCase() }),
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
