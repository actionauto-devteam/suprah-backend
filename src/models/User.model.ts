import mongoose, { Document, Schema, Model } from 'mongoose';
import bcrypt from 'bcryptjs';
import config from '../config';

export interface IUser extends Document {
  email: string;
  password?: string;
  role: 'user' | 'admin';
  isActive: boolean;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  isPasswordMatch(password: string): Promise<boolean>;
}

export interface IUserModel extends Model<IUser> {
  isEmailTaken(email: string, excludeUserId?: string): Promise<boolean>;
}

const UserSchema: Schema<IUser> = new Schema(
  {
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
      private: true, // Hides the password field by default when querying
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