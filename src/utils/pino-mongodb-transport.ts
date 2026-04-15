import { Writable } from 'stream';
import mongoose from 'mongoose';
import { SystemLog } from '../models/SystemLog.model';

const build = async (options: any) => {

  // Handle cross-thread Mongoose connection 
  // Pino transports run in a separate worker thread and don't share the main process connection.
  const connect = async () => {
    if (mongoose.connection.readyState === 1) return;
    
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
  };

  await connect();
  
  return new Writable({
    objectMode: true,
    write(chunk, encoding, callback) {
      const logData = chunk;

      const saveLog = async () => {
        try {
          // Attempt to reconnect if connection dropped
          if (mongoose.connection.readyState !== 1) {
            await connect();
          }

          if (mongoose.connection.readyState !== 1) {
            // Only warn periodically to avoid flooding stdout if DB is down
            if (Math.random() < 0.01) {
              console.warn('[Pino-MongoDB-Transport] DB not ready (readyState: %d). Skipping log.', mongoose.connection.readyState);
            }
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
          console.error('[Pino-MongoDB-Transport] Error saving log to MongoDB:', error);
          callback(); 
        }
      };

      saveLog();
    }
  });
};



export default build;
