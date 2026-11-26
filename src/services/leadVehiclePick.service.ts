import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.model';
import { summarizeVehicle, type InventoryVehicleSummary } from './leadVehiclePreview.service';

const SEARCH_FIELDS = 'year make modelName trim vin stockNumber mileage price exteriorColor images status isArchived archivedAt';
const PICK_FIELDS = 'year make modelName trim vin stockNumber mileage price';
const MAX_RESULTS = 8;
const MAX_WORDS = 5;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchWords(raw: unknown): string[] {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (text.length < 2) return [];
  return text.split(' ').filter(Boolean).slice(0, MAX_WORDS);
}

export async function searchInventoryForLead(organizationId: string, rawQuery: unknown): Promise<InventoryVehicleSummary[]> {
  const words = searchWords(rawQuery);
  if (!words.length || !mongoose.isValidObjectId(organizationId)) return [];
  const conditions = words.map((word) => {
    const pattern = new RegExp(escapeRegex(word), 'i');
    const anyField: Record<string, unknown>[] = [
      { vin: pattern },
      { stockNumber: pattern },
      { make: pattern },
      { modelName: pattern },
      { trim: pattern },
    ];
    if (/^\d{4}$/.test(word)) anyField.push({ year: Number(word) });
    return { $or: anyField };
  });
  const rows = await Vehicle.find({
    organizationId,
    isDeleted: { $ne: true },
    isArchived: { $ne: true },
    $and: conditions,
  })
    .select(SEARCH_FIELDS)
    .sort({ updatedAt: -1 })
    .limit(MAX_RESULTS)
    .lean();
  return rows.map(summarizeVehicle);
}

export async function inventoryVehicleForLead(organizationId: string, vehicleId: unknown): Promise<any | null> {
  const id = String(vehicleId ?? '').trim();
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(organizationId)) return null;
  return Vehicle.findOne({ _id: id, organizationId, isDeleted: { $ne: true } }).select(PICK_FIELDS).lean();
}

export function leadVehicleFieldsFrom(vehicle: any): Record<string, unknown> {
  return {
    vehicleId: vehicle._id,
    'vehicle.year': vehicle.year ? String(vehicle.year) : '',
    'vehicle.make': String(vehicle.make || '').trim(),
    'vehicle.model': String(vehicle.modelName || '').trim(),
    'vehicle.trim': String(vehicle.trim || '').trim(),
    'vehicle.vin': String(vehicle.vin || '').trim(),
    'vehicle.stock': String(vehicle.stockNumber || '').trim(),
    'vehicle.price': typeof vehicle.price === 'number' && vehicle.price > 0 ? String(vehicle.price) : '',
    'vehicle.odometer': typeof vehicle.mileage === 'number' && vehicle.mileage > 0 ? String(vehicle.mileage) : '',
  };
}

export function leadVehicleLabel(vehicle: any): string {
  const name = [vehicle?.year, vehicle?.make, vehicle?.model].map((part) => String(part || '').trim()).filter(Boolean).join(' ');
  const stock = String(vehicle?.stock || '').trim();
  return [name, stock ? `#${stock}` : ''].filter(Boolean).join(' ');
}
