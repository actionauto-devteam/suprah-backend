import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const correlationIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  
  req.id = requestId;
  (req as any).requestId = requestId;
  
  res.setHeader('x-request-id', requestId);
  
  next();
};
