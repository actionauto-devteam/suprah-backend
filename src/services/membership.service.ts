import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import MembershipTier, { IMembershipTier } from '../models/MembershipTier.model';
import MembershipPoints from '../models/MembershipPoints.model';
import PointTransaction, { PointSourceType } from '../models/PointTransaction.model';
import DiscountToken from '../models/DiscountToken.model';
import config from '../config';
import logger from '../utils/logger';
import { safeCreateNotification } from '../utils/safeNotification';

let tierCache: IMembershipTier[] | null = null;
let tierCacheExpiry = 0;

async function getTierList(): Promise<IMembershipTier[]> {
  if (tierCache && Date.now() < tierCacheExpiry) return tierCache;
  tierCache = await MembershipTier.find({ isActive: true }).sort({ rank: 1 }).lean() as unknown as IMembershipTier[];
  tierCacheExpiry = Date.now() + 60 * 60 * 1000;
  return tierCache;
}

function computeTierForPoints(points: number, tiers: IMembershipTier[]): IMembershipTier {
  const sorted = [...tiers].sort((a, b) => b.minPoints - a.minPoints);
  return sorted.find(t => points >= t.minPoints) ?? tiers[0];
}

interface CreditPointsParams {
  userId: string;
  organizationId: string;
  delta: number;
  sourceType: PointSourceType;
  sourceId: string;
  description: string;
  adminId?: string;
  metadata?: Record<string, unknown>;
}

interface CreditPointsResult {
  credited: boolean;
  newTotal: number;
  tierUpgraded: boolean;
  newTierSlug: string;
}

async function creditPoints(params: CreditPointsParams): Promise<CreditPointsResult> {
  const { userId, organizationId, delta, sourceType, sourceId, description, adminId, metadata } = params;

  const userObjectId = new mongoose.Types.ObjectId(userId);

  const txResult = await PointTransaction.findOneAndUpdate(
    { userId: userObjectId, sourceType, sourceId },
    {
      $setOnInsert: {
        userId: userObjectId,
        organizationId,
        delta,
        balanceAfter: 0,
        sourceType,
        sourceId,
        description,
        ...(adminId ? { adminId: new mongoose.Types.ObjectId(adminId) } : {}),
        ...(metadata ? { metadata } : {}),
      },
    },
    { upsert: true, new: false },
  );

  if (txResult !== null) {
    return { credited: false, newTotal: 0, tierUpgraded: false, newTierSlug: '' };
  }

  const updated = await MembershipPoints.findOneAndUpdate(
    { userId: userObjectId },
    { $inc: { lifetimePoints: delta, currentPoints: delta }, $setOnInsert: { organizationId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await PointTransaction.findOneAndUpdate(
    { userId: userObjectId, sourceType, sourceId },
    { $set: { balanceAfter: updated.lifetimePoints } },
  );

  const tiers = await getTierList();
  const newTier = computeTierForPoints(updated.lifetimePoints, tiers);
  const previousSlug = updated.currentTierSlug;
  const tierUpgraded = newTier.slug !== previousSlug;

  if (tierUpgraded || updated.currentTierRank !== newTier.rank) {
    await MembershipPoints.updateOne(
      { userId: userObjectId },
      { $set: { currentTierSlug: newTier.slug, currentTierRank: newTier.rank } },
    );

    if (tierUpgraded) {
      safeCreateNotification({
        userId,
        organizationId,
        type: 'system',
        title: `You've reached ${newTier.name} Class!`,
        message: `Welcome to ${newTier.name}! Enjoy ${newTier.discountPercent > 0 ? newTier.discountPercent + '% member pricing on vehicles & parts' : 'your new member perks'}.`,
        metadata: { tierSlug: newTier.slug, tierRank: newTier.rank },
      }).catch((err: unknown) => logger.error({ err }, 'Membership: class upgrade notification failed'));
    }
  }

  return {
    credited: true,
    newTotal: updated.lifetimePoints,
    tierUpgraded,
    newTierSlug: newTier.slug,
  };
}

async function getMembershipStatus(userId: string) {
  const tiers = await getTierList();
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const points = await MembershipPoints.findOne({ userId: userObjectId }).lean();
  const lifetimePoints = points?.lifetimePoints ?? 0;

  const currentTier = computeTierForPoints(lifetimePoints, tiers);
  const nextTier = tiers.find(t => t.rank === currentTier.rank + 1) ?? null;

  const pointsToNextTier = nextTier ? nextTier.minPoints - lifetimePoints : null;
  const progressPercent = nextTier
    ? Math.min(100, Math.round(((lifetimePoints - currentTier.minPoints) / (nextTier.minPoints - currentTier.minPoints)) * 100))
    : 100;

  return {
    points: {
      lifetimePoints,
      currentPoints: points?.currentPoints ?? 0,
      currentTierSlug: currentTier.slug,
      currentTierRank: currentTier.rank,
    },
    currentTier,
    nextTier,
    pointsToNextTier,
    progressPercent,
  };
}

async function getMemberPricingForUser(userId: string): Promise<{ discountPercent: number; tierName: string; tierSlug: string }> {
  const tiers = await getTierList();
  const points = await MembershipPoints.findOne({ userId: new mongoose.Types.ObjectId(userId) }).lean();
  const tier = computeTierForPoints(points?.lifetimePoints ?? 0, tiers);
  return { discountPercent: tier.discountPercent, tierName: tier.name, tierSlug: tier.slug };
}

function computeMemberPrice(price: number, cost: number | undefined, discountPercent: number): number {
  if (!price || price <= 0 || discountPercent <= 0) return price || 0;
  const discounted = Math.round(price * (1 - discountPercent / 100));
  const floor = cost && cost > 0 ? cost : 0;
  return Math.max(discounted, floor);
}

async function generateDiscountToken(userId: string, organizationId: string) {
  const tiers = await getTierList();
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const points = await MembershipPoints.findOne({ userId: userObjectId }).lean();
  const lifetimePoints = points?.lifetimePoints ?? 0;

  const tier = computeTierForPoints(lifetimePoints, tiers);
  const discountPercent = tier.discountPercent;

  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const payload = {
    sub: userId,
    jti,
    tierSlug: tier.slug,
    discountPercent,
    orgId: organizationId,
    type: 'discount',
  };

  const token = jwt.sign(payload, config.jwt.membershipDiscountSecret, { expiresIn: '15m' });

  await DiscountToken.create({
    jti,
    userId: userObjectId,
    tierSlug: tier.slug,
    discountPercent,
    used: false,
    expiresAt,
  });

  return { token, discountPercent, tierSlug: tier.slug, expiresAt };
}

interface VerifyResult {
  valid: boolean;
  discountPercent: number;
  reason?: string;
}

async function verifyAndConsumeDiscountToken(tokenString: string, userId: string): Promise<VerifyResult> {
  let payload: Record<string, unknown>;

  try {
    payload = jwt.verify(tokenString, config.jwt.membershipDiscountSecret) as Record<string, unknown>;
  } catch {
    return { valid: false, discountPercent: 0, reason: 'token_invalid' };
  }

  if (payload.sub !== userId) return { valid: false, discountPercent: 0, reason: 'token_user_mismatch' };
  if (payload.type !== 'discount') return { valid: false, discountPercent: 0, reason: 'token_wrong_type' };

  const consumed = await DiscountToken.findOneAndUpdate(
    { jti: payload.jti as string, used: false },
    { $set: { used: true, usedAt: new Date() } },
    { new: true },
  );

  if (!consumed) return { valid: false, discountPercent: 0, reason: 'token_already_used' };
  if (consumed.expiresAt < new Date()) return { valid: false, discountPercent: 0, reason: 'token_expired' };

  return { valid: true, discountPercent: consumed.discountPercent };
}

async function rewardProfileCompletion(userId: string, organizationId: string): Promise<void> {
  const userObjectId = new mongoose.Types.ObjectId(userId);
  const existing = await MembershipPoints.findOne({ userId: userObjectId }).lean();

  if (existing?.profileCompletionRewarded) return;

  await creditPoints({
    userId,
    organizationId: organizationId || 'global',
    delta: 100,
    sourceType: 'profile_completion',
    sourceId: userId,
    description: 'Profile completion bonus',
  });

  await MembershipPoints.updateOne(
    { userId: userObjectId },
    { $set: { profileCompletionRewarded: true } },
    { upsert: true },
  );
}

async function rewardAnniversary(userId: string, organizationId: string, userCreatedAt: Date): Promise<void> {
  const now = new Date();
  const yearsSince = now.getFullYear() - userCreatedAt.getFullYear();
  if (yearsSince < 1) return;

  const userObjectId = new mongoose.Types.ObjectId(userId);
  const existing = await MembershipPoints.findOne({ userId: userObjectId }).lean();

  if ((existing?.anniversaryLastRewardedYear ?? 0) >= now.getFullYear()) return;

  await creditPoints({
    userId,
    organizationId: organizationId || 'global',
    delta: 200,
    sourceType: 'account_anniversary',
    sourceId: `${userId}-${now.getFullYear()}`,
    description: `Account anniversary bonus — Year ${yearsSince}`,
  });

  await MembershipPoints.updateOne(
    { userId: userObjectId },
    { $set: { anniversaryLastRewardedYear: now.getFullYear() } },
    { upsert: true },
  );
}

async function adminAdjustPoints(params: {
  targetUserId: string;
  adminUserId: string;
  organizationId: string;
  delta: number;
  reason: string;
}): Promise<{ newTotal: number }> {
  const { targetUserId, adminUserId, organizationId, delta, reason } = params;
  const sourceId = `admin:${adminUserId}:${Date.now()}`;

  const result = await creditPoints({
    userId: targetUserId,
    organizationId,
    delta,
    sourceType: 'admin_adjustment',
    sourceId,
    description: `Admin adjustment: ${reason}`,
    adminId: adminUserId,
    metadata: { reason },
  });

  return { newTotal: result.newTotal };
}

export default {
  creditPoints,
  getMembershipStatus,
  generateDiscountToken,
  verifyAndConsumeDiscountToken,
  rewardProfileCompletion,
  rewardAnniversary,
  adminAdjustPoints,
  getTierList,
  computeTierForPoints,
  getMemberPricingForUser,
  computeMemberPrice,
};
