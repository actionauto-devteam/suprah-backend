import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface ICrmUser extends Document {
  fullName: string;
  username: string; // Employee ID (e.g., 2026-00001)
  email: string;
  password: string;
  avatar?: string;
  role: 'employee' | 'manager' | 'admin';
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  isPasswordMatch(password: string): Promise<boolean>;
}

export interface ICrmUserModel extends Model<ICrmUser> {
  isUsernameTaken(username: string, excludeId?: string): Promise<boolean>;
}

const CrmUserSchema = new Schema<ICrmUser>(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
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
  },
  {
    timestamps: true,
  }
);

// Static: check if username is taken
CrmUserSchema.statics.isUsernameTaken = async function (
  username: string,
  excludeId?: string
): Promise<boolean> {
  const user = await this.findOne({ username, _id: { $ne: excludeId } });
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