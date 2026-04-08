import { Writable } from 'stream';
const build = async (options: any) => {
  // We use a dynamic import for the model to ensure Mongoose is available in the worker
  const mongoose = require('mongoose');
  const { SystemLog } = require('../models/SystemLog.model');

  // Handle cross-thread Mongoose connection if needed
  // In most standard setups, we just need to ensure we don't crash if connection isn't ready
  
  return new Writable({
    objectMode: true,
    write(chunk, encoding, callback) {
      // Pino logs are often objects when using 'objectMode: true' in transports
      const logData = chunk;

      const saveLog = async () => {
        try {
          if (mongoose.connection.readyState !== 1) {
            // If DB is not connected, we skip this log to avoid blocking the buffer
            // In a production setup, you might want a small in-memory queue
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
          console.error('[Pino-MongoDB-Transport] Error saving log:', error);
          callback(); // Proceed to next log to prevent stream backup
        }
      };

      saveLog();
    }
  });
};

export default build;
