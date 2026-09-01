import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IEotmTeam extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  color: string;
  memberIds: mongoose.Types.ObjectId[];
  isActive: boolean;
  sortOrder: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IEotmTeamModel extends Model<IEotmTeam> {}

const EotmTeamSchema = new Schema<IEotmTeam>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    color: {
      type: String,
      default: 'amber',
    },
    memberIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

EotmTeamSchema.index({ organizationId: 1, name: 1 }, { unique: true });

const EotmTeam = mongoose.model<IEotmTeam, IEotmTeamModel>('EotmTeam', EotmTeamSchema);

export default EotmTeam;
