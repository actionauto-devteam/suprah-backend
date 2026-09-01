import mongoose, { Document, Schema, Model } from 'mongoose';

export const EOTM_KUDOS_REACTIONS = ['clap', 'fire', 'heart', 'trophy', 'star'] as const;
export type EotmKudosReaction = typeof EOTM_KUDOS_REACTIONS[number];

export interface IEotmKudos extends Document {
  organizationId: mongoose.Types.ObjectId;
  winnerId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  reaction: EotmKudosReaction;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IEotmKudosModel extends Model<IEotmKudos> {}

const EotmKudosSchema = new Schema<IEotmKudos>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    winnerId: {
      type: Schema.Types.ObjectId,
      ref: 'EmployeeOfMonth',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    authorAvatar: {
      type: String,
    },
    reaction: {
      type: String,
      enum: EOTM_KUDOS_REACTIONS,
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 280,
    },
  },
  {
    timestamps: true,
  },
);

EotmKudosSchema.index({ winnerId: 1, userId: 1 }, { unique: true });
EotmKudosSchema.index({ winnerId: 1, reaction: 1 });

const EotmKudos = mongoose.model<IEotmKudos, IEotmKudosModel>('EotmKudos', EotmKudosSchema);

export default EotmKudos;
