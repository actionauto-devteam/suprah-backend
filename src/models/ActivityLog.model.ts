import mongoose, { Document, Schema, Model } from 'mongoose';

export type ActivityActionType =
  // Lead actions
  | 'lead_created' | 'lead_contacted' | 'lead_converted' | 'lead_lost' | 'lead_replied'
  // Appointment actions
  | 'appointment_created' | 'appointment_confirmed' | 'appointment_completed' | 'appointment_cancelled'
  // Onboarding actions
  | 'onboarding_started' | 'onboarding_completed' | 'onboarding_milestone'
  // Communication actions
  | 'call_made' | 'call_received' | 'message_sent' | 'email_sent' | 'follow_up_sent'
  // Transaction actions
  | 'transaction_initiated' | 'transaction_completed' | 'payment_received'
  // CRM actions
  | 'time_in' | 'time_out' | 'login' | 'profile_updated'
  // Admin actions
  | 'user_created' | 'user_updated' | 'user_deactivated' | 'settings_changed';

export type SourceModule =
  | 'leads' | 'appointments' | 'crm' | 'onboarding'
  | 'messaging' | 'payments' | 'calendar' | 'admin';

export interface IActivityLog extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  actionType: ActivityActionType;
  sourceModule: SourceModule;
  entityId?: mongoose.Types.ObjectId;
  entityType?: string;
  metadata?: Record<string, any>;
  score?: number;       // KPI score contribution
  timestamp: Date;
  createdAt: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'CrmUser',      required: true, index: true },
    actionType:     { type: String, required: true, index: true },
    sourceModule:   { type: String, required: true },
    entityId:       { type: Schema.Types.ObjectId },
    entityType:     { type: String },
    metadata:       { type: Schema.Types.Mixed, default: {} },
    score:          { type: Number, default: 0 },
    timestamp:      { type: Date, default: Date.now, index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound indexes for leaderboard queries
ActivityLogSchema.index({ organizationId: 1, timestamp: -1 });
ActivityLogSchema.index({ organizationId: 1, userId: 1, timestamp: -1 });
ActivityLogSchema.index({ organizationId: 1, actionType: 1, timestamp: -1 });
ActivityLogSchema.index({ userId: 1, actionType: 1, timestamp: -1 });

export default mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);