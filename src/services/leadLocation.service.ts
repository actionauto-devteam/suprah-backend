import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.model';
import { matchesVehicle } from './vehicleReengagement.service';

const CANDIDATE_LIMIT = 500;
const STOCK_MATCH_LIMIT = 5;

export const UNMAPPED_LEAD_LOCATION_LABEL = 'Unknown Location';

export interface LeadVehicleDescriptor {
  vin?: string;
  stock?: string;
  year?: string;
  make?: string;
  model?: string;
}

export interface ResolvedVehicleContext {
  vehicleId?: mongoose.Types.ObjectId;
  location?: string;
  stockNumber?: string;
}

interface VehicleLocationRow {
  _id: unknown;
  dealerCity?: string | null;
  stockNumber?: string | null;
}

function storeKey(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function sharedLocation(rows: VehicleLocationRow[]): string | undefined {
  const stores = new Set(rows.map((row) => storeKey(row.dealerCity)));
  if (stores.size !== 1) return undefined;
  return String(rows[0].dealerCity || '').trim() || undefined;
}

function contextFrom(rows: VehicleLocationRow[]): ResolvedVehicleContext {
  const stockNumber = rows.length === 1 ? String(rows[0].stockNumber || '').trim() || undefined : undefined;
  return { vehicleId: rows[0]._id as mongoose.Types.ObjectId, location: sharedLocation(rows), stockNumber };
}

export async function resolveVehicleContextForLead(
  organizationId: any,
  descriptor: LeadVehicleDescriptor,
): Promise<ResolvedVehicleContext | null> {
  const vin = String(descriptor.vin || '').trim().toUpperCase();
  if (vin) {
    const byVin = await Vehicle.findOne({ organizationId, vin })
      .select('_id dealerCity stockNumber')
      .lean();
    if (byVin) {
      return { vehicleId: byVin._id as mongoose.Types.ObjectId, location: byVin.dealerCity || undefined, stockNumber: String(byVin.stockNumber || '').trim() || undefined };
    }
  }

  const stock = String(descriptor.stock || '').trim();
  if (stock) {
    const stockValues = Array.from(new Set([stock, stock.toUpperCase()]));
    const byStock = await Vehicle.find({ organizationId, stockNumber: { $in: stockValues } })
      .select('_id dealerCity stockNumber')
      .limit(STOCK_MATCH_LIMIT)
      .lean();
    if (byStock.length) return contextFrom(byStock as VehicleLocationRow[]);
  }

  const year = parseInt(String(descriptor.year || ''), 10);
  if (Number.isFinite(year) && descriptor.make && descriptor.model) {
    const candidates = await Vehicle.find({ organizationId, year })
      .select('_id year make modelName dealerCity stockNumber')
      .limit(CANDIDATE_LIMIT)
      .lean();
    const matches = candidates.filter((candidate) => matchesVehicle(descriptor, candidate as any));
    if (matches.length) return contextFrom(matches as VehicleLocationRow[]);
  }

  return null;
}
