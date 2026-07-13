import mongoose, { Document, Schema } from 'mongoose';

export type PeriodType = 'daily' | 'weekly' | 'monthly';

export interface IKpiSnapshot {
  leadsCreated: number;
  leadsContacted: number;
  leadsConverted: number;
  conversionRate: number;
  appointmentsCreated: number;
  appointmentsCompleted: number;
  appointmentShowRate: number;
  callsMade: number;
  messagesSent: number;
  followUpsSent: number;
  responsesCount: number;
  avgResponseTimeMin: number;
  transactionsCompleted: number;
  onboardingsCompleted: number;
  totalScore: number;
}

export interface IAnalyticsAggregate extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  periodType: PeriodType;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  kpis: IKpiSnapshot;
  rank?: number;
  prevRank?: number;
  badges: string[];
  updatedAt: Date;
}

const KpiSnapshotSchema = new Schema<IKpiSnapshot>({
  leadsCreated:            { type: Number, default: 0 },
  leadsContacted:          { type: Number, default: 0 },
  leadsConverted:          { type: Number, default: 0 },
  conversionRate:          { type: Number, default: 0 },
  appointmentsCreated:     { type: Number, default: 0 },
  appointmentsCompleted:   { type: Number, default: 0 },
  appointmentShowRate:     { type: Number, default: 0 },
  callsMade:               { type: Number, default: 0 },
  messagesSent:            { type: Number, default: 0 },
  followUpsSent:           { type: Number, default: 0 },
  responsesCount:          { type: Number, default: 0 },
  avgResponseTimeMin:      { type: Number, default: 0 },
  transactionsCompleted:   { type: Number, default: 0 },
  onboardingsCompleted:    { type: Number, default: 0 },
  totalScore:              { type: Number, default: 0 },
}, { _id: false });

const AnalyticsAggregateSchema = new Schema<IAnalyticsAggregate>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'CrmUser',      required: true },
    periodType:     { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
    periodKey:      { type: String, required: true },
    periodStart:    { type: Date, required: true },
    periodEnd:      { type: Date, required: true },
    kpis:           { type: KpiSnapshotSchema, default: () => ({}) },
    rank:           { type: Number },
    prevRank:       { type: Number },
    badges:         { type: [String], default: [] },
  },
  { timestamps: true }
);

AnalyticsAggregateSchema.index(
  { organizationId: 1, userId: 1, periodType: 1, periodKey: 1 },
  { unique: true }
);
AnalyticsAggregateSchema.index({ organizationId: 1, periodType: 1, periodKey: 1, 'kpis.totalScore': -1 });

export default mongoose.model<IAnalyticsAggregate>('AnalyticsAggregate', AnalyticsAggregateSchema);