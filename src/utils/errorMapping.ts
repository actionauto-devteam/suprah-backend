/**
 * Map expected database/validation failures to client errors so user mistakes
 * (malformed ids, invalid values, duplicates) never surface as HTTP 500 with a
 * raw Mongoose message.
 */
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
      message: isIdentifier ? "Invalid identifier" : `Invalid value for ${path || "field"}`,
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
      message: `Validation failed: ${fields.map((field) => field.field).filter(Boolean).join(", ") || "invalid input"}`,
      errorType: "VALIDATION_ERROR",
      errors: fields,
    };
  }

  if (err.name === "ZodError" && Array.isArray(err.issues)) {
    return {
      statusCode: 400,
      message: err.issues.map((issue: any) => issue?.message).filter(Boolean).join(", ") || "Invalid input",
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
