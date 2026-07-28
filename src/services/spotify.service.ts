import crypto from 'crypto';
import CrmUser from '../models/CrmUser.model';

/**
 * Spotify OAuth + Web API helper.
 *
 * The OAuth `state` is HMAC-signed and carries the CRM user id, so the callback
 * (which is a top-level browser redirect and therefore has no Authorization
 * header) can trust who initiated the flow without its own auth middleware —
 * same signed-state pattern SuprahPay uses for PayPal/Wise linking.
 */

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI ||
  `${process.env.API_URL || 'http://localhost:5000'}/api/crm/spotify/callback`;
const STATE_SECRET =
  process.env.SPOTIFY_STATE_SECRET || process.env.CRM_JWT_SECRET || 'spotify-state-secret';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

const SCOPES = [
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-top-read',
  'user-read-recently-played',
  'user-library-read',
  'streaming', // required for the in-browser Web Playback SDK (Premium)
].join(' ');

const STATE_TTL_MS = 10 * 60 * 1000;

export const spotifyConfigured = Boolean(CLIENT_ID && CLIENT_SECRET);

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

// ── State signing ───────────────────────────────────────────────────────────
function signState(userId: string): string {
  const payload = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyState(state: string): string | null {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8');
    const [userId, ts, sig] = decoded.split('.');
    if (!userId || !ts || !sig) return null;
    const expected = crypto.createHmac('sha256', STATE_SECRET).update(`${userId}.${ts}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Date.now() - Number(ts) > STATE_TTL_MS) return null;
    return userId;
  } catch {
    return null;
  }
}

function getAuthorizeUrl(userId: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state: signState(userId),
    show_dialog: 'false',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ── Token exchange / refresh ────────────────────────────────────────────────
interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
}

async function exchangeCode(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<TokenResponse>;
}

async function refresh(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed: ${res.status}`);
  return res.json() as Promise<TokenResponse>;
}

/** Persist tokens + profile bits on the CRM user. */
async function persistConnection(
  userId: string,
  token: TokenResponse,
  profile?: { id?: string; display_name?: string; product?: string }
) {
  const expiresAt = Date.now() + token.expires_in * 1000;
  const update: Record<string, unknown> = {
    'spotify.connected': true,
    'spotify.accessToken': token.access_token,
    'spotify.expiresAt': expiresAt,
    'spotify.scope': token.scope,
    'spotify.connectedAt': new Date(),
  };
  if (token.refresh_token) update['spotify.refreshToken'] = token.refresh_token;
  if (profile?.id) update['spotify.spotifyUserId'] = profile.id;
  if (profile?.display_name) update['spotify.displayName'] = profile.display_name;
  if (profile?.product) update['spotify.product'] = profile.product;
  await CrmUser.updateOne({ _id: userId }, { $set: update });
}

/** Returns a valid access token, refreshing (and persisting) if it's near expiry. */
async function getValidAccessToken(userId: string): Promise<string> {
  const user = await CrmUser.findById(userId).select(
    '+spotify.accessToken +spotify.refreshToken +spotify.expiresAt spotify.connected'
  );
  const sp = (user as any)?.spotify;
  if (!sp?.connected || !sp?.refreshToken) throw new Error('SPOTIFY_NOT_CONNECTED');

  if (sp.accessToken && sp.expiresAt && sp.expiresAt - Date.now() > 60_000) {
    return sp.accessToken;
  }
  const refreshed = await refresh(sp.refreshToken);
  await persistConnection(userId, { ...refreshed, refresh_token: refreshed.refresh_token || sp.refreshToken });
  return refreshed.access_token;
}

/** Authorized Spotify Web API call with one automatic refresh-and-retry on 401. */
async function api(
  userId: string,
  path: string,
  init: RequestInit = {},
  _retried = false
): Promise<{ status: number; data: any }> {
  const token = await getValidAccessToken(userId);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (res.status === 401 && !_retried) {
    // Force a refresh by clearing expiry, then retry once.
    await CrmUser.updateOne({ _id: userId }, { $set: { 'spotify.expiresAt': 0 } });
    return api(userId, path, init, true);
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function fetchProfile(accessToken: string) {
  const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return undefined;
  return res.json();
}

export default {
  spotifyConfigured,
  getAuthorizeUrl,
  verifyState,
  exchangeCode,
  persistConnection,
  getValidAccessToken,
  fetchProfile,
  api,
};