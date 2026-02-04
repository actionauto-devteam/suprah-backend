// middleware/webhookValidation.middleware.ts - NEW FILE

import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

/**
 * Validate Google Calendar webhook requests
 * 
 * Google sends specific headers that we can validate:
 * - x-goog-channel-id: The channel ID we registered
 * - x-goog-resource-state: The type of notification (sync, exists, not_exists)
 * - x-goog-resource-id: The opaque ID for the watched resource
 * 
 * Optional: Add custom token validation via query param or header
 */
export const validateGoogleWebhook = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    // Check for required Google headers
    const channelId = req.headers['x-goog-channel-id'];
    const resourceState = req.headers['x-goog-resource-state'];
    
    if (!channelId || !resourceState) {
      console.log('Missing required Google webhook headers');
      throw new ApiError(400, 'Invalid webhook request - missing headers');
    }

    // Optional: Validate webhook token if configured
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

/**
 * Rate limiting for webhook endpoint (optional)
 */
export const webhookRateLimit = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Implement rate limiting if needed
  // For now, just pass through
  next();
};