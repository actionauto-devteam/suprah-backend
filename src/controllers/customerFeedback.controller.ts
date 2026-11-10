import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { getPublicFeedback, submitPublicFeedback } from '../services/customerFeedback.service';

export const getPublicFeedbackHandler = asyncHandler(async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, await getPublicFeedback(req.params.token), 'Feedback'));
});

export const submitPublicFeedbackHandler = asyncHandler(async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, await submitPublicFeedback(req.params.token, req.body || {}), 'Thank you for your feedback'));
});
