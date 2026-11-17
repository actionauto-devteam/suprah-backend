import Load from "../models/Load.model";
import DriverPayout from "../models/DriverPayout.model";

/**
 * The driver's Earnings page (2026-11-16): the number of completed loads, the
 * number still waiting for pay, and the newest unpaid ones to list beside the
 * payouts. Before, the page downloaded every load the driver ever had.
 * "Unpaid" is the page's own rule: a delivered load with no paid or
 * processing payout.
 */
export const EARNINGS_UNPAID_LIMIT = 100;

const EARNINGS_LOAD_FIELDS =
  "loadNumber trackingNumber origin destination pickupLocation.city deliveryLocation.city pricing.carrierPayAmount carrierPayAmount dates.deliveryDeadline deliveredAt delivered createdAt status";

export async function driverEarningsSummary(driverId: unknown) {
  const settled = await DriverPayout.find({ driverId, status: { $in: ["paid", "processing"] } })
    .select("loadId")
    .lean<Array<{ loadId?: unknown }>>();
  const settledLoadIds = settled.map((payout) => payout.loadId).filter(Boolean);

  const delivered = { assignedDriverId: driverId, status: "Delivered" };
  const unpaid = settledLoadIds.length ? { ...delivered, _id: { $nin: settledLoadIds } } : delivered;

  const [completedCount, unpaidCount, unpaidLoads] = await Promise.all([
    Load.countDocuments(delivered),
    Load.countDocuments(unpaid),
    Load.find(unpaid)
      .select(EARNINGS_LOAD_FIELDS)
      .sort({ deliveredAt: -1, createdAt: -1 })
      .limit(EARNINGS_UNPAID_LIMIT)
      .lean(),
  ]);

  return { completedCount, unpaidCount, unpaidLoads };
}
