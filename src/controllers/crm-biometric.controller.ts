import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as webauthnService from '../services/webauthn.service';
import * as sshKeyService from '../services/sshKey.service';
import BiometricAuditLog from '../models/BiometricAuditLog.model';

const JWT_SECRET = process.env.JWT_SECRET || 'crm_jwt_secret_change_me';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '24h';

function getIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
}

function getUserAgent(req: Request): string {
  return (req.headers['user-agent'] as string) || '';
}

// ══════════════════════════════════════════════════════════════════════════════
//  WebAuthn – Registration
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/crm/biometric/register/options
 * Generate WebAuthn registration options for the authenticated user.
 */
export async function getRegistrationOptions(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const options = await webauthnService.generateRegistrationOptions(user);
    res.json({ success: true, data: options });
  } catch (err: any) {
    next(err);
  }
}

/**
 * POST /api/crm/biometric/register/verify
 * Verify the WebAuthn registration response and store the credential.
 * Body: { credential, deviceName, deviceType }
 */
export async function verifyRegistration(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const { credential, deviceName, deviceType } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, message: 'Missing credential data.' });
    }

    const result = await webauthnService.verifyRegistrationResponse(
      user,
      credential,
      deviceName || 'My Device',
      deviceType || 'platform',
      getIp(req),
      getUserAgent(req)
    );

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  WebAuthn – Authentication
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/crm/biometric/auth/options
 * Generate WebAuthn authentication options.
 * Body: { username? }  (optional – for discoverable credentials)
 */
export async function getAuthenticationOptions(req: Request, res: Response, next: NextFunction) {
  try {
    const { username } = req.body;
    const { options, storeKey } = await webauthnService.generateAuthenticationOptions(username);

    res.json({ success: true, data: { options, storeKey } });
  } catch (err: any) {
    next(err);
  }
}

/**
 * POST /api/crm/biometric/auth/verify
 * Verify the WebAuthn authentication response and issue a JWT.
 * Body: { credential, storeKey }
 */
export async function verifyAuthentication(req: Request, res: Response, next: NextFunction) {
  try {
    const { credential, storeKey } = req.body;

    if (!credential || !storeKey) {
      return res.status(400).json({ success: false, message: 'Missing credential or storeKey.' });
    }

    const user = await webauthnService.verifyAuthenticationResponse(
      storeKey,
      credential,
      getIp(req),
      getUserAgent(req)
    );

    // Issue JWT (same format as password login)
  const token = jwt.sign(
  { id: user._id, username: user.username, role: user.role },
  JWT_SECRET as string,
  { expiresIn: JWT_EXPIRES as any }
);

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user._id,
          fullName: user.fullName,
          username: user.username,
          email: user.email,
          role: user.role,
          avatar: user.avatar,
        },
        authMethod: 'biometric',
      },
    });
  } catch (err: any) {
    res.status(401).json({ success: false, message: err.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Credential Management
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/crm/biometric/credentials
 * List the authenticated user's active biometric credentials.
 */
export async function listCredentials(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const credentials = await webauthnService.getUserCredentials(user._id);
    res.json({ success: true, data: credentials });
  } catch (err: any) {
    next(err);
  }
}

/**
 * DELETE /api/crm/biometric/credentials/:credentialId
 * Revoke a biometric credential.
 */
export async function deleteCredential(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const { credentialId } = req.params;
    const result = await webauthnService.revokeCredential(user._id, credentialId);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

/**
 * PATCH /api/crm/biometric/credentials/:credentialId
 * Rename a biometric credential.
 * Body: { deviceName }
 */
export async function updateCredential(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const { credentialId } = req.params;
    const { deviceName } = req.body;

    if (!deviceName?.trim()) {
      return res.status(400).json({ success: false, message: 'Device name is required.' });
    }

    const cred = await webauthnService.renameCredential(user._id, credentialId, deviceName.trim());
    res.json({ success: true, data: cred });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SSH Key Management
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/crm/ssh-keys
 */
export async function listSshKeys(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const keys = await sshKeyService.getUserSshKeys(user._id);
    res.json({ success: true, data: keys });
  } catch (err: any) {
    next(err);
  }
}

/**
 * POST /api/crm/ssh-keys
 * Body: { title, publicKey, expiresAt?, allowedIPs? }
 */
export async function addSshKey(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const { title, publicKey, expiresAt, allowedIPs } = req.body;

    if (!publicKey?.trim()) {
      return res.status(400).json({ success: false, message: 'Public key is required.' });
    }

    const key = await sshKeyService.addSshKey(user._id, title || '', publicKey, {
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      allowedIPs,
      ipAddress: getIp(req),
      userAgent: getUserAgent(req),
    });

    res.status(201).json({ success: true, data: key });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

/**
 * DELETE /api/crm/ssh-keys/:keyId
 */
export async function deleteSshKey(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const result = await sshKeyService.revokeSshKey(user._id, req.params.keyId, undefined, getIp(req));
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/crm/ssh-keys/authorized-keys
 * Generate the authorized_keys content for the authenticated user.
 */
export async function getAuthorizedKeys(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    const content = await sshKeyService.generateAuthorizedKeys(user._id);
    res.type('text/plain').send(content);
  } catch (err: any) {
    next(err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Audit Logs
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/crm/biometric/audit-log
 * Admin/manager only: view biometric audit logs.
 */
export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as any).crmUser;
    if (!['admin', 'manager'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
    }

    const { userId, event, limit = 50, page = 1 } = req.query;
    const filter: any = {};
    if (userId) filter.userId = userId;
    if (event) filter.event = event;

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      BiometricAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('userId', 'fullName username'),
      BiometricAuditLog.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: { logs, total, page: Number(page), limit: Number(limit) },
    });
  } catch (err: any) {
    next(err);
  }
}