import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/crm-biometric.controller';

const router = Router();

// ── Public: Biometric Login ──────────────────────────────────────────────────
router.post('/auth/options', ctrl.getAuthenticationOptions);
router.post('/auth/verify', ctrl.verifyAuthentication);

// ── Public: SSH Key Login (challenge-sign) ───────────────────────────────────
router.post('/ssh/challenge', ctrl.getSshChallenge);
router.post('/ssh/verify', ctrl.verifySshLogin);

// ── Protected: Biometric Registration ────────────────────────────────────────
router.post('/register/options', crmAuth(), ctrl.getRegistrationOptions);
router.post('/register/verify', crmAuth(), ctrl.verifyRegistration);

// ── Protected: Credential Management ─────────────────────────────────────────
router.get('/credentials', crmAuth(), ctrl.listCredentials);
router.patch('/credentials/:credentialId', crmAuth(), ctrl.updateCredential);
router.delete('/credentials/:credentialId', crmAuth(), ctrl.deleteCredential);

// ── Protected: SSH Key Management ────────────────────────────────────────────
router.get('/ssh-keys', crmAuth(), ctrl.listSshKeys);
router.post('/ssh-keys', crmAuth(), ctrl.addSshKey);
router.delete('/ssh-keys/:keyId', crmAuth(), ctrl.deleteSshKey);
router.get('/ssh-keys/authorized-keys', crmAuth(), ctrl.getAuthorizedKeys);

// ── Protected: Audit Log (admin/manager) ─────────────────────────────────────
router.get('/audit-log', crmAuth(), ctrl.getAuditLogs);

export default router;