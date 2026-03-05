import mongoose, { Document, Schema, Model } from 'mongoose';

/**
 * WebAuthn Credential Model
 * Stores FIDO2/WebAuthn credentials linked to CRM users.
 * Supports fingerprint, face recognition, and security key authenticators.
 */

export type BiometricType = 'fingerprint' | 'face' | 'security_key' | 'platform';

export interface IWebAuthnCredential extends Document {
  userId: mongoose.Types.ObjectId;
  credentialId: string;           // Base64URL-encoded credential ID
  publicKey: string;              // Base64URL-encoded public key (COSE)
  counter: number;                // Signature counter for replay protection
  deviceType: BiometricType;
  deviceName: string;             // User-friendly label, e.g. "MacBook Touch ID"
  transports?: string[];          // e.g. ['internal', 'usb', 'ble', 'nfc']
  aaguid?: string;                // Authenticator Attestation GUID
  backedUp: boolean;              // Whether credential is backed up (e.g. iCloud Keychain)
  lastUsedAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WebAuthnCredentialSchema = new Schema<IWebAuthnCredential>(
  {
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

// Compound index: fast lookup per user
WebAuthnCredentialSchema.index({ userId: 1, isActive: 1 });

const WebAuthnCredential = mongoose.model<IWebAuthnCredential>(
  'WebAuthnCredential',
  WebAuthnCredentialSchema
);

export default WebAuthnCredential;