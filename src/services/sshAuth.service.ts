import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import SshKey from '../models/SshKey.model';
import CrmUser from '../models/CrmUser.model';
import BiometricAuditLog from '../models/BiometricAuditLog.model';
import { generateCrmToken } from '../middleware/crmAuth.middleware';

/**
 * SSH Challenge-Sign Authentication
 *
 * Flow:
 *  1. Client sends username → server generates random challenge + storeKey
 *  2. User signs the challenge locally: echo "CHALLENGE" | ssh-keygen -Y sign -f KEY -n crm-login
 *  3. Client sends { username, storeKey, signature } → server verifies using ssh-keygen -Y verify
 *  4. On success → issue CRM JWT
 *
 * Requires: openssh-client (ssh-keygen) on the server.
 */

// ── In-memory challenge store ────────────────────────────────────────────────

interface SshChallenge {
  challenge: string;
  userId: string;
  expiresAt: number;
}

const sshChallengeStore = new Map<string, SshChallenge>();

// Cleanup every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sshChallengeStore) {
    if (val.expiresAt < now) sshChallengeStore.delete(key);
  }
}, 60_000);

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an SSH challenge for a given username.
 */
export async function generateSshChallenge(username: string) {
  const user = await CrmUser.findOne({ username: username.trim(), isActive: true });
  if (!user) {
    throw new Error('Employee ID not found or account is inactive.');
  }

  // Check user has at least one active SSH key
  const keyCount = await SshKey.countDocuments({ userId: user._id, isActive: true });
  if (keyCount === 0) {
    throw new Error('No SSH keys registered for this account. Add one in Biometric Security settings.');
  }

  const challenge = crypto.randomBytes(32).toString('hex');
  const storeKey = `ssh:${user._id}:${crypto.randomBytes(8).toString('hex')}`;

  sshChallengeStore.set(storeKey, {
    challenge,
    userId: user._id.toString(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
  });

  await BiometricAuditLog.create({
    userId: user._id,
    event: 'challenge_issued',
    success: true,
    metadata: { method: 'ssh', keyCount },
  });

  return { challenge, storeKey };
}

/**
 * Verify an SSH signature against the user's registered public keys.
 */
export async function verifySshSignature(
  username: string,
  storeKey: string,
  signature: string,
  ipAddress?: string,
  userAgent?: string
) {
  // 1. Validate challenge
  const pending = sshChallengeStore.get(storeKey);
  if (!pending || pending.expiresAt < Date.now()) {
    throw new Error('SSH challenge expired. Please request a new one.');
  }
  sshChallengeStore.delete(storeKey);

  // 2. Find user
  const user = await CrmUser.findOne({ username: username.trim(), isActive: true });
  if (!user || user._id.toString() !== pending.userId) {
    throw new Error('Employee ID mismatch.');
  }

  // 3. Get all active SSH keys for user
  const keys = await SshKey.find({ userId: user._id, isActive: true });
  if (keys.length === 0) {
    throw new Error('No SSH keys registered.');
  }

  // 4. Try to verify signature against each registered key
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ssh-'));
  let verified = false;
  let matchedKey: typeof keys[0] | null = null;

  try {
    // Write signature to temp file
    const sigFile = path.join(tmpDir, 'signature');
    fs.writeFileSync(sigFile, signature.trim() + '\n');

    // Write challenge data to temp file
    const dataFile = path.join(tmpDir, 'challenge');
    fs.writeFileSync(dataFile, pending.challenge);

    // Build allowed signers file: one line per registered key
    //   Format: <email/identifier> <key-type> <base64-key>
    const allowedSignersLines = keys.map((k) => {
      // Extract key-type and base64 from stored publicKey
      const parts = k.publicKey.trim().split(/\s+/);
      return `${user.email} ${parts[0]} ${parts[1]}`;
    });
    const allowedSignersFile = path.join(tmpDir, 'allowed_signers');
    fs.writeFileSync(allowedSignersFile, allowedSignersLines.join('\n') + '\n');

    // Verify using ssh-keygen
    try {
      execSync(
        `ssh-keygen -Y verify -f "${allowedSignersFile}" -I "${user.email}" -n crm-login -s "${sigFile}" < "${dataFile}"`,
        { stdio: 'pipe', timeout: 5000 }
      );
      verified = true;

      // Determine which key matched (best effort)
      matchedKey = keys[0]; // ssh-keygen -Y verify doesn't tell us which key matched
    } catch {
      verified = false;
    }
  } finally {
    // Cleanup temp files
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  if (!verified) {
    await BiometricAuditLog.create({
      userId: user._id,
      event: 'authentication_failed',
      success: false,
      failureReason: 'SSH signature verification failed',
      ipAddress,
      userAgent,
      metadata: { method: 'ssh' },
    });
    throw new Error('SSH signature verification failed. Make sure you signed the correct challenge with a registered key.');
  }

  // 5. Update last used
  if (matchedKey) {
    matchedKey.lastUsedAt = new Date();
    await matchedKey.save();
  }

  // 6. Update user last login
  user.lastLoginAt = new Date();
  await user.save({ validateModifiedOnly: true });

  await BiometricAuditLog.create({
    userId: user._id,
    event: 'authentication_success',
    success: true,
    ipAddress,
    userAgent,
    metadata: {
      method: 'ssh',
      keyFingerprint: matchedKey?.fingerprint,
    },
  });

  // 7. Issue token
  const token = generateCrmToken(user._id.toString());

  return {
    token,
    user: {
      _id: user._id,
      fullName: user.fullName,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar: user.avatar,
    },
    authMethod: 'ssh',
  };
}