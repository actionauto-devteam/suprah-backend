/**
 * Map expected database/validation failures to client errors so user mistakes
 * (malformed ids, invalid values, duplicates) never surface as HTTP 500 with a
 * raw Mongoose message.
 */
import { INVALID_LINK, describeValidationIssues } from "./userMessages";

const FIELD_WORDS: Record<string, string> = {
  zip: "ZIP code",
  vin: "VIN",
  pickupLocation: "pickup",
  deliveryLocation: "delivery",
  carrierPayAmount: "carrier pay",
  copCodAmount: "COP/COD amount",
  pricePerMile: "price per mile",
};

/** "pickupLocation.zip" -> "pickup ZIP code"; "vehicles.0.year" -> "year". */
function humanizeField(path: string) {
  const words = path
    .split(".")
    .filter((segment) => segment && !/^d+$/.test(segment))
    .map((segment) => FIELD_WORDS[segment] ?? segment.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase());
  return words.slice(-2).join(" ") || "a field";
}

export interface MappedError {
  statusCode: number;
  message: string;
  errorType?: string;
  errors?: unknown[];
}

function isMongooseValidationError(err: any) {
  return (
    err?.name === "ValidationError" &&
    err.errors &&
    typeof err.errors === "object" &&
    !Array.isArray(err.errors)
  );
}

export function mapKnownError(err: any): MappedError | null {
  if (!err || typeof err !== "object") return null;

  // Explicit ApiError / http-errors style status wins.
  if (Number.isInteger(err.statusCode) && err.statusCode >= 400) return null;

  if (err.name === "CastError") {
    const path = String(err.path ?? "");
    const isIdentifier = path === "_id" || /Id$/.test(path) || err.kind === "ObjectId";
    return {
      statusCode: 400,
      message: isIdentifier
        ? INVALID_LINK
        : `The value entered for ${humanizeField(path)} isn't valid. Check it and try again.`,
      errorType: isIdentifier ? "INVALID_ID" : "INVALID_VALUE",
    };
  }

  if (isMongooseValidationError(err)) {
    const fields = Object.values(err.errors as Record<string, any>).map((entry) => ({
      field: String(entry?.path ?? ""),
      kind: String(entry?.kind ?? "invalid"),
    }));
    return {
      statusCode: 400,
      message: `Some information is missing or not valid: ${[...new Set(fields.map((field) => humanizeField(field.field)))].join(", ")}. Check these fields and try again.`,
      errorType: "VALIDATION_ERROR",
      errors: fields,
    };
  }

  if (err.name === "ZodError" && Array.isArray(err.issues)) {
    return {
      statusCode: 400,
      message: err.issues.length ? describeValidationIssues(err.issues) : "Some of the information entered isn't valid. Check the form and try again.",
      errorType: "VALIDATION_ERROR",
    };
  }

  if (Number(err.code) === 11000) {
    return {
      statusCode: 409,
      message: "This record conflicts with an existing one. Refresh and try again.",
      errorType: "DUPLICATE_KEY",
      errors: [{ fields: Object.keys(err.keyPattern ?? err.keyValue ?? {}) }],
    };
  }

  return null;
}
