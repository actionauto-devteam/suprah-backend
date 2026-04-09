import { Request, Response, NextFunction } from 'express';
import { metrics } from '../utils/metrics';

/**
 * Middleware to track request metrics (Latency, Traffic, Errors)
 */
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime();
  
  // Track start of request
  metrics.requestsTotal++;

  // Track end of request
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const timeInMs = diff[0] * 1e3 + diff[1] * 1e-6;

    // 1. Record Latency (Circular buffer of last 1000)
    metrics.latencies.push(timeInMs);
    if (metrics.latencies.length > 1000) {
      metrics.latencies.shift();
    }

    // 2. Track Errors
    if (res.statusCode >= 400) {
      metrics.errorsTotal++;
      if (res.statusCode >= 500) {
        metrics.errors5xx++;
      } else {
        metrics.errors4xx++;
      }
    }
  });

  next();
};
