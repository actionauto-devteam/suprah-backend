import mongoose, { Schema } from 'mongoose';

export interface RoutingOption {
  digit: string;
  label: string;
  type: 'location' | 'department' | 'language';
  groupId: string | null;
  leadLocation: string;
  language: string;
  externalDestination: string;
}

export interface RoutingConfig {
  enabled: boolean;
  name: string;
  inboundNumber: string;
  mainNumber: string;
  greeting: string;
  ringTimeoutSeconds: number;
  retryCount: number;
  receptionGroupId: string | null;
  allOrgFallback: boolean;
  options: RoutingOption[];
}

export interface IvrRoutingState {
  config: RoutingConfig;
  stage: 'initializing' | 'menu' | 'routing' | 'selected' | 'reception' | 'all-org' | 'terminal';
  revision: number;
  attempts: number;
  selectedDigit?: string;
  selectedLabel?: string;
  type?: string;
  language?: string;
  leadLocation?: string;
  targetGroupId?: string | null;
  recipientIds: string[];
  notifiedIds: string[];
  allOrg: boolean;
  customerAnswered?: boolean;
  deadline?: Date | null;
  history: { stage: string; reason: string; at: Date }[];
}

const optionSchema = new Schema({
  digit: String,
  label: String,
  type: String,
  groupId: { type: String, default: null },
  leadLocation: { type: String, default: '' },
  language: { type: String, default: '' },
  externalDestination: { type: String, default: '' },
}, { _id: false });

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  enabled: { type: Boolean, default: false },
  name: { type: String, required: true },
  inboundNumber: { type: String, required: true, unique: true },
  mainNumber: String,
  greeting: String,
  ringTimeoutSeconds: { type: Number, default: 35 },
  retryCount: { type: Number, default: 1 },
  receptionGroupId: { type: String, default: null },
  allOrgFallback: { type: Boolean, default: false },
  options: [optionSchema],
  updatedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });

export default mongoose.model('CallRoutingConfig', schema);

export const IvrInboundClaim = mongoose.model('IvrInboundClaim', new Schema({
  callControlId: { type: String, required: true, unique: true },
  organizationId: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true }));
