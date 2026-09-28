import logger from './logger';

const INSECURE_DEFAULT = 'crm-secret-key';
let warned = false;

/**
 * Secret used to sign and verify CRM tokens. Falls back to a built-in default
 * only when neither CRM_JWT_SECRET nor JWT_SECRET is set. That default is
 * public (it is in the source code), so anyone could forge CRM sign-ins:
 * the fallback is logged loudly so a missing setting is noticed.
 */
export function resolveCrmJwtSecret(preferred?: string | null): string {
  const secret = preferred || process.env.CRM_JWT_SECRET || process.env.JWT_SECRET;
  if (secret) return secret;
  if (!warned) {
    warned = true;
    logger.error(
      'SECURITY: neither CRM_JWT_SECRET nor JWT_SECRET is set, so CRM tokens use the built-in default secret. Set CRM_JWT_SECRET in this environment.',
    );
  }
  return INSECURE_DEFAULT;
}
