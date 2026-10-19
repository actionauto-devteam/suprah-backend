import { Request, Response } from "express";
import mongoose from "mongoose";
import Load from "../models/Load.model";
import { IUser } from "../models/User.model";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { LOAD_UNAVAILABLE_FOR_DRIVER } from "../utils/userMessages";
import { storageService, BucketType } from "../services/storage.service";
import { getSocketIO } from "../utils/socketEmitter";
import logger from "../utils/logger";
import {
  CONDITION_PHOTOS_PER_VEHICLE,
  CONDITION_STOP_STATUSES,
  type ConditionStop,
} from "../constants/conditionReport";
import {
  assertConditionStopEditable,
  editableConditionStops,
  parseConditionPhotoArea,
  parseConditionStop,
  parseDeliverySignature,
  parseVehicleIndex,
  presentConditionReport,
  sanitizeConditionDetails,
} from "../services/loadConditionReport.service";

/*
 * Vehicle condition reports, filled in by the assigned driver on their phone:
 * photos of each vehicle and the damage they see at pickup and at delivery,
 * plus the customer's signature at delivery. Optional and separate from the
 * pickup/delivery proof photos, which work exactly as before.
 */

const getUser = (req: Request) => req.user as IUser;

/** The load, if it's assigned to this driver (and, for a stop, still open for that stop). */
async function driverLoad(req: Request, stop?: ConditionStop) {
  const user = getUser(req);
  const load = await Load.findById(req.params.id);
  if (!load) throw new ApiError(404, LOAD_UNAVAILABLE_FOR_DRIVER);
  if (String(load.assignedDriverId ?? "") !== user._id.toString()) {
    throw new ApiError(403, `Load ${load.loadNumber} is not assigned to you, so you can't change its condition report.`);
  }
  if (stop) assertConditionStopEditable(stop, load.status, load.loadNumber);
  return { user, load };
}

/** Only while the load is still with this driver at a status open for the stop. */
const openForDriver = (loadId: unknown, driverId: unknown, stop: ConditionStop) => ({
  _id: loadId,
  assignedDriverId: driverId,
  status: { $in: CONDITION_STOP_STATUSES[stop] },
});

const myReportMatch = (stop: ConditionStop, vehicleIndex: number, driverId: unknown) => ({
  stop,
  vehicleIndex,
  driverId,
});

const findMyReport = (load: any, stop: ConditionStop, vehicleIndex: number, driverId: string) =>
  (load.conditionReports ?? []).find(
    (report: any) =>
      report.stop === stop && report.vehicleIndex === vehicleIndex && String(report.driverId) === driverId,
  );

/** Dispatch's open load page refreshes when a report changes. */
function announceLoadChange(load: any) {
  const io = getSocketIO();
  const organizationId = String(load.organizationId ?? "");
  if (io && organizationId) {
    io.to(`org:${organizationId}`).emit("load:change", { action: "updated", loadId: load._id.toString() });
  }
}

const vehicleLabel = (vehicle: any) =>
  [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") || "Vehicle";

// GET /api/driver-tracking/loads/:id/condition
// The driver's own reports for this load, with photo links.
const getMyConditionReport = asyncHandler(async (req: Request, res: Response) => {
  const { user, load } = await driverLoad(req);
  const driverId = user._id.toString();
  const mine = (load.conditionReports ?? []).filter((report: any) => String(report.driverId) === driverId);
  const signature =
    load.deliverySignature && String(load.deliverySignature.driverId) === driverId
      ? {
          signerName: load.deliverySignature.signerName,
          signedAt: load.deliverySignature.signedAt,
          signatureDataUrl: load.deliverySignature.signatureDataUrl,
        }
      : null;

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        loadNumber: load.loadNumber,
        status: load.status,
        editableStops: editableConditionStops(load.status),
        photosPerVehicle: CONDITION_PHOTOS_PER_VEHICLE,
        vehicles: (load.vehicles ?? []).map((vehicle: any, index: number) => ({
          index,
          label: vehicleLabel(vehicle),
          vin: vehicle?.vin ?? "",
        })),
        reports: await Promise.all(mine.map((report: any) => presentConditionReport(report.toObject()))),
        signature,
      },
      "Condition report fetched",
    ),
  );
});

// POST /api/driver-tracking/loads/:id/condition/:stop/:vehicleIndex/photos   (photo field: "proof")
const uploadConditionPhoto = asyncHandler(async (req: Request, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) throw new ApiError(400, "Take or choose a photo first.");
  const stop = parseConditionStop(req.params.stop);
  // Optional: the damaged part this photo shows (multipart field "area").
  const area = parseConditionPhotoArea((req.body as any)?.area);
  const { user, load } = await driverLoad(req, stop);
  const vehicleIndex = parseVehicleIndex(req.params.vehicleIndex, load.vehicles?.length ?? 0);
  const driverId = user._id.toString();

  const existing = findMyReport(load, stop, vehicleIndex, driverId);
  if ((existing?.photos?.length ?? 0) >= CONDITION_PHOTOS_PER_VEHICLE) {
    throw new ApiError(
      400,
      `You can add up to ${CONDITION_PHOTOS_PER_VEHICLE} photos for each vehicle. Remove one to add another.`,
    );
  }

  const key = await storageService.upload(file, "condition-report", BucketType.PRIVATE);
  const now = new Date();
  const photo = { _id: new mongoose.Types.ObjectId(), key, uploadedAt: now, ...(area ? { area } : {}) };
  const open = openForDriver(load._id, user._id, stop);

  // Add to this driver's report for the vehicle (while under the limit), or start it.
  let updated = await Load.findOneAndUpdate(
    {
      ...open,
      conditionReports: {
        $elemMatch: {
          ...myReportMatch(stop, vehicleIndex, user._id),
          [`photos.${CONDITION_PHOTOS_PER_VEHICLE - 1}`]: { $exists: false },
        },
      },
    },
    { $push: { "conditionReports.$.photos": photo }, $set: { "conditionReports.$.updatedAt": now } },
    { new: true, runValidators: true },
  );
  if (!updated) {
    updated = await Load.findOneAndUpdate(
      { ...open, conditionReports: { $not: { $elemMatch: myReportMatch(stop, vehicleIndex, user._id) } } },
      {
        $push: {
          conditionReports: {
            ...myReportMatch(stop, vehicleIndex, user._id),
            driverName: user.name,
            photos: [photo],
            damageAreas: [],
            damageTypes: [],
            note: "",
            updatedAt: now,
          },
        },
      },
      { new: true, runValidators: true },
    );
  }
  if (!updated) {
    try { await storageService.delete(key, BucketType.PRIVATE); } catch { /* non-fatal cleanup */ }
    throw new ApiError(
      409,
      `Load ${load.loadNumber} changed while your photo was uploading, so it wasn't saved. Refresh the load and try again.`,
    );
  }

  announceLoadChange(updated);
  logger.info({ loadId: load._id, userId: driverId, stop, vehicleIndex }, "Condition photo added");
  const report = findMyReport(updated, stop, vehicleIndex, driverId);
  return res
    .status(200)
    .json(new ApiResponse(200, await presentConditionReport(report.toObject()), "Photo added"));
});

// DELETE /api/driver-tracking/loads/:id/condition/:stop/:vehicleIndex/photos/:photoId
const deleteConditionPhoto = asyncHandler(async (req: Request, res: Response) => {
  const stop = parseConditionStop(req.params.stop);
  const { user, load } = await driverLoad(req, stop);
  const vehicleIndex = parseVehicleIndex(req.params.vehicleIndex, load.vehicles?.length ?? 0);
  const driverId = user._id.toString();
  const photoId = String(req.params.photoId ?? "");

  const report = findMyReport(load, stop, vehicleIndex, driverId);
  const photo = (report?.photos ?? []).find((item: any) => String(item._id) === photoId);
  if (!report || !photo) {
    // Already gone (a repeat tap): nothing to do.
    return res.status(200).json(new ApiResponse(200, report ? await presentConditionReport(report.toObject()) : null, "Photo removed"));
  }

  const updated = await Load.findOneAndUpdate(
    openForDriver(load._id, user._id, stop),
    {
      $pull: { "conditionReports.$[report].photos": { _id: photo._id } },
      $set: { "conditionReports.$[report].updatedAt": new Date() },
    },
    {
      new: true,
      arrayFilters: [{ "report.stop": stop, "report.vehicleIndex": vehicleIndex, "report.driverId": user._id }],
    },
  );
  if (!updated) {
    throw new ApiError(409, `Load ${load.loadNumber} changed before the photo was removed. Refresh the load and try again.`);
  }
  try { await storageService.delete(photo.key, BucketType.PRIVATE); } catch { /* non-fatal cleanup */ }

  announceLoadChange(updated);
  const after = findMyReport(updated, stop, vehicleIndex, driverId);
  return res
    .status(200)
    .json(new ApiResponse(200, after ? await presentConditionReport(after.toObject()) : null, "Photo removed"));
});

// PUT /api/driver-tracking/loads/:id/condition/:stop/:vehicleIndex   { damageAreas, damageTypes, note }
const saveConditionDetails = asyncHandler(async (req: Request, res: Response) => {
  const stop = parseConditionStop(req.params.stop);
  const details = sanitizeConditionDetails(req.body);
  const { user, load } = await driverLoad(req, stop);
  const vehicleIndex = parseVehicleIndex(req.params.vehicleIndex, load.vehicles?.length ?? 0);
  const driverId = user._id.toString();
  const now = new Date();
  const open = openForDriver(load._id, user._id, stop);

  let updated = await Load.findOneAndUpdate(
    { ...open, conditionReports: { $elemMatch: myReportMatch(stop, vehicleIndex, user._id) } },
    {
      $set: {
        "conditionReports.$.damageAreas": details.damageAreas,
        "conditionReports.$.damageTypes": details.damageTypes,
        "conditionReports.$.note": details.note,
        "conditionReports.$.updatedAt": now,
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated) {
    updated = await Load.findOneAndUpdate(
      { ...open, conditionReports: { $not: { $elemMatch: myReportMatch(stop, vehicleIndex, user._id) } } },
      {
        $push: {
          conditionReports: {
            ...myReportMatch(stop, vehicleIndex, user._id),
            driverName: user.name,
            photos: [],
            ...details,
            updatedAt: now,
          },
        },
      },
      { new: true, runValidators: true },
    );
  }
  if (!updated) {
    throw new ApiError(409, `Load ${load.loadNumber} changed while saving, so nothing was saved. Refresh the load and try again.`);
  }

  announceLoadChange(updated);
  const report = findMyReport(updated, stop, vehicleIndex, driverId);
  return res
    .status(200)
    .json(new ApiResponse(200, await presentConditionReport(report.toObject()), "Condition saved"));
});

// PUT /api/driver-tracking/loads/:id/condition/signature   { signerName, signatureDataUrl }
const saveDeliverySignature = asyncHandler(async (req: Request, res: Response) => {
  const { signerName, signatureDataUrl } = parseDeliverySignature(req.body);
  const { user, load } = await driverLoad(req, "delivery");
  const signedAt = new Date();

  const updated = await Load.findOneAndUpdate(
    openForDriver(load._id, user._id, "delivery"),
    {
      $set: {
        deliverySignature: {
          signerName,
          signatureDataUrl,
          signedAt,
          driverId: user._id,
          driverName: user.name,
        },
      },
    },
    { new: true, runValidators: true },
  );
  if (!updated) {
    throw new ApiError(409, `Load ${load.loadNumber} changed while saving the signature. Refresh the load and try again.`);
  }

  announceLoadChange(updated);
  return res.status(200).json(new ApiResponse(200, { signerName, signedAt }, "Signature saved"));
});

export default {
  getMyConditionReport,
  uploadConditionPhoto,
  deleteConditionPhoto,
  saveConditionDetails,
  saveDeliverySignature,
};
