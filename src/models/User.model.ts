import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import config from '../config';

export type OnlineStatus = 'online' | 'idle' | 'away' | 'busy' | 'offline' | 'do_not_disturb';

export interface IPersonalInfo {
  bio?: string;
  phone?: string;
  location?: string;
  timezone?: string;
  language?: string;
  dateOfBirth?: Date;
  jobTitle?: string;
  department?: string;
  linkedIn?: string;
  website?: string;
}

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  clerkId?: string;
  emailVerified: boolean;
  avatar?: string;
  role: "customer" | "employee" | "admin" | "super_admin" | "driver";
  isActive: boolean;
  organizationId?: mongoose.Types.ObjectId;
  organizationRole?: string;

  // New profile fields
  onlineStatus: OnlineStatus;
  customStatus?: string;
  personalInfo?: IPersonalInfo;
  lastActive?: Date;
  lastPasswordChange?: Date;

  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  theme: "light" | "dark";

  // Wallet and Referral Engine
  referralCode?: string;
  walletBalance: number;
  totalEarned: number;

  // Google Calendar Integration
  googleCalendar?: {
    connected: boolean;
    accessToken?: string;
    refreshToken?: string;
    expiryDate?: number;
    connectedAt?: Date;

    // NEW: Webhook tracking
    watchChannelId?: string; // Current webhook channel ID
    watchResourceId?: string; // Current webhook resource ID
    watchExpiration?: Date; // When the webhook expires
  };

  notificationPreferences: {
    quoteCreated: boolean;
    quoteUpdated: boolean;
    quoteDeleted: boolean;
    shipmentCreated: boolean;
    shipmentUpdated: boolean;
    shipmentDeleted: boolean;
    passwordChanged: boolean;
    emailChanged: boolean;
    profileUpdated: boolean;
  };
  subscription?: {
    plan: "free" | "starter" | "professional" | "enterprise";
    status: "active" | "inactive" | "trial" | "cancelled";
    startDate: Date;
    endDate?: Date;
    features: string[];
  };
  isPasswordMatch(password: string): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {
  isEmailTaken(email: string, excludeUserId?: string): Promise<boolean>;
}

const UserSchema = new Schema(
  {
    name: {
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
    clerkId: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    password: {
      type: String,
      required: false,
      private: true,
    },
    avatar: {
      type: String,
      default: null,
    },
    role: {
      type: String,
      enum: ['customer', 'employee', 'admin', 'super_admin', 'driver'],
      default: 'customer',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    organizationRole: {
      type: String,
    },

    // New profile fields
    onlineStatus: {
      type: String,
      enum: ['online', 'idle', 'away', 'busy', 'offline', 'do_not_disturb'],
      default: 'offline',
    },
    customStatus: {
      type: String,
      maxlength: 100,
    },
    personalInfo: {
      bio: { type: String, maxlength: 500 },
      phone: { type: String },
      location: { type: String },
      timezone: { type: String },
      language: { type: String, default: 'en' },
      dateOfBirth: { type: Date },
      jobTitle: { type: String },
      department: { type: String },
      linkedIn: { type: String },
      website: { type: String },
    },
    lastActive: {
      type: Date,
      default: Date.now,
    },
    lastPasswordChange: {
      type: Date,
    },

    passwordResetToken: {
      type: String,
      private: true,
    },
    passwordResetExpires: {
      type: Date,
      private: true,
    },
    theme: {
      type: String,
      enum: ['light', 'dark'],
      default: 'light',
    },

    // Wallet and Referral Engine
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      uppercase: true
    },
    walletBalance: {
      type: Number,
      default: 0,
      min: 0
    },
    totalEarned: {
      type: Number,
      default: 0,
    },

    // Google Calendar Integration
    googleCalendar: {
      connected: { type: Boolean, default: false },
      accessToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      expiryDate: { type: Number },
      connectedAt: { type: Date },

      // NEW fields for webhook tracking
      watchChannelId: { type: String },
      watchResourceId: { type: String },
      watchExpiration: { type: Date },
    },

    notificationPreferences: {
      quoteCreated: { type: Boolean, default: true },
      quoteUpdated: { type: Boolean, default: true },
      quoteDeleted: { type: Boolean, default: true },
      shipmentCreated: { type: Boolean, default: true },
      shipmentUpdated: { type: Boolean, default: true },
      shipmentDeleted: { type: Boolean, default: true },
      passwordChanged: { type: Boolean, default: true },
      emailChanged: { type: Boolean, default: true },
      profileUpdated: { type: Boolean, default: true },
    },
    subscription: {
      plan: {
        type: String,
        enum: ['free', 'starter', 'professional', 'enterprise'],
        default: 'free',
      },
      status: {
        type: String,
        enum: ['active', 'inactive', 'trial', 'cancelled'],
        default: 'active',
      },
      startDate: {
        type: Date,
        default: Date.now,
      },
      endDate: {
        type: Date,
        default: null,
      },
      features: {
        type: [String],
        default: ['Basic Dashboard', 'Up to 10 Vehicles', 'Email Support'],
      },
    },
  },
  {
    timestamps: true,
  }
);

// Static method to check if email is taken
UserSchema.statics.isEmailTaken = async function (
  email: string,
  excludeUserId?: string
): Promise<boolean> {
  const user = await this.findOne({ email, _id: { $ne: excludeUserId } });
  return !!user;
};

// Pre-save hook to hash password and generate referral code
UserSchema.pre<IUser>('save', async function (next) {
  const user = this;

  // 1. Hash password if modified
  if (user.isModified('password') && user.password) {
    user.password = await bcrypt.hash(user.password, Number(config.bcryptSaltRounds));
  }

  // 2. Auto-generate AAU referral code if new and missing
  if (user.isNew && !user.referralCode) {
    // Extract first name (or part of email if name is weird)
    let baseName = user.name ? user.name.split(' ')[0].replace(/[^a-zA-Z]/g, '').toUpperCase() : 'USER';
    if (baseName.length < 2) baseName = 'USER';

    // Generate an incredibly aggressive unique generation loop to prevent collision
    let codeUnique = false;
    let attempts = 0;
    while (!codeUnique && attempts < 10) {
      const random3Digits = Math.floor(100 + Math.random() * 900); // 100-999
      const candidateCode = `AAU-${baseName}-${random3Digits}`;

      const existingUser = await mongoose.models.User.findOne({ referralCode: candidateCode });
      if (!existingUser) {
        user.referralCode = candidateCode;
        codeUnique = true;
      }
      attempts++;
    }
    // Fallback if 10 collisions happen (incredibly rare)
    if (!codeUnique) {
      user.referralCode = `AAU-${baseName}-${Date.now().toString().slice(-4)}`;
    }
  }

  next();
});

// Instance method to compare password
UserSchema.methods.isPasswordMatch = async function (password: string): Promise<boolean> {
  const user = this as IUser;
  return bcrypt.compare(password, user.password!);
};

const User = mongoose.model<IUser, IUserModel>('User', UserSchema);

export default User;