import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import AftermarketReview from '../models/AftermarketReview.model';
import AftermarketProduct from '../models/AftermarketProduct.model';
import AftermarketOrder from '../models/AftermarketOrder.model';
import Organization from '../models/Organization.model';

// ─── Shared helper (same pattern as aftermarket.controller.ts) ───────────────

async function resolveCustomerOrg(req: Request): Promise<string | undefined> {
  if (req.orgId) return req.orgId;
  const orgCount = await Organization.countDocuments({});
  if (orgCount === 1) {
    const only = await Organization.findOne().select('_id');
    if (only) return only._id.toString();
  }
  return undefined;
}

// ─── Customer: submit a review ───────────────────────────────────────────────

/**
 * POST /api/aftermarket/:productId/reviews
 * Body: { rating, title?, body }
 */
export const submitReview = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as any;
  if (!user?._id) throw new ApiError(401, 'Not authenticated');

  const orgId = await resolveCustomerOrg(req);
  if (!orgId) throw new ApiError(403, 'No organization context.');

  const { productId } = req.params;
  const { rating, title, body } = req.body;

  if (!rating || Number(rating) < 1 || Number(rating) > 5) {
    throw new ApiError(400, 'rating must be a whole number between 1 and 5');
  }
  if (!body?.trim() || body.trim().length < 10) {
    throw new ApiError(400, 'Review must be at least 10 characters');
  }

  const product = await AftermarketProduct.findOne({
    _id: productId,
    organizationId: orgId,
    isActive: true,
  });
  if (!product) throw new ApiError(404, 'Product not found');

  // Check if verified purchase (any paid or fulfilled order containing this product)
  const isVerifiedPurchase = !!(await AftermarketOrder.findOne({
    customerId: user._id,
    organizationId: orgId,
    status: { $in: ['paid', 'fulfilled'] },
    'items.productId': productId,
  }));

  const customerName =
    user.fullName ||
    user.name ||
    `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
    'Customer';

  const review = await AftermarketReview.create({
    productId,
    organizationId: orgId,
    customerId: user._id,
    customerName,
    customerAvatar: user.imageUrl || user.avatar || null,
    rating: Math.round(Number(rating)),
    title: title?.trim() || null,
    body: body.trim(),
    isVerifiedPurchase,
  });

  res.status(201).json(new ApiResponse(201, review, 'Review submitted'));
});

// ─── Public: list reviews for a product ─────────────────────────────────────

/**
 * GET /api/aftermarket/:productId/reviews
 * Returns visible reviews + aggregated rating summary.
 * Public — uses auth() only so orgId is available.
 */
export const getProductReviews = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await resolveCustomerOrg(req);
  if (!orgId) throw new ApiError(403, 'No organization context.');

  const { productId } = req.params;
  const { page = '1', limit = '20', sort = 'newest' } = req.query;
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const skip = (pageNum - 1) * limitNum;

  const product = await AftermarketProduct.findOne({
    _id: productId,
    organizationId: orgId,
  }).select('_id name');
  if (!product) throw new ApiError(404, 'Product not found');

  const baseFilter = { productId, organizationId: orgId, isVisible: true };

  // Aggregate stats — must use ObjectId for both fields; aggregate() bypasses Mongoose coercion
  const [stats] = await AftermarketReview.aggregate([
    { $match: {
      productId: new mongoose.Types.ObjectId(productId),
      organizationId: new mongoose.Types.ObjectId(orgId.toString()),
      isVisible: true,
    } },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$rating' },
        totalReviews: { $sum: 1 },
        verifiedCount: { $sum: { $cond: ['$isVerifiedPurchase', 1, 0] } },
        ratingBreakdown: {
          $push: '$rating',
        },
      },
    },
  ]);

  // Count per star (1–5)
  const breakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  if (stats?.ratingBreakdown) {
    for (const r of stats.ratingBreakdown) breakdown[r] = (breakdown[r] || 0) + 1;
  }

  const sortOrder: Record<string, any> =
    sort === 'highest' ? { rating: -1, createdAt: -1 }
    : sort === 'lowest' ? { rating: 1, createdAt: -1 }
    : { createdAt: -1 };

  const [reviews, total] = await Promise.all([
    AftermarketReview.find(baseFilter).sort(sortOrder).skip(skip).limit(limitNum).lean(),
    AftermarketReview.countDocuments(baseFilter),
  ]);

  // Check if the current user has already submitted a review
  const currentUserId = (req.user as any)?._id;
  let myReview: any = null;
  if (currentUserId) {
    myReview = await AftermarketReview.findOne({
      productId,
      customerId: currentUserId,
    }).lean();
  }

  res.json(
    new ApiResponse(
      200,
      {
        summary: {
          averageRating: stats ? Math.round(stats.averageRating * 10) / 10 : 0,
          totalReviews: stats?.totalReviews ?? 0,
          verifiedCount: stats?.verifiedCount ?? 0,
          breakdown,
        },
        myReview,
        reviews,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
      'Reviews fetched'
    )
  );
});

// ─── Customer: delete own review ─────────────────────────────────────────────

/**
 * DELETE /api/aftermarket/:productId/reviews/mine
 */
export const deleteMyReview = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as any;
  if (!user?._id) throw new ApiError(401, 'Not authenticated');

  const { productId } = req.params;
  const deleted = await AftermarketReview.findOneAndDelete({
    productId,
    customerId: user._id,
  });
  if (!deleted) throw new ApiError(404, 'Review not found');

  res.json(new ApiResponse(200, null, 'Review deleted'));
});

// ─── Admin (CRM): toggle review visibility ────────────────────────────────────

/**
 * PATCH /api/crm/aftermarket/reviews/:reviewId  { isVisible: boolean }
 */
export const adminToggleReviewVisibility = asyncHandler(
  async (req: Request, res: Response) => {
    const actor = req.crmUser;
    if (!actor || actor.role !== 'admin') {
      throw new ApiError(403, 'Admin only');
    }

    const { reviewId } = req.params;
    const { isVisible } = req.body;

    const review = await AftermarketReview.findOneAndUpdate(
      { _id: reviewId, organizationId: actor.organizationId },
      { isVisible: !!isVisible },
      { new: true }
    );
    if (!review) throw new ApiError(404, 'Review not found');

    res.json(new ApiResponse(200, review, isVisible ? 'Review made visible' : 'Review hidden'));
  }
);

/**
 * GET /api/crm/aftermarket/:productId/reviews
 * Admin view — includes hidden reviews and extra metadata.
 */
export const adminListReviews = asyncHandler(async (req: Request, res: Response) => {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  if (!actor.organizationId) throw new ApiError(403, 'No organization context.');

  const { productId } = req.params;
  const { page = '1', limit = '20' } = req.query;
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const filter = { productId, organizationId: actor.organizationId };
  const [reviews, total] = await Promise.all([
    AftermarketReview.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    AftermarketReview.countDocuments(filter),
  ]);

  res.json(
    new ApiResponse(
      200,
      { reviews, pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) } },
      'Reviews fetched'
    )
  );
});