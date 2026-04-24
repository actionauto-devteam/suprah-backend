import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Middleware to add a unique Request ID to every incoming request.
 * This ID is used for correlation across logs and tracing.
 */
export const correlationIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Use existing ID if provided (e.g., by Nginx/Cloudflare), otherwise generate new one
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  
  // Attach to request object for pino-http and downstream services
  req.id = requestId;
  (req as any).requestId = requestId; // Backup for older code
  
  // Expose to client for support/debugging
  res.setHeader('x-request-id', requestId);
  
  next();
};
