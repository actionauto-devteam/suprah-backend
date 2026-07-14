import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface ICrmPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceHint?: string;
  createdAt?: Date;
}

export interface ICrmUser extends Document {
  organizationId: mongoose.Types.ObjectId;
  fullName: string;
  username: string; // Employee ID (e.g., 2026-00001)
  email: string;
  password: string;
  avatar?: string;
  role: 'employee' | 'manager' | 'admin';
  isActive: boolean;
  lastLoginAt?: Date;
  resetOtp?: string;
  resetOtpExpiry?: Date;
  birthday?: Date;
  hireDate?: Date;
  gender?: 'male' | 'female';
  isOffboarded: boolean;
  offboardedAt?: Date;
  isSystem: boolean;
  locationConsent?: {
    granted: boolean;
    grantedAt?: Date;
    deviceHint?: string;
  };
  locationSharingOptOut?: boolean;
  pushSubscriptions: ICrmPushSubscription[];
  department?: string;
  screenshotExempt?: boolean;
  screenshotBlurUntilPayout?: boolean;
  googleCalendar?: {
    calendarConnected: boolean;
    gmailAddress?: string;
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    lastSyncAt?: Date;
    syncToken?: string;
  };
  createdAt: Date;
  updatedAt: Date;
  isPasswordMatch(password: string): Promise<boolean>;
}

export interface ICrmUserModel extends Model<ICrmUser> {
  isUsernameTaken(username: string, organizationId: string, excludeId?: string): Promise<boolean>;
}

const CrmUserSchema = new Schema<ICrmUser>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: false, // optional for existing records; required for all new records going forward
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      select: false, // Never return password by default
    },
    avatar: {
      type: String,
      default: null,
    },
    role: {
      type: String,
      enum: ['employee', 'manager', 'admin'],
      default: 'employee',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    resetOtp: {
      type: String,
      select: false,
    },
    resetOtpExpiry: {
      type: Date,
      select: false,
    },
    birthday: {
      type: Date,
      default: null,
    },
    hireDate: {
      type: Date,
      default: null,
    },
    gender: {
      type: String,
      enum: ['male', 'female'],
      default: null,
    },
    isOffboarded: {
      type: Boolean,
      default: false,
    },
    offboardedAt: {
      type: Date,
      default: null,
    },
    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },
    locationConsent: {
      granted: { type: Boolean, default: false },
      grantedAt: { type: Date },
      deviceHint: { type: String },
    },
    locationSharingOptOut: {
      type: Boolean,
      // Off by default — only mandatory-location departments (Lot Tech) get auto-share forced
      // on server-side regardless of this flag; see isMandatoryLocationDept.
      default: true,
    },
    pushSubscriptions: [
      {
        endpoint: { type: String, required: true },
        keys: {
          p256dh: { type: String, required: true },
          auth: { type: String, required: true },
        },
        deviceHint: { type: String },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    department: {
      type: String,
      trim: true,
      default: null,
    },
    screenshotExempt: {
      // Per-account exemption from tray screenshot capture, set by an admin
      // for an individual user (e.g. a role that shouldn't be screen-monitored)
      // — distinct from department-level monitoring rules.
      type: Boolean,
      default: false,
    },
    screenshotBlurUntilPayout: {
      // Per-account privacy setting: this account's screenshots are still
      // captured normally, but any OTHER admin/manager viewing them in the
      // TimeProof calendar sees them blurred except in the 2-day window
      // before/through each payout date (see isPayoutUnblurWindow). The
      // account owner always sees their own screenshots unblurred.
      type: Boolean,
      default: false,
    },
    googleCalendar: {
      calendarConnected: { type: Boolean, default: false },
      gmailAddress: { type: String },
      accessToken: { type: String },
      refreshToken: { type: String },
      expiryDate: { type: Number },
      lastSyncAt: { type: Date },
      syncToken: { type: String },
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique: username must be unique per organization
CrmUserSchema.index({ organizationId: 1, username: 1 }, { unique: true });

// Static: check if username is taken within the same organization
CrmUserSchema.statics.isUsernameTaken = async function (
  username: string,
  organizationId: string,
  excludeId?: string
): Promise<boolean> {
  const user = await this.findOne({ username, organizationId, _id: { $ne: excludeId } });
  return !!user;
};

// Pre-save: hash password
CrmUserSchema.pre<ICrmUser>('save', async function (next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  next();
});

// Instance: compare password
CrmUserSchema.methods.isPasswordMatch = async function (password: string): Promise<boolean> {
  return bcrypt.compare(password, this.password);
};

const CrmUser = mongoose.model<ICrmUser, ICrmUserModel>('CrmUser', CrmUserSchema);

export default CrmUser;
