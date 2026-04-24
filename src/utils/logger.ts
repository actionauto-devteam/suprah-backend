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

// Ensure log directory exists
const fs = require('fs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

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
  let terminalStream;
  try {
    terminalStream = require('pino-pretty')({
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
    });
  } catch (e) {
    // If pino-pretty is not available (e.g., inside basic Docker container), fallback to stdout
    terminalStream = process.stdout;
  }
  
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
      { stream: terminalStream, level: logLevel },
      { stream: fileStream, level: 'info' },
      { stream: mongoDevStream as any, level: 'info' }
    ])
  );
} else if (isTest) {
  // In test environment, use a silent logger to keep output clean and avoid worker conflicts
  logger = pino({ level: 'silent' });
} else {
  // In production, we decouple streams to prevent one (e.g., MongoDB) from blocking the others (e.g., Docker logs)
  const streams = [
    // 1. Immediate Stdout: Zero worker overhead for instant Docker pulse
    {
      stream: pino.destination({ dest: 1, sync: false }),
      level: 'info',
    },
    // 2. Rolling File: Asynchronous worker for long-term audit trail
    {
      stream: pino.transport({
        target: 'pino-roll',
        options: {
          file: logFile,
          frequency: 'daily',
          size: '20m',
          mkdir: true,
        },
      }),
      level: 'info',
    },
    // 3. MongoDB Cloud Log: Dedicated worker for the Admin Dashboard
    {
      stream: pino.transport({
        target: path.join(__dirname, `pino-mongodb-transport${__filename.endsWith('.ts') ? '.ts' : '.js'}`),
        options: { 
          uri: process.env.MONGODB_URI 
        },
      }),
      level: 'info',
    }
  ];

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
    pino.multistream(streams)
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
