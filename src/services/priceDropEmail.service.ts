import Lead from '../models/lead.model';
import { IVehicle } from '../models/Vehicle.model';
import PriceDropEmailLog from '../models/PriceDropEmailLog.model';
import { matchesVehicle } from './vehicleReengagement.service';
import emailService from './email.service';
import { NURTURE_ELIGIBLE_STATUSES } from '../constants/leadStatus';
import logger from '../utils/logger';

const MIN_DROP_AMOUNT = parseFloat(process.env.PRICE_DROP_EMAIL_MIN_AMOUNT || '250');
const CANDIDATE_SCAN_LIMIT = 2000;
const MAX_MATCHES_PER_VEHICLE = parseInt(process.env.PRICE_DROP_EMAIL_MAX_MATCHES_PER_VEHICLE || '25', 10);

function normalizeVinOrStock(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

export type PriceDropMatchMethod = 'vin' | 'stock' | 'fuzzy';

export async function matchLeadsForVehicle(
  vehicle: IVehicle,
): Promise<Array<{ lead: any; matchMethod: PriceDropMatchMethod }>> {
  const candidates = await Lead.find({
    organizationId: vehicle.organizationId,
    status: { $in: NURTURE_ELIGIBLE_STATUSES },
    email: { $exists: true, $ne: '' },
    'vehicle.year': { $exists: true, $ne: '' },
    'vehicle.make': { $exists: true, $ne: '' },
    'vehicle.model': { $exists: true, $ne: '' },
  })
    .select('organizationId firstName lastName email phone vehicle')
    .limit(CANDIDATE_SCAN_LIMIT)
    .lean();

  const vin = normalizeVinOrStock(vehicle.vin);
  const stock = normalizeVinOrStock(vehicle.stockNumber);

  const matched: Array<{ lead: any; matchMethod: PriceDropMatchMethod }> = [];
  for (const lead of candidates) {
    const leadVin = normalizeVinOrStock((lead as any).vehicle?.vin);
    const leadStock = normalizeVinOrStock((lead as any).vehicle?.stock);

    if (vin && leadVin && leadVin === vin) {
      matched.push({ lead, matchMethod: 'vin' });
      continue;
    }
    if (stock && leadStock && leadStock === stock) {
      matched.push({ lead, matchMethod: 'stock' });
      continue;
    }
    // Only fall back to fuzzy year/make/model matching when the lead has no
    // vin/stock of its own on file — a lead whose vin/stock is known but
    // doesn't match this vehicle is a genuinely different car, not a miss.
    if (!leadVin && !leadStock && matchesVehicle((lead as any).vehicle, vehicle)) {
      matched.push({ lead, matchMethod: 'fuzzy' });
    }
  }

  return matched.slice(0, MAX_MATCHES_PER_VEHICLE);
}

async function writeLog(entry: Record<string, unknown>) {
  try {
    await PriceDropEmailLog.create(entry as any);
  } catch (err) {
    // The unique {leadId,vehicleId,priceChangedAt} index is the dedup guard —
    // a duplicate-key error here means this exact event was already logged.
    logger.warn({ err }, '[PriceDropEmail] Failed to write log (may be an expected dedup collision)');
  }
}

export async function processVehicleForPriceDrop(vehicle: IVehicle): Promise<{ matched: number }> {
  const history = vehicle.priceHistory || [];
  const latest = history[history.length - 1];
  if (!latest) return { matched: 0 };

  const previousPrice = latest.previousPrice;
  const newPrice = latest.newPrice;
  if (
    previousPrice === null ||
    previousPrice === undefined ||
    !Number.isFinite(previousPrice) ||
    !Number.isFinite(newPrice) ||
    previousPrice <= 0 ||
    newPrice <= 0 ||
    previousPrice - newPrice < MIN_DROP_AMOUNT
  ) {
    return { matched: 0 };
  }

  const vehicleLabel = [vehicle.year, vehicle.make, vehicle.modelName, vehicle.trim]
    .filter(Boolean)
    .join(' ');
  const matches = await matchLeadsForVehicle(vehicle);

  for (const { lead, matchMethod } of matches) {
    const base = {
      organizationId: vehicle.organizationId,
      vehicleId: vehicle._id,
      leadId: lead._id,
      vehicleLabel,
      leadEmail: lead.email,
      previousPrice,
      newPrice,
      priceChangedAt: latest.changedAt,
      matchMethod,
    };

    try {
      const sent = await emailService.sendPriceDropEmail({ lead, vehicle, previousPrice, newPrice });
      if (sent) {
        await writeLog({ ...base, status: 'sent', sentAt: new Date() });
      } else {
        await writeLog({ ...base, status: 'skipped', skippedReason: 'No email on file or opted out' });
      }
    } catch (err: any) {
      logger.error({ err, leadId: lead._id, vehicleId: vehicle._id }, '[PriceDropEmail] Send failed');
      await writeLog({
        ...base,
        status: 'failed',
        failureReason: String(err?.message || err).slice(0, 500),
      });
    }
  }

  return { matched: matches.length };
}
