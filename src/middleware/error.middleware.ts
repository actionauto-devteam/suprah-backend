import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { streamLogToAdmins } from '../utils/socketEmitter';
import { isDbOutageError, isQuotaExceededError, DB_OUTAGE_MESSAGE } from '../utils/dbOutage';

const errorHandler: ErrorRequestHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let errorType: string | undefined;

  if (isDbOutageError(err)) {
    statusCode = 503;
    message = DB_OUTAGE_MESSAGE;
    errorType = 'SERVICE_UNAVAILABLE';
    if (isQuotaExceededError(err)) {
      logger.fatal({ err: err.message }, '[CRITICAL] MongoDB storage quota exceeded — writes are blocked. Free up space or upgrade the Atlas cluster tier.');
    }
  }

  // For now, we will not send the stack trace to the client in production
  const response = {
    code: statusCode,
    message,
    ...(errorType && { errorType }),
    ...(Array.isArray(err.errors) && err.errors.length > 0 && { errors: err.errors }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  logger.error({ 
    err,
    url: req.url,
    method: req.method,
    body: req.body,
    params: req.params,
    query: req.query
  }, 'Unhandled Error');

  // Stream critical errors to monitoring dashboard (Phase 5)
  if (statusCode >= 500) {
    streamLogToAdmins({
      level: 'error',
      message: err.message || 'System Error',
      timestamp: new Date().toISOString(),
      requestId: req.id,
      url: req.url,
      method: req.method
    });
  }

  res.status(statusCode).send(response);
};

export { errorHandler };
