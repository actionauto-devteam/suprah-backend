import express from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { emitToTrayClients } from '../utils/socketEmitter';

const router = express.Router();

/**
 * POST /api/internal/tray-update-available
 * Called by the tray-app's GitHub Actions release workflow right after a new
 * version is published. Pushes an instant "check for update now" signal to
 * every currently-connected tray-app instance instead of each one waiting for
 * its own next periodic poll — this is what makes the rollout near-real-time.
 * Authenticated with a shared secret (CI-only caller, no logged-in user).
 */
router.post('/tray-update-available', asyncHandler(async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.TRAY_UPDATE_BROADCAST_SECRET) {
    throw new ApiError(401, 'Unauthorized');
  }
  emitToTrayClients('tray:check-update', { at: new Date() });
  res.json(new ApiResponse(200, { broadcasted: true }, 'Tray clients notified'));
}));

export default router;
