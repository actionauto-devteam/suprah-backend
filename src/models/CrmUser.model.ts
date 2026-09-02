import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import { notificationPreferencesSchema, NotificationPreferences } from './notificationPreferences.schema';

export interface ICrmPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceHint?: string;
  appSource?: 'main' | 'supraspace';
  createdAt?: Date;
  lastSuccessAt?: Date;
  failureCount?: number;
}

export interface ICrmUser extends Document {
  organizationId: mongoose.Types.ObjectId;
  fullName: string;
  username: string;
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
  notificationPreferences: NotificationPreferences;
  department?: string;
  screenshotExempt?: boolean;
  hourlyTrackingExempt?: boolean;
  otWarningExempt?: boolean;
  screenshotBlurUntilPayout?: boolean;
  locationRequiredOverride?: 'default' | 'required' | 'exempt';
  hourlyRate?: number;
  payrollLocation?: 'Utah' | 'Philippines';
  googleCalendar?: {
    calendarConnected: boolean;
    gmailAddress?: string;
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    lastSyncAt?: Date;
    syncToken?: string;
  };
  googleMail?: {
    connected: boolean;
    gmailAddress?: string;
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    historyId?: string;
    lastSyncAt?: Date;
    lastSyncError?: string;
    connectedAt?: Date;
  };
  spotify?: {
    connected: boolean;
    spotifyUserId?: string;
    displayName?: string;
    product?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;        // epoch ms
    scope?: string;
    connectedAt?: Date;
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
      required: false,
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
      select: false,
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
      default: false,
    },
    pushSubscriptions: [
      {
        endpoint: { type: String, required: true },
        keys: {
          p256dh: { type: String, required: true },
          auth: { type: String, required: true },
        },
        deviceHint: { type: String },
        appSource: { type: String, enum: ['main', 'supraspace'] },
        createdAt: { type: Date, default: Date.now },
        lastSuccessAt: { type: Date },
        failureCount: { type: Number, default: 0 },
      },
    ],
    notificationPreferences: {
      type: notificationPreferencesSchema,
      default: () => ({}),
    },
    department: {
      type: String,
      trim: true,
      default: null,
    },
    screenshotExempt: {
      type: Boolean,
      default: false,
    },
    hourlyTrackingExempt: {
      type: Boolean,
      default: false,
    },
    otWarningExempt: {
      type: Boolean,
      default: false,
    },
    screenshotBlurUntilPayout: {
      type: Boolean,
      default: false,
    },
    locationRequiredOverride: {
      type: String,
      enum: ['default', 'required', 'exempt'],
      default: 'default',
    },
    hourlyRate: {
      type: Number,
      default: null,
      min: 0,
    },
    payrollLocation: {
      type: String,
      enum: ['Utah', 'Philippines'],
      default: null,
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
    googleMail: {
      connected: { type: Boolean, default: false },
      gmailAddress: { type: String },
      accessToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      expiryDate: { type: Number, select: false },
      historyId: { type: String },
      lastSyncAt: { type: Date },
      lastSyncError: { type: String },
      connectedAt: { type: Date },
    },
    spotify: {
      connected: { type: Boolean, default: false },
      spotifyUserId: { type: String },
      displayName: { type: String },
      product: { type: String },
      accessToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      expiresAt: { type: Number, select: false },
      scope: { type: String },
      connectedAt: { type: Date },
    },
  },
  {
    timestamps: true,
  }
);

CrmUserSchema.index({ organizationId: 1, username: 1 }, { unique: true });

CrmUserSchema.statics.isUsernameTaken = async function (
  username: string,
  organizationId: string,
  excludeId?: string
): Promise<boolean> {
  const user = await this.findOne({ username, organizationId, _id: { $ne: excludeId } });
  return !!user;
};

CrmUserSchema.pre<ICrmUser>('save', async function (next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 12);
  }
  next();
});

CrmUserSchema.methods.isPasswordMatch = async function (password: string): Promise<boolean> {
  return bcrypt.compare(password, this.password);
};

const CrmUser = mongoose.model<ICrmUser, ICrmUserModel>('CrmUser', CrmUserSchema);

export default CrmUser;