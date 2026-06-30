import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DealershipReview from '../models/DealershipReview.model';

const SOURCES = ['google', 'yelp', 'facebook', 'other'] as const;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeUrl = (url?: string | null): string | null => {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  rating_desc: { rating: -1, createdAt: -1 },
  rating_asc: { rating: 1, createdAt: -1 },
};

/**
 * GET /api/crm/reviews
 * Paginated, org-scoped list with source/rating/search filters + sort,
 * an average-rating summary, and a per-source count breakdown for the org.
 */
export const getAllReviews = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(400, 'Organization context missing');

  const { page = '1', limit = '20', source, rating, search, sort } = req.query;
  const pageNum = Math.max(Number(page) || 1, 1);
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = { organizationId: orgId };
  if (source && source !== 'all') filter.source = source;
  if (rating) filter.rating = Number(rating);
  if (search && String(search).trim()) {
    const rx = { $regex: escapeRegex(String(search).trim()), $options: 'i' };
    filter.$or = [{ reviewerName: rx }, { reviewText: rx }];
  }

  const sortOption = SORTS[String(sort)] || SORTS.newest;
  const orgObjectId = new mongoose.Types.ObjectId(orgId.toString());

  const [reviews, total, [stats], bySourceAgg] = await Promise.all([
    DealershipReview.find(filter).sort(sortOption).skip(skip).limit(limitNum).lean(),
    DealershipReview.countDocuments(filter),
    DealershipReview.aggregate([
      { $match: { organizationId: orgObjectId, isVisible: true } },
      { $group: { _id: null, averageRating: { $avg: '$rating' }, totalVisible: { $sum: 1 } } },
    ]),
    DealershipReview.aggregate([
      { $match: { organizationId: orgObjectId } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
  ]);

  const bySource: Record<string, number> = { google: 0, yelp: 0, facebook: 0, other: 0 };
  for (const row of bySourceAgg) bySource[row._id] = row.count;

  res.json(new ApiResponse(200, {
    reviews,
    total,
    page: pageNum,
    pages: Math.max(Math.ceil(total / limitNum), 1),
    summary: {
      averageRating: stats ? Math.round(stats.averageRating * 10) / 10 : 0,
      totalVisible: stats?.totalVisible ?? 0,
      totalReviews: SOURCES.reduce((sum, s) => sum + bySource[s], 0),
      bySource,
    },
  }));
});

/**
 * POST /api/crm/reviews
 * Body: { source, reviewerName, rating, reviewText, reviewUrl?, reviewDate?, response? }
 */
export const createReview = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId) throw new ApiError(400, 'Organization context missing');
  const user = req.user || req.crmUser;
  if (!user) throw new ApiError(401, 'Please authenticate');

  const { source, reviewerName, rating, reviewText, reviewUrl, reviewDate, response } = req.body;

  if (!reviewerName?.trim()) throw new ApiError(400, 'Reviewer name is required');
  if (!rating || Number(rating) < 1 || Number(rating) > 5) {
    throw new ApiError(400, 'Rating must be a whole number between 1 and 5');
  }
  if (!reviewText?.trim()) throw new ApiError(400, 'Review text is required');

  const review = await DealershipReview.create({
    organizationId: orgId,
    source: source || 'other',
    reviewerName: reviewerName.trim(),
    rating: Math.round(Number(rating)),
    reviewText: reviewText.trim(),
    reviewUrl: normalizeUrl(reviewUrl),
    reviewDate: reviewDate ? new Date(reviewDate) : new Date(),
    response: response?.trim() || null,
    createdBy: user._id,
  });

  res.status(201).json(new ApiResponse(201, review, 'Review added'));
});

/**
 * PATCH /api/crm/reviews/:id
 * Body: any of { reviewText, response, isVisible, rating, reviewerName, reviewUrl, reviewDate, source }
 */
export const updateReview = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const { id } = req.params;
  const allowed = ['source', 'reviewerName', 'rating', 'reviewText', 'reviewUrl', 'reviewDate', 'response', 'isVisible'];
  const update: any = {};
  for (const key of allowed) {
    if (key in req.body) update[key] = req.body[key];
  }
  if (update.rating !== undefined && (Number(update.rating) < 1 || Number(update.rating) > 5)) {
    throw new ApiError(400, 'Rating must be a whole number between 1 and 5');
  }
  if ('reviewUrl' in update) update.reviewUrl = normalizeUrl(update.reviewUrl);

  const review = await DealershipReview.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    update,
    { new: true }
  );
  if (!review) throw new ApiError(404, 'Review not found');

  res.json(new ApiResponse(200, review, 'Review updated'));
});

/**
 * DELETE /api/crm/reviews/:id
 */
export const deleteReview = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  const { id } = req.params;

  const review = await DealershipReview.findOneAndDelete({ _id: id, organizationId: orgId });
  if (!review) throw new ApiError(404, 'Review not found');

  res.json(new ApiResponse(200, null, 'Review deleted'));
});
