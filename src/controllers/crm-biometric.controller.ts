import { Request, Response, NextFunction } from 'express';
import { generateCrmToken } from '../middleware/crmAuth.middleware';
import * as webauthnService from '../services/webauthn.service';
import * as sshKeyService from '../services/sshKey.service';
import * as sshAuthService from '../services/sshAuth.service';
import BiometricAuditLog from '../models/BiometricAuditLog.model';
import CrmUser from '../models/CrmUser.model';

function getIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
}

function getUserAgent(req: Request): string {
  return (req.headers['user-agent'] as string) || '';
}


export async function getRegistrationOptions(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const options = await webauthnService.generateRegistrationOptions(user);
    res.json({ success: true, data: options });
  } catch (err: any) {
    next(err);
  }
}

export async function verifyRegistration(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

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


export async function getAuthenticationOptions(req: Request, res: Response, next: NextFunction) {
  try {
    const { username } = req.body;
    const { options, storeKey } = await webauthnService.generateAuthenticationOptions(username);

    res.json({ success: true, data: { options, storeKey } });
  } catch (err: any) {
    next(err);
  }
}

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

    const token = generateCrmToken(user._id.toString());

    res.json({
      success: true,
      data: {
        token,
        user: {
          _id: user._id,
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


export async function getSshChallenge(req: Request, res: Response, next: NextFunction) {
  try {
    const { username } = req.body;

    if (!username?.trim()) {
      return res.status(400).json({ success: false, message: 'Employee ID is required.' });
    }

    const data = await sshAuthService.generateSshChallenge(username);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

export async function verifySshLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { username, storeKey, signature } = req.body;

    if (!username?.trim() || !storeKey || !signature?.trim()) {
      return res.status(400).json({ success: false, message: 'Username, storeKey, and signature are required.' });
    }

    const data = await sshAuthService.verifySshSignature(
      username,
      storeKey,
      signature,
      getIp(req),
      getUserAgent(req)
    );

    res.json({ success: true, data });
  } catch (err: any) {
    res.status(401).json({ success: false, message: err.message });
  }
}


export async function listCredentials(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const credentials = await webauthnService.getUserCredentials(user._id.toString());
    res.json({ success: true, data: credentials });
  } catch (err: any) {
    next(err);
  }
}

export async function deleteCredential(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const { credentialId } = req.params;
    const result = await webauthnService.revokeCredential(user._id.toString(), credentialId);
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

export async function updateCredential(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const { credentialId } = req.params;
    const { deviceName } = req.body;

    if (!deviceName?.trim()) {
      return res.status(400).json({ success: false, message: 'Device name is required.' });
    }

    const cred = await webauthnService.renameCredential(user._id.toString(), credentialId, deviceName.trim());
    res.json({ success: true, data: cred });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}


export async function listSshKeys(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const keys = await sshKeyService.getUserSshKeys(user._id.toString());
    res.json({ success: true, data: keys });
  } catch (err: any) {
    next(err);
  }
}

export async function addSshKey(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const { title, publicKey, expiresAt, allowedIPs } = req.body;

    if (!publicKey?.trim()) {
      return res.status(400).json({ success: false, message: 'Public key is required.' });
    }

    const key = await sshKeyService.addSshKey(user._id.toString(), title || '', publicKey, {
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

export async function deleteSshKey(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const result = await sshKeyService.revokeSshKey(user._id.toString(), req.params.keyId, undefined, getIp(req));
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err.message });
  }
}

export async function getAuthorizedKeys(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const content = await sshKeyService.generateAuthorizedKeys(user._id.toString());
    res.type('text/plain').send(content);
  } catch (err: any) {
    next(err);
  }
}


export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.crmUser;
    if (!user) return res.status(401).json({ success: false, message: 'Not authenticated.' });

    if (!['admin', 'manager'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions.' });
    }

    const { userId, event, limit = 50, page = 1 } = req.query;

    const orgUsers = await CrmUser.find({ organizationId: user.organizationId }).select('_id').lean();
    const orgUserIds = orgUsers.map((u) => u._id.toString());

    if (userId && !orgUserIds.includes(String(userId))) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const filter: any = { userId: userId ? String(userId) : { $in: orgUserIds } };
    if (event && typeof event === 'string') filter.event = event;

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