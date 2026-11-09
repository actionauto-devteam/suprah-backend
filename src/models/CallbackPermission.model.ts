import mongoose, { Document, Schema } from 'mongoose';

export interface ICallbackAttempt {
  userId?: string | null;
  name?: string | null;
  callLogId?: string | null;
  at: Date;
}

export interface ICallbackPermission extends Document {
  organizationId: mongoose.Types.ObjectId;
  phone: string;
  sourceCallLogId: mongoose.Types.ObjectId;
  calledAt: Date;
  expiresAt: Date;
  maxAttempts: number;
  attemptsUsed: number;
  attempts: ICallbackAttempt[];
  restrictingLeadIds: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const CallbackAttemptSchema = new Schema<ICallbackAttempt>(
  {
    userId: { type: String, default: null },
    name: { type: String, trim: true, maxlength: 160, default: null },
    callLogId: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const CallbackPermissionSchema = new Schema<ICallbackPermission>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    phone: { type: String, required: true, trim: true },
    sourceCallLogId: { type: Schema.Types.ObjectId, ref: 'CallLog', required: true },
    calledAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    maxAttempts: { type: Number, required: true, min: 1 },
    attemptsUsed: { type: Number, default: 0, min: 0 },
    attempts: { type: [CallbackAttemptSchema], default: [] },
    restrictingLeadIds: [{ type: Schema.Types.ObjectId, ref: 'Lead' }],
  },
  { timestamps: true },
);

CallbackPermissionSchema.index({ organizationId: 1, phone: 1 }, { unique: true, name: 'callback_permission_org_phone' });

const CallbackPermission =
  (mongoose.models.CallbackPermission as mongoose.Model<ICallbackPermission>)
  || mongoose.model<ICallbackPermission>('CallbackPermission', CallbackPermissionSchema);

export default CallbackPermission;
