import mongoose from "mongoose";
import Appointment from "../models/Appointment.model";

const VEHICLE_MODEL_NAMES = ["Vehicle", "Vehicles", "OwnedVehicle", "CrmVehicle"];

const VEHICLE_FIELD_MAP = {
  soldFlag: "isSold",
  statusField: "status",
  soldStatusValue: "sold",
  soldAtField: "soldAt",
  orgField: "organizationId",
};

const TEST_DRIVE_VALUES = ["test-drive", "test_drive", "test drive", "testdrive"];
const DEFAULT_LOOKBACK_MONTHS = 36;
const QUERY_TIMEOUT_MS = 20_000;
const VEHICLE_LIMIT = 5_000;

function resolveVehicleModel(): mongoose.Model<any> | null {
  for (const name of VEHICLE_MODEL_NAMES) {
    try {
      return mongoose.model(name);
    } catch {
    }
  }
  return null;
}

function readSold(vehicle: any): { sold: boolean; soldAt?: Date } {
  if (!vehicle) return { sold: false };
  const flag = vehicle[VEHICLE_FIELD_MAP.soldFlag];
  const status = vehicle[VEHICLE_FIELD_MAP.statusField];
  const sold =
    flag === true ||
    (typeof status === "string" &&
      status.toLowerCase() === VEHICLE_FIELD_MAP.soldStatusValue);
  return { sold, soldAt: vehicle[VEHICLE_FIELD_MAP.soldAtField] };
}

interface HistoryOptions {
  startDate?: Date;
  endDate?: Date;
  status?: "all" | "sold" | "available" | "test-driven";
}

class VehicleHistoryService {
  async getVehicleHistory(organizationId: string, options: HistoryOptions = {}) {
    const VehicleModel = resolveVehicleModel();

    if (!VehicleModel) {
      return {
        vehicles: [],
        summary: { total: 0, sold: 0, testDriven: 0, available: 0 },
        warning: "Vehicle model not found",
      };
    }

    const orgField = VEHICLE_FIELD_MAP.orgField;

    const start =
      options.startDate ??
      new Date(
        Date.now() - DEFAULT_LOOKBACK_MONTHS * 30 * 24 * 60 * 60 * 1000,
      );
    const end = options.endDate;

    const startTimeMatch: Record<string, Date> = { $gte: start };
    if (end) startTimeMatch.$lte = end;

    const vehicles = await VehicleModel.find({ [orgField]: organizationId })
      .select(
        [
          "year",
          "make",
          "model",
          "vin",
          "stockNumber",
          "stockNo",
          VEHICLE_FIELD_MAP.soldFlag,
          VEHICLE_FIELD_MAP.statusField,
          VEHICLE_FIELD_MAP.soldAtField,
        ].join(" "),
      )
      .limit(VEHICLE_LIMIT)
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean();

    const agg = await Appointment.aggregate([
      {
        $match: {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          startTime: startTimeMatch,
        },
      },
      {
        $project: {
          type: { $toLower: { $ifNull: ["$type", ""] } },
          startTime: 1,
          vids: {
            $concatArrays: [
              {
                $cond: [
                  { $ifNull: ["$vehicleId", false] },
                  ["$vehicleId"],
                  [],
                ],
              },
              { $ifNull: ["$vehicleIds", []] },
            ],
          },
        },
      },
      { $unwind: "$vids" },
      {
        $group: {
          _id: "$vids",
          total: { $sum: 1 },
          testDrives: {
            $sum: { $cond: [{ $in: ["$type", TEST_DRIVE_VALUES] }, 1, 0] },
          },
          lastActivity: { $max: "$startTime" },
          lastTestDrive: {
            $max: {
              $cond: [
                { $in: ["$type", TEST_DRIVE_VALUES] },
                "$startTime",
                null,
              ],
            },
          },
        },
      },
    ])
      .option({ maxTimeMS: QUERY_TIMEOUT_MS })
      .exec();

    const activityByVehicle = new Map<string, any>();
    for (const a of agg) activityByVehicle.set(a._id?.toString(), a);

    let records = vehicles.map((v: any) => {
      const key = v._id.toString();
      const activity = activityByVehicle.get(key);
      const { sold, soldAt } = readSold(v);
      const testDriven = (activity?.testDrives ?? 0) > 0;

      let derivedStatus: "sold" | "test-driven" | "available";
      if (sold) derivedStatus = "sold";
      else if (testDriven) derivedStatus = "test-driven";
      else derivedStatus = "available";

      return {
        _id: key,
        year: v.year,
        make: v.make,
        model: v.model,
        vin: v.vin,
        stockNumber: v.stockNumber ?? v.stockNo,
        status: derivedStatus,
        sold,
        soldAt,
        testDriven,
        testDriveCount: activity?.testDrives ?? 0,
        appointmentCount: activity?.total ?? 0,
        lastTestDriveAt: activity?.lastTestDrive ?? undefined,
        lastActivityAt: activity?.lastActivity ?? undefined,
      };
    });

    if (options.status && options.status !== "all") {
      records = records.filter((r) => r.status === options.status);
    }

    records.sort((a, b) => {
      const at = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
      const bt = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
      return bt - at;
    });

    const summary = {
      total: records.length,
      sold: records.filter((r) => r.status === "sold").length,
      testDriven: records.filter((r) => r.testDriven).length,
      available: records.filter((r) => r.status === "available").length,
    };

    return { vehicles: records, summary };
  }
}

export default new VehicleHistoryService();