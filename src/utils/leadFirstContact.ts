import { CallLog, CommunicationMessage } from '../models/communication.model';

export interface LeadFirstContact {
  firstContactBy: 'customer' | 'team';
  firstContactVia: 'team_text' | 'team_call' | null;
}

export async function firstContactForConversation(conversationId: unknown): Promise<LeadFirstContact> {
  const [message, call]: any[] = await Promise.all([
    CommunicationMessage.findOne({ conversationId }).sort({ createdAt: 1, _id: 1 }).select('direction createdAt').lean(),
    CallLog.findOne({ conversationId }).sort({ createdAt: 1, _id: 1 }).select('direction createdAt').lean(),
  ]);
  const touches = [
    message ? { direction: message.direction, at: new Date(message.createdAt).getTime(), via: 'team_text' as const } : null,
    call ? { direction: call.direction, at: new Date(call.createdAt).getTime(), via: 'team_call' as const } : null,
  ].filter((touch): touch is NonNullable<typeof touch> => Boolean(touch));
  touches.sort((a, b) => a.at - b.at);
  const first = touches[0];
  if (first?.direction === 'outbound') return { firstContactBy: 'team', firstContactVia: first.via };
  return { firstContactBy: 'customer', firstContactVia: null };
}
