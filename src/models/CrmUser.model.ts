import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

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
  isOffboarded: boolean;
  offboardedAt?: Date;
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
    isOffboarded: {
      type: Boolean,
      default: false,
    },
    offboardedAt: {
      type: Date,
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