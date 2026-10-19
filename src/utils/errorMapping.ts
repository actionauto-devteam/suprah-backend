/**
 * Map expected database/validation failures to client errors so user mistakes
 * (malformed ids, invalid values, duplicates) never surface as HTTP 500 with a
 * raw Mongoose message.
 */
import { INVALID_LINK, describeValidationIssues, fieldLabelForPath } from "./userMessages";

/** "pickupLocation.zip" -> "pickup ZIP code"; "vehicles.0.year" -> "vehicle 1 year". */
function humanizeField(path: string) {
  const label = fieldLabelForPath(path.split(".").filter(Boolean));
  return label ? label[0].toLowerCase() + label.slice(1) : "a field";
}

/** What is wrong with one field, without repeating the value that was entered. */
function describeFieldProblem(entry: any): string {
  const path = String(entry?.path ?? "");
  const label = fieldLabelForPath(path.split(".").filter(Boolean)) || "A field";
  const lower = label[0].toLowerCase() + label.slice(1);
  const props = entry?.properties ?? {};
  switch (String(entry?.kind ?? "")) {
    case "required":
      return `${label} is missing.`;
    case "min":
      return `${label} must be at least ${props.min}.`;
    case "max":
      return `${label} can be at most ${props.max}.`;
    case "minlength":
      return `${label} must be at least ${props.minlength} characters.`;
    case "maxlength":
      return `${label} can be at most ${props.maxlength} characters.`;
    case "enum":
      return `Choose a valid ${lower}.`;
    case "regexp":
      return `${label} isn't in the right format.`;
    case "Number":
      return `${label} must be a number.`;
    case "Date":
      return `${label} must be a valid date.`;
    case "Boolean":
      return `${label} must be yes or no.`;
    default:
      return `${label} isn't valid.`;
  }
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

  // Upload limits (file too large, too many files) are the user's to fix, not
  // a server fault, so they must not read as "something went wrong on our side".
  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") {
      return {
        statusCode: 413,
        message:
          "This file is too large to upload. Choose a smaller file, or for a photo, take a new one with your camera, and try again.",
        errorType: "FILE_TOO_LARGE",
      };
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return {
        statusCode: 400,
        message: "Too many files were sent at once. Choose fewer files and try again.",
        errorType: "TOO_MANY_FILES",
      };
    }
    return {
      statusCode: 400,
      message:
        "This upload couldn't be read. Choose the file again and try once more. If it keeps happening, contact support.",
      errorType: "UPLOAD_INVALID",
    };
  }

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
    const entries = Object.values(err.errors as Record<string, any>);
    const fields = entries.map((entry) => ({
      field: String(entry?.path ?? ""),
      kind: String(entry?.kind ?? "invalid"),
    }));
    const problems = [...new Set(entries.slice(0, 6).map(describeFieldProblem))];
    return {
      statusCode: 400,
      message: `Please fix the following: ${problems.join(" ")}`,
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
