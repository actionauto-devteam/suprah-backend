import type { IVehicle } from '../models/Vehicle.model';

export function normalizeToken(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchesVehicle(leadVehicle: any, vehicle: IVehicle): boolean {
  const leadYear = parseInt(leadVehicle?.year, 10);
  if (!Number.isFinite(leadYear) || leadYear !== vehicle.year) return false;

  const leadMake = normalizeToken(leadVehicle?.make);
  const targetMake = normalizeToken(vehicle.make);
  if (!leadMake || !targetMake || leadMake !== targetMake) return false;

  const leadModel = normalizeToken(leadVehicle?.model);
  const targetModel = normalizeToken(vehicle.modelName);
  if (!leadModel || !targetModel) return false;
  if (leadModel.length < 3 || targetModel.length < 3) return leadModel === targetModel;
  return leadModel.includes(targetModel) || targetModel.includes(leadModel);
}
