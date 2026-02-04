import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import config from '../config';

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  clerkId?: string;
  emailVerified: boolean;
  avatar?: string;
  role: 'user' | 'admin';
  isActive: boolean;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  theme: 'light' | 'dark';
  
  // Google Calendar Integration
googleCalendar?: {
  connected: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
  connectedAt?: Date;
  
  // NEW: Webhook tracking
  watchChannelId?: string;      // Current webhook channel ID
  watchResourceId?: string;      // Current webhook resource ID
  watchExpiration?: Date;        // When the webhook expires
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
    plan: 'free' | 'starter' | 'professional' | 'enterprise';
    status: 'active' | 'inactive' | 'trial' | 'cancelled';
    startDate: Date;
    endDate?: Date;
    features: string[];
  };
  isPasswordMatch(password: string): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {
  isEmailTaken(email: string, excludeUserId?: string): Promise<boolean>;
}

const UserSchema: Schema<IUser> = new Schema(
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
      enum: ['user', 'admin'],
      default: 'user',
    },
    isActive: {
      type: Boolean,
      default: true,
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

// Pre-save hook to hash password
UserSchema.pre<IUser>('save', async function (next) {
  const user = this;
  if (user.isModified('password') && user.password) {
    user.password = await bcrypt.hash(user.password, Number(config.bcryptSaltRounds));
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