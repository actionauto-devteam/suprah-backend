import mongoose, { Document, Schema, Model } from 'mongoose';

export type EotmNominationStatus = 'pending' | 'dismissed';

export interface IEotmNomination extends Document {
  organizationId: mongoose.Types.ObjectId;
  teamId: mongoose.Types.ObjectId;
  month: string;
  nomineeId: mongoose.Types.ObjectId;
  submittedBy: mongoose.Types.ObjectId;
  note?: string;
  status: EotmNominationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface IEotmNominationModel extends Model<IEotmNomination> {}

const EotmNominationSchema = new Schema<IEotmNomination>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    teamId: {
      type: Schema.Types.ObjectId,
      ref: 'EotmTeam',
      required: true,
      index: true,
    },
    month: {
      type: String,
      required: true,
    },
    nomineeId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    status: {
      type: String,
      enum: ['pending', 'dismissed'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  },
);

EotmNominationSchema.index({ organizationId: 1, teamId: 1, month: 1 });

const EotmNomination = mongoose.model<IEotmNomination, IEotmNominationModel>(
  'EotmNomination',
  EotmNominationSchema,
);

export default EotmNomination;
