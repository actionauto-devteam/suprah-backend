import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import config from '../config';

export type OnlineStatus = 'online' | 'idle' | 'away' | 'busy' | 'offline' | 'do_not_disturb';

export interface ISocialLink {
  label: string;
  url: string;
}

export interface IPersonalInfo {
  bio?: string;
  phone?: string;
  phoneCountryCode?: string;
  location?: string;
  timezone?: string;
  language?: string;
  dateOfBirth?: Date;
  gender?: string;
  jobTitle?: string;
  department?: string;
  linkedIn?: string;
  website?: string;
  socialLinks?: ISocialLink[];
}

export interface IPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  deviceHint?: string;
  createdAt?: Date;
}

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  passwordHash?: string;
  otpCode?: string;
  otpExpiresAt?: Date;
  googleId?: string;
  emailVerified: boolean;
  avatar?: string;
  role: "customer" | "employee" | "admin" | "super_admin" | "driver";
  isActive: boolean;
  isApproved: boolean;
  organizationId?: mongoose.Types.ObjectId;
  organizationRole?: string;

  // New profile fields
  onlineStatus: OnlineStatus;
  customStatus?: string;
  // True once the user has explicitly chosen a status (anything but the automatic "online" state).
  // While true, presence heartbeats never overwrite onlineStatus — only the user (or statusExpiresAt lapsing) can.
  statusIsManual: boolean;
  personalInfo?: IPersonalInfo;
  lastActive?: Date;
  // Last real user interaction (mouse/keyboard/touch) across ANY device — drives the 30-min auto-away timer.
  lastInteractionAt?: Date;
  // Device type of whichever tab/device sent the most recent presence heartbeat — used to show
  // a phone-shaped presence indicator instead of a circle when someone is active from mobile.
  lastDeviceType?: 'mobile' | 'desktop';
  lastPasswordChange?: Date;
  breakStatus?: {
    isOnBreak: boolean;
    startedAt?: Date;
  };
  statusExpiresAt?: Date;
  onboardingCompleted: boolean;
  employmentLocationType: "onsite" | "remote";
  locationConsent?: {
    granted: boolean;
    grantedAt?: Date;
    deviceHint?: string;
  };
  locationSharingOptOut?: boolean;

  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  theme: "light" | "dark";

  // Wallet and Referral Engine
  referralCode?: string;
  walletBalance: number;
  totalEarned: number;

  notificationPreferences: {
    // CRM & Sales
    quoteCreated: boolean;
    quoteUpdated: boolean;
    quoteDeleted: boolean;
    // Transportation
    shipmentCreated: boolean;
    shipmentUpdated: boolean;
    shipmentDeleted: boolean;
    // Appointments
    appointmentCreated: boolean;
    appointmentUpdated: boolean;
    appointmentCancelled: boolean;
    // Account & Security
    passwordChanged: boolean;
    emailChanged: boolean;
    profileUpdated: boolean;
    loginAlerts: boolean;
    // Team & CRM
    driverRequests: boolean;
    crmActivity: boolean;
  };
  subscription?: {
    plan: "free" | "starter" | "professional" | "enterprise";
    status: "active" | "inactive" | "trial" | "cancelled";
    startDate: Date;
    endDate?: Date;
    features: string[];
  };
  stripeConnectAccountId?: string;
  pushSubscriptions: IPushSubscription[];
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
    emailVerified: {
      type: Boolean,
      default: false,
    },
    password: {
      type: String,
      required: false,
      private: true,
    },
    passwordHash: {
      type: String,
      required: false,
      private: true,
    },
    otpCode: {
      type: String,
      private: true,
    },
    otpExpiresAt: {
      type: Date,
      private: true,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
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
    isApproved: {
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
    onboardingCompleted: {
      type: Boolean,
      default: false, // Default false to force new users to onboard properly
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
    statusIsManual: {
      type: Boolean,
      default: false,
    },
    personalInfo: {
      bio: { type: String, maxlength: 500 },
      phone: { type: String },
      phoneCountryCode: { type: String, default: '' },
      location: { type: String },
      timezone: { type: String },
      language: { type: String, default: 'en' },
      dateOfBirth: { type: Date },
      gender: { type: String, enum: ['', 'male', 'female', 'prefer-not-to-say'], default: '' },
      jobTitle: { type: String },
      department: { type: String },
      linkedIn: { type: String },
      website: { type: String },
      socialLinks: [{
        label: { type: String },
        url: { type: String },
      }],
    },
    lastActive: {
      type: Date,
      default: Date.now,
    },
    lastInteractionAt: {
      type: Date,
      default: Date.now,
    },
    lastDeviceType: {
      type: String,
      enum: ['mobile', 'desktop'],
    },
    breakStatus: {
      isOnBreak: { type: Boolean, default: false },
      startedAt: { type: Date },
    },
    statusExpiresAt: {
      type: Date,
      default: null,
    },
    employmentLocationType: {
      type: String,
      enum: ['onsite', 'remote'],
      default: 'remote',
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

    notificationPreferences: {
      // CRM & Sales
      quoteCreated: { type: Boolean, default: true },
      quoteUpdated: { type: Boolean, default: true },
      quoteDeleted: { type: Boolean, default: true },
      // Transportation
      shipmentCreated: { type: Boolean, default: true },
      shipmentUpdated: { type: Boolean, default: true },
      shipmentDeleted: { type: Boolean, default: true },
      // Appointments
      appointmentCreated: { type: Boolean, default: true },
      appointmentUpdated: { type: Boolean, default: true },
      appointmentCancelled: { type: Boolean, default: true },
      // Account & Security
      passwordChanged: { type: Boolean, default: true },
      emailChanged: { type: Boolean, default: true },
      profileUpdated: { type: Boolean, default: true },
      loginAlerts: { type: Boolean, default: true },
      // Team & CRM
      driverRequests: { type: Boolean, default: true },
      crmActivity: { type: Boolean, default: true },
    },
    stripeConnectAccountId: {
      type: String,
      trim: true,
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

      const User = this.constructor as mongoose.Model<IUser>;
      const existingUser = await User.findOne({ referralCode: candidateCode });
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