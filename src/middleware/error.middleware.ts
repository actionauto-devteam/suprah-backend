import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { streamLogToAdmins } from '../utils/socketEmitter';

const errorHandler: ErrorRequestHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // For now, we will not send the stack trace to the client in production
  const response = {
    code: statusCode,
    message,
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
