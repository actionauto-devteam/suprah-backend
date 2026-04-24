import mongoose, { Document, Schema } from 'mongoose';

export interface IBadgeDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;       // emoji or icon key
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  condition: {
    metric: string;
    operator: 'gte' | 'lte' | 'eq' | 'top_n' | 'streak';
    value: number;
    period?: 'daily' | 'weekly' | 'monthly' | 'alltime';
  };
  scoreBonus: number;
}

export const BADGE_DEFINITIONS: IBadgeDefinition[] = [
  {
    id: 'first_lead',
    name: 'First Contact',
    description: 'Created your first lead',
    icon: '🌱',
    tier: 'bronze',
    condition: { metric: 'leadsCreated', operator: 'gte', value: 1, period: 'alltime' },
    scoreBonus: 10,
  },
  {
    id: 'lead_machine',
    name: 'Lead Machine',
    description: '10+ leads created in a week',
    icon: '⚡',
    tier: 'silver',
    condition: { metric: 'leadsCreated', operator: 'gte', value: 10, period: 'weekly' },
    scoreBonus: 50,
  },
  {
    id: 'converter',
    name: 'The Converter',
    description: '50%+ conversion rate (min 5 leads)',
    icon: '🎯',
    tier: 'gold',
    condition: { metric: 'conversionRate', operator: 'gte', value: 50, period: 'monthly' },
    scoreBonus: 100,
  },
  {
    id: 'speed_demon',
    name: 'Speed Demon',
    description: 'Avg response time under 10 minutes',
    icon: '🚀',
    tier: 'silver',
    condition: { metric: 'avgResponseTimeMin', operator: 'lte', value: 10, period: 'weekly' },
    scoreBonus: 75,
  },
  {
    id: 'onboarding_hero',
    name: 'Onboarding Hero',
    description: '10+ onboardings completed',
    icon: '🏆',
    tier: 'gold',
    condition: { metric: 'onboardingsCompleted', operator: 'gte', value: 10, period: 'monthly' },
    scoreBonus: 150,
  },
  {
    id: 'appointment_setter',
    name: 'Appointment Setter',
    description: '20+ appointments completed',
    icon: '📅',
    tier: 'silver',
    condition: { metric: 'appointmentsCompleted', operator: 'gte', value: 20, period: 'monthly' },
    scoreBonus: 80,
  },
  {
    id: 'top_weekly',
    name: 'Weekly Champion',
    description: '#1 on the weekly leaderboard',
    icon: '👑',
    tier: 'platinum',
    condition: { metric: 'rank', operator: 'eq', value: 1, period: 'weekly' },
    scoreBonus: 200,
  },
  {
    id: 'follow_up_king',
    name: 'Follow-Up King',
    description: '30+ follow-ups sent in a week',
    icon: '📞',
    tier: 'silver',
    condition: { metric: 'followUpsSent', operator: 'gte', value: 30, period: 'weekly' },
    scoreBonus: 60,
  },
  {
    id: 'transaction_titan',
    name: 'Transaction Titan',
    description: '5+ transactions completed in a month',
    icon: '💰',
    tier: 'gold',
    condition: { metric: 'transactionsCompleted', operator: 'gte', value: 5, period: 'monthly' },
    scoreBonus: 200,
  },
];

export interface IUserBadge extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  badgeId: string;
  awardedAt: Date;
  periodKey?: string;
  metadata?: Record<string, any>;
}

const UserBadgeSchema = new Schema<IUserBadge>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'CrmUser',      required: true, index: true },
    badgeId:        { type: String, required: true },
    awardedAt:      { type: Date, default: Date.now },
    periodKey:      { type: String },
    metadata:       { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

UserBadgeSchema.index({ organizationId: 1, userId: 1, badgeId: 1, periodKey: 1 }, { unique: true });

export const UserBadge = mongoose.model<IUserBadge>('UserBadge', UserBadgeSchema);