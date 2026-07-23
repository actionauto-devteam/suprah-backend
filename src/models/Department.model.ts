import mongoose, { Document, Schema } from 'mongoose';

export interface IDepartment extends Document {
  organizationId?: mongoose.Types.ObjectId;
  key: string;
  label: string;
  color: string;
  isMobileMonitoringDept: boolean;
  isTimeEditExempt: boolean;
  isMandatoryLocationDept: boolean;
  locationRequiredForTimeproof: boolean;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const DepartmentSchema = new Schema<IDepartment>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    color: {
      type: String,
      default: 'emerald',
    },
    isMobileMonitoringDept: {
      type: Boolean,
      default: false,
    },
    isTimeEditExempt: {
      type: Boolean,
      default: false,
    },
    isMandatoryLocationDept: {
      type: Boolean,
      default: false,
    },
    // Gates the entire Shift Alerts location-monitoring feature (no-location-
    // at-shift-start, turned-off-mid-shift auto-clockout, no-location-after-
    // break, connection-lost) for this department — see
    // isLocationRequiredForTimeproof in config/departmentMonitoring.ts.
    // Defaults true to match the feature's existing behavior for everyone
    // (it shipped with no exemptions); toggling off is what opts a
    // department out.
    locationRequiredForTimeproof: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

DepartmentSchema.index({ organizationId: 1, key: 1 }, { unique: true });

const Department = mongoose.model<IDepartment>('Department', DepartmentSchema);

export default Department;
