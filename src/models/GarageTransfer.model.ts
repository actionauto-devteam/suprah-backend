import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IGarageTransfer extends Document {
  organizationId: mongoose.Types.ObjectId;
  vehicleId: mongoose.Types.ObjectId;
  ownedVehicleId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;
  dealId?: mongoose.Types.ObjectId | null;
  vin: string;
  vehicleLabel: string;
  customerName: string;
  customerEmail: string;
  mileageAtTransfer: number;
  vehicleMarkedSold: boolean;
  performedBy: mongoose.Types.ObjectId;
  performedByName: string;
  status: 'transferred' | 'already_in_garage';
  createdAt: Date;
  updatedAt: Date;
}

const GarageTransferSchema = new Schema<IGarageTransfer>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    vehicleId:      { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    ownedVehicleId: { type: Schema.Types.ObjectId, ref: 'OwnedVehicle', required: true },
    customerId:     { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dealId:         { type: Schema.Types.ObjectId, ref: 'Deal', default: null },
    vin:            { type: String, required: true },
    vehicleLabel:   { type: String, required: true },
    customerName:   { type: String, required: true },
    customerEmail:  { type: String, required: true },
    mileageAtTransfer: { type: Number, default: 0 },
    vehicleMarkedSold: { type: Boolean, default: false },
    performedBy:    { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    performedByName:{ type: String, required: true },
    status: {
      type: String,
      enum: ['transferred', 'already_in_garage'],
      default: 'transferred',
    },
  },
  { timestamps: true }
);

GarageTransferSchema.index({ organizationId: 1, createdAt: -1 });

const GarageTransfer: Model<IGarageTransfer> =
  mongoose.models.GarageTransfer ||
  mongoose.model<IGarageTransfer>('GarageTransfer', GarageTransferSchema);

export default GarageTransfer;