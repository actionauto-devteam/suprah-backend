import { Router } from 'express';
import * as ctrl from '../controllers/crm-biometric.controller';

/**
 * Biometric Authentication Routes
 *
 * Public (no auth required):
 *   POST /api/crm/biometric/auth/options     – Get WebAuthn authentication challenge
 *   POST /api/crm/biometric/auth/verify      – Verify biometric login → JWT
 *
 * Protected (JWT required):
 *   POST /api/crm/biometric/register/options  – Get WebAuthn registration challenge
 *   POST /api/crm/biometric/register/verify   – Complete biometric enrollment
 *   GET  /api/crm/biometric/credentials       – List user's biometric credentials
 *   PATCH /api/crm/biometric/credentials/:id  – Rename credential
 *   DELETE /api/crm/biometric/credentials/:id – Revoke credential
 *
 *   GET  /api/crm/ssh-keys                    – List user's SSH keys
 *   POST /api/crm/ssh-keys                    – Add SSH key
 *   DELETE /api/crm/ssh-keys/:keyId           – Revoke SSH key
 *   GET  /api/crm/ssh-keys/authorized-keys    – Download authorized_keys
 *
 *   GET  /api/crm/biometric/audit-log         – Admin audit trail
 *
 * Mount: app.use('/api/crm', biometricRoutes);
 * Auth middleware should populate req.crmUser on protected routes.
 */

export default function createBiometricRoutes(authMiddleware: any): Router {
  const router = Router();

  // ── Public: Biometric Login ────────────────────────────────────────────────
  router.post('/biometric/auth/options', ctrl.getAuthenticationOptions);
  router.post('/biometric/auth/verify', ctrl.verifyAuthentication);

  // ── Protected: Biometric Registration ──────────────────────────────────────
  router.post('/biometric/register/options', authMiddleware, ctrl.getRegistrationOptions);
  router.post('/biometric/register/verify', authMiddleware, ctrl.verifyRegistration);

  // ── Protected: Credential Management ───────────────────────────────────────
  router.get('/biometric/credentials', authMiddleware, ctrl.listCredentials);
  router.patch('/biometric/credentials/:credentialId', authMiddleware, ctrl.updateCredential);
  router.delete('/biometric/credentials/:credentialId', authMiddleware, ctrl.deleteCredential);

  // ── Protected: SSH Key Management ──────────────────────────────────────────
  router.get('/ssh-keys', authMiddleware, ctrl.listSshKeys);
  router.post('/ssh-keys', authMiddleware, ctrl.addSshKey);
  router.delete('/ssh-keys/:keyId', authMiddleware, ctrl.deleteSshKey);
  router.get('/ssh-keys/authorized-keys', authMiddleware, ctrl.getAuthorizedKeys);

  // ── Protected: Audit Log (admin/manager) ───────────────────────────────────
  router.get('/biometric/audit-log', authMiddleware, ctrl.getAuditLogs);

  return router;
}