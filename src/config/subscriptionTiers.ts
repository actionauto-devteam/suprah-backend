import { SubscriptionTier } from '../models/Organization.model';

export const TIER_IDS: SubscriptionTier[] = [
    'suprah_go',
    'suprah_premium',
    'suprah_premium_pro',
    'suprah_premium_ultra',
    'suprah_origin',
];

export const TIER_SEAT_LIMITS: Record<SubscriptionTier, number | null> = {
    suprah_go: 5,
    suprah_premium: 15,
    suprah_premium_pro: 30,
    suprah_premium_ultra: null,
    suprah_origin: null,
};

export const TIER_PRICES: Record<SubscriptionTier, number> = {
    suprah_go: 0,
    suprah_premium: 30,
    suprah_premium_pro: 50,
    suprah_premium_ultra: 100,
    suprah_origin: 0,
};

export const TIER_LABELS: Record<SubscriptionTier, string> = {
    suprah_go: 'Suprah Go',
    suprah_premium: 'Suprah Premium',
    suprah_premium_pro: 'Suprah Premium Pro',
    suprah_premium_ultra: 'Suprah Premium Ultra',
    suprah_origin: 'Suprah Origin',
};

export function isValidTier(tier: unknown): tier is SubscriptionTier {
    return typeof tier === 'string' && (TIER_IDS as string[]).includes(tier);
}

export function isPurchasableTier(tier: SubscriptionTier): boolean {
    return tier !== 'suprah_origin';
}
