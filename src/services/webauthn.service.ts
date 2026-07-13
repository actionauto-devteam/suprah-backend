import crypto from 'crypto';
import { Buffer } from 'buffer';
import WebAuthnCredential, { BiometricType } from '../models/WebAuthnCredential.model';
import BiometricAuditLog from '../models/BiometricAuditLog.model';
import type { ICrmUser } from '../models/CrmUser.model';



interface WebAuthnConfig {
  rpName: string;
  rpId: string;
  origin: string;
  challengeTTL: number;
  timeout: number;
}

const config: WebAuthnConfig = {
  rpName: process.env.WEBAUTHN_RP_NAME || 'Action Auto CRM',
  rpId: process.env.WEBAUTHN_RP_ID || 'localhost',
  origin: process.env.WEBAUTHN_ORIGIN || 'http://localhost:3000',
  challengeTTL: 5 * 60 * 1000,
  timeout: 120_000,
};


interface PendingChallenge {
  challenge: string;
  userId: string;
  type: 'registration' | 'authentication';
  expiresAt: number;
}

const challengeStore = new Map<string, PendingChallenge>();

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of challengeStore) {
      if (val.expiresAt < now) challengeStore.delete(key);
    }
  }, 60_000);
}


function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

function generateChallenge(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}


export async function generateRegistrationOptions(user: ICrmUser) {
  const challenge = generateChallenge();

  const existingCreds = await WebAuthnCredential.find({
    userId: user._id,
    isActive: true,
  }).select('credentialId transports');

  const excludeCredentials = existingCreds.map((cred) => ({
    id: cred.credentialId,
    type: 'public-key' as const,
    transports: cred.transports || [],
  }));

  const options = {
    challenge,
    rp: {
      name: config.rpName,
      id: config.rpId,
    },
    user: {
      id: base64UrlEncode(Buffer.from(user._id.toString())),
      name: user.username,
      displayName: user.fullName,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' as const },
      { alg: -257, type: 'public-key' as const },
      { alg: -8, type: 'public-key' as const },
    ],
    timeout: config.timeout,
    excludeCredentials,
    authenticatorSelection: {
      authenticatorAttachment: 'platform' as const,
      residentKey: 'preferred' as const,
      userVerification: 'required' as const,
    },
    attestation: 'direct' as const,
  };

  challengeStore.set(`reg:${user._id}`, {
    challenge,
    userId: user._id.toString(),
    type: 'registration',
    expiresAt: Date.now() + config.challengeTTL,
  });

  await BiometricAuditLog.create({
    userId: user._id,
    event: 'registration_started',
    success: true,
    metadata: { credentialCount: existingCreds.length },
  });

  return options;
}

export async function verifyRegistrationResponse(
  user: ICrmUser,
  credential: {
    id: string;
    rawId: string;
    type: string;
    response: {
      clientDataJSON: string;
      attestationObject: string;
    };
    authenticatorAttachment?: string;
  },
  deviceName: string,
  deviceType: BiometricType = 'platform',
  ipAddress?: string,
  userAgent?: string
) {
  const pending = challengeStore.get(`reg:${user._id}`);
  if (!pending || pending.expiresAt < Date.now()) {
    await BiometricAuditLog.create({
      userId: user._id,
      event: 'registration_failed',
      success: false,
      failureReason: 'Challenge expired or missing',
      ipAddress,
      userAgent,
    });
    throw new Error('Registration challenge expired. Please try again.');
  }
  challengeStore.delete(`reg:${user._id}`);

  const clientDataJSON = JSON.parse(
    base64UrlDecode(credential.response.clientDataJSON).toString('utf8')
  );

  if (clientDataJSON.type !== 'webauthn.create') {
    throw new Error('Invalid ceremony type');
  }
  if (clientDataJSON.challenge !== pending.challenge) {
    throw new Error('Challenge mismatch');
  }
  if (clientDataJSON.origin !== config.origin) {
    throw new Error(`Origin mismatch: expected ${config.origin}, got ${clientDataJSON.origin}`);
  }

  const attestationBuffer = base64UrlDecode(credential.response.attestationObject);

  const existing = await WebAuthnCredential.findOne({ credentialId: credential.id });
  if (existing) {
    throw new Error('This authenticator is already registered.');
  }

  const newCredential = await WebAuthnCredential.create({
    userId: user._id,
    credentialId: credential.id,
    publicKey: credential.response.attestationObject,
    counter: 0,
    deviceType,
    deviceName: deviceName || 'Biometric Device',
    transports: getTransportsFromAttachment(credential.authenticatorAttachment),
    backedUp: false,
    isActive: true,
  });

  await BiometricAuditLog.create({
    userId: user._id,
    event: 'registration_completed',
    credentialId: credential.id,
    success: true,
    ipAddress,
    userAgent,
    metadata: {
      deviceName,
      deviceType,
      authenticatorAttachment: credential.authenticatorAttachment,
    },
  });

  return {
    credentialId: newCredential.credentialId,
    deviceName: newCredential.deviceName,
    deviceType: newCredential.deviceType,
    createdAt: newCredential.createdAt,
  };
}


export async function generateAuthenticationOptions(username?: string, userId?: string) {
  const challenge = generateChallenge();

  let allowCredentials: Array<{ id: string; type: 'public-key'; transports: string[] }> = [];
  let resolvedUserId = userId;

  if (username) {
    const CrmUser = (await import('../models/CrmUser.model')).default;
    const user = await CrmUser.findOne({ username, isActive: true });
    if (user) {
      resolvedUserId = user._id.toString();
      const creds = await WebAuthnCredential.find({ userId: user._id, isActive: true });
      allowCredentials = creds.map((c) => ({
        id: c.credentialId,
        type: 'public-key' as const,
        transports: c.transports || [],
      }));
    }
  }

  const storeKey = resolvedUserId ? `auth:${resolvedUserId}` : `auth:anon:${challenge}`;

  const options = {
    challenge,
    timeout: config.timeout,
    rpId: config.rpId,
    allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
    userVerification: 'required' as const,
  };

  challengeStore.set(storeKey, {
    challenge,
    userId: resolvedUserId || '',
    type: 'authentication',
    expiresAt: Date.now() + config.challengeTTL,
  });

  await BiometricAuditLog.create({
    userId: resolvedUserId || undefined,
    event: 'challenge_issued',
    success: true,
    metadata: { credentialCount: allowCredentials.length },
  });

  return { options, storeKey };
}

export async function verifyAuthenticationResponse(
  storeKey: string,
  credential: {
    id: string;
    rawId: string;
    type: string;
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle?: string;
    };
  },
  ipAddress?: string,
  userAgent?: string
) {
  const pending = challengeStore.get(storeKey);
  if (!pending || pending.expiresAt < Date.now()) {
    await BiometricAuditLog.create({
      event: 'authentication_failed',
      success: false,
      failureReason: 'Challenge expired or missing',
      ipAddress,
      userAgent,
    });
    throw new Error('Authentication challenge expired. Please try again.');
  }
  challengeStore.delete(storeKey);

  const storedCred = await WebAuthnCredential.findOne({
    credentialId: credential.id,
    isActive: true,
  });

  if (!storedCred) {
    await BiometricAuditLog.create({
      event: 'authentication_failed',
      credentialId: credential.id,
      success: false,
      failureReason: 'Credential not found',
      ipAddress,
      userAgent,
    });
    throw new Error('Credential not recognized.');
  }

  const clientDataJSON = JSON.parse(
    base64UrlDecode(credential.response.clientDataJSON).toString('utf8')
  );

  if (clientDataJSON.type !== 'webauthn.get') {
    throw new Error('Invalid ceremony type');
  }
  if (clientDataJSON.challenge !== pending.challenge) {
    throw new Error('Challenge mismatch');
  }
  if (clientDataJSON.origin !== config.origin) {
    throw new Error('Origin mismatch');
  }

  const authData = base64UrlDecode(credential.response.authenticatorData);

  const dataView = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const newCounter = dataView.getUint32(33, false);

  if (newCounter <= storedCred.counter && storedCred.counter !== 0) {
    await BiometricAuditLog.create({
      userId: storedCred.userId,
      event: 'authentication_failed',
      credentialId: credential.id,
      success: false,
      failureReason: `Counter replay detected: ${newCounter} <= ${storedCred.counter}`,
      ipAddress,
      userAgent,
    });
    throw new Error('Authenticator counter replay detected. Possible cloned authenticator.');
  }


  storedCred.counter = newCounter;
  storedCred.lastUsedAt = new Date();
  await storedCred.save();

  const CrmUser = (await import('../models/CrmUser.model')).default;
  const user = await CrmUser.findById(storedCred.userId);

  if (!user || !user.isActive) {
    throw new Error('User account is deactivated.');
  }

  user.lastLoginAt = new Date();
  await user.save();

  await BiometricAuditLog.create({
    userId: user._id,
    event: 'authentication_success',
    credentialId: credential.id,
    success: true,
    ipAddress,
    userAgent,
    metadata: {
      deviceType: storedCred.deviceType,
      deviceName: storedCred.deviceName,
      counter: newCounter,
    },
  });

  return user;
}


export async function getUserCredentials(userId: string) {
  return WebAuthnCredential.find({ userId, isActive: true })
    .select('credentialId deviceType deviceName transports backedUp lastUsedAt createdAt')
    .sort({ createdAt: -1 });
}

export async function revokeCredential(userId: string, credentialId: string) {
  const cred = await WebAuthnCredential.findOne({ userId, credentialId, isActive: true });
  if (!cred) throw new Error('Credential not found.');

  cred.isActive = false;
  await cred.save();

  await BiometricAuditLog.create({
    userId,
    event: 'credential_revoked',
    credentialId,
    success: true,
  });

  return { message: 'Credential revoked successfully.' };
}

export async function renameCredential(userId: string, credentialId: string, newName: string) {
  const cred = await WebAuthnCredential.findOne({ userId, credentialId, isActive: true });
  if (!cred) throw new Error('Credential not found.');

  const oldName = cred.deviceName;
  cred.deviceName = newName;
  await cred.save();

  await BiometricAuditLog.create({
    userId,
    event: 'credential_renamed',
    credentialId,
    success: true,
    metadata: { oldName, newName },
  });

  return cred;
}


function getTransportsFromAttachment(attachment?: string): string[] {
  if (attachment === 'platform') return ['internal'];
  if (attachment === 'cross-platform') return ['usb', 'ble', 'nfc'];
  return [];
}

export { config as webAuthnConfig };