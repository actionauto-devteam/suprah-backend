import pino from 'pino';
// v1.4.0
import pinoHttp from 'pino-http';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
const isDev = env === 'development';
const isTest = env === 'test';
const logLevel = (isDev || isTest) ? 'debug' : 'info';

const logDir = path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'app.log');

const fs = require('fs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

let logger: pino.Logger;

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
          event: logData.event,
          meta: logData.meta,
          env: logData.env || process.env.NODE_ENV,
        }).catch((e: any) => console.error('[Mongo-Log-Dev] Error:', e));
      }
    } catch (e) {  }
  }
};

if (isDev) {
  let terminalStream;
  try {
    terminalStream = require('pino-pretty')({
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard',
    });
  } catch (e) {
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
      // Routine request logs stay local only — only warn/error/fatal are
      // worth persisting to Mongo. See the `streams` array below for why.
      { stream: mongoDevStream as any, level: 'warn' }
    ])
  );
} else if (isTest) {
  logger = pino({ level: 'silent' });
} else {
  const streams = [
    {
      stream: pino.destination({ dest: 1, sync: false }),
      level: 'info',
    },
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
    {
      // Every request at 'info' was writing ~290k docs/day into MongoDB and
      // blew through the Atlas storage quota (8.7M docs, ~3GB) in 30 days.
      // Routine request logs stay in the local rotating file above; only
      // warn/error/fatal are worth the Mongo write.
      stream: pino.transport({
        target: path.join(__dirname, `pino-mongodb-transport${__filename.endsWith('.ts') ? '.ts' : '.js'}`),
        options: {
          uri: process.env.MONGODB_URI
        },
      }),
      level: 'warn',
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
