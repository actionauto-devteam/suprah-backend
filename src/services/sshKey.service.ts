import crypto from 'crypto';
import SshKey from '../models/SshKey.model';
import BiometricAuditLog from '../models/BiometricAuditLog.model';



const VALID_KEY_PREFIXES = [
  'ssh-rsa',
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
];

interface ParsedSshKey {
  keyType: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'ecdsa-sha2-nistp384';
  keyData: string;
  comment: string;
}

function parseSshPublicKey(publicKey: string): ParsedSshKey {
  const trimmed = publicKey.trim();
  const parts = trimmed.split(/\s+/);

  if (parts.length < 2) {
    throw new Error('Invalid SSH public key format. Expected: <key-type> <key-data> [comment]');
  }

  const keyType = parts[0] as ParsedSshKey['keyType'];
  if (!VALID_KEY_PREFIXES.includes(keyType)) {
    throw new Error(
      `Unsupported key type: ${keyType}. Supported: ${VALID_KEY_PREFIXES.join(', ')}`
    );
  }

  // Validate base64 key data
  const keyData = parts[1];
  try {
    const decoded = Buffer.from(keyData, 'base64');
    if (decoded.length < 16) throw new Error('Key data too short');
  } catch {
    throw new Error('Invalid base64 key data.');
  }

  // RSA key minimum size check
  if (keyType === 'ssh-rsa') {
    const decoded = Buffer.from(keyData, 'base64');
    if (decoded.length < 256) {
      throw new Error('RSA keys must be at least 2048 bits. Recommend 4096 bits.');
    }
  }

  return {
    keyType,
    keyData,
    comment: parts.slice(2).join(' ') || '',
  };
}

function computeFingerprint(keyData: string): string {
  const hash = crypto.createHash('sha256').update(Buffer.from(keyData, 'base64')).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a new SSH public key for a user.
 */
export async function addSshKey(
  userId: string,
  title: string,
  publicKey: string,
  options: {
    expiresAt?: Date;
    allowedIPs?: string[];
    ipAddress?: string;
    userAgent?: string;
  } = {}
) {
  // Validate
  const parsed = parseSshPublicKey(publicKey);
  const fingerprint = computeFingerprint(parsed.keyData);

  // Check for duplicate fingerprint
  const duplicate = await SshKey.findOne({ fingerprint, isActive: true });
  if (duplicate) {
    throw new Error(
      'This SSH key is already registered' +
      (duplicate.userId.toString() === userId ? ' on your account.' : ' by another user.')
    );
  }

  // Enforce per-user limit
  const userKeyCount = await SshKey.countDocuments({ userId, isActive: true });
  if (userKeyCount >= 10) {
    throw new Error('Maximum of 10 active SSH keys per user. Please revoke an existing key.');
  }

  const sshKey = await SshKey.create({
    userId,
    title: title.trim() || `${parsed.keyType} key`,
    publicKey: publicKey.trim(),
    fingerprint,
    keyType: parsed.keyType,
    expiresAt: options.expiresAt || null,
    allowedIPs: options.allowedIPs || [],
    isActive: true,
  });

  await BiometricAuditLog.create({
    userId,
    event: 'ssh_key_added',
    success: true,
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
    metadata: {
      keyType: parsed.keyType,
      fingerprint,
      title: sshKey.title,
    },
  });

  return {
    id: sshKey._id,
    title: sshKey.title,
    fingerprint: sshKey.fingerprint,
    keyType: sshKey.keyType,
    createdAt: sshKey.createdAt,
    expiresAt: sshKey.expiresAt,
  };
}

/**
 * List active SSH keys for a user.
 */
export async function getUserSshKeys(userId: string) {
  return SshKey.find({ userId, isActive: true })
    .select('title fingerprint keyType expiresAt lastUsedAt allowedIPs createdAt')
    .sort({ createdAt: -1 });
}

/**
 * Revoke an SSH key.
 */
export async function revokeSshKey(
  userId: string,
  keyId: string,
  revokedBy?: string,
  ipAddress?: string
) {
  const key = await SshKey.findOne({ _id: keyId, userId, isActive: true });
  if (!key) throw new Error('SSH key not found.');

  key.isActive = false;
  key.revokedAt = new Date();
  key.revokedBy = revokedBy ? (revokedBy as any) : userId as any;
  await key.save();

  await BiometricAuditLog.create({
    userId,
    event: 'ssh_key_revoked',
    success: true,
    ipAddress,
    metadata: {
      fingerprint: key.fingerprint,
      title: key.title,
      revokedBy: revokedBy || userId,
    },
  });

  return { message: 'SSH key revoked successfully.' };
}

/**
 * Generate an authorized_keys file content for a specific user.
 * Includes options like IP restrictions and key expiry enforcement.
 */
export async function generateAuthorizedKeys(userId: string): Promise<string> {
  const now = new Date();
  const keys = await SshKey.find({
    userId,
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  });

  const lines = keys.map((key) => {
    const options: string[] = [];

    // IP restriction
    if (key.allowedIPs && key.allowedIPs.length > 0) {
      options.push(`from="${key.allowedIPs.join(',')}"`);
    }

    // Restrict to non-dangerous commands
    options.push('no-port-forwarding');
    options.push('no-agent-forwarding');

    const optionStr = options.length > 0 ? options.join(',') + ' ' : '';
    return `${optionStr}${key.publicKey}`;
  });

  return lines.join('\n') + '\n';
}

/**
 * Validate an SSH key fingerprint against stored keys (for auth callback).
 */
export async function validateSshKeyByFingerprint(
  fingerprint: string,
  ipAddress?: string
) {
  const key = await SshKey.findOne({ fingerprint, isActive: true });
  if (!key) return null;

  // Check expiry
  if (key.expiresAt && key.expiresAt < new Date()) {
    key.isActive = false;
    await key.save();
    return null;
  }

  // Check IP allowlist
  if (key.allowedIPs && key.allowedIPs.length > 0 && ipAddress) {
    if (!key.allowedIPs.includes(ipAddress)) return null;
  }

  // Update last used
  key.lastUsedAt = new Date();
  await key.save();

  await BiometricAuditLog.create({
    userId: key.userId,
    event: 'ssh_key_used',
    success: true,
    ipAddress,
    metadata: { fingerprint, title: key.title },
  });

  return key;
}