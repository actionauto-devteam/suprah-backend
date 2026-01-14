import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

const errorHandler = (err: ApiError, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // For now, we will not send the stack trace to the client in production
  const response = {
    code: statusCode,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  };

  console.error(err);

  res.status(statusCode).send(response);
};

export { errorHandler };
