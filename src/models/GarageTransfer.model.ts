import mongoose, { Document, Schema, Model } from 'mongoose';

/**
 * GarageTransfer
 * ----------------------------------------------------------------------------
 * Audit record created every time the Finance team transfers an inventory
 * vehicle into a customer's My Garage from the CRM "Garage Review" screen.
 *
 * Snapshots (vin, vehicleLabel, customerName, customerEmail, mileage) are stored
 * inline so the history list never needs a populate and stays accurate even if
 * the source Vehicle / OwnedVehicle / User records later change.
 */
export interface IGarageTransfer extends Document {
  organizationId: mongoose.Types.ObjectId;
  vehicleId: mongoose.Types.ObjectId;        // inventory Vehicle
  ownedVehicleId: mongoose.Types.ObjectId;   // OwnedVehicle created in customer garage
  customerId: mongoose.Types.ObjectId;       // User (customer)
  dealId?: mongoose.Types.ObjectId | null;   // optional linked Deal
  vin: string;
  vehicleLabel: string;                      // "2022 Toyota Camry"
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