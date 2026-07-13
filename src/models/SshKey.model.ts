import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';


export interface ISshKey extends Document {
  userId: mongoose.Types.ObjectId;
  title: string;
  publicKey: string;
  fingerprint: string;
  keyType: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384';
  keySize?: number;
  expiresAt?: Date;
  lastUsedAt?: Date;
  allowedIPs?: string[];
  isActive: boolean;
  revokedAt?: Date;
  revokedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SshKeySchema = new Schema<ISshKey>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    publicKey: {
      type: String,
      required: true,
    },
    fingerprint: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    keyType: {
      type: String,
      enum: ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384'],
      required: true,
    },
    keySize: {
      type: Number,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    allowedIPs: {
      type: [String],
      default: [],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

SshKeySchema.statics.computeFingerprint = function (publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const keyData = parts.length >= 2 ? parts[1] : parts[0];
  const hash = crypto.createHash('sha256').update(Buffer.from(keyData, 'base64')).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
};

/**
 * Detect key type from public key string.
 */
SshKeySchema.statics.detectKeyType = function (
  publicKey: string
): 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384' {
  const trimmed = publicKey.trim();
  if (trimmed.startsWith('ssh-ed25519')) return 'ssh-ed25519';
  if (trimmed.startsWith('ecdsa-sha2-nistp384')) return 'ecdsa-sha2-nistp384';
  if (trimmed.startsWith('ecdsa-sha2-nistp256')) return 'ecdsa-sha2-nistp256';
  return 'ssh-rsa';
};

SshKeySchema.index({ userId: 1, isActive: 1 });

const SshKey = mongoose.model<ISshKey>('SshKey', SshKeySchema);

export default SshKey;