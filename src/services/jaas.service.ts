import jwt from 'jsonwebtoken';


const APP_ID = process.env.JAAS_APP_ID || '';
const KID = process.env.JAAS_KID || '';
const PRIVATE_KEY = (process.env.JAAS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

export const JAAS_DOMAIN = process.env.JITSI_DOMAIN || '8x8.vc';
export const jaasConfigured = (): boolean => Boolean(APP_ID && KID && PRIVATE_KEY);
export const getJaasAppId = (): string => APP_ID;

/** JaaS requires rooms to be tenant-prefixed: `{AppID}/{room}` */
export const jaasRoomName = (room: string): string => (APP_ID ? `${APP_ID}/${room}` : room);

export interface JaasUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  moderator: boolean;
}

/**
 * Generate a per-user JaaS JWT (RS256).
 * Per the 8x8 spec, the `moderator` flag and feature permissions are strings
 * ("true" / "false"), not booleans.
 */
export function generateJaasToken(opts: { user: JaasUser; room?: string; expSeconds?: number }): string {
  if (!jaasConfigured()) {
    throw new Error('JaaS is not configured (JAAS_APP_ID / JAAS_KID / JAAS_PRIVATE_KEY).');
  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    aud: 'jitsi',
    iss: 'chat',
    sub: APP_ID,
    // '*' is valid for any room under this AppID. Tighten to a literal room name
    // (without the tenant prefix) if you want one token per room.
    room: opts.room || '*',
    nbf: now - 10,
    exp: now + (opts.expSeconds ?? 60 * 60 * 3), // 3 hours
    context: {
      user: {
        id: opts.user.id,
        name: opts.user.name,
        email: opts.user.email || '',
        avatar: opts.user.avatar || '',
        moderator: opts.user.moderator ? 'true' : 'false',
      },
      features: {
        livestreaming: 'false',
        recording: 'false',
        transcription: 'false',
        'outbound-call': 'false',
      },
      room: { regex: false },
    },
  };

  return jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    header: { kid: KID, alg: 'RS256', typ: 'JWT' },
  });
}
