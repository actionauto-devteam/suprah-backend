import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { streamLogToAdmins } from '../utils/socketEmitter';
import { isDbOutageError, isQuotaExceededError, DB_OUTAGE_MESSAGE } from '../utils/dbOutage';
import { mapKnownError } from '../utils/errorMapping';
import { redactForLog } from '../utils/logRedaction';

const errorHandler: ErrorRequestHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let errorType: string | undefined;
  let errors: unknown[] | undefined = Array.isArray(err?.errors) && err.errors.length > 0 ? err.errors : undefined;

  // Malformed ids, schema validation and duplicate keys are client errors, not 500s.
  const mapped = mapKnownError(err);
  if (mapped) {
    statusCode = mapped.statusCode;
    message = mapped.message;
    errorType = mapped.errorType;
    errors = mapped.errors;
  }

  if (isDbOutageError(err)) {
    statusCode = 503;
    message = DB_OUTAGE_MESSAGE;
    errorType = 'SERVICE_UNAVAILABLE';
    if (isQuotaExceededError(err)) {
      logger.fatal({ err: err.message }, '[CRITICAL] MongoDB storage quota exceeded — writes are blocked. Free up space or upgrade the Atlas cluster tier.');
    }
  }

  const response = {
    code: statusCode,
    message,
    ...(errorType && { errorType }),
    ...(errors && errors.length > 0 && { errors }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  logger.error({ 
    err,
    url: req.url,
    method: req.method,
    // Never log raw request data: bodies carry GPS, signatures, chat text and credentials.
    body: redactForLog(req.body),
    params: req.params,
    query: redactForLog(req.query)
  }, 'Unhandled Error');

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
