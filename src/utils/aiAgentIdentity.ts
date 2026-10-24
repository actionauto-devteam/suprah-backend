import Organization from '../models/Organization.model';
import logger from './logger';

export const AI_AGENT_FALLBACK_LABEL = 'AI Agent';
export const AI_AGENT_NAME_MAX_LENGTH = 40;
export const AI_AGENT_NAME_REQUIRED_CODE = 'AI_AGENT_NAME_REQUIRED';
export const AI_AGENT_NAME_REQUIRED_MESSAGE = 'Set an AI Agent name in CRM Settings to enable AI features.';
export const AI_AGENT_NAME_REQUIRED_REASON = 'The AI Agent has no name set for this dealership';

export interface AiAgentIdentity {
  configured: boolean;
  name: string | null;
  displayName: string;
  lookupFailed?: boolean;
}

export function cleanAiAgentName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AI_AGENT_NAME_MAX_LENGTH)
    .trim();
}

export function isValidAiAgentName(value: unknown): boolean {
  return /\p{L}/u.test(cleanAiAgentName(value));
}

export function configuredAiAgentName(metadata: any): string | null {
  const name = cleanAiAgentName(metadata?.aiAgentName);
  return isValidAiAgentName(name) ? name : null;
}

export function aiAgentDisplayName(name: string | null | undefined): string {
  return name || AI_AGENT_FALLBACK_LABEL;
}

export function identityFromMetadata(metadata: any): AiAgentIdentity {
  const name = configuredAiAgentName(metadata);
  return { configured: Boolean(name), name, displayName: aiAgentDisplayName(name) };
}

export async function resolveAiAgentIdentity(organizationId: unknown): Promise<AiAgentIdentity> {
  const orgId = String(organizationId || '');
  if (!orgId) return { configured: false, name: null, displayName: AI_AGENT_FALLBACK_LABEL };
  try {
    const org: any = await Organization.findById(orgId).select('metadata.aiAgentName').lean();
    return identityFromMetadata(org?.metadata);
  } catch (err) {
    logger.warn({ err, organizationId: orgId }, '[AiAgentIdentity] Could not read the AI Agent name');
    return { configured: false, name: null, displayName: AI_AGENT_FALLBACK_LABEL, lookupFailed: true };
  }
}
