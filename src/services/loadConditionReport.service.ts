import { ApiError } from "../utils/ApiError";
import { getSignedProofUrl } from "../utils/signedUrlCache";
import {
  CONDITION_AREAS,
  CONDITION_DAMAGE_TYPES,
  CONDITION_STOPS,
  CONDITION_STOP_STATUSES,
  SIGNATURE_DATA_URL_MAX_LENGTH,
  type ConditionStop,
} from "../constants/conditionReport";

/*
 * Rules for vehicle condition reports (see constants/conditionReport.ts),
 * kept apart from the endpoints so they're testable without a database.
 */

export function parseConditionStop(value: unknown): ConditionStop {
  if (CONDITION_STOPS.includes(value as ConditionStop)) return value as ConditionStop;
  throw new ApiError(400, "Choose whether this is the pickup or the delivery condition report.");
}

export function parseVehicleIndex(value: unknown, vehicleCount: number): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= vehicleCount) {
    throw new ApiError(404, "That vehicle is no longer on this load. Refresh the load and try again.");
  }
  return index;
}

/** The stops whose report the driver can still change at this load status. */
export function editableConditionStops(status: unknown): ConditionStop[] {
  return CONDITION_STOPS.filter((stop) => CONDITION_STOP_STATUSES[stop].includes(String(status ?? "")));
}

export function assertConditionStopEditable(stop: ConditionStop, status: unknown, loadNumber: unknown) {
  if (editableConditionStops(status).includes(stop)) return;
  throw new ApiError(
    400,
    stop === "pickup"
      ? `The pickup condition report for load ${loadNumber} can be filled in after you accept the load and until you start the route.`
      : `The delivery condition report for load ${loadNumber} can be filled in once the vehicles are picked up and until the load is delivered.`,
  );
}

const uniqueAllowed = (values: unknown, allowed: readonly string[]) =>
  Array.isArray(values) ? [...new Set(values.map(String).filter((value) => allowed.includes(value)))] : [];

/** The damage details a driver sent, limited to known areas and kinds. */
export function sanitizeConditionDetails(body: unknown): {
  damageAreas: string[];
  damageTypes: string[];
  note: string;
} {
  const input = (body ?? {}) as { damageAreas?: unknown; damageTypes?: unknown; note?: unknown };
  return {
    damageAreas: uniqueAllowed(input.damageAreas, CONDITION_AREAS),
    damageTypes: uniqueAllowed(input.damageTypes, CONDITION_DAMAGE_TYPES),
    note: String(input.note ?? "").trim().slice(0, 1000),
  };
}

/**
 * The damaged part a condition photo shows. Optional: no value means a general
 * photo of the vehicle. An unknown part is refused rather than dropped, so the
 * driver isn't told the photo is linked when it isn't.
 */
export function parseConditionPhotoArea(value: unknown): string | undefined {
  const area = String(value ?? "").trim();
  if (!area) return undefined;
  if (!(CONDITION_AREAS as readonly string[]).includes(area)) {
    throw new ApiError(400, "Choose which part of the vehicle this photo shows from the list, or leave it blank.");
  }
  return area;
}

/** The customer's name and drawn signature (a PNG data URL), checked. */
export function parseDeliverySignature(body: unknown): { signerName: string; signatureDataUrl: string } {
  const input = (body ?? {}) as { signerName?: unknown; signatureDataUrl?: unknown };
  const signerName = String(input.signerName ?? "").trim().slice(0, 200);
  const signatureDataUrl = String(input.signatureDataUrl ?? "");
  if (!signerName) throw new ApiError(400, "Enter the name of the person signing for the vehicles.");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureDataUrl)) {
    throw new ApiError(400, "Ask the customer to sign in the box, then save again.");
  }
  if (signatureDataUrl.length > SIGNATURE_DATA_URL_MAX_LENGTH) {
    throw new ApiError(400, "That signature is too large to save. Clear it and sign again.");
  }
  return { signerName, signatureDataUrl };
}

type StoredPhoto = { _id?: unknown; key?: string; uploadedAt?: unknown; area?: string };
type StoredReport = {
  _id?: unknown;
  stop?: string;
  vehicleIndex?: number;
  driverId?: unknown;
  driverName?: string;
  photos?: StoredPhoto[];
  damageAreas?: string[];
  damageTypes?: string[];
  note?: string;
  updatedAt?: unknown;
};

async function signedPhotos(photos: StoredPhoto[] | undefined) {
  return Promise.all(
    (photos ?? []).map(async (photo) => ({
      id: String(photo._id ?? ""),
      url: photo.key ? (await getSignedProofUrl(photo.key)) || null : null,
      uploadedAt: photo.uploadedAt ?? null,
      area: photo.area ?? null,
    })),
  );
}

/** A report as shown in the apps: photo links instead of storage keys. */
export async function presentConditionReport(report: StoredReport) {
  return {
    id: String(report._id ?? ""),
    stop: report.stop,
    vehicleIndex: report.vehicleIndex,
    driverId: report.driverId ? String(report.driverId) : null,
    driverName: report.driverName ?? null,
    photos: await signedPhotos(report.photos),
    damageAreas: report.damageAreas ?? [],
    damageTypes: report.damageTypes ?? [],
    note: report.note ?? "",
    updatedAt: report.updatedAt ?? null,
  };
}

/** Load details for Dispatch: every condition report, with photo links. */
export async function presentConditionReportsForStaff(load: Record<string, any>) {
  if (!Array.isArray(load?.conditionReports)) return;
  load.conditionReports = await Promise.all(load.conditionReports.map(presentConditionReport));
}

/** Load lists don't need condition reports or the signature drawing. */
export function omitConditionReportsFromList(load: Record<string, any>) {
  delete load.conditionReports;
  if (load.deliverySignature) {
    const { signatureDataUrl: _drawing, ...rest } = load.deliverySignature;
    load.deliverySignature = rest;
  }
}
