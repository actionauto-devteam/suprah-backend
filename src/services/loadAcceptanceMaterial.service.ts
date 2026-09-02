import { createHash } from "crypto";
import mongoose from "mongoose";

export type LoadMaterialChange = {
  field:
    | "postType"
    | "pickupLocation"
    | "deliveryLocation"
    | "vehicles"
    | "trailerType"
    | "dates"
    | "pricing"
    | "additionalInfo";
  label: string;
  before: string;
  after: string;
};

export function canonicalizeAcceptanceMaterial(value: any): any {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeAcceptanceMaterial(entry));
  }

  if (typeof value === "object") {
    const source =
      typeof value.toObject === "function"
        ? value.toObject({
            depopulate: true,
            getters: false,
            virtuals: false,
          })
        : value;

    if (source instanceof Date) return source.toISOString();
    if (source instanceof mongoose.Types.ObjectId) return source.toString();

    const result: Record<string, any> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === "_id" || key === "__v" || key === "inspectionPhotoUrl") {
        continue;
      }
      const normalized = canonicalizeAcceptanceMaterial(source[key]);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }

  return value;
}

export function getLoadAcceptanceMaterialSnapshot(load: any) {
  const source =
    typeof load?.toObject === "function"
      ? load.toObject({
          depopulate: true,
          getters: false,
          virtuals: false,
        })
      : load ?? {};

  return canonicalizeAcceptanceMaterial({
    postType: source.postType ?? null,
    pickupLocation: source.pickupLocation ?? null,
    deliveryLocation: source.deliveryLocation ?? null,
    vehicles: source.vehicles ?? [],
    trailerType: source.trailerType ?? null,
    dates: source.dates ?? null,
    pricing: source.pricing ?? null,
    additionalInfo: source.additionalInfo ?? null,
  });
}

export function getLoadAcceptanceMaterialVersion(load: any) {
  return createHash("sha256")
    .update(JSON.stringify(getLoadAcceptanceMaterialSnapshot(load)))
    .digest("hex");
}

function formatDate(value: any) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function locationSummary(value: any) {
  if (!value) return "Not set";
  const address = [value.address, value.city, value.state, value.zip]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const contact = [
    value.contactName ? `Contact: ${value.contactName}` : "",
    value.phone ? `Phone: ${value.phone}${value.phoneExt ? ` ext. ${value.phoneExt}` : ""}` : "",
    value.email ? `Email: ${value.email}` : "",
  ].filter(Boolean).join(" | ");
  const notes = value.notes ? `Notes: ${value.notes}` : "";
  return [address || value.name || "Not set", contact, notes].filter(Boolean).join(" | ");
}

function vehiclesSummary(value: any) {
  if (!Array.isArray(value) || value.length === 0) return "No vehicles";
  return value
    .map((vehicle: any, index: number) => {
      const description = [vehicle.year, vehicle.make, vehicle.model]
        .map((part) => String(part ?? "").trim())
        .filter(Boolean)
        .join(" ");
      const vin = String(vehicle.vin ?? "").trim();
      const condition = String(vehicle.condition ?? "").trim();
      return `${index + 1}. ${description || "Vehicle"}${vin ? ` · VIN ${vin}` : ""}${condition ? ` · ${condition}` : ""}`;
    })
    .join("; ");
}

function datesSummary(value: any) {
  if (!value) return "Not set";
  return [
    `First available: ${formatDate(value.firstAvailable)}`,
    `Pickup deadline: ${formatDate(value.pickupDeadline)}`,
    `Delivery deadline: ${formatDate(value.deliveryDeadline)}`,
    value.notes ? `Notes: ${value.notes}` : "",
  ].filter(Boolean).join(" | ");
}

function money(value: any) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : "Not set";
}

function pricingSummary(value: any) {
  if (!value) return "Not set";
  return [
    `Driver pay: ${money(value.carrierPayAmount)}`,
    Number.isFinite(Number(value.pricePerMile)) ? `Rate: $${Number(value.pricePerMile).toLocaleString("en-US")}/mi` : "",
    Number.isFinite(Number(value.miles)) ? `Miles: ${Number(value.miles).toLocaleString("en-US")}` : "",
    Number(value.copCodAmount) > 0 ? `COP/COD: ${money(value.copCodAmount)}` : "",
  ].filter(Boolean).join(" | ");
}

function additionalInfoSummary(value: any) {
  if (!value) return "None";
  return [
    value.instructions ? `Instructions: ${value.instructions}` : "",
    value.notes ? `Notes: ${value.notes}` : "",
    value.referenceNumber ? `Reference: ${value.referenceNumber}` : "",
    value.visibility ? `Visibility: ${value.visibility}` : "",
  ].filter(Boolean).join(" | ") || "None";
}

function summarize(field: LoadMaterialChange["field"], value: any) {
  switch (field) {
    case "pickupLocation":
    case "deliveryLocation":
      return locationSummary(value);
    case "vehicles":
      return vehiclesSummary(value);
    case "dates":
      return datesSummary(value);
    case "pricing":
      return pricingSummary(value);
    case "additionalInfo":
      return additionalInfoSummary(value);
    case "trailerType":
      return String(value ?? "Not set");
    case "postType":
      return String(value ?? "Not set");
  }
}

const MATERIAL_LABELS: Record<LoadMaterialChange["field"], string> = {
  postType: "Load Type",
  pickupLocation: "Pickup",
  deliveryLocation: "Delivery",
  vehicles: "Vehicles",
  trailerType: "Trailer Requirement",
  dates: "Schedule",
  pricing: "Compensation",
  additionalInfo: "Instructions / Load Details",
};

export function buildLoadMaterialChanges(beforeLoad: any, afterLoad: any) {
  const before = getLoadAcceptanceMaterialSnapshot(beforeLoad);
  const after = getLoadAcceptanceMaterialSnapshot(afterLoad);
  const fields = Object.keys(MATERIAL_LABELS) as LoadMaterialChange["field"][];

  return fields.flatMap((field) => {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) return [];
    return [{
      field,
      label: MATERIAL_LABELS[field],
      before: summarize(field, before[field]),
      after: summarize(field, after[field]),
    }];
  });
}