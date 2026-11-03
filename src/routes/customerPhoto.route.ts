import express from "express";
import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import storageService from "../services/storage.service";
import { customerPhotoKey } from "../services/customerPhoto";

const router = express.Router();

// GET /api/photos/:folder/:file
// Customer photos (garage cars, car listings, aftermarket products). Open
// without signing in, like profile pictures: an <img> can't send a sign-in,
// and these photos are already in the public bucket under random names.
router.get(
  "/:folder/:file",
  asyncHandler(async (req: Request, res: Response) => {
    const photo = customerPhotoKey(String(req.params.folder), String(req.params.file));
    const stored = photo ? await storageService.streamPublicFile(photo.key) : null;
    if (!photo || !stored) throw new ApiError(404, "We couldn't find this photo.");

    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.type(photo.contentType);
    stored.stream.on("error", () => res.destroy());
    stored.stream.pipe(res);
  }),
);

export default router;
