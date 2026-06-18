import { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';
import PointTransaction from '../models/PointTransaction.model';
import membershipService from '../services/membership.service';

export const discountTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => (req.user as IUser)?._id?.toString() ?? req.ip ?? 'unknown',
  message: { success: false, message: 'Too many discount token requests, please wait a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const getMyMembership = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const status = await membershipService.getMembershipStatus(userId);
  res.json(new ApiResponse(200, status, 'Membership status fetched'));
});

export const getAllTiers = asyncHandler(async (_req: Request, res: Response) => {
  const tiers = await membershipService.getTierList();
  res.json(new ApiResponse(200, tiers, 'Tiers fetched'));
});

export const getMyHistory = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    PointTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PointTransaction.countDocuments({ userId }),
  ]);

  res.json(new ApiResponse(200, { transactions, total, page, limit }, 'History fetched'));
});

export const generateDiscountToken = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId ?? 'global';
  const result = await membershipService.generateDiscountToken(userId, orgId);
  res.json(new ApiResponse(200, result, 'Discount token generated'));
});

export const verifyDiscountToken = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const { token } = req.body;
  if (!token) throw new ApiError(400, 'token is required');
  const result = await membershipService.verifyAndConsumeDiscountToken(token, userId);
  res.json(new ApiResponse(200, result, result.valid ? 'Token valid' : 'Token invalid'));
});

export const adminAdjustPoints = asyncHandler(async (req: Request, res: Response) => {
  const adminUserId = (req.user as IUser)._id.toString();
  const orgId = req.orgId ?? 'global';
  const { targetUserId, delta, reason } = req.body;

  if (!targetUserId || delta === undefined || !reason) {
    throw new ApiError(400, 'targetUserId, delta, and reason are required');
  }
  if (typeof delta !== 'number' || delta === 0) {
    throw new ApiError(400, 'delta must be a non-zero number');
  }

  const result = await membershipService.adminAdjustPoints({
    targetUserId,
    adminUserId,
    organizationId: orgId,
    delta,
    reason,
  });

  res.json(new ApiResponse(200, result, 'Points adjusted'));
});
