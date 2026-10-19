export const WEBCHAT_ACK_ACTOR_ID = 'system-webchat-ack';

export function buildWebchatUnavailableAck(dealerName: string): string {
  const name = String(dealerName || '').trim() || 'our dealership';
  return `Thanks for reaching out to ${name}! We've received your message, and a member of our team will get back to you as soon as possible.`;
}
