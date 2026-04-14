import { Writable } from 'stream';
const build = async (options: any) => {
  // We use a dynamic import for the model to ensure Mongoose is available in the worker
  const mongoose = require('mongoose');
  const { SystemLog } = require('../models/SystemLog.model');

  // Handle cross-thread Mongoose connection 
  // Pino transports run in a separate worker thread and don't share the main process connection.
  if (mongoose.connection.readyState !== 1) {
    const mongoUri = options.uri || process.env.MONGODB_URI;
    if (mongoUri) {
      try {
        await mongoose.connect(mongoUri);
        console.log('[Pino-MongoDB-Transport] Worker established DB connection');
      } catch (err) {
        console.error('[Pino-MongoDB-Transport] Failed to connect to DB in worker:', err);
      }
    } else {
      console.warn('[Pino-MongoDB-Transport] No MONGODB_URI provided to worker transport');
    }
  }
  
  return new Writable({
    objectMode: true,
    write(chunk, encoding, callback) {
      // Pino logs are often objects when using 'objectMode: true' in transports
      const logData = chunk;

      const saveLog = async () => {
        try {
          if (mongoose.connection.readyState !== 1) {
            // Log to stdout so the user can see in Docker/PM2 that logging is disconnected
            console.warn('[Pino-MongoDB-Transport] DB not ready (readyState: %d). Skipping log.', mongoose.connection.readyState);
            return callback();
          }

          // Map Pino log fields to our SystemLog schema
          await SystemLog.create({
            timestamp: new Date(logData.time || Date.now()),
            level: logData.level || 'INFO',
            message: logData.msg || '',
            req: logData.req,
            res: logData.res,
            err: logData.err,
            context: logData.context,
            env: logData.env || process.env.NODE_ENV,
          });

          callback();
        } catch (error) {
          // Log the error to stdout to avoid silent failures in the worker
          console.error('[Pino-MongoDB-Transport] Error saving log to MongoDB:', error);
          callback(); 
        }
      };


      saveLog();
    }
  });
};


export default build;
