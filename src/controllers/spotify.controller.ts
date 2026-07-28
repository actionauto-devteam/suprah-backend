import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import CrmUser from '../models/CrmUser.model';
import spotifyService from '../services/spotify.service';

const FRONTEND_URL = process.env.FRONTEND_URL || process.env.CLIENT_URL || 'http://localhost:3000';

/** GET /api/crm/spotify/auth-url  (crmAuth) — returns the Spotify authorize URL. */
const getAuthUrl = asyncHandler(async (req: Request, res: Response) => {
  const user = req.crmUser!;
  if (!spotifyService.spotifyConfigured) throw new ApiError(503, 'Spotify integration is not configured.');
  const url = spotifyService.getAuthorizeUrl(user._id.toString());
  res.json(new ApiResponse(200, { url }, 'Authorize URL generated'));
});

/**
 * GET /api/crm/spotify/callback  (PUBLIC — trust comes from the signed state).
 * Exchanges the code, stores tokens, then bounces back to the dashboard.
 */
const callback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) return res.redirect(`${FRONTEND_URL}/?spotify=denied`);
  if (!code || !state) return res.redirect(`${FRONTEND_URL}/?spotify=error`);

  const userId = spotifyService.verifyState(state);
  if (!userId) return res.redirect(`${FRONTEND_URL}/?spotify=badstate`);

  try {
    const token = await spotifyService.exchangeCode(code);
    const profile = await spotifyService.fetchProfile(token.access_token);
    await spotifyService.persistConnection(userId, token, profile as any);
    return res.redirect(`${FRONTEND_URL}/?spotify=connected`);
  } catch (e) {
    console.error('[SPOTIFY] callback failed:', e);
    return res.redirect(`${FRONTEND_URL}/?spotify=error`);
  }
});

/** GET /api/crm/spotify/status */
const status = asyncHandler(async (req: Request, res: Response) => {
  const user = await CrmUser.findById(req.crmUser!._id).select('spotify.connected spotify.displayName spotify.product');
  const sp = (user as any)?.spotify;
  res.json(
    new ApiResponse(200, {
      connected: Boolean(sp?.connected),
      displayName: sp?.displayName,
      product: sp?.product, // "premium" gates the in-app player
    }, 'Spotify status')
  );
});

/** POST /api/crm/spotify/disconnect */
const disconnect = asyncHandler(async (req: Request, res: Response) => {
  await CrmUser.updateOne(
    { _id: req.crmUser!._id },
    {
      $set: {
        'spotify.connected': false,
        'spotify.accessToken': undefined,
        'spotify.refreshToken': undefined,
        'spotify.expiresAt': undefined,
      },
    }
  );
  res.json(new ApiResponse(200, null, 'Spotify disconnected'));
});

/** GET /api/crm/spotify/token — short-lived access token for the Web Playback SDK. */
const getToken = asyncHandler(async (req: Request, res: Response) => {
  try {
    const accessToken = await spotifyService.getValidAccessToken(req.crmUser!._id.toString());
    res.json(new ApiResponse(200, { accessToken }, 'Token'));
  } catch (e: any) {
    if (e?.message === 'SPOTIFY_NOT_CONNECTED') throw new ApiError(400, 'Spotify is not connected.');
    throw e;
  }
});

// ── Read-through proxies ─────────────────────────────────────────────────────

function proxy(path: (req: Request) => string, method: string = 'GET') {
  return asyncHandler(async (req: Request, res: Response) => {
    try {
      const { status: s, data } = await spotifyService.api(req.crmUser!._id.toString(), path(req), { method });
      res.status(s === 204 ? 200 : s).json(new ApiResponse(s === 204 ? 200 : s, data, 'ok'));
    } catch (e: any) {
      if (e?.message === 'SPOTIFY_NOT_CONNECTED') throw new ApiError(400, 'Spotify is not connected.');
      throw e;
    }
  });
}

const me = proxy(() => '/me');
const playlists = proxy((req) => `/me/playlists?limit=${Number(req.query.limit) || 30}`);
const recentlyPlayed = proxy((req) => `/me/player/recently-played?limit=${Number(req.query.limit) || 25}`);
const topTracks = proxy((req) => `/me/top/tracks?limit=${Number(req.query.limit) || 25}&time_range=${req.query.range || 'short_term'}`);
const savedTracks = proxy((req) => `/me/tracks?limit=${Number(req.query.limit) || 25}`);
const player = proxy(() => '/me/player');
const devices = proxy(() => '/me/player/devices');

// ── Playback controls ───────────────────────────────────────────────────────

const controlPlay = asyncHandler(async (req: Request, res: Response) => {
  const { device_id, context_uri, uris, position_ms } = req.body || {};
  const body: Record<string, unknown> = {};
  if (context_uri) body.context_uri = context_uri;
  if (uris) body.uris = uris;
  if (typeof position_ms === 'number') body.position_ms = position_ms;
  const q = device_id ? `?device_id=${device_id}` : '';
  const { status: s, data } = await spotifyService.api(
    req.crmUser!._id.toString(),
    `/me/player/play${q}`,
    { method: 'PUT', body: Object.keys(body).length ? JSON.stringify(body) : undefined }
  );
  res.status(s === 204 ? 200 : s).json(new ApiResponse(s === 204 ? 200 : s, data, 'Playing'));
});

const controlPause = proxy(() => '/me/player/pause', 'PUT');
const controlNext = proxy(() => '/me/player/next', 'POST');
const controlPrevious = proxy(() => '/me/player/previous', 'POST');
const controlSeek = proxy((req) => `/me/player/seek?position_ms=${Number(req.query.position_ms) || 0}`, 'PUT');
const controlVolume = proxy((req) => `/me/player/volume?volume_percent=${Number(req.query.percent) || 50}`, 'PUT');
const controlShuffle = proxy((req) => `/me/player/shuffle?state=${req.query.state === 'true'}`, 'PUT');
const controlRepeat = proxy((req) => `/me/player/repeat?state=${req.query.state || 'off'}`, 'PUT');

const transfer = asyncHandler(async (req: Request, res: Response) => {
  const { device_id, play } = req.body || {};
  if (!device_id) throw new ApiError(400, 'device_id is required');
  const { status: s, data } = await spotifyService.api(
    req.crmUser!._id.toString(),
    '/me/player',
    { method: 'PUT', body: JSON.stringify({ device_ids: [device_id], play: Boolean(play) }) }
  );
  res.status(s === 204 ? 200 : s).json(new ApiResponse(s === 204 ? 200 : s, data, 'Transferred'));
});

export default {
  getAuthUrl,
  callback,
  status,
  disconnect,
  getToken,
  me,
  playlists,
  recentlyPlayed,
  topTracks,
  savedTracks,
  player,
  devices,
  controlPlay,
  controlPause,
  controlNext,
  controlPrevious,
  controlSeek,
  controlVolume,
  controlShuffle,
  controlRepeat,
  transfer,
};