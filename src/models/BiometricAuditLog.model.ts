import mongoose, { Document, Schema } from 'mongoose';

/**
 * Biometric Audit Log
 *
 * Immutable log of all biometric and SSH key events.
 * Separate from the general AuditLog model.
 *
 * File: models/BiometricAuditLog.model.ts
 */

export type BiometricEventType =
  | 'registration_started'
  | 'registration_completed'
  | 'registration_failed'
  | 'authentication_started'
  | 'authentication_success'
  | 'authentication_failed'
  | 'credential_revoked'
  | 'credential_renamed'
  | 'ssh_key_added'
  | 'ssh_key_revoked'
  | 'ssh_key_used'
  | 'challenge_issued'
  | 'challenge_expired';

export interface IBiometricAuditLog extends Document {
  userId?: mongoose.Types.ObjectId;
  event: BiometricEventType;
  credentialId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
  success: boolean;
  failureReason?: string;
  createdAt: Date;
}

const BiometricAuditLogSchema = new Schema<IBiometricAuditLog>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      index: true,
    },
    event: {
      type: String,
      required: true,
      enum: [
        'registration_started',
        'registration_completed',
        'registration_failed',
        'authentication_started',
        'authentication_success',
        'authentication_failed',
        'credential_revoked',
        'credential_renamed',
        'ssh_key_added',
        'ssh_key_revoked',
        'ssh_key_used',
        'challenge_issued',
        'challenge_expired',
      ],
      index: true,
    },
    credentialId: { type: String, default: null },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    success: { type: Boolean, required: true },
    failureReason: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

// TTL: auto-delete after 2 years
BiometricAuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 63072000 });
BiometricAuditLogSchema.index({ userId: 1, event: 1, createdAt: -1 });

const BiometricAuditLog = mongoose.model<IBiometricAuditLog>(
  'BiometricAuditLog',
  BiometricAuditLogSchema
);

export default BiometricAuditLog;