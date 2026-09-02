import type { RequestHandler } from "express";
import multer from "multer";
import path from "path";
import { TextDecoder } from "util";
import { ApiError } from "../utils/ApiError";

const DISPATCH_CHAT_MAX_FILES = 5;
const DISPATCH_CHAT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_ZIP_COMPRESSION_RATIO = 100;

const OCTET_STREAM = "application/octet-stream";

const startsWithBytes = (buffer: Buffer, bytes: number[]) =>
  buffer.length >= bytes.length &&
  bytes.every((byte, index) => buffer[index] === byte);

const isJpeg = (buffer: Buffer) =>
  startsWithBytes(buffer, [0xff, 0xd8, 0xff]);

const isPng = (buffer: Buffer) =>
  startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isGif = (buffer: Buffer) => {
  const header = buffer.subarray(0, 6).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
};

const isWebp = (buffer: Buffer) =>
  buffer.length >= 12 &&
  buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
  buffer.subarray(8, 12).toString("ascii") === "WEBP";

const isPdf = (buffer: Buffer) =>
  buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";

const isIsoBmff = (buffer: Buffer) =>
  buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";

const isQuickTime = (buffer: Buffer) =>
  isIsoBmff(buffer) &&
  [
    buffer.subarray(8, 12).toString("ascii"),
    buffer.length >= 20 ? buffer.subarray(16, 20).toString("ascii") : "",
  ].includes("qt  ");

const isMp4 = (buffer: Buffer) => {
  if (!isIsoBmff(buffer)) return false;
  const brands = [
    buffer.subarray(8, 12).toString("ascii"),
    ...(buffer.length >= 24
      ? Array.from({ length: Math.min(8, Math.floor((Math.min(buffer.length, 48) - 16) / 4)) }, (_, index) =>
          buffer.subarray(16 + index * 4, 20 + index * 4).toString("ascii"),
        )
      : []),
  ];
  return brands.some((brand) =>
    /^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/i.test(brand),
  );
};

const isWebm = (buffer: Buffer) =>
  startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3]);

function isSafeUtf8Text(buffer: Buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  if (buffer.includes(0x00)) return false;

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    // Reject binary-looking control characters while preserving tabs/newlines.
    for (let index = 0; index < decoded.length; index += 1) {
      const code = decoded.charCodeAt(index);
      if (
        code < 0x20 &&
        code !== 0x09 &&
        code !== 0x0a &&
        code !== 0x0c &&
        code !== 0x0d
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

type ZipInspection = {
  names: string[];
  encrypted: boolean;
  totalCompressed: number;
  totalUncompressed: number;
};

function findZipEndOfCentralDirectory(buffer: Buffer) {
  // EOCD is 22 bytes plus a maximum 65,535-byte comment.
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function inspectZip(buffer: Buffer): ZipInspection | null {
  if (
    buffer.length < 22 ||
    !(
      startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08])
    )
  ) {
    return null;
  }

  const eocd = findZipEndOfCentralDirectory(buffer);
  if (eocd < 0 || eocd + 22 > buffer.length) return null;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocd + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);

  // This attachment flow intentionally does not accept ZIP64 containers.
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    return null;
  }
  if (entryCount <= 0 || entryCount > MAX_ZIP_ENTRIES) return null;
  if (
    centralDirectoryOffset < 0 ||
    centralDirectorySize < 0 ||
    centralDirectoryOffset + centralDirectorySize > buffer.length
  ) {
    return null;
  }

  const names: string[] = [];
  let encrypted = false;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;

    const flags = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return null;
    }

    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > buffer.length) return null;

    const name = buffer.subarray(fileNameStart, fileNameEnd).toString("utf8");
    const normalizedName = name.replace(/\\/g, "/");

    // Reject archive paths that could write outside an extraction directory.
    if (
      normalizedName.startsWith("/") ||
      /^[a-zA-Z]:\//.test(normalizedName) ||
      normalizedName.split("/").some((segment) => segment === "..")
    ) {
      return null;
    }

    names.push(normalizedName);
    encrypted ||= Boolean(flags & 0x0001);
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;

    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) return null;

    offset = fileNameEnd + extraLength + commentLength;
    if (offset > buffer.length) return null;
  }

  if (encrypted) return null;
  if (
    totalUncompressed > 10 * 1024 * 1024 &&
    totalCompressed > 0 &&
    totalUncompressed / totalCompressed > MAX_ZIP_COMPRESSION_RATIO
  ) {
    return null;
  }

  return {
    names,
    encrypted,
    totalCompressed,
    totalUncompressed,
  };
}

const BLOCKED_ARCHIVE_MEMBER_EXTENSION =
  /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|js|mjs|cjs|sh|php|jar|app|dmg)$/i;

function isSafeGenericZip(buffer: Buffer) {
  const zip = inspectZip(buffer);
  if (!zip) return false;
  return !zip.names.some((name) =>
    BLOCKED_ARCHIVE_MEMBER_EXTENSION.test(name),
  );
}

function isOpenXmlPackage(
  buffer: Buffer,
  family: "word" | "xl" | "ppt",
) {
  const zip = inspectZip(buffer);
  if (!zip) return false;

  const names = new Set(zip.names);
  if (!names.has("[Content_Types].xml")) return false;
  if (![...names].some((name) => name.startsWith(`${family}/`))) return false;

  // Macro-enabled and embedded executable/object content is deliberately not
  // accepted under the safer .docx/.xlsx/.pptx allowlist.
  const unsafeOfficeMember = [...names].some((name) => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith("vbaproject.bin") ||
      lower.includes("/activex/") ||
      lower.includes("/embeddings/")
    );
  });

  return !unsafeOfficeMember;
}

type AttachmentSpec = {
  canonicalMime: string;
  claimedMimes: ReadonlySet<string>;
  validate: (buffer: Buffer) => boolean;
};

const attachmentSpec = (
  canonicalMime: string,
  claimedMimes: string[],
  validate: (buffer: Buffer) => boolean,
): AttachmentSpec => ({
  canonicalMime,
  claimedMimes: new Set(
    [canonicalMime, OCTET_STREAM, ...claimedMimes].map((value) =>
      value.toLowerCase(),
    ),
  ),
  validate,
});

const ALLOWED_ATTACHMENTS: Record<string, AttachmentSpec> = {
  ".jpg": attachmentSpec("image/jpeg", [], isJpeg),
  ".jpeg": attachmentSpec("image/jpeg", [], isJpeg),
  ".png": attachmentSpec("image/png", [], isPng),
  ".gif": attachmentSpec("image/gif", [], isGif),
  ".webp": attachmentSpec("image/webp", [], isWebp),
  ".pdf": attachmentSpec("application/pdf", [], isPdf),
  ".txt": attachmentSpec("text/plain", ["text/x-log"], isSafeUtf8Text),
  ".csv": attachmentSpec(
    "text/csv",
    ["text/plain", "application/vnd.ms-excel"],
    isSafeUtf8Text,
  ),
  ".docx": attachmentSpec(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ["application/zip"],
    (buffer) => isOpenXmlPackage(buffer, "word"),
  ),
  ".xlsx": attachmentSpec(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ["application/zip"],
    (buffer) => isOpenXmlPackage(buffer, "xl"),
  ),
  ".pptx": attachmentSpec(
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ["application/zip"],
    (buffer) => isOpenXmlPackage(buffer, "ppt"),
  ),
  ".zip": attachmentSpec(
    "application/zip",
    ["application/x-zip-compressed"],
    isSafeGenericZip,
  ),
  ".mp4": attachmentSpec("video/mp4", [], isMp4),
  ".mov": attachmentSpec("video/quicktime", [], isQuickTime),
  ".webm": attachmentSpec("video/webm", [], isWebm),
};

function getAttachmentSpec(file: Express.Multer.File) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const spec = ALLOWED_ATTACHMENTS[extension];
  if (!spec) {
    throw new ApiError(
      400,
      `${file.originalname || "This file"} is not a supported Dispatch Chat attachment. Allowed: JPG, PNG, GIF, WebP, PDF, TXT, CSV, DOCX, XLSX, PPTX, ZIP, MP4, MOV, and WebM.`,
    );
  }

  const claimedMime = String(file.mimetype || OCTET_STREAM).toLowerCase();
  if (!spec.claimedMimes.has(claimedMime)) {
    throw new ApiError(
      400,
      `${file.originalname || "This file"} does not match an allowed Dispatch Chat file type.`,
    );
  }

  return spec;
}

const dispatchChatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: DISPATCH_CHAT_MAX_FILES,
    fileSize: DISPATCH_CHAT_MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    try {
      getAttachmentSpec(file);
      callback(null, true);
    } catch (error) {
      callback(error as Error);
    }
  },
});

export const uploadDispatchChatFiles: RequestHandler = (req, res, next) => {
  dispatchChatUpload.array("files", DISPATCH_CHAT_MAX_FILES)(
    req,
    res,
    (error: any) => {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return next(
            new ApiError(
              400,
              "Each Dispatch Chat attachment must be 25 MB or smaller",
            ),
          );
        }
        if (error.code === "LIMIT_FILE_COUNT") {
          return next(
            new ApiError(
              400,
              `You can attach up to ${DISPATCH_CHAT_MAX_FILES} files at once`,
            ),
          );
        }
        return next(new ApiError(400, error.message));
      }

      if (error) {
        return next(
          error instanceof ApiError
            ? error
            : new ApiError(
                400,
                error.message || "Failed to process Dispatch Chat attachment",
              ),
        );
      }

      const files = (req.files || []) as Express.Multer.File[];
      try {
        for (const file of files) {
          const spec = getAttachmentSpec(file);
          if (!Buffer.isBuffer(file.buffer) || !spec.validate(file.buffer)) {
            throw new ApiError(
              400,
              `The contents of ${file.originalname || "the uploaded file"} do not match the allowed file type.`,
            );
          }

          // Downstream storage/message metadata now records the validated type,
          // not a browser-controlled Content-Type claim.
          file.mimetype = spec.canonicalMime;
        }
      } catch (validationError) {
        return next(validationError);
      }

      return next();
    },
  );
};