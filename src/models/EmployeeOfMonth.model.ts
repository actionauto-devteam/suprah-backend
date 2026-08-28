import mongoose, { Document, Schema, Model } from 'mongoose';

export type EmployeeOfMonthTeam = 'Philippines' | 'Utah';

export interface IEmployeeOfMonth extends Document {
  organizationId: mongoose.Types.ObjectId;
  team: EmployeeOfMonthTeam;
  month: string;
  employeeId: mongoose.Types.ObjectId;
  note?: string;
  setByUserId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IEmployeeOfMonthModel extends Model<IEmployeeOfMonth> {}

const EmployeeOfMonthSchema = new Schema<IEmployeeOfMonth>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    team: {
      type: String,
      enum: ['Philippines', 'Utah'],
      required: true,
    },
    month: {
      type: String,
      required: true,
    },
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    note: {
      type: String,
      trim: true,
      maxlength: 280,
    },
    setByUserId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

EmployeeOfMonthSchema.index({ organizationId: 1, team: 1, month: 1 }, { unique: true });

const EmployeeOfMonth = mongoose.model<IEmployeeOfMonth, IEmployeeOfMonthModel>(
  'EmployeeOfMonth',
  EmployeeOfMonthSchema,
);

export default EmployeeOfMonth;
