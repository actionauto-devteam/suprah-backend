
import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

export const validateGoogleWebhook = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const channelId = req.headers['x-goog-channel-id'];
    const resourceState = req.headers['x-goog-resource-state'];
    
    if (!channelId || !resourceState) {
      console.log('Missing required Google webhook headers');
      throw new ApiError(400, 'Invalid webhook request - missing headers');
    }

    const webhookToken = process.env.GOOGLE_CALENDAR_WEBHOOK_TOKEN;
    if (webhookToken) {
      const providedToken = req.headers['x-goog-channel-token'] || req.query.token;
      
      if (providedToken !== webhookToken) {
        console.log('Invalid webhook token');
        throw new ApiError(401, 'Invalid webhook token');
      }
    }

    console.log('Webhook validation passed');
    next();
  } catch (error) {
    next(error);
  }
};

export const webhookRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  next();
};