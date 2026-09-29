import { Request, Response, NextFunction } from 'express';
import { metrics, connectionMetrics } from '../utils/metrics';
import logger from '../utils/logger';

export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime();
  
  metrics.requestsTotal++;

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const timeInMs = diff[0] * 1e3 + diff[1] * 1e-6;

    metrics.latencies.push(timeInMs);
    if (metrics.latencies.length > 1000) {
      metrics.latencies.shift();
    }

    if (res.statusCode === 401) {
      connectionMetrics.signedOutRefusals++;
    } else if (res.statusCode === 403) {
      connectionMetrics.notAllowedRefusals++;
      // Who was refused and where. No query string (it can carry tokens) and no body.
      logger.warn({
        event: 'authorization_refused',
        method: req.method,
        path: String(req.originalUrl || req.url || '').split('?')[0],
        userId: req.user?._id ? String(req.user._id) : null,
        organizationId: req.orgId ?? null,
      }, 'Request refused: not allowed');
    }

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
