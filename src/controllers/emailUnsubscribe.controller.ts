import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { asyncHandler } from '../utils/asyncHandler';
import EmailOptOut from '../models/EmailOptOut.model';
import logger from '../utils/logger';

interface UnsubscribeTokenPayload {
  organizationId: string;
  email: string;
  purpose: string;
}

function verifyToken(token: unknown): UnsubscribeTokenPayload | null {
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = jwt.verify(token, config.jwt.emailOptOutSecret) as UnsubscribeTokenPayload;
    if (payload?.purpose !== 'review_request_unsubscribe' || !payload.organizationId || !payload.email) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #f4f4f5; color: #18181b; margin: 0; padding: 40px 16px; }
  .card { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); text-align: center; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.6; color: #52525b; margin: 0 0 20px; }
  button { font-size: 14px; font-weight: 600; padding: 10px 20px; border-radius: 8px; border: none; background: #18181b; color: #fff; cursor: pointer; }
</style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

export const renderUnsubscribeConfirm = asyncHandler(async (req: Request, res: Response) => {
  const payload = verifyToken(req.query.token);
  if (!payload) {
    res.type('html').status(400).send(
      page('Link expired', '<h1>This link is no longer valid</h1><p>Please contact us directly if you no longer want to receive review request emails.</p>'),
    );
    return;
  }

  res.type('html').send(
    page(
      'Unsubscribe',
      `<h1>Stop review request emails?</h1>
       <p>You'll no longer receive review request emails at ${payload.email}. This won't affect other emails from us.</p>
       <form method="POST" action="/api/email/unsubscribe?token=${encodeURIComponent(String(req.query.token))}">
         <button type="submit">Confirm unsubscribe</button>
       </form>`,
    ),
  );
});

export const confirmUnsubscribe = asyncHandler(async (req: Request, res: Response) => {
  const payload = verifyToken(req.query.token);
  if (!payload) {
    res.type('html').status(400).send(
      page('Link expired', '<h1>This link is no longer valid</h1><p>Please contact us directly if you no longer want to receive review request emails.</p>'),
    );
    return;
  }

  await EmailOptOut.findOneAndUpdate(
    { organizationId: payload.organizationId, email: payload.email },
    { $set: { optedOut: true, changedAt: new Date() } },
    { upsert: true },
  );

  logger.info({ organizationId: payload.organizationId, email: payload.email }, '[EmailUnsubscribe] Opted out');

  res.type('html').send(
    page('Unsubscribed', `<h1>You're unsubscribed</h1><p>${payload.email} will no longer receive review request emails.</p>`),
  );
});
