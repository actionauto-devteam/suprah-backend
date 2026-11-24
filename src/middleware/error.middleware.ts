import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { streamLogToAdmins } from '../utils/socketEmitter';
import { isDbOutageError, isQuotaExceededError, DB_OUTAGE_MESSAGE } from '../utils/dbOutage';
import { mapKnownError } from '../utils/errorMapping';
import { redactForLog } from '../utils/logRedaction';
import { isStripeError, stripeErrorForLog } from '../utils/stripeErrors';
import { SUPPORT_EMAIL } from '../utils/userMessages';

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

  // Unexpected failures (anything not raised on purpose as an ApiError) must
  // not show raw technical text to users. The full error is logged below.
  // A mapped error (a Stripe failure, for example) already has a plain message.
  if (statusCode >= 500 && !(err instanceof ApiError) && !mapped) {
    message =
      `Something went wrong on our side, so this action wasn't completed. Please try again in a moment. If it keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
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

  // A Stripe error's message can repeat values that were sent (an email
  // address, for example): its type, code and request id find it in Stripe.
  const stripe = isStripeError(err);
  logger.error({
    err: stripe ? stripeErrorForLog(err) : err,
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
      message: stripe ? `Payment provider error (${String(err.type)}${err.code ? `, ${String(err.code)}` : ''})` : err.message || 'System Error',
      timestamp: new Date().toISOString(),
      requestId: req.id,
      url: req.url,
      method: req.method
    });
  }

  res.status(statusCode).send(response);
};

export { errorHandler };
