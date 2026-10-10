import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.model';
import { matchesVehicle } from './vehicleReengagement.service';

const CANDIDATE_LIMIT = 500;

export const UNMAPPED_LEAD_LOCATION_LABEL = 'Unknown Location';

export interface LeadVehicleDescriptor {
  vin?: string;
  year?: string;
  make?: string;
  model?: string;
}

export interface ResolvedVehicleContext {
  vehicleId: mongoose.Types.ObjectId;
  location?: string;
}

export async function resolveVehicleContextForLead(
  organizationId: any,
  descriptor: LeadVehicleDescriptor,
): Promise<ResolvedVehicleContext | null> {
  const vin = String(descriptor.vin || '').trim().toUpperCase();
  if (vin) {
    const byVin = await Vehicle.findOne({ organizationId, vin })
      .select('_id dealerCity')
      .lean();
    if (byVin) {
      return { vehicleId: byVin._id as mongoose.Types.ObjectId, location: byVin.dealerCity || undefined };
    }
  }

  const year = parseInt(String(descriptor.year || ''), 10);
  if (Number.isFinite(year) && descriptor.make && descriptor.model) {
    const candidates = await Vehicle.find({ organizationId, year })
      .select('_id make modelName dealerCity')
      .limit(CANDIDATE_LIMIT)
      .lean();
    const match = candidates.find((candidate) => matchesVehicle(descriptor, candidate as any));
    if (match) {
      return { vehicleId: match._id as mongoose.Types.ObjectId, location: match.dealerCity || undefined };
    }
  }

  return null;
}
