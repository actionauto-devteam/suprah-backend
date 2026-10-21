import { isLocalUiAcceptanceMode } from './aiOutboundSafety';
import { isLocalMongoTarget } from './productionDbGuard.util';
import type { AttentionTechnicalCode } from '../models/aiHumanAttention';

export type MockAttentionDecision =
  | { intent: 'none' | 'human_request' | 'ai_identity_concern' }
  | { intent: 'unavailable'; failure: AttentionTechnicalCode };

export function isAttentionMockClassifierActive(): boolean {
  if ((process.env.LOCAL_ATTENTION_MOCK_CLASSIFIER || '').trim().toLowerCase() !== 'true') return false;
  if (!isLocalUiAcceptanceMode()) return false;
  if ((process.env.NODE_ENV || '').trim().toLowerCase() === 'production') return false;
  if (!isLocalMongoTarget(process.env.MONGODB_URI)) return false;
  return true;
}

const MOCK_DIRECTIVE = /\[mock:(timeout|provider_error|unreadable_response|uncertain)\]/i;

const HUMAN_REQUEST_PATTERNS = [
  /\b(talk|speak|chat|text)\s+(to|with)\s+(a\s+|an\s+|someone\s+|somebody\s+)?(real\s+|actual\s+|live\s+)?(person|human|someone|somebody|salesperson|sales\s*person|representative|rep|manager|agent)\b/,
  /\b(get|give|connect)\s+me\s+(to\s+|with\s+)?(a\s+|an\s+)?(real\s+|actual\s+|live\s+)?(person|human|someone|somebody|salesperson|representative|rep|manager)\b/,
  /\bstop\s+(the\s+)?(ai|bot|automated)\b/,
  /\b(don'?t|do not)\s+want\s+(to\s+(talk|chat|text)\s+(to|with)\s+)?(a\s+|an\s+)?(bot|ai|robot)\b/,
  /\b(human|person)\s+please\b/,
];

const IDENTITY_PATTERNS = [
  /\bare\s+you\s+(a\s+|an\s+)?(bot|robot|ai|human|real|machine|automated)\b/,
  /\bis\s+this\s+(a\s+|an\s+)?(bot|robot|ai|automated|real\s+person|human)\b/,
  /\bam\s+i\s+(talking|chatting|texting|speaking)\s+(to|with)\s+(a\s+|an\s+)?(bot|robot|ai|machine|real\s+person|human)\b/,
  /\bai[-\s]generated\b/,
  /\bwho\s+is\s+(actually\s+)?(replying|answering|texting)\b/,
];

export function classifyWithMock(body: string): MockAttentionDecision {
  const text = String(body || '').toLowerCase().replace(/[’‘]/g, "'");
  const directive = text.match(MOCK_DIRECTIVE);
  if (directive) return { intent: 'unavailable', failure: directive[1].toLowerCase() as AttentionTechnicalCode };
  if (HUMAN_REQUEST_PATTERNS.some(pattern => pattern.test(text))) return { intent: 'human_request' };
  if (IDENTITY_PATTERNS.some(pattern => pattern.test(text))) return { intent: 'ai_identity_concern' };
  return { intent: 'none' };
}
