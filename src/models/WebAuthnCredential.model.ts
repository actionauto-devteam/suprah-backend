import mongoose, { Document, Schema } from 'mongoose';

/**
 * WebAuthn Credential Model
 * Stores FIDO2/WebAuthn credentials linked to CRM users.
 *
 * File: models/WebAuthnCredential.model.ts
 */

export type BiometricType = 'fingerprint' | 'face' | 'security_key' | 'platform';

export interface IWebAuthnCredential extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType: BiometricType;
  deviceName: string;
  transports?: string[];
  aaguid?: string;
  backedUp: boolean;
  lastUsedAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WebAuthnCredentialSchema = new Schema<IWebAuthnCredential>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    credentialId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    publicKey: {
      type: String,
      required: true,
    },
    counter: {
      type: Number,
      required: true,
      default: 0,
    },
    deviceType: {
      type: String,
      enum: ['fingerprint', 'face', 'security_key', 'platform'],
      default: 'platform',
    },
    deviceName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    transports: {
      type: [String],
      default: [],
    },
    aaguid: {
      type: String,
      default: null,
    },
    backedUp: {
      type: Boolean,
      default: false,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

WebAuthnCredentialSchema.index({ userId: 1, isActive: 1 });

const WebAuthnCredential = mongoose.model<IWebAuthnCredential>(
  'WebAuthnCredential',
  WebAuthnCredentialSchema
);

export default WebAuthnCredential;