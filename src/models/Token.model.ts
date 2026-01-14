import mongoose, { Document, Schema } from 'mongoose';

export interface IToken extends Document {
  token: string;
  user: mongoose.Schema.Types.ObjectId;
  type: string;
  expires: Date;
  blacklisted: boolean;
}

const TokenSchema: Schema<IToken> = new Schema(
  {
    token: {
      type: String,
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['refresh', 'resetPassword', 'verifyEmail'],
      required: true,
    },
    expires: {
      type: Date,
      required: true,
    },
    blacklisted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Token = mongoose.model<IToken>('Token', TokenSchema);

export default Token;
