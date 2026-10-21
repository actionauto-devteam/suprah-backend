import { CommunicationMessage } from '../models/communication.model';
import WebChatMessage from '../models/WebChatMessage.model';
import Vehicle from '../models/Vehicle.model';
import { AiAgentTranscriptEntry, HISTORY_LIMIT } from './aiAgent.service';
import { matchesVehicle } from '../utils/vehicleMatch';

const AI_AGENT_ACTOR_ID = 'ai-agent';

function toTranscriptEntry(m: any): AiAgentTranscriptEntry {
  if (m.direction === 'inbound') return { from: 'customer', body: m.body };
  if (m.sentBy?.userId === AI_AGENT_ACTOR_ID) return { from: 'ai', body: m.body };
  return { from: 'staff', staffName: m.sentBy?.name, body: m.body };
}

export async function buildSmsTranscript(conversationId: any): Promise<AiAgentTranscriptEntry[]> {
  const messages = await CommunicationMessage.find({ conversationId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  return messages.reverse().map(toTranscriptEntry);
}

export async function buildWebchatTranscript(sessionId: any): Promise<AiAgentTranscriptEntry[]> {
  const messages = await WebChatMessage.find({ sessionId, aiDispatchPending: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  return messages.reverse().map(toTranscriptEntry);
}

export async function buildSmsTranscriptUntil(conversationId: any, messageId: any): Promise<AiAgentTranscriptEntry[]> {
  const source: any = await CommunicationMessage.findOne({ _id: messageId, conversationId }).select('createdAt').lean();
  if (!source?.createdAt) return buildSmsTranscript(conversationId);
  const messages = await CommunicationMessage.find({ conversationId, createdAt: { $lte: source.createdAt } })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  return messages.reverse().map(toTranscriptEntry);
}

export async function buildWebchatTranscriptUntil(sessionId: any, messageId: any): Promise<AiAgentTranscriptEntry[]> {
  const source: any = await WebChatMessage.findOne({ _id: messageId, sessionId }).select('createdAt').lean();
  if (!source?.createdAt) return buildWebchatTranscript(sessionId);
  const messages = await WebChatMessage.find({ sessionId, aiDispatchPending: { $ne: true }, createdAt: { $lte: source.createdAt } })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();
  return messages.reverse().map(toTranscriptEntry);
}

function normalizeVinOrStock(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

export async function resolveCurrentVehicleAndPrice(lead: any): Promise<{ vehicle: any; price?: number; previousPrice?: number } | null> {
  if (!lead?.vehicle) return null;
  const vin = normalizeVinOrStock(lead.vehicle.vin);
  const stock = normalizeVinOrStock(lead.vehicle.stock);

  let vehicle: any = null;
  if (vin) {
    vehicle = await Vehicle.findOne({ organizationId: lead.organizationId, vin: new RegExp(`^${vin}$`, 'i') }).lean();
  }
  if (!vehicle && stock) {
    vehicle = await Vehicle.findOne({ organizationId: lead.organizationId, stockNumber: new RegExp(`^${stock}$`, 'i') }).lean();
  }
  if (!vehicle && !vin && !stock) {
    const candidates = await Vehicle.find({ organizationId: lead.organizationId, isArchived: { $ne: true } }).limit(500).lean();
    vehicle = candidates.find((v: any) => matchesVehicle(lead.vehicle, v)) || null;
  }
  if (!vehicle || typeof vehicle.price !== 'number') return vehicle ? { vehicle } : null;

  const history = Array.isArray(vehicle.priceHistory) ? vehicle.priceHistory : [];
  const last = history[history.length - 1];
  return {
    vehicle,
    price: vehicle.price,
    previousPrice: typeof last?.previousPrice === 'number' ? last.previousPrice : undefined,
  };
}
