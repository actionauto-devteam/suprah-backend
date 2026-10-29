import cron from 'node-cron';
import Quote from '../models/Quote.model';
import Vehicle from '../models/Vehicle.model';
import cacheService from '../services/cache.service';
import { notifyQuoteCustomer } from '../services/customerShipments.service';
import { vehicleStateOf } from '../services/vehicleAvailability';
import { getSocketIO } from '../utils/socketEmitter';
import logger from '../utils/logger';

/*
 * A customer's waiting shipping request is for a car on the marketplace. When
 * that car is sold or removed from inventory, the request is closed as "No
 * longer available" (Declined, with closedReason vehicle_unavailable) and the
 * customer is told. A car back In Recon or In Transit is left alone. Staff
 * quotes are never touched.
 */

/** Requests checked per run; the rest are picked up on the next run. */
const BATCH_SIZE = 500;

export async function closeUnavailableCustomerRequests(): Promise<number> {
  const waiting = await Quote.find({ source: 'customer_portal', status: 'pending', vehicleId: { $ne: null } })
    .select('_id organizationId vehicleId')
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE)
    .lean<Array<{ _id: unknown; organizationId: string; vehicleId: unknown }>>();
  if (waiting.length === 0) return 0;

  const vehicleIds = [...new Set(waiting.map((quote) => String(quote.vehicleId)))];
  const vehicles = await Vehicle.find({ _id: { $in: vehicleIds } })
    .select('status isDeleted isArchived')
    .lean<Array<{ _id: unknown; status?: string; isDeleted?: boolean; isArchived?: boolean }>>();
  const vehicleById = new Map(vehicles.map((vehicle) => [String(vehicle._id), vehicle]));

  let closed = 0;
  const touchedOrgs = new Set<string>();
  for (const quote of waiting) {
    if (vehicleStateOf(vehicleById.get(String(quote.vehicleId))) === 'available') continue;
    // Only if it's still waiting: staff may have answered it meanwhile.
    const result = await Quote.updateOne(
      { _id: quote._id, source: 'customer_portal', status: 'pending' },
      { $set: { status: 'rejected', closedReason: 'vehicle_unavailable', closedAt: new Date() } },
    );
    if (result.modifiedCount !== 1) continue;
    closed += 1;
    touchedOrgs.add(String(quote.organizationId));
    await notifyQuoteCustomer(String(quote.organizationId), quote._id, 'unavailable');
  }

  for (const orgId of touchedOrgs) {
    await cacheService.invalidateByPrefix(`quotes:${orgId}`);
    getSocketIO()?.to(`org:${orgId}`).emit('quote:change', { action: 'updated' });
  }
  return closed;
}

async function run() {
  try {
    const closed = await closeUnavailableCustomerRequests();
    if (closed) logger.info({ closed }, '[CustomerRequestAvailability] Closed requests for vehicles no longer available');
  } catch (error) {
    logger.error({ error }, '[CustomerRequestAvailability] Run failed');
  }
}

export const initCustomerRequestAvailabilityScheduler = () => {
  // Every 15 minutes, plus once at startup. Each close is a conditional
  // update, so overlapping runs never close or notify twice.
  cron.schedule('*/15 * * * *', run);
  void run();
};
